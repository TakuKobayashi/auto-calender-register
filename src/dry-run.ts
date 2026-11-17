import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';
import { classifyAll, type MailPlan, type EventPlan } from './classify.js';
import type { Collection } from './collect.js';
import {
  extractWithOllama,
  extractionToPlan,
  modelText,
  extractionCacheKey,
  localModelDigest,
  validateExtraction,
} from './ollama.js';
import type { Store } from './db/store.js';
import { finalize } from './classify.js';

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
) {
  const overrides = new Map<number, MailPlan>();
  if (model) {
    // 全文を無差別にモデルへ流さず、ルールで拾った候補・要確認と予約らしい本文を再判定。
    const initial = classifyAll(collection.messages, now);
    for (let i = 0; i < collection.messages.length; i++) {
      const mail = collection.messages[i]!;
      const plan = initial[i]!;
      if (
        !['candidate', 'review', 'pending'].includes(plan.decision) &&
        !/予約が成功|お客様のチケット|ご予約いただ|booking is confirmed|旅程|発券|フライト|check.?in|チェックイン/i.test(
          modelText(mail).slice(0, 4000),
        ) &&
        !/打ち合わせ|打合せ|面談|面接|旅程|チケット|航空券|予約|受験|試験|appointment|meeting|itinerary|reservation|ticket|flight|booking/i.test(
          mail.subject,
        )
      )
        continue;
      console.error(`Ollama再判定 UID ${mail.uid}`);
      try {
        const key = extractionCacheKey(mail, model, await localModelDigest(model));
        const cached = await store?.getExtraction(key);
        const extraction = cached
          ? validateExtraction(cached)
          : await extractWithOllama(mail, model);
        if (!cached && store) await store.saveExtraction(key, model, extraction);
        const inferred = extractionToPlan(mail, extraction, now, finalize);
        overrides.set(mail.uid, reconcileModelPlan(plan, inferred));
      } catch {
        overrides.set(mail.uid, {
          ...plan,
          decision: 'error',
          events: [],
          reasons: ['Ollamaの呼び出し・出力検証に失敗。登録しない'],
        });
      }
    }
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
      receivedAt: null,
      messageId: null,
      decision: 'error',
      reasons: [error.reason],
      events: [],
    });
  const counts = { candidate: 0, review: 0, excluded: 0, duplicate: 0, error: 0, pending: 0 };
  for (const plan of plans) counts[plan.decision]++;
  const proposed = plans.flatMap((p) =>
    p.events
      .filter((e) => e.decision === 'candidate')
      .map((e) => ({
        sourceUid: p.uid,
        sourceSubject: p.subject,
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
    executedAt: now.toISOString(),
    since: collection.since,
    mailbox: collection.mailbox,
    uidValidity: collection.uidValidity,
    sourceScope: collection.sourceScope,
    mailCollectedAt: collection.collectedAt,
    complete: collection.complete && counts.error === 0 && plans.length === collection.matched,
    calendarDuplicateCheck: existingFile ? 'local_snapshot_only' : 'not_connected',
    calendarWrites: 0,
    summary: { scanned: plans.length, ...counts, proposedEvents: proposed.length },
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
    `確認メール ${plans.length}件 / 候補 ${counts.candidate}件 / 要確認 ${counts.review}件 / 未確定 ${counts.pending}件 / 対象外 ${counts.excluded}件 / 重複 ${counts.duplicate}件 / エラー ${counts.error}件`,
    '',
    '## 登録候補',
    '',
    '| 元メールUID | 予定 | 開始 | 終了 | タイムゾーン | 場所 | 判定根拠 |',
    '|---|---|---|---|---|---|---|',
  ];
  const row = (p: MailPlan, e: EventPlan) =>
    `| ${p.uid} | ${md(e.title)} | ${md(displayDate(e.start))} | ${md(displayDate(e.end))} | ${md(e.timeZone)} | ${md(e.location)} | ${md(e.reasons.join(' / '))} |`;
  for (const p of plans)
    for (const e of p.events.filter((e) => e.decision === 'candidate')) lines.push(row(p, e));
  if (!proposed.length) lines.push('| — | 登録候補なし | | | | | |');
  const futureReviews = plans.flatMap((p) =>
    p.events
      .filter(
        (e) =>
          e.decision === 'review' &&
          ((e.start && new Date(e.start) > now) ||
            (!e.start &&
              e.localStart &&
              e.localStart.slice(0, 10) >
                DateTime.fromJSDate(now).setZone('Asia/Tokyo').toISODate()!)),
      )
      .map((e) => ({ p, e })),
  );
  lines.push(
    '',
    '## 未来の日時が記載されている要確認予定',
    '',
    '| 元メールUID | 件名・予定 | 開始 | 終了 | 判定理由 |',
    '|---|---|---|---|---|',
  );
  for (const { p, e } of futureReviews)
    lines.push(
      `| ${p.uid} | ${md(e.title)} | ${md(displayStart(e))} | ${md(displayDate(e.end))} | ${md(e.reasons.join(' / '))} |`,
    );
  lines.push(
    '',
    '## 要確認',
    '',
    '| 元メールUID | 件名・予定 | 開始 | 終了 | 判定理由 |',
    '|---|---|---|---|---|',
  );
  for (const p of plans.filter((p) => p.decision === 'review')) {
    const events = p.events.filter((e) => e.decision === 'review');
    if (!events.length)
      lines.push(
        `| ${p.uid} | ${md(p.subject)} | 未確定 | 未確定 | ${md(p.reasons.join(' / '))} |`,
      );
    for (const e of events)
      lines.push(
        `| ${p.uid} | ${md(e.title)} | ${md(displayStart(e))} | ${md(displayDate(e.end))} | ${md(e.reasons.join(' / '))} |`,
      );
  }
  lines.push(
    '',
    '## 未確定・確定通知待ち',
    '',
    '| 元メールUID | 件名 | 判定理由 |',
    '|---|---|---|',
  );
  for (const p of plans.filter((p) => p.decision === 'pending'))
    lines.push(`| ${p.uid} | ${md(p.subject)} | ${md(p.reasons.join(' / '))} |`);
  lines.push(
    '',
    '## 確認方法',
    '',
    'UIDを指定して元メールを表示できます。',
    '',
    '```sh',
    'node --import tsx src/cli.ts show <UID>',
    '```',
    '',
    '対象外・重複も含む全メールの判定、根拠の抜粋、登録用payloadは dry-run.json を参照してください。',
    'JSONのcandidateは既存カレンダー照合前の候補です。要確認メールは自動登録しません。',
    'このツールはルールベースです。未対応の文面は見落とす可能性があり、全予定の抽出を保証しません。',
    '',
  );
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'dry-run.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await writeFile(resolve(directory, 'dry-run.md'), lines.join('\n'), { mode: 0o600 });
  if (store && collection.sourceScope) await store.savePlans(collection.sourceScope, plans);
  return report;
}

export function reconcileModelPlan(rule: MailPlan, inferred: MailPlan): MailPlan {
  const merged = {
    ...inferred,
    bookingIds: rule.bookingIds,
    cancelled: rule.cancelled || inferred.intent === 'cancelled',
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
    // CBTの明記された150分等をモデルが取りこぼしても、検証済みの終了時刻は捨てない。
    const retained = structuredClone(rule);
    retained.intent = 'confirmed';
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
