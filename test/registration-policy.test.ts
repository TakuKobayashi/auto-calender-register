import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionToPlan, type Extraction } from '../src/ollama.js';
import { finalize } from '../src/classify.js';
import type { CollectedMail } from '../src/domain/mail.js';
import { createIcs } from '../src/ics.js';

const now = new Date('2026-11-14T00:00:00Z');
function example(label: string, intent: Extraction['intent'] = 'confirmed') {
  const mail: CollectedMail = {
    uid: 1,
    from: 'Unknown Service <notice@example.test>',
    subject: label,
    to: [],
    date: now.toISOString(),
    receivedAt: now.toISOString(),
    messageId: '<test@example.test>',
    flags: [],
    attachments: [],
    calendarParts: [],
    text: `${label}\n対応が必要です。\n期限：2026年11月20日\n所在地：東京都港区\n受付番号：REF123456`,
  };
  const extraction: Extraction = {
    intent,
    reason: '本人の対応期限',
    evidence: '対応が必要です。',
    references: ['REF123456'],
    events: [
      {
        kind: 'deadline',
        title: label,
        startLocal: '2026-11-20',
        endLocal: null,
        startZone: 'Asia/Tokyo',
        endZone: null,
        location: '',
        startEvidence: '期限：2026年11月20日',
        endEvidence: '',
        zoneEvidence: '所在地：東京都港区',
        confirmationEvidence: '対応が必要です。',
      },
    ],
  };
  return { mail, extraction };
}
for (const label of [
  'Amazon ロッカー受取',
  '図書館の返却',
  '書類の提出',
  '登録更新手続き',
  '未知のサービスの対応期限',
]) {
  test(`${label}を共通の意味抽出結果から検証する`, () => {
    const { mail, extraction } = example(label);
    const plan = extractionToPlan(mail, extraction, now, finalize);
    assert.equal(plan.decision, 'candidate');
    assert.equal(plan.events[0]?.payload?.allDayDate, '2026-11-20');
    assert.equal(plan.bookingIds?.length, 1);
    const event = plan.events[0]!;
    assert.match(
      createIcs(
        [{ sourceUid: 1, eventKey: event.eventKey!, iCalUID: 'test', payload: event.payload! }],
        now,
      ),
      /DTSTART;VALUE=DATE:20261120/,
    );
  });
}
for (const intent of ['pending', 'marketing', 'completed', 'cancelled', 'not_event'] as const) {
  test(`${intent}は登録候補を作らない`, () => {
    const { mail, extraction } = example('任意の用事', intent);
    assert.equal(extractionToPlan(mail, extraction, now, finalize).events.length, 0);
  });
}
test('本文にない日時はLLMが返しても登録しない', () => {
  const { mail, extraction } = example('提出');
  extraction.events[0]!.startLocal = '2026-11-21';
  assert.equal(extractionToPlan(mail, extraction, now, finalize).decision, 'review');
});
test('期限を過ぎた用事は登録しない', () => {
  const { mail, extraction } = example('提出');
  assert.equal(
    extractionToPlan(mail, extraction, new Date('2026-11-21T00:00:00Z'), finalize).decision,
    'excluded',
  );
});

test('時刻のない期限にモデルが補った00:00は本文を検証して終日表示にする', () => {
  const { mail, extraction } = example('任意の提出期限');
  extraction.events[0]!.startLocal = '2026-11-20T00:00:00';
  const result = extractionToPlan(mail, extraction, now, finalize);
  assert.equal(result.events[0]?.payload?.allDayDate, '2026-11-20');
});
