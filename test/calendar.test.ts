import assert from 'node:assert/strict';
import test from 'node:test';
import * as ical from 'node-ical';
import type { OAuth2Client } from 'google-auth-library';
import {
  validateSelection,
  googleEventId,
  type SelectedEvent,
  type Selection,
} from '../src/selection.js';
import { createIcs } from '../src/ics.js';
import {
  CalendarApiError,
  GoogleCalendar,
  matchExisting,
  syncCalendar,
  type CalendarPort,
  type GoogleEvent,
} from '../src/google-calendar.js';
import { readOllamaChat } from '../src/ollama.js';

const now = new Date('2026-11-16T00:00:00Z');
function selected(): SelectedEvent {
  const key = 'a'.repeat(64);
  return {
    sourceUid: 1,
    eventKey: key,
    iCalUID: `${key}@auto-calendar-register.local`,
    payload: {
      summary: '試験',
      location: '東京都の試験会場',
      description: '元メールの根拠',
      start: { dateTime: '2026-11-30T18:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-11-30T20:30:00+09:00', timeZone: 'Asia/Tokyo' },
      extendedProperties: { private: { sourceEventKey: key } },
    },
  };
}
function report() {
  const e = selected();
  return {
    schemaVersion: 1,
    mode: 'dry-run',
    complete: true,
    executedAt: now.toISOString(),
    proposed: [{ sourceUid: e.sourceUid, eventKey: e.eventKey, payload: e.payload }],
    messages: [
      {
        uid: 1,
        decision: 'candidate',
        events: [
          { decision: 'candidate', eventKey: e.eventKey, payload: structuredClone(e.payload) },
        ],
      },
    ],
  };
}
const selection = (): Selection => ({
  executedAt: now.toISOString(),
  events: [selected()],
  pastSkipped: 0,
  repeatedSkipped: 0,
});
class MemoryCalendar implements CalendarPort {
  events: GoogleEvent[] = [];
  inserts = 0;
  async get(id: string) {
    return this.events.find((e) => e.id === id) ?? null;
  }
  async list() {
    return this.events;
  }
  async insert(event: GoogleEvent) {
    this.inserts++;
    this.events.push(event);
    return event;
  }
}

test('candidateとpayloadの一致を確認し、過去・同じキーの重複を除外', () => {
  const raw = report();
  raw.proposed.push(structuredClone(raw.proposed[0]!));
  assert.equal(validateSelection(raw, now).events.length, 1);
  assert.equal(validateSelection(raw, now).repeatedSkipped, 1);
  assert.equal(validateSelection(raw, new Date('2026-12-01')).pastSkipped, 2);
});

test('未完了・未確定・改変されたpayload・不正日時を登録前に拒否', () => {
  const incomplete = report();
  incomplete.complete = false;
  assert.throws(() => validateSelection(incomplete, now));
  const pending = report();
  pending.messages[0]!.decision = 'pending';
  assert.throws(() => validateSelection(pending, now));
  const tampered = report();
  tampered.proposed[0]!.payload.summary = '別の予定';
  assert.throws(() => validateSelection(tampered, now));
  const invalid = report();
  invalid.proposed[0]!.payload.start.dateTime = '2026-11-30T18:00:00';
  invalid.messages[0]!.events[0]!.payload.start.dateTime = '2026-11-30T18:00:00';
  assert.throws(() => validateSelection(invalid, now));
});

test('attendees等の余分なフィールドをGoogle登録payloadへ流さない', () => {
  const raw = report();
  Object.assign(raw.proposed[0]!.payload, { attendees: [{ email: 'other@example.com' }] });
  Object.assign(raw.messages[0]!.events[0]!.payload, {
    attendees: [{ email: 'other@example.com' }],
  });
  assert.equal('attendees' in validateSelection(raw, now).events[0]!.payload, false);
});

test('ICSは日本語・改行・カンマ・セミコロン・逆スラッシュを往復できる', () => {
  const event = selected();
  event.payload.summary = '日本語の長い予定'.repeat(12);
  event.payload.description = '改行\nカンマ, セミコロン; 逆スラッシュ\\ 絵文字😀';
  const text = createIcs([event], now);
  for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
  const parsed = Object.values(ical.sync.parseICS(text)).find(
    (e): e is ical.VEvent => e?.type === 'VEVENT',
  )!;
  assert.equal(parsed.summary, event.payload.summary);
  assert.equal(parsed.description, event.payload.description);
  assert.equal(parsed.uid, event.iCalUID);
  assert.equal(parsed.start.toISOString(), '2026-11-30T09:00:00.000Z');
  assert.equal(parsed.end?.toISOString(), '2026-11-30T11:30:00.000Z');
});

test('ICS UIDは再出力しても安定し、海外オフセットも同じ瞬間に変換', () => {
  const event = selected();
  event.payload.start = { dateTime: '2026-11-30T10:00:00-05:00' };
  event.payload.end = { dateTime: '2026-11-30T11:00:00-05:00' };
  const first = createIcs([event], now),
    second = createIcs([event], new Date(now.getTime() + 1000));
  assert.equal(first.match(/UID:([^\r]+)/)?.[1], second.match(/UID:([^\r]+)/)?.[1]);
  assert.match(first, /DTSTART:20261130T150000Z/);
});

test('GoogleイベントIDはbase32hex互換で同じ予定に対して安定', () => {
  assert.match(googleEventId(selected().eventKey), /^[a-v0-9]{5,1024}$/);
  assert.equal(googleEventId(selected().eventKey), googleEventId(selected().eventKey));
});

test('Google照合dry-runでは書き込まず、apply後の再実行は重複として除外', async () => {
  const port = new MemoryCalendar();
  assert.equal(
    (await syncCalendar(selection(), port, { apply: false, now: () => now }))[0]?.action,
    'would_create',
  );
  assert.equal(port.inserts, 0);
  assert.equal(
    (await syncCalendar(selection(), port, { apply: true, now: () => now }))[0]?.action,
    'created',
  );
  assert.equal(
    (await syncCalendar(selection(), port, { apply: true, now: () => now }))[0]?.action,
    'duplicate',
  );
  assert.equal(port.inserts, 1);
});

test('Grokbot等の既存予定とタイトル・UTC開始日時が一致すれば登録しない', async () => {
  const port = new MemoryCalendar();
  port.events = [
    { id: 'grok-created', summary: '試験', start: { dateTime: '2026-11-30T09:00:00Z' } },
  ];
  assert.equal(
    (await syncCalendar(selection(), port, { apply: true, now: () => now }))[0]?.action,
    'duplicate',
  );
  assert.equal(port.inserts, 0);
});

test('タイトルが違っても同時刻の既存予定は重複の疑いとして保留', async () => {
  const port = new MemoryCalendar();
  port.events = [
    { id: 'existing', summary: '別のタイトル', start: { dateTime: '2026-11-30T09:00:00Z' } },
  ];
  assert.equal(
    (await syncCalendar(selection(), port, { apply: true, now: () => now }))[0]?.action,
    'possible_duplicate',
  );
  assert.equal(port.inserts, 0);
});

test('カレンダー上で削除済みの管理予定は復活させない', async () => {
  const port = new MemoryCalendar();
  port.events = [{ id: googleEventId(selected().eventKey), status: 'cancelled' }];
  assert.equal(
    (await syncCalendar(selection(), port, { apply: true, now: () => now }))[0]?.action,
    'previously_deleted',
  );
  assert.equal(port.inserts, 0);
});

test('照合中に予定開始時刻を過ぎたら直前の再確認で登録を止める', async () => {
  const port = new MemoryCalendar();
  let calls = 0;
  const rows = await syncCalendar(selection(), port, {
    apply: true,
    now: () => (++calls === 1 ? now : new Date('2026-12-01')),
  });
  assert.equal(rows[0]?.action, 'past');
  assert.equal(port.inserts, 0);
});

test('403等の照合失敗時は登録せず、認証情報をエラーへ含めない', async () => {
  const port = new MemoryCalendar();
  port.list = async () => {
    throw new CalendarApiError(403);
  };
  const rows = await syncCalendar(selection(), port, { apply: true, now: () => now });
  assert.equal(rows[0]?.action, 'error');
  assert.equal(port.inserts, 0);
});

test('同時登録で409になった場合は既存IDを確認し、二重登録しない', async () => {
  const port = new MemoryCalendar();
  port.insert = async (event) => {
    port.events.push(event);
    throw new CalendarApiError(409);
  };
  assert.equal(
    (await syncCalendar(selection(), port, { apply: true, now: () => now }))[0]?.action,
    'duplicate',
  );
});

test('ICSインポート済み・終日予定も既存予定の照合対象', () => {
  assert.equal(
    matchExisting(selected(), [{ id: 'imported', iCalUID: selected().iCalUID }])?.kind,
    'duplicate',
  );
  assert.equal(
    matchExisting(selected(), [{ summary: '試験', start: { date: '2026-11-30' } }])?.kind,
    'possible_duplicate',
  );
});

test('Google APIアダプターは全ページを取得し、カレンダーIDをエスケープ', async () => {
  const requests: any[] = [];
  const auth = {
    request: async (options: any) => {
      requests.push(options);
      return {
        data:
          requests.length === 1
            ? { items: [{ id: 'first' }], nextPageToken: 'next' }
            : { items: [{ id: 'second' }] },
      };
    },
  } as unknown as OAuth2Client;
  const api = new GoogleCalendar(auth, 'user+calendar@example.com');
  const events = await api.list({ timeMin: now.toISOString() });
  assert.deepEqual(
    events.map((e) => e.id),
    ['first', 'second'],
  );
  assert.equal(requests[1].params.pageToken, 'next');
  assert.match(requests[0].url, /user%2Bcalendar%40example.com/);
  assert.equal(requests[0].params.singleEvents, true);
});

test('APIのPOSTは固定IDとsendUpdates=noneで実行', async () => {
  let captured: any;
  const auth = {
    request: async (options: any) => {
      captured = options;
      return { data: options.data };
    },
  } as unknown as OAuth2Client;
  await new GoogleCalendar(auth, 'primary').insert({
    ...selected().payload,
    id: googleEventId(selected().eventKey),
  });
  assert.equal(captured.method, 'POST');
  assert.equal(captured.params.sendUpdates, 'none');
  assert.equal(captured.data.id, googleEventId(selected().eventKey));
});

test('Ollamaストリームの分割された日本語JSONを最後まで復元', async () => {
  const data = new TextEncoder().encode(
    [
      JSON.stringify({ message: { content: '{"title":"予定' } }),
      JSON.stringify({ message: { content: '"}' }, done: true, done_reason: 'stop' }),
    ].join('\n'),
  );
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += 7) controller.enqueue(data.slice(i, i + 7));
      controller.close();
    },
  });
  assert.equal(await readOllamaChat(new Response(stream)), '{"title":"予定"}');
});

test('Ollama応答の途中切断・出力上限を成功扱いしない', async () => {
  await assert.rejects(readOllamaChat(new Response('{"message":{"content":"{}"}}\n')), /途中/);
  await assert.rejects(
    readOllamaChat(new Response('{"done":true,"done_reason":"length"}\n')),
    /上限/,
  );
});
