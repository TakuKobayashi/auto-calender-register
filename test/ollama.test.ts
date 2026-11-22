import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMail, finalize } from '../src/classify.js';
import type { CollectedMail, Collection } from '../src/collect.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dateSupported,
  extractionCacheKey,
  localModelDigest,
  extractionToPlan,
  modelText,
  unwrapForward,
  validateExtraction,
  type Extraction,
} from '../src/ollama.js';
import { filterGmailForwards, matchOriginal } from '../src/forward-audit.js';
import { reconcileModelPlan, writeDryRun } from '../src/dry-run.js';

const now = new Date('2026-11-16T00:00:00Z');

function collection(message: CollectedMail): Collection {
  return {
    version: 1,
    mailbox: 'INBOX',
    uidValidity: '1',
    since: '2026-10-01T00:00:00Z',
    collectedAt: now.toISOString(),
    matched: 1,
    complete: true,
    messages: [message],
    errors: [],
  };
}

test('長すぎる本文は推論せず要確認とし、候補を作らず処理を完了する', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('長文をOllamaへ送信してはいけません');
  });
  const directory = await mkdtemp(join(tmpdir(), 'calendar-long-mail-'));
  const result = await writeDryRun(
    collection(mail({ text: '予約が確定しました。2026年11月20日 15:00\n' + '本文'.repeat(13000) })),
    directory,
    undefined,
    now,
    'unused-model',
  );
  assert.equal(result.complete, true);
  assert.equal(result.summary.review, 1);
  assert.equal(result.summary.error, 0);
  assert.equal(result.proposed.length, 0);
  assert.match(result.messages[0]!.reasons.join(' '), /上限24000文字/);
});

test('LLMタイムアウトは理由を保存し、未完了のまま登録を止める', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'timeout-test', digest: 'a'.repeat(64) }] });
    if (String(input).endsWith('/api/show')) return Response.json({ details: { format: 'gguf' } });
    throw new DOMException('timeout', 'TimeoutError');
  });
  const directory = await mkdtemp(join(tmpdir(), 'calendar-timeout-'));
  const result = await writeDryRun(
    collection(mail()),
    directory,
    undefined,
    now,
    'timeout-test',
    undefined,
    { mailDetails: false },
  );
  assert.equal(result.complete, false);
  assert.equal(result.summary.error, 1);
  assert.equal(result.proposed.length, 0);
  assert.deepEqual(
    logs.mock.calls.map((call) => call.arguments[0]),
    [
      'メール選別: 0/1件処理済み',
      'メール選別: 0/1件処理済み（1件目をLLMで判定中）',
      'メール選別: 1/1件処理済み',
    ],
  );
  assert.match(result.messages[0]!.reasons.join(' '), /制限時間/);
  assert.match(await readFile(join(directory, 'dry-run.md'), 'utf8'), /処理エラー[\s\S]*制限時間/);
});

test('モデル更新でdigestが変われば、同じモデル名とメールでも抽出キャッシュを更新する', () => {
  const original = extractionCacheKey(mail(), 'model', 'a'.repeat(64));
  assert.equal(extractionCacheKey(mail({ flags: ['\\Seen'] }), 'model', 'a'.repeat(64)), original);
  assert.notEqual(extractionCacheKey(mail(), 'model', 'b'.repeat(64)), original);
});

test('digest未取得・クラウドモデルでは保存済みの抽出結果も利用しない', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: 'missing-digest' }, { name: 'remote-model', digest: 'a'.repeat(64) }],
      });
    return Response.json({ remote_host: 'https://example.com', details: { format: 'gguf' } });
  });
  await assert.rejects(localModelDigest('missing-digest'), /digest/);
  await assert.rejects(localModelDigest('remote-model'), /クラウド/);
});
function mail(overrides: Partial<CollectedMail> = {}): CollectedMail {
  return {
    uid: 1,
    subject: '予約確認',
    from: 'hotel@example.com',
    to: ['user@yahoo.co.jp'],
    date: '2026-10-02T00:00:00Z',
    receivedAt: '2026-10-02T00:00:00Z',
    messageId: '<original@example.com>',
    flags: [],
    size: 1000,
    attachments: [],
    calendarParts: [],
    text: '予約が確定しました。\nチェックイン:2026年11月20日 15:00\nチェックアウト:2026年11月21日 10:00\n所在地:東京都港区1-1-1',
    ...overrides,
  };
}
function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    intent: 'confirmed',
    reason: '予約が確定済み',
    evidence: '予約が確定しました。',
    events: [
      {
        title: 'ホテル宿泊',
        startLocal: '2026-11-20T15:00:00',
        endLocal: '2026-11-21T10:00:00',
        startZone: 'Asia/Tokyo',
        endZone: 'Asia/Tokyo',
        location: '東京都港区1-1-1',
        startEvidence: '2026年11月20日 15:00',
        endEvidence: '2026年11月21日 10:00',
        zoneEvidence: '所在地:東京都港区1-1-1',
        confirmationEvidence: '予約が確定しました。',
      },
    ],
    ...overrides,
  };
}

test('転送の外側の引用だけを除き、元メールの過去返信引用は保持', () => {
  const forwarded = mail({
    subject: 'Fw: 予約確認',
    from: 'owner@yahoo.co.jp',
    to: ['owner@gmail.com'],
    text: '> ----- 転送メッセージ -----\n> From: hotel@example.com\n> To: owner@yahoo.co.jp\n> 件名:予約確認\n> \n> 予約が確定しました。\n> > 古い引用です',
  });
  const unwrapped = unwrapForward(forwarded);
  assert.equal(unwrapped.from, 'hotel@example.com');
  assert.equal(unwrapped.subject, '予約確認');
  assert.match(modelText(forwarded), /予約が確定しました/);
  assert.doesNotMatch(modelText(forwarded), /古い引用/);
});

test('転送された事実を確定根拠にしない。LLMが確定と言っても明示の未確定を優先', () => {
  const pending = mail({ text: '予約はまだ確定ではありません。\n' + mail().text });
  assert.equal(classifyMail(pending, now).decision, 'pending');
  const result = extractionToPlan(pending, extraction(), now, finalize);
  assert.equal(result.decision, 'pending');
  assert.equal(result.events.length, 0);
});

test('pendingからconfirmedの通知が来たときだけ候補にできる', () => {
  assert.equal(
    extractionToPlan(mail(), extraction({ intent: 'pending' }), now, finalize).decision,
    'pending',
  );
  assert.equal(extractionToPlan(mail(), extraction(), now, finalize).decision, 'candidate');
});

test('予定日時・会場・確定の引用が正しければ登録用payloadを生成', () => {
  const original = mail();
  const modelResult = extraction();
  modelResult.events[0]!.calendarDetails = [
    '受付で身分証を提示してください。',
    '朝食は無料です。',
    '受取コード：123456',
  ];
  const result = extractionToPlan(
    { ...original, text: original.text + '\n受付で身分証を提示してください。\n受取コード：123456' },
    validateExtraction(modelResult),
    now,
    finalize,
  );
  assert.equal(result.events[0]?.payload?.start.dateTime, '2026-11-20T15:00:00.000+09:00');
  assert.equal(result.events[0]?.payload?.end.dateTime, '2026-11-21T10:00:00.000+09:00');
  const description = result.events[0]!.payload!.description;
  assert.equal(description, '受付で身分証を提示してください。');
});

test('メールは1通ずつ判定し、カレンダー本文には原文にある実用情報だけを載せる', async (t) => {
  const hotel = mail({
    text:
      mail().text + '\n予約番号: 1793129809 (支払済: ¥6,402)\n施設連絡先: frontdesk@example.com',
  });
  const notice = mail({
    uid: 2,
    subject: '定期案内',
    text: '2026年11月20日 15:00 にお知らせを掲載します。',
  });
  const modelResult = extraction({ references: ['1793129809'] });
  modelResult.events[0]!.calendarNotes = [
    {
      text: '予約ID：1793129809（支払済 ¥6,402）',
      evidence: '予約番号: 1793129809 (支払済: ¥6,402)',
    },
    {
      text: 'チェックイン：11/20 15:00',
      evidence: 'チェックイン:2026年11月20日 15:00',
    },
    {
      text: 'チェックイン: 11/20 15:00',
      evidence: 'チェックイン:2026年11月20日 15:00',
    },
    {
      text: '施設連絡先：frontdesk@example.com',
      evidence: '施設連絡先: frontdesk@example.com',
    },
    { text: '朝食付き', evidence: '無料の朝食をご用意しています' },
  ];
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'calendar-notes-test', digest: 'a'.repeat(64) }] });
    if (String(input).endsWith('/api/show')) return Response.json({ details: { format: 'gguf' } });
    assert.ok(String(input).endsWith('/api/chat'));
    const request = JSON.parse(String(init?.body));
    const payload = JSON.parse(request.messages.at(-1).content);
    assert.equal(payload.mails, undefined);
    calls.push(payload.subject);
    const reply =
      payload.subject === hotel.subject
        ? modelResult
        : extraction({ intent: 'not_event', events: [] });
    return new Response(
      JSON.stringify({ message: { content: JSON.stringify(reply) }, done: true }) + '\n',
    );
  });
  const directory = await mkdtemp(join(tmpdir(), 'calendar-notes-'));
  const report = await writeDryRun(
    { ...collection(hotel), messages: [hotel, notice], matched: 2 },
    directory,
    undefined,
    now,
    'calendar-notes-test',
  );
  assert.equal(report.complete, true);
  assert.deepEqual(calls, [hotel.subject, notice.subject]);
  assert.equal(report.llm.requests, 2);
  assert.equal(report.proposed.length, 1);
  assert.equal(
    report.proposed[0]!.payload!.description,
    [
      '予約ID：1793129809（支払済 ¥6,402）',
      'チェックイン：11/20 15:00',
      '施設連絡先：frontdesk@example.com',
    ].join('\n'),
  );
});

test('モデルが日付を捏造しても原文との照合で保留', () => {
  const e = extraction();
  e.events[0]!.startLocal = '2026-11-22T15:00:00';
  assert.equal(extractionToPlan(mail(), e, now, finalize).decision, 'review');
});

test('オンライン予定には元メールの参加相手と会議リンクを載せる', () => {
  const original = mail({
    subject: 'オンライン面接が確定しました',
    text: [
      '面接が確定しました。',
      '日時：2026年11月20日 15:00–15:45（日本時間）',
      '',
      '参加者',
      '',
      '応募者 user@yahoo.co.jp',
      '採用担当 reviewer@example.com',
      '',
      'Web会議',
      'URL: https://meet.google.com/abc-defg-hij',
      '日程の変更：https://schedule.example.com/manage',
      '> 前回の会議 https://meet.google.com/xyz-abcd-efg',
    ].join('\n'),
  });
  const result = extraction();
  Object.assign(result.events[0]!, {
    title: 'オンライン面接',
    endLocal: '2026-11-20T15:45:00',
    location: '',
    startEvidence: '2026年11月20日 15:00–15:45',
    endEvidence: '2026年11月20日 15:00–15:45',
    zoneEvidence: '日本時間',
    confirmationEvidence: '面接が確定しました。',
    calendarNotes: [
      { text: '11/20 15:00–15:45（日本時間）', evidence: '2026年11月20日 15:00–15:45（日本時間）' },
    ],
  });
  const event = extractionToPlan(original, result, now, finalize).events[0]!;
  assert.equal(event.decision, 'candidate');
  assert.equal(
    event.payload?.description,
    [
      '11/20 15:00–15:45（日本時間）',
      '参加相手：採用担当',
      '参加リンク：https://meet.google.com/abc-defg-hij',
    ].join('\n'),
  );
  assert.doesNotMatch(modelText(original), /meet\.google\.com/);

  const ambiguous = {
    ...original,
    text: '別の参加リンク: https://example.zoom.us/j/123456789\n' + original.text,
  };
  const ambiguousEvent = extractionToPlan(ambiguous, result, now, finalize).events[0]!;
  assert.equal(ambiguousEvent.payload?.description, '11/20 15:00–15:45（日本時間）');
});

test('IANA名だけを引用したふりにしても本文に存在しなければ保留', () => {
  const e = extraction();
  e.events[0]!.zoneEvidence = 'Asia/Tokyo';
  assert.equal(extractionToPlan(mail(), e, now, finalize).decision, 'review');
});

test('海外の都市を引用して日本時間を出力しても保留', () => {
  const e = extraction();
  e.events[0]!.zoneEvidence = '所在地:プラハ';
  assert.equal(
    extractionToPlan(
      mail({ text: mail().text.replace('所在地:東京都港区1-1-1', '所在地:プラハ') }),
      e,
      now,
      finalize,
    ).decision,
    'review',
  );
});

test('過去の予定を正しく抽出できても現在の登録候補にはしない', () => {
  assert.equal(
    extractionToPlan(mail(), extraction(), new Date('2026-12-01T00:00:00Z'), finalize).decision,
    'excluded',
  );
});

test('営業とキャンセルはモデルがイベントを返しても登録対象外', () => {
  for (const intent of ['marketing', 'cancelled', 'not_event'] as const) {
    assert.equal(
      extractionToPlan(mail(), extraction({ intent }), now, finalize).decision,
      'excluded',
    );
  }
});

test('不正なモデル出力を拒否', () => {
  for (const value of [null, {}, { intent: 'confirmed', reason: '', evidence: '', events: [{}] }])
    assert.throws(() => validateExtraction(value));
});

test('原文の時刻と年月日を検証し、年の勝手な補完を拒否', () => {
  assert.equal(dateSupported('2026-11-20T15:00:00', '2026年11月20日 15:00', now), true);
  assert.equal(dateSupported('2027-11-20T15:00:00', '2026年11月20日 15:00', now), false);
  assert.equal(dateSupported('2026-11-20T15:00:00', '11月20日 15:00', now), true);
});

test('日付の次行の括弧内に書かれた時刻を捨てない', () => {
  assert.equal(dateSupported('2026-11-20T15:00:00', '2026年11月20日\n\n(15:00以降)', now), true);
});

test('日時に付いたオフセットは会場のタイムゾーンと一致するときだけ許可', () => {
  const e = extraction();
  e.events[0]!.startLocal += '+09:00';
  e.events[0]!.endLocal += '+09:00';
  assert.equal(extractionToPlan(mail(), e, now, finalize).decision, 'candidate');
  e.events[0]!.startLocal = '2026-11-20T15:00:00-05:00';
  assert.equal(extractionToPlan(mail(), e, now, finalize).decision, 'review');
});

test('ルールの確定候補をLLMが営業と言った場合、黙って除外せず矛盾として保留', () => {
  const rule = extractionToPlan(mail(), extraction(), now, finalize);
  const inferred = extractionToPlan(mail(), extraction({ intent: 'marketing' }), now, finalize);
  const merged = reconcileModelPlan(rule, inferred);
  assert.equal(merged.decision, 'review');
  assert.equal(merged.events[0]?.payload, undefined);
});

test('LLMも確定と判断し開始日時が一致するとき、ルールで検証済みの終了日時を維持', () => {
  const rule = extractionToPlan(mail(), extraction(), now, finalize);
  const partial = extraction();
  partial.events[0]!.endLocal = null;
  partial.events[0]!.calendarNotes = [
    { text: 'チェックイン：11/20 15:00', evidence: 'チェックイン:2026年11月20日 15:00' },
  ];
  const inferred = extractionToPlan(mail(), partial, now, finalize);
  assert.equal(inferred.decision, 'candidate');
  const merged = reconcileModelPlan(rule, inferred);
  assert.equal(merged.decision, 'candidate');
  assert.equal(merged.events[0]?.payload?.end.dateTime, '2026-11-21T10:00:00.000+09:00');
  assert.equal(merged.events[0]?.payload?.description, 'チェックイン：11/20 15:00');
});

test('LLMが場所を捏造した場合も自動登録しない', () => {
  const e = extraction();
  e.events[0]!.location = '架空のホテル';
  assert.equal(extractionToPlan(mail(), e, now, finalize).decision, 'review');
});

test('転送先が複数ならユーザー指定なしで混同しない', () => {
  const one = mail({ subject: 'Fw: 予約確認', to: ['"Owner" <owner@gmail.com>'] });
  assert.equal(filterGmailForwards([one]).messages.length, 1);
  const two = mail({ subject: 'Fw: 予約確認', to: ['other@gmail.com'] });
  assert.throws(() => filterGmailForwards([one, two]));
  assert.equal(filterGmailForwards([one, two], 'owner@gmail.com').messages.length, 1);
});

test('同じ件名だけでは別の送信元や転送後に届いた原本を一致させない', () => {
  const forwarded = mail({
    subject: 'Fw:予約確認',
    receivedAt: '2026-10-03T00:00:00Z',
    text: 'From:hotel@example.com\n件名:予約確認\n\n' + mail().text,
  });
  assert.equal(matchOriginal(forwarded, [mail()]).length, 1);
  assert.equal(matchOriginal(forwarded, [mail({ from: 'attacker@example.org' })]).length, 0);
  assert.equal(matchOriginal(forwarded, [mail({ receivedAt: '2026-10-04T00:00:00Z' })]).length, 0);
});
