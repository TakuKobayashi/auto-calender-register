import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMail, finalize } from '../src/classify.js';
import type { CollectedMail, Collection } from '../src/collect.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractionCacheKey,
  localModelDigest,
  extractionToPlan,
  modelText,
  unwrapForward,
  validateExtraction,
  type Extraction,
} from '../src/ollama.js';
import { filterGmailForwards, matchOriginal } from '../src/forward-audit.js';
import { writeDryRun } from '../src/dry-run.js';
import type { Store } from '../src/db/store.js';
import { validateSelection } from '../src/selection.js';

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

test('個別のLLMタイムアウトだけを次回に再試行し、判定済みの予定は登録候補に残す', async (t) => {
  const timedOutMail = mail({ subject: 'PRIVATE_TIMEOUT', text: '日時：2026年11月20日 15:00 JST' });
  const confirmedMail = mail({ uid: 2 });
  const calls: string[] = [];
  const logs = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'timeout-test', digest: 'a'.repeat(64) }] });
    if (String(input).endsWith('/api/show')) return Response.json({ details: { format: 'gguf' } });
    const request = JSON.parse(String(init?.body));
    const mailInput = JSON.parse(request.messages.at(-1).content);
    calls.push(mailInput.subject);
    if (mailInput.subject === timedOutMail.subject) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('timeout', 'TimeoutError'));
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({ message: { content: JSON.stringify(extraction()) }, done: true }) + '\n',
    );
  });

  const directory = await mkdtemp(join(tmpdir(), 'calendar-timeout-'));
  const input = {
    ...collection(timedOutMail),
    messages: [timedOutMail, confirmedMail],
    matched: 2,
  };
  const extractions = new Map<string, Extraction>();
  const store = {
    getExtraction: async (key: string) => extractions.get(key),
    saveExtraction: async (key: string, _model: string, extraction: Extraction) =>
      extractions.set(key, extraction),
  } as unknown as Store;
  const run = () =>
    writeDryRun(input, directory, undefined, now, 'timeout-test', store, { mailDetails: false });
  const result = await run();
  assert.equal(result.complete, true);
  assert.equal(result.summary.error, 0);
  assert.equal(result.summary.review, 1);
  assert.equal(result.llm.deferredTimeouts, 1);
  assert.equal(extractions.size, 1);
  assert.deepEqual(
    validateSelection(result, now).events.map((e) => e.sourceUid),
    [confirmedMail.uid],
  );
  assert.doesNotMatch(
    logs.mock.calls.map((call) => call.arguments.join(' ')).join('\n'),
    /PRIVATE_TIMEOUT/,
  );
  assert.match(result.messages[0]!.reasons.join(' '), /次回実行で再試行/);

  const next = await run();
  assert.equal(next.complete, true);
  assert.equal(next.llm.cacheHits, 1);
  assert.equal(next.llm.requests, 1);
  assert.deepEqual(calls, [timedOutMail.subject, confirmedMail.subject, timedOutMail.subject]);
});

test('実行時間で区切っても、次回は保存済み結果を再利用して残りだけ判定する', async (t) => {
  const model = 'resume-budget-test';
  const digest = 'e'.repeat(64);
  const first = mail();
  const second = mail({ uid: 2, subject: '別の予約確認' });
  const stored = new Map([[extractionCacheKey(first, model, digest), extraction()]]);
  const calls = t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: model, digest }] });
    if (url.endsWith('/api/show')) return Response.json({ details: { format: 'gguf' } });
    return new Response(
      JSON.stringify({ message: { content: JSON.stringify(extraction()) }, done: true }) + '\n',
    );
  });
  const store = {
    getExtraction: async (key: string) => stored.get(key),
    saveExtraction: async (key: string, _model: string, result: Extraction) =>
      stored.set(key, result),
  } as unknown as Store;
  const input = { ...collection(first), messages: [first, second], matched: 2 };
  const directory = await mkdtemp(join(tmpdir(), 'calendar-resume-budget-'));
  const run = (llmDeadline?: number) =>
    writeDryRun(input, directory, undefined, now, model, store, {
      llmDeadline,
      mailDetails: false,
    });
  const paused = await run(0);
  assert.equal(paused.complete, false);
  assert.equal(paused.remainingLlm, 1);
  assert.equal(paused.summary.scanned, 1);
  assert.equal(paused.llm.cacheHits, 1);
  assert.equal(paused.llm.requests, 0);
  assert.throws(() => validateSelection(paused, now));

  const completed = await run();
  assert.equal(completed.complete, true);
  assert.equal(completed.remainingLlm, 0);
  assert.equal(completed.llm.cacheHits, 1);
  assert.equal(completed.llm.requests, 1);
  assert.equal(stored.size, 2);
  const cached = await run(0);
  assert.equal(cached.complete, true);
  assert.equal(cached.llm.cacheHits, 2);
  assert.equal(
    calls.mock.calls.filter((call) => String(call.arguments[0]).endsWith('/api/chat')).length,
    1,
  );
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

test('pendingからconfirmedの通知が来たときだけ候補にできる', () => {
  assert.equal(
    extractionToPlan(mail(), extraction({ intent: 'pending' }), now, finalize).decision,
    'pending',
  );
  assert.equal(extractionToPlan(mail(), extraction(), now, finalize).decision, 'candidate');
});

test('LLMの予定データから登録用payloadを生成し、認証情報を本文から除く', () => {
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
  assert.equal(description, '受付で身分証を提示してください。\n朝食は無料です。');
});

test('メールは1通ずつ判定し、LLMの要約をカレンダー本文に使う', async (t) => {
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
      '朝食付き',
    ].join('\n'),
  );
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

test('日時に付いたオフセットは会場のタイムゾーンと一致するときだけ許可', () => {
  const e = extraction();
  e.events[0]!.startLocal += '+09:00';
  e.events[0]!.endLocal += '+09:00';
  assert.equal(extractionToPlan(mail(), e, now, finalize).decision, 'candidate');
  e.events[0]!.startLocal = '2026-11-20T15:00:00-05:00';
  assert.equal(extractionToPlan(mail(), e, now, finalize).decision, 'review');
});

test('不正な日付、存在しないタイムゾーン、開始以前の終了は登録候補にしない', () => {
  for (const overrides of [
    { startLocal: '2026-11-31T15:00:00' },
    { startZone: 'Asia/Invalid' },
    { endLocal: '2026-11-20T14:00:00' },
  ]) {
    const e = extraction();
    Object.assign(e.events[0]!, overrides);
    assert.equal(extractionToPlan(mail(), e, now, finalize).decision, 'review');
  }
});

test('場所が空欄か原文と一致しなくても日時を確認できれば登録候補に残す', () => {
  const e = extraction();
  for (const location of ['', '架空のホテル']) {
    e.events[0]!.location = location;
    const result = extractionToPlan(mail(), e, now, finalize);
    assert.equal(result.decision, 'candidate');
    assert.equal(result.events[0]?.payload?.location, '');
  }
});

test('通常の選別で本文ルールが異なる結果を出してもLLMの判定と予定を採用する', async (t) => {
  const confirmed = mail({
    subject: 'キャンセル待ちから予約が確定しました',
    text: ['予約番号:ABC12345', mail().text, '配信停止はこちら'].join('\n'),
  });
  const promotion = mail({ uid: 2, subject: '期間限定セール', text: '2026年11月20日まで全品割引' });
  const reminder = mail({
    uid: 3,
    receivedAt: '2026-10-03T00:00:00Z',
    subject: 'ご利用案内',
    text: '予約番号:ABC12345\n受付で予約番号を提示してください。',
  });
  assert.equal(classifyMail(confirmed, now).decision, 'pending');
  const confirmedExtraction = extraction({ references: ['ABC12345'] });
  Object.assign(confirmedExtraction.events[0]!, {
    title: 'LLMが選んだ予約名',
    startEvidence: '',
    endEvidence: '',
    zoneEvidence: '',
    confirmationEvidence: '',
    endLocal: '2026-11-21T11:00:00',
  });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'marketing-test', digest: 'a'.repeat(64) }] });
    if (String(input).endsWith('/api/show')) return Response.json({ details: { format: 'gguf' } });
    const request = JSON.parse(String(init?.body));
    const { subject } = JSON.parse(request.messages.at(-1).content);
    const result =
      subject === promotion.subject
        ? extraction({ intent: 'marketing', events: [] })
        : confirmedExtraction;
    return new Response(
      JSON.stringify({ message: { content: JSON.stringify(result) }, done: true }) + '\n',
    );
  });
  const directory = await mkdtemp(join(tmpdir(), 'calendar-marketing-'));
  const input = {
    ...collection(confirmed),
    messages: [confirmed, promotion, reminder],
    matched: 3,
  };
  const report = await writeDryRun(input, directory, undefined, now, 'marketing-test', undefined, {
    mailDetails: false,
  });
  assert.equal(report.complete, true);
  assert.equal(report.llm.requests, 2);
  assert.deepEqual(
    report.proposed.map((event) => event.sourceUid),
    [confirmed.uid],
  );
  const [selected] = validateSelection(report, now).events;
  assert.equal(selected?.payload.summary, 'LLMが選んだ予約名');
  assert.equal(selected?.payload.end.dateTime, '2026-11-21T11:00:00.000+09:00');
  assert.equal(report.messages.find((plan) => plan.uid === promotion.uid)?.decision, 'excluded');
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
