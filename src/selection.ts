import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { isDeepStrictEqual } from 'node:util';
import type { EventPlan } from './classify.js';

export type CalendarPayload = NonNullable<EventPlan['payload']>;
export type SelectedEvent = {
  sourceUid: number;
  eventKey: string;
  iCalUID: string;
  payload: CalendarPayload;
};
export type Selection = {
  executedAt: string;
  events: SelectedEvent[];
  pastSkipped: number;
  repeatedSkipped: number;
};

function parseDate(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new Error('候補日時にはタイムゾーン付きRFC3339形式が必要です。');
  }
  const date = DateTime.fromISO(value, { setZone: true });
  if (!date.isValid) throw new Error('候補日時が不正です。');
  return date;
}

function calendarTime(value: { dateTime: string; timeZone?: string }) {
  const date = parseDate(value?.dateTime);
  if (!value.timeZone) return { dateTime: date.toISO()! };
  const zoned = date.setZone(value.timeZone);
  if (!zoned.isValid) throw new Error('候補タイムゾーンが不正です。');
  // 出発・到着が別地域の場合も、オフセットが表す同じ瞬間を維持する。
  return { dateTime: zoned.toISO()!, timeZone: value.timeZone };
}

export function validateSelection(raw: unknown, now = new Date()): Selection {
  if (!raw || typeof raw !== 'object') throw new Error('選別レポートの形式が不正です。');
  const report = raw as Record<string, any>;
  if (
    report.schemaVersion !== 1 ||
    report.mode !== 'dry-run' ||
    report.complete !== true ||
    !Array.isArray(report.proposed) ||
    !Array.isArray(report.messages) ||
    typeof report.executedAt !== 'string' ||
    !Number.isFinite(Date.parse(report.executedAt))
  ) {
    throw new Error(
      '完了済みのdry-run.jsonを指定してください。未完了・解析エラーのあるレポートは登録できません。',
    );
  }
  const events: SelectedEvent[] = [];
  let pastSkipped = 0,
    repeatedSkipped = 0;
  const seen = new Set<string>();
  for (const proposal of report.proposed) {
    if (
      !proposal ||
      !Number.isSafeInteger(proposal.sourceUid) ||
      typeof proposal.eventKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(proposal.eventKey) ||
      !proposal.payload
    )
      throw new Error('登録候補の形式が不正です。');
    const mail = report.messages.find(
      (m: any) => m.uid === proposal.sourceUid && m.decision === 'candidate',
    );
    const event = mail?.events?.find(
      (e: any) => e.decision === 'candidate' && e.eventKey === proposal.eventKey,
    );
    if (
      !event?.payload ||
      !isDeepStrictEqual(event.payload, proposal.payload) ||
      event.payload.extendedProperties?.private?.sourceEventKey !== proposal.eventKey
    ) {
      throw new Error('候補とメールごとの選別結果が一致しません。dry-runを再生成してください。');
    }
    const payload = proposal.payload as CalendarPayload;
    if (
      typeof payload.summary !== 'string' ||
      !payload.summary.trim() ||
      typeof payload.location !== 'string' ||
      typeof payload.description !== 'string'
    )
      throw new Error('予定タイトル・場所・説明の形式が不正です。');
    const start = parseDate(payload.start?.dateTime),
      end = parseDate(payload.end?.dateTime);
    if (end <= start) throw new Error('終了日時が開始日時以前です。');
    if (start.toMillis() <= now.getTime()) {
      pastSkipped++;
      continue;
    }
    if (seen.has(proposal.eventKey)) {
      repeatedSkipped++;
      continue;
    }
    seen.add(proposal.eventKey);
    const originalUID =
      typeof event.identity === 'string' &&
      event.identity.startsWith('ics:') &&
      event.identity.endsWith(':')
        ? event.identity.slice(4, -1)
        : undefined;
    events.push({
      sourceUid: proposal.sourceUid,
      eventKey: proposal.eventKey,
      iCalUID: originalUID || `${proposal.eventKey}@auto-calendar-register.local`,
      payload: {
        summary: payload.summary,
        location: payload.location,
        description: payload.description,
        start: calendarTime(payload.start),
        end: calendarTime(payload.end),
        extendedProperties: { private: { sourceEventKey: proposal.eventKey } },
      },
    });
  }
  return { executedAt: report.executedAt, events, pastSkipped, repeatedSkipped };
}

export async function readSelection(file: string, now = new Date()) {
  return validateSelection(JSON.parse(await readFile(file, 'utf8')), now);
}

export function googleEventId(eventKey: string) {
  // base32hexで許可される文字だけを使い、再実行・並行実行でも同じIDにする。
  return 'acr' + createHash('sha256').update(eventKey).digest('hex');
}
