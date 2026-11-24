import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';
import {
  classifyAll,
  classifyMail,
  calendarEvents,
  type MailPlan,
  type EventPlan,
} from './classify.js';
import type { Collection } from './collect.js';
import {
  extractWithOllama,
  extractionToPlan,
  modelText,
  extractionCacheKey,
  localModelDigest,
  validateExtraction,
  checkedModelText,
  OllamaError,
  OllamaTimeoutError,
  ollamaFailureReason,
  isReviewOutcome,
  type Extraction,
} from './ollama.js';
import type { Store } from './db/store.js';
import { finalize } from './classify.js';
import { mailLabel, sourceScope } from './domain/mail.js';
import { inspectDatePresence } from './date-presence.js';
import { shortlistReason } from './mail-shortlist.js';
import type { CollectedMail } from './domain/mail.js';
import type { ExistingCalendarEvent } from './domain/calendar.js';
import { matchExisting } from './event-matching.js';
import { calendarIcalUid } from './selection.js';

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

export function applyExistingEvents(plans: MailPlan[], existing: ExistingCalendarEvent[]) {
  for (const plan of plans)
    for (const event of plan.events) {
      if (event.decision !== 'candidate' || !event.eventKey || !event.payload) continue;
      const match = matchExisting(
        {
          sourceUid: plan.uid,
          eventKey: event.eventKey,
          iCalUID: calendarIcalUid(event.eventKey, event.identity),
          payload: event.payload,
        },
        existing,
      );
      if (match) {
        event.decision = 'duplicate';
        delete event.payload;
        event.reasons.push(match.reason);
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
  options: { retryReviews?: boolean; mailDetails?: boolean; llmDeadline?: number } = {},
) {
  const overrides = new Map<number, MailPlan>();
  let remainingLlm = 0;
  const llm = {
    skippedNoDate: 0,
    skippedByShortlist: 0,
    cacheHits: 0,
    requests: 0,
    uncachedMails: 0,
    deferredTimeouts: 0,
  };
  const total = collection.messages.length;
  const progressOnly = options.mailDetails === false;
  const logProgress = (processed: number, runningLlm = false) => {
    const active = runningLlm ? `（${processed + 1}件目をLLMで判定中）` : '';
    const counts = model
      ? ` / LLMキャッシュ再利用: ${llm.cacheHits}件 / 新規判定開始: ${llm.requests}件`
      : '';
    console.error(`メール選別: ${processed}/${total}件処理済み${active}${counts}`);
  };
  if (progressOnly) logProgress(0);
  if (model) {
    const applyExtraction = (mail: CollectedMail, extraction: Extraction) => {
      const calendar = calendarEvents(mail, now);
      const plan = extractionToPlan(mail, extraction, now, (event, date) => {
        const matches = calendar.filter(
          (item) => item.start && event.start && Date.parse(item.start) === Date.parse(event.start),
        );
        const original = matches.length === 1 ? matches[0] : undefined;
        if (original?.identity) {
          event.identity = original.identity;
          event.sequence = original.sequence;
        }
        return finalize(event, date);
      });
      overrides.set(mail.uid, plan);
    };
    const emptyPlan = ({ uid, source, subject, from, messageId, receivedAt }: CollectedMail) => ({
      uid,
      source,
      subject,
      from,
      messageId,
      receivedAt,
      events: [],
    });
    const recordFailure = async (mail: CollectedMail, error: unknown, key?: string) => {
      const timedOut = error instanceof OllamaTimeoutError;
      const cacheReview = error instanceof OllamaError && error.needsReview;
      const decision = timedOut || cacheReview ? 'review' : 'error';
      const reason = ollamaFailureReason(error);
      if (timedOut) llm.deferredTimeouts++;
      if (cacheReview && key && store)
        await store.saveExtraction(key, model, { kind: 'review', reason });
      if (options.mailDetails !== false)
        console.error(`登録しない: ${mailLabel(mail)} ｜ ${reason}`);
      overrides.set(mail.uid, {
        ...emptyPlan(mail),
        decision,
        reasons: [reason, '自動登録しない'],
      });
    };
    const reuseExtraction = async (mail: CollectedMail, key: string) => {
      const cached = await store?.getExtraction(key);
      if (!cached || (isReviewOutcome(cached) && options.retryReviews)) return false;
      llm.cacheHits++;
      if (isReviewOutcome(cached)) {
        overrides.set(mail.uid, {
          ...emptyPlan(mail),
          decision: 'review',
          reasons: [
            cached.reason,
            '入力・モデルが同じため保存済みの要確認結果を使用。自動登録しない',
          ],
        });
      } else {
        applyExtraction(mail, validateExtraction(cached));
      }
      return true;
    };
    const pending: { mail: CollectedMail; key: string; shortlist: string }[] = [];
    for (let i = 0; i < total; i++) {
      if (progressOnly && i > 0 && i % 25 === 0) logProgress(i - pending.length);
      const mail = collection.messages[i]!;
      let key: string | undefined;
      try {
        const shortlist = shortlistReason(mail, now);
        if (!shortlist) {
          const plan = classifyMail(mail, now);
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
          if (options.mailDetails !== false)
            console.error(`登録しない: ${mailLabel(mail)} ｜ ${reason}`);
          continue;
        }
        checkedModelText(mail);
        key = extractionCacheKey(mail, model, await localModelDigest(model));
        if (!(await reuseExtraction(mail, key))) pending.push({ mail, key, shortlist });
      } catch (error) {
        await recordFailure(mail, error, key);
      }
    }
    if (progressOnly && pending.length)
      console.error(
        `LLM判定の内訳: キャッシュ再利用 ${llm.cacheHits}件 / 新規判定待ち ${pending.length}件`,
      );

    const receivedTime = (mail: CollectedMail) => {
      const received = Date.parse(mail.receivedAt ?? '');
      if (Number.isFinite(received)) return received;
      const sent = Date.parse(mail.date ?? '');
      return Number.isFinite(sent) ? sent : -Infinity;
    };
    pending.sort((a, b) => receivedTime(b.mail) - receivedTime(a.mail));
    for (const [index, { mail, key, shortlist }] of pending.entries()) {
      const processed = total - pending.length + index;
      try {
        // A preceding request in this run may have saved an identical input.
        if (!(await reuseExtraction(mail, key))) {
          if (options.llmDeadline !== undefined && Date.now() >= options.llmDeadline) {
            remainingLlm = pending.length - index;
            break;
          }
          llm.uncachedMails++;
          llm.requests++;
          if (progressOnly) logProgress(processed, true);
          else console.error(`LLM判定対象: ${mailLabel(mail)} ｜ ${shortlist}`);
          const extraction = await extractWithOllama(mail, model);
          await store?.saveExtraction(key, model, extraction);
          applyExtraction(mail, extraction);
        }
      } catch (error) {
        await recordFailure(mail, error, key);
      }
      if (progressOnly && processed + 1 < total) logProgress(processed + 1);
    }
  }
  const processed = remainingLlm
    ? collection.messages.filter((mail) => overrides.has(mail.uid))
    : collection.messages;
  const plans = classifyAll(processed, now, overrides);
  if (progressOnly && total) logProgress(processed.length);
  if (existingFile) {
    const raw = JSON.parse(await readFile(existingFile, 'utf8'));
    const existing: ExistingCalendarEvent[] = Array.isArray(raw) ? raw : raw.items;
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
    complete:
      collection.complete &&
      remainingLlm === 0 &&
      counts.error === 0 &&
      plans.length === collection.matched,
    remainingLlm,
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
    `新規LLM判定 ${llm.uncachedMails}通 / LLM呼び出し ${llm.requests}回 / キャッシュ利用 ${llm.cacheHits}通 / 日付なしで省略 ${llm.skippedNoDate}件 / 今後の日時候補なしで省略 ${llm.skippedByShortlist}件`,
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
