import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectedMail, Collection } from '../src/collect.js';
import { inspectDatePresence } from '../src/date-presence.js';
import { writeDryRun } from '../src/dry-run.js';

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
  test(`日付のない後続通知を残す: ${text}`, () => {
    const result = inspectDatePresence(mail(text));
    assert.equal(result.hasDate, false);
    assert.equal(result.needsLifecycleCheck, true);
  });
}
test('日付がなければモデル情報取得・推論・キャッシュ参照を呼ばない', async (t) => {
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
    matched: 1,
    complete: true,
    messages: [mail('おすすめの新商品です')],
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
  assert.deepEqual(report.llm, {
    skippedNoDate: 1,
    lifecycleWithoutDate: 0,
    cacheHits: 0,
    requests: 0,
  });
});

test('日付のない取消通知はLLMで判定して取消状態を保持する', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'date-gate-test', digest: 'c'.repeat(64) }] });
    if (String(input).endsWith('/api/show')) return Response.json({ details: { format: 'gguf' } });
    calls++;
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            intent: 'cancelled',
            reason: '予約取消済み',
            evidence: '予約を取り消しました',
            references: ['REF123456'],
            events: [],
          }),
        },
        done: true,
      }) + '\n',
    );
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
    messages: [mail('予約を取り消しました。受付番号：REF123456')],
    errors: [],
  };
  const report = await writeDryRun(
    collection,
    directory,
    undefined,
    new Date('2026-11-18T00:00:00Z'),
    'date-gate-test',
  );
  assert.equal(calls, 1);
  assert.equal(report.messages[0]!.cancelled, true);
  assert.equal(report.messages[0]!.shouldRegister, false);
  assert.equal(report.llm.lifecycleWithoutDate, 1);
  assert.equal(report.llm.requests, 1);
});
