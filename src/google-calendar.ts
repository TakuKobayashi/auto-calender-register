import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { OAuth2Client } from 'google-auth-library';
import { DateTime } from 'luxon';
import { mailLabel } from './domain/mail.js';
import {
  googleEventId,
  type SelectedEvent,
  type Selection,
  type CalendarPayload,
} from './selection.js';

import type { ExistingCalendarEvent } from './domain/calendar.js';
import { matchExisting, type Match } from './event-matching.js';
export { matchExisting } from './event-matching.js';
export type GoogleEvent = ExistingCalendarEvent;
export type ListQuery = {
  privateExtendedProperty?: string;
  iCalUID?: string;
  timeMin?: string;
  timeMax?: string;
};
export interface CalendarPort {
  get(id: string): Promise<GoogleEvent | null>;
  list(query: ListQuery): Promise<GoogleEvent[]>;
  insert(event: CalendarPayload & { id: string }): Promise<GoogleEvent>;
}

export class CalendarApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 400
        ? `Google Calendar認証・リクエストエラー（HTTP ${status}）。権限とauth loginを確認してください。`
        : `Google Calendar APIエラー（HTTP ${status}）。`,
    );
  }
}

export class GoogleCalendar implements CalendarPort {
  private readonly url: string;
  constructor(
    private readonly auth: OAuth2Client,
    calendarId: string,
  ) {
    if (!calendarId.trim()) throw new Error('GoogleカレンダーIDを指定してください。');
    this.url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  }
  private async request<T>(
    method: 'GET' | 'POST',
    url: string,
    params?: Record<string, unknown>,
    data?: unknown,
  ) {
    try {
      const response = await this.auth.request<T>({
        method,
        url,
        params,
        data,
        timeout: 30_000,
        retry: false,
      });
      return response.data;
    } catch (error) {
      const e = error as { response?: { status?: number }; status?: number };
      throw new CalendarApiError(e.response?.status ?? e.status ?? 0);
    }
  }
  async get(id: string) {
    try {
      return await this.request<GoogleEvent>('GET', `${this.url}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof CalendarApiError && error.status === 404) return null;
      if (error instanceof CalendarApiError && error.status === 410)
        return { id, status: 'cancelled' };
      throw error;
    }
  }
  async list(query: ListQuery) {
    const results: GoogleEvent[] = [];
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page: { items?: GoogleEvent[]; nextPageToken?: string } = await this.request(
        'GET',
        this.url,
        {
          ...query,
          pageToken,
          singleEvents: true,
          showDeleted: false,
          maxResults: 2500,
        },
      );
      results.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      if (pageToken && tokens.has(pageToken))
        throw new Error('Calendar APIのページネーションが循環しています。登録を中止しました。');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    return results;
  }
  async insert(event: CalendarPayload & { id: string }) {
    const { allDayDate, ...payload } = event;
    const data = allDayDate
      ? {
          ...payload,
          start: { date: allDayDate },
          end: { date: DateTime.fromISO(payload.end.dateTime, { setZone: true }).toISODate()! },
        }
      : payload;
    return this.request<GoogleEvent>('POST', this.url, { sendUpdates: 'none' }, data);
  }
}

async function findExisting(
  port: CalendarPort,
  selected: SelectedEvent,
  withinBatch: GoogleEvent[],
) {
  const own = await port.get(googleEventId(selected.eventKey));
  if (own) {
    if (
      own.status === 'cancelled' ||
      own.extendedProperties?.private?.sourceEventKey === selected.eventKey
    ) {
      return {
        kind: own.status === 'cancelled' ? 'previously_deleted' : 'duplicate',
        event: own,
        reason: 'Matching deterministic event identifier',
      } as Match;
    }
    throw new Error('予定IDが別の予定と衝突しています。登録を中止しました。');
  }
  const byKey = await port.list({ privateExtendedProperty: `sourceEventKey=${selected.eventKey}` });
  const byIcs = await port.list({ iCalUID: selected.iCalUID });
  const identified = matchExisting(selected, [...withinBatch, ...byKey, ...byIcs]);
  if (identified) return identified;
  const start = Date.parse(selected.payload.start.dateTime);
  const end = Date.parse(selected.payload.end.dateTime);
  const nearby = await port.list({
    timeMin: new Date(start - 86400_000).toISOString(),
    timeMax: new Date(end + 86400_000).toISOString(),
  });
  return matchExisting(selected, [...withinBatch, ...nearby]);
}

export type SyncRow = {
  shouldRegister: boolean;
  sourceFrom?: string;
  sourceSubject?: string;
  eventKey: string;
  sourceUid: number;
  action:
    | 'created'
    | 'would_create'
    | 'duplicate'
    | 'possible_duplicate'
    | 'previously_registered'
    | 'previously_deleted'
    | 'past'
    | 'skipped'
    | 'error';
  googleEventId?: string;
  reason?: string;
};
type FindRegistration = (event: SelectedEvent) => Promise<{ googleEventId?: string } | undefined>;

export async function syncCalendar(
  selection: Selection,
  port: CalendarPort,
  options: {
    apply: boolean;
    now?: () => Date;
    mailDetails?: boolean;
    findRegistration?: FindRegistration;
    checkpoint?: (rows: SyncRow[]) => Promise<void>;
  },
) {
  const rows: SyncRow[] = [];
  const withinBatch: GoogleEvent[] = [];
  const clock = options.now ?? (() => new Date());
  const total = selection.events.length;
  if (options.mailDetails === false) console.error(`カレンダー照合: 0/${total}件処理済み`);
  for (const selected of selection.events) {
    const row: SyncRow = {
      eventKey: selected.eventKey,
      sourceUid: selected.sourceUid,
      action: 'error',
      shouldRegister: false,
      sourceFrom: selected.sourceFrom,
      sourceSubject: selected.sourceSubject,
    };
    try {
      if (
        Date.parse(
          selected.payload.allDayDate
            ? selected.payload.end.dateTime
            : selected.payload.start.dateTime,
        ) <= clock().getTime()
      )
        row.action = 'past';
      else {
        const registration = await options.findRegistration?.(selected);
        const match = registration ? undefined : await findExisting(port, selected, withinBatch);
        if (registration) {
          row.action = 'previously_registered';
          row.googleEventId = registration.googleEventId;
          row.reason = 'このカレンダーへの登録履歴があるため再登録しない';
        } else if (match) {
          row.action = match.kind;
          row.googleEventId = match.event.id;
          row.reason = match.reason;
        } else if (
          Date.parse(
            selected.payload.allDayDate
              ? selected.payload.end.dateTime
              : selected.payload.start.dateTime,
          ) <= clock().getTime()
        )
          row.action = 'past';
        else if (!options.apply) {
          row.action = 'would_create';
          withinBatch.push({ ...selected.payload, id: googleEventId(selected.eventKey) });
        } else {
          try {
            const created = await port.insert({
              ...selected.payload,
              id: googleEventId(selected.eventKey),
            });
            row.action = 'created';
            row.googleEventId = created.id;
            withinBatch.push(created);
          } catch (error) {
            if (!(error instanceof CalendarApiError && error.status === 409)) throw error;
            const raced = await port.get(googleEventId(selected.eventKey));
            if (
              !raced ||
              (raced.status !== 'cancelled' &&
                raced.extendedProperties?.private?.sourceEventKey !== selected.eventKey)
            )
              throw error;
            row.action = raced.status === 'cancelled' ? 'previously_deleted' : 'duplicate';
            row.googleEventId = raced.id;
          }
        }
      }
    } catch (error) {
      row.action = 'error';
      row.reason =
        error instanceof CalendarApiError
          ? error.message
          : '予定の照合または登録に失敗しました。登録結果を再確認して再実行してください。';
    }
    row.shouldRegister = row.action === 'created' || row.action === 'would_create';
    row.reason ??= row.shouldRegister
      ? '未来の確定予定で、指定カレンダーに一致する既存予定なし'
      : row.action === 'past'
        ? '日時を過ぎているため登録しない'
        : row.action === 'previously_deleted'
          ? '以前削除された予定のため再登録しない'
          : '既存予定と一致するため重複登録しない';
    if (options.mailDetails !== false)
      console.error(
        `${row.shouldRegister ? '登録する' : '登録しない'}: ${mailLabel({ from: selected.sourceFrom ?? '', subject: selected.sourceSubject ?? selected.payload.summary, source: selected.source })} ｜ ${row.reason}`,
      );
    rows.push(row);
    if (options.checkpoint) await options.checkpoint(rows);
    if (options.mailDetails === false)
      console.error(`カレンダー照合: ${rows.length}/${total}件処理済み`);
  }
  return rows;
}

export async function syncCalendarToFile(
  selection: Selection,
  port: CalendarPort,
  options: {
    apply: boolean;
    calendarId: string;
    output: string;
    mailDetails?: boolean;
    findRegistration?: FindRegistration;
    checkpoint?: (rows: SyncRow[]) => Promise<void>;
  },
) {
  const target = resolve(options.output);
  await mkdir(dirname(target), { recursive: true });
  const start = new Date().toISOString();
  const write = async (rows: SyncRow[], complete: boolean) => {
    const result = {
      mode: options.apply ? 'apply' : 'dry-run',
      calendarId: options.calendarId,
      startedAt: start,
      sourceReportExecutedAt: selection.executedAt,
      complete,
      calendarWrites: rows.filter((r) => r.action === 'created').length,
      pastSkippedAtRead: selection.pastSkipped,
      repeatedSkipped: selection.repeatedSkipped,
      rows,
    };
    await writeFile(target, JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  };
  await write([], false);
  const rows = await syncCalendar(selection, port, {
    apply: options.apply,
    mailDetails: options.mailDetails,
    findRegistration: options.findRegistration,
    checkpoint: async (rows) => {
      await options.checkpoint?.(rows);
      await write(rows, false);
    },
  });
  const result = await write(
    rows,
    rows.every((r) => r.action !== 'error'),
  );
  return { ...result, output: target };
}
