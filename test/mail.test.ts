import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, positiveInteger } from '../src/config.js';
import { getMail, listMail, parseMail } from '../src/mail.js';
import type { ImapFlow } from 'imapflow';

test('認証情報は必須、TLSとYahoo! JAPANの接続先を使用', () => {
  assert.throws(() => loadConfig({}), /設定/);
  const config = loadConfig({ YAHOO_IMAP_USER: 'example', YAHOO_IMAP_PASSWORD: 'secret' });
  assert.equal(config.host, 'imap.mail.yahoo.co.jp');
  assert.equal(config.secure, true);
  for (const value of ['0', '-1', '1.2', '2abc', '9007199254740992']) {
    assert.throws(() => positiveInteger(value));
  }
});

test('MIMEの日本語件名と本文を復号し、タイムゾーンをUTCに正規化', async () => {
  const result = await parseMail(Buffer.from([
    'From: sender@example.com', 'To: user@example.com',
    'Subject: =?UTF-8?B?5LqI5a6a?=',
    'Date: Mon, 16 Nov 2026 12:00:00 -0500',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64', '',
    Buffer.from('予定は2026年12月1日です。').toString('base64'),
  ].join('\r\n')));
  assert.equal(result.subject, '予定');
  assert.equal(result.text.trim(), '予定は2026年12月1日です。');
  assert.equal(result.date, '2026-11-16T17:00:00.000Z');
});

test('HTMLメールもテキスト本文として取得', async () => {
  const result = await parseMail(Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n<p>Meeting at 10:00 UTC</p>'));
  assert.match(result.text, /Meeting at 10:00 UTC/);
});

test('空のメールボックスではIMAP FETCHしない', async () => {
  const client = { mailbox: { path: 'INBOX', uidValidity: 1n, exists: 0 } } as ImapFlow;
  assert.deepEqual(await listMail(client, 10), []);
});

test('一覧はメールボックスの範囲内で取得し、新着順に出力', async () => {
  const client = {
    mailbox: { path: 'INBOX', uidValidity: 1n, exists: 2 },
    fetchAll: async (range: string) => {
      assert.equal(range, '1:*');
      return [{ uid: 5 }, { uid: 9 }];
    },
  } as unknown as ImapFlow;
  assert.deepEqual((await listMail(client, 10)).map(m => m.uid), [9, 5]);
});

test('巨大なメールは本文ダウンロード前に拒否する', async () => {
  let calls = 0;
  const client = {
    fetchOne: async () => { calls++; return { uid: 1, size: 200 }; },
  } as unknown as ImapFlow;
  await assert.rejects(getMail(client, 1, 100), /取得上限/);
  assert.equal(calls, 1);
});

test('存在しないUIDは明示的に失敗する', async () => {
  const client = { fetchOne: async () => false } as unknown as ImapFlow;
  await assert.rejects(getMail(client, 123, 100), /見つかりません/);
});
