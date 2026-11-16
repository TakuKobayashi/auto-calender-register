import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyAll, classifyMail, parseSince } from '../src/classify.js';
import { applyExistingEvents, writeDryRun } from '../src/dry-run.js';
import { listSinceMail, parseMail } from '../src/mail.js';
import type { CollectedMail, Collection } from '../src/collect.js';
import type { ImapFlow } from 'imapflow';

const now = new Date('2026-11-16T07:00:00Z');
function mail(overrides: Partial<CollectedMail> = {}): CollectedMail {
  return {
    uid: 10,
    subject: 'お申し込み完了のお知らせ',
    from: 'Support <support@example.com>',
    to: ['user@example.net'],
    messageId: '<test@example.com>',
    date: '2026-10-10T00:00:00Z',
    receivedAt: '2026-10-10T00:00:00Z',
    flags: [],
    size: 1000,
    attachments: [],
    calendarParts: [],
    text: '■サンプル試験(90分)\n受験日:2026年11月30日(月)\n試験開始時刻:18:00\nテストセンター住所:東京都港区1-1-1',
    ...overrides,
  };
}
function ics(start = 'DTSTART:20261130T090000Z', extra = '') {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test-event@example.com\r\nDTSTAMP:20261001T000000Z\r\nSUMMARY:Test event\r\n${start}\r\nDTEND:20261130T100000Z\r\n${extra}END:VEVENT\r\nEND:VCALENDAR`;
}

test('日本時間の10/1 00:00をUTCに正しく変換し、不正日付を拒否', () => {
  assert.equal(parseSince('2026-10-01').toISOString(), '2026-09-30T15:00:00.000Z');
  for (const value of ['2026-02-30', '2026-10-01T00:00Z', '10/1'])
    assert.throws(() => parseSince(value));
});

test('受信日検索はINTERNALDATEを使用し、境界直前のメールを除外', async () => {
  const since = parseSince('2026-10-01');
  const client = {
    search: async () => [1, 2],
    fetchAll: async (_range: unknown, _query: unknown, options: { uid: boolean }) => {
      assert.equal(options.uid, true);
      return [
        { uid: 1, internalDate: new Date(since.getTime() - 1) },
        { uid: 2, internalDate: since },
      ];
    },
  } as unknown as ImapFlow;
  assert.deepEqual(
    (await listSinceMail(client, since)).map((m) => m.uid),
    [2],
  );
});

test('国内会場・別行の日時・科目別試験時間を解析し、期限や営業時間を拾わない', () => {
  const result = classifyMail(
    mail({ text: mail().text + '\n予約変更は2026年11月27日 23:59まで\nサポート時間:8:30～17:30' }),
    now,
  );
  assert.equal(result.decision, 'candidate');
  assert.equal(result.events.length, 1);
  const event = result.events[0]!;
  assert.equal(event.start, '2026-11-30T18:00:00.000+09:00');
  assert.equal(event.end, '2026-11-30T19:30:00.000+09:00');
  assert.equal(event.payload?.start.timeZone, 'Asia/Tokyo');
});

test('開始が実行日時と同じ場合も対象外', () => {
  const result = classifyMail(mail(), new Date('2026-11-30T09:00:00Z'));
  assert.equal(result.decision, 'excluded');
  assert.equal(result.events[0]?.payload, undefined);
});

test('国内住所も明示タイムゾーンもなければ日本語でも要確認', () => {
  const result = classifyMail(mail({ text: '開催日時:2026年11月30日 18:00～19:00' }), now);
  assert.equal(result.decision, 'review');
  assert.equal(result.events[0]?.start, null);
});

test('年・終了時刻の欠落を推測で補わない', () => {
  const missingYear = classifyMail(mail({ text: '開催日時:11月30日 18:00～19:00 JST' }), now);
  assert.equal(missingYear.decision, 'review');
  const missingEnd = classifyMail(
    mail({ text: '受験日時:2026年11月30日 18:00\nテストセンター住所:東京都港区1-1-1' }),
    now,
  );
  assert.equal(missingEnd.events[0]?.start, '2026-11-30T18:00:00.000+09:00');
  assert.equal(missingEnd.decision, 'review');
});

test('祝日の曜日表記があっても時刻範囲を解析', () => {
  const result = classifyMail(
    mail({ text: '開催日時:2026年11月23日(月・祝) 10:00～19:00\n日本時間' }),
    now,
  );
  assert.equal(result.events[0]?.start, '2026-11-23T10:00:00.000+09:00');
  assert.equal(result.events[0]?.end, '2026-11-23T19:00:00.000+09:00');
});

test('海外の明示UTCオフセットを日本時間に置き換えない', () => {
  const result = classifyMail(
    mail({ subject: 'Booking confirmation', text: 'Date: November 30, 2026 14:00 to 15:00 PST' }),
    now,
  );
  assert.equal(result.decision, 'candidate');
  assert.equal(new Date(result.events[0]!.start!).toISOString(), '2026-11-30T22:00:00.000Z');
});

test('夏時間の重複時刻・存在しない時刻は要確認', () => {
  for (const text of [
    'Date: November 1, 2026 01:30 to 02:30 America/New_York',
    'Date: March 8, 2026 02:30 to 03:30 America/New_York',
  ]) {
    const result = classifyMail(
      mail({ subject: 'Booking confirmation', text }),
      new Date('2026-01-01T00:00:00Z'),
    );
    assert.equal(result.decision, 'review');
  }
});

test('未申込の広告は未来の日時があっても登録しない', () => {
  const result = classifyMail(
    mail({ subject: '無料セミナーのご案内', text: '開催日時:2026年11月30日 18:00～19:00 JST' }),
    now,
  );
  assert.equal(result.decision, 'excluded');
});

test('引用された古い予約内容を現行の予定として抽出しない', () => {
  const result = classifyMail(
    mail({ text: '現在調整中です。\n> 開催日時:2026年11月30日 18:00～19:00 JST' }),
    now,
  );
  assert.equal(result.events.length, 0);
});

test('確定済みICSのUTC日時を抽出し、floatingや繰り返しは保留', () => {
  assert.equal(classifyMail(mail({ calendarParts: [ics()] }), now).decision, 'candidate');
  assert.equal(
    classifyMail(mail({ calendarParts: [ics('DTSTART:20261130T090000')] }), now).decision,
    'review',
  );
  assert.equal(
    classifyMail(mail({ calendarParts: [ics(undefined, 'RRULE:FREQ=WEEKLY\r\n')] }), now).decision,
    'review',
  );
});

test('ICS取消を後から受け取ったら元の予定を重複として除き、登録案を作らない', () => {
  const plans = classifyAll(
    [
      mail({ calendarParts: [ics()] }),
      mail({
        uid: 11,
        subject: '予約キャンセルの確認',
        receivedAt: '2026-10-11T00:00:00Z',
        calendarParts: [ics(undefined, 'SEQUENCE:1\r\nSTATUS:CANCELLED\r\n')],
      }),
    ],
    now,
  );
  assert.equal(plans[0]?.decision, 'duplicate');
  assert.equal(plans[1]?.decision, 'excluded');
  assert.equal(
    plans.flatMap((p) => p.events).some((e) => e.payload),
    false,
  );
});

test('同じ予約番号の後続キャンセルを本文予定にも反映', () => {
  const plans = classifyAll(
    [
      mail({ text: '予約番号:ABC12345\n' + mail().text }),
      mail({ uid: 11, subject: '予約キャンセルの確認', text: '予約番号:ABC12345' }),
    ],
    now,
  );
  assert.equal(plans[0]?.decision, 'excluded');
  assert.equal(plans[0]?.events[0]?.payload, undefined);
});

test('住所省略のリマインダーは予約番号と予定名・現地日時で元メールと照合', () => {
  const plans = classifyAll(
    [
      mail({ text: '受付番号:ABC12345\n' + mail().text }),
      mail({
        uid: 11,
        text: '受付番号:ABC12345\n■サンプル試験(90分)\n受験日:2026年11月30日\n試験開始時刻:18:00',
        receivedAt: '2026-10-11T00:00:00Z',
      }),
    ],
    now,
  );
  assert.equal(plans[0]?.decision, 'candidate');
  assert.equal(plans[1]?.decision, 'duplicate');
});

test('既存Google予定JSONと開始UTC・件名が一致すれば登録案を除外', () => {
  const plans = classifyAll([mail()], now);
  const event = plans[0]!.events[0]!;
  applyExistingEvents(plans, [
    { id: 'existing', summary: event.title, start: { dateTime: '2026-11-30T09:00:00Z' } },
  ]);
  assert.equal(plans[0]?.decision, 'duplicate');
  assert.equal(event.payload, undefined);
});

test('dry-runは未接続を明示し、不完全な取得結果を成功扱いしない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-dry-run-'));
  try {
    const collection: Collection = {
      version: 1,
      mailbox: 'INBOX',
      uidValidity: '1',
      since: parseSince('2026-10-01').toISOString(),
      collectedAt: now.toISOString(),
      matched: 1,
      complete: false,
      messages: [mail()],
      errors: [],
    };
    const report = await writeDryRun(collection, directory, undefined, now);
    assert.equal(report.calendarWrites, 0);
    assert.equal(report.complete, false);
    assert.equal(report.proposed[0]?.operation, 'pending_calendar_duplicate_check');
    assert.match(await readFile(join(directory, 'dry-run.md'), 'utf8'), /未接続・未確認/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('空のtext/plainが併存するHTMLメールでも本文を復元', async () => {
  const parsed = await parseMail(
    Buffer.from(
      [
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="test"',
        '',
        '--test',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '',
        '--test',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>予約内容: Meeting</p>',
        '--test--',
        '',
      ].join('\r\n'),
    ),
  );
  assert.match(parsed.text, /Meeting/);
});
