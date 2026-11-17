import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { OAuth2Client } from 'google-auth-library';
import { DateTime } from 'luxon';
import {
  googleEventId,
  type SelectedEvent,
  type Selection,
  type CalendarPayload,
} from './selection.js';

export type GoogleEvent = {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  iCalUID?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};
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
    return this.request<GoogleEvent>('POST', this.url, { sendUpdates: 'none' }, event);
  }
}

export type Match = {
  kind: 'duplicate' | 'possible_duplicate' | 'previously_deleted';
  event: GoogleEvent;
};
function normalizeTitle(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(\d+分\)/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

export function matchExisting(selected: SelectedEvent, existing: GoogleEvent[]): Match | null {
  const start = Date.parse(selected.payload.start.dateTime);
  const title = normalizeTitle(selected.payload.summary);
  const location = selected.payload.location.normalize('NFKC').replace(/\s/g, '');
  let possible: GoogleEvent | undefined;
  for (const event of existing) {
    const identity =
      event.id === googleEventId(selected.eventKey) ||
      event.extendedProperties?.private?.sourceEventKey === selected.eventKey ||
      event.iCalUID === selected.iCalUID;
    if (identity)
      return { kind: event.status === 'cancelled' ? 'previously_deleted' : 'duplicate', event };
    if (event.status === 'cancelled') continue;
    const otherTitle = normalizeTitle(event.summary ?? '');
    const otherStart = event.start?.dateTime ? Date.parse(event.start.dateTime) : NaN;
    const sameTitle = title === otherTitle && title.length > 0;
    const similarTitle =
      title.length >= 4 &&
      otherTitle.length >= 4 &&
      (title.includes(otherTitle) || otherTitle.includes(title));
    const sameLocation =
      location.length > 0 && event.location?.normalize('NFKC').replace(/\s/g, '') === location;
    if (otherStart === start && sameTitle) return { kind: 'duplicate', event };
    // Grokbot・手動登録でタイトルや時刻が少し異なるものを勝手に追加しない。
    if (
      otherStart === start ||
      (Math.abs(otherStart - start) <= 15 * 60_000 && (sameTitle || similarTitle || sameLocation))
    )
      possible = event;
    const localDate = DateTime.fromISO(selected.payload.start.dateTime, {
      setZone: true,
    }).toISODate();
    if (event.start?.date === localDate && (sameTitle || similarTitle)) possible = event;
  }
  return possible ? { kind: 'possible_duplicate', event: possible } : null;
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
  eventKey: string;
  sourceUid: number;
  action:
    | 'created'
    | 'would_create'
    | 'duplicate'
    | 'possible_duplicate'
    | 'previously_deleted'
    | 'past'
    | 'error';
  googleEventId?: string;
  reason?: string;
};
export async function syncCalendar(
  selection: Selection,
  port: CalendarPort,
  options: {
    apply: boolean;
    now?: () => Date;
    checkpoint?: (rows: SyncRow[]) => Promise<void>;
  },
) {
  const rows: SyncRow[] = [];
  const withinBatch: GoogleEvent[] = [];
  const clock = options.now ?? (() => new Date());
  for (const selected of selection.events) {
    const row: SyncRow = {
      eventKey: selected.eventKey,
      sourceUid: selected.sourceUid,
      action: 'error',
    };
    try {
      if (Date.parse(selected.payload.start.dateTime) <= clock().getTime()) row.action = 'past';
      else {
        const match = await findExisting(port, selected, withinBatch);
        if (match) {
          row.action = match.kind;
          row.googleEventId = match.event.id;
        } else if (Date.parse(selected.payload.start.dateTime) <= clock().getTime())
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
    rows.push(row);
    if (options.checkpoint) await options.checkpoint(rows);
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
    checkpoint: (rows) => write(rows, false).then(() => {}),
  });
  const result = await write(
    rows,
    rows.every((r) => r.action !== 'error'),
  );
  return { ...result, output: target };
}
