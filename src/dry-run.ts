import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';
import { classifyAll, type MailPlan, type EventPlan } from './classify.js';
import type { Collection } from './collect.js';
import {
  extractWithOllama,
  extractBatchWithOllama,
  extractionInputBytes,
  extractionToPlan,
  modelText,
  extractionCacheKey,
  localModelDigest,
  validateExtraction,
  checkedModelText,
  OllamaError,
  ollamaFailureReason,
  isReviewOutcome,
  type Extraction,
} from './ollama.js';
import type { Store } from './db/store.js';
import { finalize } from './classify.js';
import { mailLabel, sourceScope } from './domain/mail.js';
import { inspectDatePresence } from './date-presence.js';
import { shortlistReason } from './mail-shortlist.js';
import { optionalMailExclusion } from './mail-exclusions.js';
import type { CollectedMail } from './domain/mail.js';

type ExistingEvent = {
  id?: string;
  status?: string;
  summary?: string;
  iCalUID?: string;
  start?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: { sourceEventKey?: string } };
};

export async function readCollection(path: string, since: Date): Promise<Collection> {
  const data = JSON.parse(await readFile(path, 'utf8')) as Collection;
  if (
    data.version !== 1 ||
    !Array.isArray(data.messages) ||
    !Array.isArray(data.errors) ||
    data.since !== since.toISOString() ||
    typeof data.complete !== 'boolean'
  ) {
    throw new Error('キャッシュの形式または --since が一致しません。');
  }
  return data;
}

export function applyExistingEvents(plans: MailPlan[], existing: ExistingEvent[]) {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s/g, '');
  for (const plan of plans)
    for (const event of plan.events) {
      if (event.decision !== 'candidate') continue;
      const match = existing.find(
        (e) =>
          e.status !== 'cancelled' &&
          ((event.eventKey && e.extendedProperties?.private?.sourceEventKey === event.eventKey) ||
            (event.identity?.startsWith('ics:') &&
              e.iCalUID &&
              event.identity === `ics:${e.iCalUID}:`) ||
            (e.summary &&
              normalize(e.summary) === normalize(event.title) &&
              e.start?.dateTime &&
              event.start &&
              new Date(e.start.dateTime).getTime() === new Date(event.start).getTime())),
      );
      if (match) {
        event.decision = 'duplicate';
        delete event.payload;
        event.reasons.push(`既存カレンダースナップショットと一致: ${match.id ?? '(IDなし)'}`);
      }
    }
  for (const plan of plans)
    if (plan.decision === 'candidate' && !plan.events.some((e) => e.decision === 'candidate')) {
      plan.decision = plan.events.some((e) => e.decision === 'review') ? 'review' : 'duplicate';
    }
}

function md(value: unknown) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}
function displayDate(value: string | null) {
  return value
    ? DateTime.fromISO(value, { setZone: true }).toFormat('yyyy-MM-dd HH:mm ZZZZ')
    : '未確定';
}
function displayStart(event: EventPlan) {
  return event.start
    ? displayDate(event.start)
    : event.localStart
      ? `${event.localStart.replace('T', ' ')}（TZ未確定）`
      : '未確定';
}

export async function writeDryRun(
  collection: Collection,
  directory: string,
  existingFile?: string,
  now = new Date(),
  model?: string,
  store?: Store,
  options: { retryReviews?: boolean } = {},
) {
  const overrides = new Map<number, MailPlan>();
  const llm = {
    skippedNoDate: 0,
    skippedByShortlist: 0,
    skippedOptionalMail: 0,
    cacheHits: 0,
    requests: 0,
    batchRequests: 0,
    uncachedMails: 0,
  };
  if (model) {
    const initial = classifyAll(collection.messages, now);
    type Pending = { mail: CollectedMail; plan: MailPlan; key: string; bytes: number };
    const pending: Pending[] = [];
    const applyExtraction = (mail: CollectedMail, plan: MailPlan, extraction: Extraction) => {
      const inferred = extractionToPlan(mail, extraction, now, finalize);
      overrides.set(mail.uid, reconcileModelPlan(plan, inferred));
    };
    const recordFailure = async (
      mail: CollectedMail,
      plan: MailPlan,
      error: unknown,
      key?: string,
    ) => {
      const decision = error instanceof OllamaError && error.needsReview ? 'review' : 'error';
      const reason = ollamaFailureReason(error);
      if (decision === 'review' && key && store)
        await store.saveExtraction(key, model, { kind: 'review', reason });
      console.error(`登録しない: ${mailLabel(mail)} ｜ ${reason}`);
      overrides.set(mail.uid, {
        ...plan,
        decision,
        events: [],
        reasons: [...plan.reasons, reason, '自動登録しない'],
      });
    };
    const flush = async () => {
      const batch = pending.splice(0);
      if (!batch.length) return;
      let results: (Extraction | undefined)[] = [];
      if (batch.length > 1) {
        llm.requests++;
        llm.batchRequests++;
        console.error(`LLMでまとめて判定: ${batch.length}通`);
        try {
          results = await extractBatchWithOllama(
            batch.map(({ mail }) => mail),
            model,
          );
        } catch (error) {
          for (const { mail, plan } of batch) await recordFailure(mail, plan, error);
          return;
        }
      }
      for (const [index, { mail, plan, key }] of batch.entries()) {
        try {
          let extraction = results[index];
          if (!extraction) {
            llm.requests++;
            extraction = await extractWithOllama(mail, model);
          }
          await store?.saveExtraction(key, model, extraction);
          applyExtraction(mail, plan, extraction);
        } catch (error) {
          await recordFailure(mail, plan, error, key);
        }
      }
    };
    for (let i = 0; i < collection.messages.length; i++) {
      const mail = collection.messages[i]!;
      const plan = initial[i]!;
      let key: string | undefined;
      try {
        const exclusion = optionalMailExclusion(mail);
        if (exclusion) {
          llm.skippedOptionalMail++;
          const reason = `${exclusion}。LLM判定を省略`;
          overrides.set(mail.uid, {
            ...plan,
            decision: 'excluded',
            events: [],
            reasons: [...plan.reasons, reason],
          });
          console.error(`登録しない: ${mailLabel(mail)} ｜ ${reason}`);
          continue;
        }
        const shortlist = shortlistReason(mail, now);
        if (!shortlist) {
          const presence = inspectDatePresence(mail);
          if (presence.hasDate) llm.skippedByShortlist++;
          else llm.skippedNoDate++;
          const reason = presence.hasDate
            ? '今後の日時候補を確認できない。LLM判定を省略'
            : '件名・本文・ICSに日付情報なし。LLM判定を省略';
          overrides.set(mail.uid, {
            ...plan,
            decision: 'excluded',
            events: [],
            reasons: [...plan.reasons, reason],
          });
          console.error(`登録しない: ${mailLabel(mail)} ｜ ${reason}`);
          continue;
        }
        const body = checkedModelText(mail);
        key = extractionCacheKey(mail, model, await localModelDigest(model));
        const cached = await store?.getExtraction(key);
        if (cached && !(isReviewOutcome(cached) && options.retryReviews)) llm.cacheHits++;
        if (isReviewOutcome(cached) && !options.retryReviews) {
          overrides.set(mail.uid, {
            ...plan,
            decision: 'review',
            events: [],
            reasons: [
              ...plan.reasons,
              cached.reason,
              '入力・モデルが同じため保存済みの要確認結果を使用。自動登録しない',
            ],
          });
          continue;
        }
        if (cached && !isReviewOutcome(cached)) {
          applyExtraction(mail, plan, validateExtraction(cached));
          continue;
        }
        const bytes = extractionInputBytes(mail, body);
        // Leave room in the context for the prompt and up to three extractions.
        if (pending.reduce((sum, item) => sum + item.bytes, bytes) > 5000) await flush();
        llm.uncachedMails++;
        console.error(`LLM判定対象: ${mailLabel(mail)} ｜ ${shortlist}`);
        pending.push({ mail, plan, key, bytes });
        if (pending.length === 3 || bytes > 5000) await flush();
      } catch (error) {
        await recordFailure(mail, plan, error, key);
      }
    }
    await flush();
  }
  const plans = classifyAll(collection.messages, now, overrides);
  if (existingFile) {
    const raw = JSON.parse(await readFile(existingFile, 'utf8'));
    const existing: ExistingEvent[] = Array.isArray(raw) ? raw : raw.items;
    if (!Array.isArray(existing))
      throw new Error(
        '既存予定は配列またはGoogle Events形式の { items: [...] } を指定してください。',
      );
    applyExistingEvents(plans, existing);
  }
  for (const error of collection.errors)
    plans.push({
      uid: error.uid,
      subject: error.subject,
      from: '',
      source: error.source,
      receivedAt: null,
      messageId: null,
      decision: 'error',
      reasons: [error.reason],
      events: [],
    });
  for (const plan of plans) {
    plan.shouldRegister = plan.events.some((event) => event.decision === 'candidate');
    if (!plan.shouldRegister && !plan.reasons.length && plan.events.length)
      plan.reasons.push(...new Set(plan.events.flatMap((e) => e.reasons)));
  }
  const counts = { candidate: 0, review: 0, excluded: 0, duplicate: 0, error: 0, pending: 0 };
  for (const plan of plans) counts[plan.decision]++;
  const proposed = plans.flatMap((p) =>
    p.events
      .filter((e) => e.decision === 'candidate')
      .map((e) => ({
        sourceUid: p.uid,
        sourceSubject: p.subject,
        sourceFrom: p.from,
        source: p.source,
        eventKey: e.eventKey,
        operation: existingFile
          ? 'would_insert_if_snapshot_is_current'
          : 'pending_calendar_duplicate_check',
        payload: e.payload,
      })),
  );
  const report = {
    schemaVersion: 1,
    mode: 'dry-run',
    model: model ?? null,
    llm,
    executedAt: now.toISOString(),
    since: collection.since,
    mailbox: collection.mailbox,
    uidValidity: collection.uidValidity,
    sourceScope: collection.sourceScope,
    mailCollectedAt: collection.collectedAt,
    complete: collection.complete && counts.error === 0 && plans.length === collection.matched,
    calendarDuplicateCheck: existingFile ? 'local_snapshot_only' : 'not_connected',
    calendarWrites: 0,
    summary: {
      scanned: plans.length,
      register: plans.filter((p) => p.shouldRegister).length,
      skip: plans.filter((p) => !p.shouldRegister).length,
      ...counts,
      proposedEvents: proposed.length,
    },
    proposed,
    messages: plans,
  };
  const lines = [
    '# メール予定抽出 dry-run',
    '',
    `実行日時: ${now.toISOString()} / 受信期間: ${DateTime.fromISO(collection.since).setZone('Asia/Tokyo').toISODate()} 00:00 JST以降`,
    `対象: ${collection.mailbox} / 本文取得日時: ${collection.collectedAt} / 全件取得・解析: ${report.complete ? '完了' : '未完了'}`,
    '',
    '**Googleカレンダーへの書き込み: 0件**',
    `既存カレンダー照合: ${existingFile ? 'ローカルスナップショットのみ（最新性は未保証）' : '未接続・未確認。候補は登録確定ではありません。'}`,
    '',
    `確認メール ${plans.length}件 / 登録候補 ${proposed.length}件 / 登録しない ${plans.filter((p) => !p.shouldRegister).length}件 / 処理エラー ${counts.error}件`,
    `新規LLM判定 ${llm.uncachedMails}通 / LLM呼び出し ${llm.requests}回（うち一括 ${llm.batchRequests}回） / キャッシュ利用 ${llm.cacheHits}通 / 販促・一般案内等で省略 ${llm.skippedOptionalMail}件 / 日付なしで省略 ${llm.skippedNoDate}件 / 今後の日時候補なしで省略 ${llm.skippedByShortlist}件`,
    '',
    '## 登録候補',
    '',
    '| 送信元・件名 | 予定 | 開始 | 終了 | タイムゾーン | 場所 | 判定根拠 |',
    '|---|---|---|---|---|---|---|',
  ];
  const row = (p: MailPlan, e: EventPlan) =>
    `| ${md(mailLabel(p))} | ${md(e.title)} | ${md(displayDate(e.start))} | ${md(displayDate(e.end))} | ${md(e.timeZone)} | ${md(e.location)} | ${md(e.reasons.join(' / '))} |`;
  for (const p of plans)
    for (const e of p.events.filter((e) => e.decision === 'candidate')) lines.push(row(p, e));
  if (!proposed.length) lines.push('| — | 登録候補なし | | | | | |');
  lines.push(
    '',
    '## 登録する／登録しないの判定',
    '',
    '| 登録する | 送信元 | 件名 | 理由 |',
    '|---|---|---|---|',
  );
  for (const p of plans)
    lines.push(
      `| ${p.shouldRegister ? 'true' : 'false'} | ${md(p.from)} | ${md(p.subject)} | ${md([...p.reasons, ...p.events.flatMap((e) => e.reasons)].join(' / '))} |`,
    );
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'dry-run.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await writeFile(resolve(directory, 'dry-run.md'), lines.join('\n'), { mode: 0o600 });
  if (store) {
    const scopes = new Set(plans.filter((p) => p.source).map((p) => sourceScope(p.source!)));
    for (const scope of scopes)
      await store.savePlans(
        scope,
        plans.filter((p) => p.source && sourceScope(p.source) === scope),
      );
  }
  return report;
}

export function reconcileModelPlan(rule: MailPlan, inferred: MailPlan): MailPlan {
  const merged = {
    ...inferred,
    source: rule.source,
    bookingIds: [...new Set([...(rule.bookingIds ?? []), ...(inferred.bookingIds ?? [])])],
    cancelled: rule.cancelled || ['cancelled', 'completed'].includes(inferred.intent ?? ''),
  };
  if (rule.decision === 'pending' || inferred.decision === 'pending') {
    return {
      ...merged,
      decision: 'pending',
      events: [],
      reasons: [...rule.reasons, ...inferred.reasons, '未確定の根拠を優先。確定通知まで登録しない'],
    };
  }
  const candidates = rule.events.filter((e) => e.decision === 'candidate');
  if (
    rule.decision === 'candidate' &&
    inferred.intent === 'confirmed' &&
    candidates.length &&
    candidates.every((e) =>
      inferred.events.some(
        (other) =>
          other.start && e.start && new Date(other.start).getTime() === new Date(e.start).getTime(),
      ),
    )
  ) {
    const retained = structuredClone(rule);
    retained.bookingIds = merged.bookingIds;
    retained.intent = 'confirmed';
    for (const event of retained.events) {
      if (!event.payload || !event.start) continue;
      const extracted = inferred.events.find(
        (other) =>
          other.payload && other.start && Date.parse(other.start) === Date.parse(event.start!),
      );
      if (!extracted?.payload) continue;
      event.title = extracted.title;
      event.payload.summary = extracted.payload.summary;
      if (extracted.calendarDetails?.length) {
        event.calendarDetails = extracted.calendarDetails;
        event.payload.description = [
          ...extracted.calendarDetails,
          '',
          event.payload.description,
        ].join('\n');
      }
    }
    retained.reasons.push(
      ...inferred.reasons,
      '本人の確定予定とLLMが判断。日時は既存ルールの検証済み情報を使用',
    );
    return retained;
  }
  if (rule.decision === 'candidate' && !['candidate', 'duplicate'].includes(inferred.decision)) {
    const events = structuredClone(rule.events);
    for (const event of events) {
      event.decision = 'review';
      delete event.payload;
      event.reasons.push('予約ルールとLLMが不一致。自動登録しない');
    }
    return {
      ...merged,
      decision: 'review',
      events,
      reasons: [...rule.reasons, ...inferred.reasons],
    };
  }
  return merged;
}
