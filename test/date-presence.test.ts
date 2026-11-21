import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectedMail, Collection } from '../src/collect.js';
import { inspectDatePresence } from '../src/date-presence.js';
import { writeDryRun } from '../src/dry-run.js';
import { shortlistReason } from '../src/mail-shortlist.js';
import { filterCalendarMails } from '../src/mail-exclusions.js';

function mail(text: string, overrides: Partial<CollectedMail> = {}): CollectedMail {
  return {
    uid: 1,
    subject: 'お知らせ',
    from: 'notice@example.test',
    to: [],
    date: '2026-11-18T00:00:00Z',
    receivedAt: '2026-11-18T00:00:00Z',
    messageId: '<123456@example.test>',
    flags: [],
    attachments: [],
    calendarParts: [],
    text,
    ...overrides,
  };
}
for (const text of [
  '2026年11月25日 14時',
  '１１月２５日まで',
  '十一月二十五日',
  '令和八年十一月二十五日',
  '2026-11-25',
  '25/11/2026',
  '11/25',
  '明日提出',
  '明後日まで',
  '来週火曜に伺います',
  '金曜日の午後',
  '今月末までに更新',
  '3営業日以内に提出',
  '三日後に予約',
  '25日までに受取',
  'November 25, 2026',
  '25 Nov',
  'next Tuesday',
  'tomorrow morning',
  'within three business days',
  'end of this month',
  'by the 25th',
  'this evening',
]) {
  test(`日付候補を残す: ${text}`, () =>
    assert.equal(inspectDatePresence(mail(text)).hasDate, true));
}
for (const text of [
  'おすすめ商品のご紹介です。詳しくはこちら。',
  '受付番号 ABC123456',
  'https://example.test/2026/11/25/sale',
  'サイズ 100cm、価格 5000円',
  '最新情報をご覧ください。\n> 2026年11月25日 14:00 古い引用',
]) {
  test(`日付なしを検出: ${text.slice(0, 24)}`, () =>
    assert.equal(inspectDatePresence(mail(text)).hasDate, false));
}
test('受信日時だけでは日付ありにしない', () => {
  assert.equal(inspectDatePresence(mail('登録ありがとうございます')).hasDate, false);
});
test('件名の日付、HTML本文、転送本文、ICSを確認する', () => {
  assert.equal(inspectDatePresence(mail('詳細は後ほど', { subject: '明日の会議' })).hasDate, true);
  assert.equal(
    inspectDatePresence(mail('<html><body><p>2026年11月25日まで</p></body></html>')).hasDate,
    true,
  );
  assert.equal(
    inspectDatePresence(
      mail('> From: sender@example.test\n> Subject: 予約\n> \n> 来週火曜に伺います', {
        subject: 'Fw: 予約',
      }),
    ).hasDate,
    true,
  );
  assert.equal(
    inspectDatePresence(
      mail('添付をご覧ください', {
        calendarParts: [
          'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261125T090000Z\nEND:VEVENT\nEND:VCALENDAR',
        ],
      }),
    ).hasDate,
    true,
  );
});
test('長文の末尾にある日付を検出する', () => {
  assert.equal(
    inspectDatePresence(mail('お知らせ。'.repeat(6000) + '\n明日までに提出')).hasDate,
    true,
  );
});
for (const text of [
  '受取完了のお知らせ。注文番号 ABC123456',
  '予約を取り消しました',
  'Your booking was cancelled.',
  'Your documents have been submitted.',
]) {
  test(`後続通知の種類で日付の有無は変わらない: ${text}`, () => {
    const result = inspectDatePresence(mail(text));
    assert.equal(result.hasDate, false);
  });
}
test('事前選別は用途を問わず、具体的な未来の日付や相対日付とICSを残す', () => {
  const time = new Date('2026-11-21T08:28:00Z');
  for (const text of [
    '11月25日に検体の保管場所が切り替わります。',
    '2026年11月25日から全品セール。',
    '来週火曜に古い鍵を使えなくなります。',
    'within three business days',
  ]) {
    assert.ok(shortlistReason(mail(text), time), text);
  }
  assert.equal(shortlistReason(mail('対象月：2026年12月'), time), undefined);
  assert.equal(shortlistReason(mail('明日'), time), undefined);
  const event = mail('添付をご覧ください。', {
    calendarParts: ['BEGIN:VCALENDAR\r\nDTSTART;VALUE=DATE:20261125\r\nEND:VCALENDAR'],
  });
  assert.ok(shortlistReason(event, time));
});

test('事前選別は定型フッターだけの日付を省略し、本文・件名・紛らわしい行の日付を残す', () => {
  const time = new Date('2026-11-21T08:28:00Z');
  const body =
    'ご利用ありがとうございます。\nこのメールは定期のお知らせです。\n配信停止: https://example.test/stop\nサービス移行日: 2026年11月25日';
  assert.equal(shortlistReason(mail(body), time), undefined);
  assert.ok(shortlistReason(mail(body, { subject: '11月25日のお知らせ' }), time));
  assert.ok(shortlistReason(mail('11月25日にお越しください。\n' + body), time));
  assert.ok(
    shortlistReason(
      mail(
        body.replace(
          '配信停止: https://example.test/stop',
          '配信停止については担当者にご連絡ください。',
        ),
      ),
      time,
    ),
  );
  assert.ok(
    shortlistReason(mail(body.replace('配信停止:', '11月25日までに配信停止する場合:')), time),
  );
});

test('同じ除外パターンを件名にも本文にも適用する', () => {
  const sale = '期間限定セールは11月25日まで';
  const appointment = mail('11月25日14時の面談が確定しました。');
  const candidates = filterCalendarMails([mail('', { subject: sale }), appointment, mail(sale)]);
  assert.deepEqual(candidates, [appointment]);
});

test('販促の表現が一つでもあれば候補から外す', () => {
  const promotions = [
    'クーポンコードは11月25日まで有効です。',
    '11月25日開催のおすすめイベント情報',
    '11月25日までご応募いただけます。メールマガジンの配信停止はこちら。',
    'ご予約番号: TEST123456。無料トライアルは11月25日まで。',
    'Concerts are now on sale until November 25.',
  ];
  assert.deepEqual(filterCalendarMails(promotions.map((text) => mail(text))), []);
});

test('価格や期限を含む確定予定と本人の対応期限を残す', () => {
  const mails = [
    mail('お荷物を11月25日までにお受け取りください。期限を過ぎると返送します。'),
    mail('合計金額は1,500円です。支払日: 2026年12月1日', {
      subject: '領収書のお知らせ',
    }),
    mail('サービス終了日の11月25日までにデータをダウンロードしてください。'),
    mail('11月25日開催。参加が確定しました。参加費は無料です。'),
  ];
  assert.deepEqual(filterCalendarMails(mails), mails);
});

test('ICS付きのメールは販促語のチェックで候補から外さない', () => {
  const invite = mail('期間限定セールのお知らせ', {
    calendarParts: ['BEGIN:VCALENDAR'],
  });
  assert.deepEqual(filterCalendarMails([invite]), [invite]);
});

test('日時候補がないメールや販促メールはモデルを呼ばない', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Ollamaを呼んではいけません');
  });
  const directory = await mkdtemp(join(tmpdir(), 'calendar-date-gate-'));
  const collection: Collection = {
    version: 1,
    mailbox: 'INBOX',
    uidValidity: '1',
    since: '2026-10-01T00:00:00Z',
    collectedAt: '2026-11-18T00:00:00Z',
    matched: 3,
    complete: true,
    messages: [
      mail('商品情報のお知らせです'),
      mail('2026年11月15日 12:00に行われました。', { uid: 2 }),
      mail('11月25日まで全品割引。配信停止は設定から行えます。', {
        uid: 3,
        subject: '期間限定セール',
      }),
    ],
    errors: [],
  };
  const report = await writeDryRun(
    collection,
    directory,
    undefined,
    new Date('2026-11-18T00:00:00Z'),
    'unused-model',
  );
  assert.equal(report.complete, true);
  assert.equal(report.messages[0]!.shouldRegister, false);
  assert.equal(report.messages[0]!.decision, 'excluded');
  assert.match(report.messages[0]!.reasons.join(' '), /日付情報なし/);
  assert.equal(report.messages[1]!.shouldRegister, false);
  assert.match(report.messages[1]!.reasons.join(' '), /今後の日時候補を確認できない/);
  assert.equal(report.messages[2]!.shouldRegister, false);
  assert.equal(report.messages[2]!.decision, 'excluded');
  assert.deepEqual(report.messages[2]!.reasons, []);
  assert.deepEqual(report.llm, {
    skippedNoDate: 1,
    skippedByShortlist: 1,
    skippedOptionalMail: 1,
    cacheHits: 0,
    requests: 0,
    batchRequests: 0,
    uncachedMails: 0,
  });
});

test('日付のない明示的な取消通知は推論せず取消状態を保持する', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected LLM request');
  });
  const directory = await mkdtemp(join(tmpdir(), 'calendar-undated-cancel-'));
  const collection: Collection = {
    version: 1,
    mailbox: 'INBOX',
    uidValidity: '1',
    since: '2026-10-01T00:00:00Z',
    collectedAt: '2026-11-18T00:00:00Z',
    matched: 1,
    complete: true,
    messages: [mail('受付番号：REF123456', { subject: 'ご予約をキャンセルしました' })],
    errors: [],
  };
  const report = await writeDryRun(
    collection,
    directory,
    undefined,
    new Date('2026-11-18T00:00:00Z'),
    'date-gate-test',
  );
  assert.equal(report.messages[0]!.cancelled, true);
  assert.equal(report.messages[0]!.shouldRegister, false);
  assert.equal(report.llm.requests, 0);
  assert.equal(report.complete, true);
});
