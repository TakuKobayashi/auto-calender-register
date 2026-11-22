import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeYahooCache, selectYahooMailbox } from '../src/sources/yahoo.js';
import type { Collection, CollectedMail } from '../src/collect.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function message(folder: string): CollectedMail {
  return {
    uid: 42,
    subject: folder,
    from: 'sender@example.test',
    to: [],
    date: null,
    receivedAt: '2026-11-01T00:00:00Z',
    messageId: null,
    flags: [],
    attachments: [],
    calendarParts: [],
    text: '本文',
    source: {
      account: { provider: 'yahoo-japan', key: 'user' },
      id: folder,
      name: folder,
      generation: '1',
      messageId: '42',
    },
  };
}
function cache(): Collection {
  return {
    version: 1,
    mailbox: 'all received folders',
    uidValidity: 'multiple',
    since: '2026-10-01T00:00:00Z',
    collectedAt: '2026-11-01T00:00:00Z',
    matched: 4,
    complete: true,
    messages: [message('INBOX'), message('Shopping'), message('Other')],
    errors: [
      {
        uid: -1,
        subject: 'Shopping failed',
        reason: '取得失敗',
        source: { ...message('Shopping').source!, messageId: '43' },
      },
    ],
  };
}
test('全フォルダーのキャッシュでも既定はINBOXだけを選別する', () => {
  const original = cache();
  const result = selectYahooMailbox(original);
  assert.equal(result.mailbox, 'INBOX');
  assert.deepEqual(
    result.messages.map((mail) => mail.subject),
    ['INBOX'],
  );
  assert.equal(result.messages[0]!.source!.messageId, '42');
  assert.equal(result.matched, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(original.messages.length, 3);
});
test('Shopping指定ではINBOXや他フォルダーを混ぜない', () => {
  const result = selectYahooMailbox(cache(), ['Shopping']);
  assert.deepEqual(
    result.messages.map((mail) => mail.subject),
    ['Shopping'],
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.matched, 2);
});
test('複数フォルダーと重複指定を扱い、フォルダーごとの同じUIDを保持する', () => {
  const result = selectYahooMailbox(cache(), ['inbox', 'Shopping', 'INBOX', 'Shopping']);
  assert.deepEqual(result.messages.map((mail) => mail.subject).sort(), ['INBOX', 'Shopping']);
  assert.equal(new Set(result.messages.map((mail) => mail.uid)).size, 2);
  assert.ok(result.messages.every((mail) => mail.source!.messageId === '42'));
  assert.equal(result.matched, 3);
  assert.equal(result.sourceScope, undefined);
});
test('Task・Actionsのカンマ区切り指定でも複数フォルダーを選択する', () => {
  const result = selectYahooMailbox(cache(), ['INBOX, Shopping']);
  assert.equal(result.messages.length, 2);
  assert.equal(result.mailbox, 'INBOX, Shopping');
});
test('CLIで複数フォルダーを指定してキャッシュから選別する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-multi-mailbox-'));
  const collection = cache();
  collection.since = '2026-09-30T15:00:00.000Z';
  collection.errors = [];
  collection.matched = collection.messages.length;
  const path = join(directory, 'mail-cache.json');
  await writeFile(path, JSON.stringify(collection));
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    'src/cli.ts',
    'dry-run',
    '--since',
    '2026-10-01',
    '--from-cache',
    path,
    '--mailbox',
    'INBOX',
    'Shopping',
    '--no-database',
    '--output-dir',
    directory,
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.complete, true);
  assert.equal(result.summary.checked, 2);
});
test('CLIのログを抑制しても件数とファイル出力を維持する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-private-console-'));
  const original = cache();
  const subject = '予約が確定しました PRIVATE_SUBJECT';
  const title = 'PRIVATE_EVENT';
  original.since = '2026-09-30T15:00:00.000Z';
  original.messages = [
    {
      ...message('INBOX'),
      subject,
      calendarParts: [
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:private-test@example.test',
          'DTSTAMP:20261101T000000Z',
          'DTSTART:20991120T100000Z',
          'DTEND:20991120T110000Z',
          'SUMMARY:' + title,
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
      ],
    },
  ];
  const failedSubject = 'PRIVATE_FAILED_SUBJECT';
  original.errors = [
    {
      ...original.errors[0]!,
      subject: failedSubject,
      source: { ...message('INBOX').source!, messageId: '43' },
    },
  ];
  original.complete = false;
  original.matched = 2;
  const input = join(directory, 'mail-cache.json');
  await writeFile(input, JSON.stringify(original));
  for (const flags of [[], ['--no-mail-details']]) {
    const args = [
      '--import',
      'tsx',
      'src/cli.ts',
      'dry-run',
      '--since',
      '2026-10-01',
      '--from-cache',
      input,
      '--output-dir',
      directory,
      '--no-database',
      ...flags,
    ];
    await assert.rejects(promisify(execFile)(process.execPath, args), (error: unknown) => {
      const { stdout, stderr, code } = error as { stdout: string; stderr: string; code: number };
      assert.equal(code, 2);
      const summary = JSON.parse(stdout);
      assert.equal(summary.summary.checked, 2);
      assert.equal(summary.summary.register, 1);
      if (flags.length) {
        assert.equal(summary.proposed, undefined);
        assert.doesNotMatch(stdout + stderr, /PRIVATE_|sender@example\.test/);
      } else {
        assert.equal(summary.proposed[0].subject, subject);
        assert.equal(summary.proposed[0].title, title);
        assert.ok(stderr.includes(failedSubject));
      }
      return true;
    });
  }
  const report = JSON.parse(await readFile(join(directory, 'dry-run.json'), 'utf8'));
  assert.equal(report.proposed[0].sourceSubject, subject);
  assert.equal(report.proposed[0].payload.summary, title);
});

test('単一フォルダーの旧キャッシュも同じ対象指定に従う', () => {
  const original = cache();
  original.mailbox = 'Shopping';
  original.uidValidity = '1';
  original.messages = [{ ...message('Shopping'), source: undefined }];
  original.errors = [];
  const normalized = normalizeYahooCache(original, { provider: 'yahoo-japan', key: 'user' });
  assert.equal(selectYahooMailbox(normalized).matched, 0);
  assert.equal(selectYahooMailbox(normalized, ['Shopping']).messages[0]!.source!.id, 'Shopping');
});
