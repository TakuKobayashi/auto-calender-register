import 'dotenv/config';
import { Command } from 'commander';
import { positiveInteger } from './config.js';
import { getMail, listMail, mailboxInfo, withMailbox } from './mail.js';

const program = new Command()
  .name('yahoo-mail')
  .description('Yahoo! JAPANメールを読み取り専用で取得（JSON出力）')
  .version('0.1.0');

const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

program.command('check').description('接続とメールボックス情報を確認')
  .option('--mailbox <name>', 'メールボックス名')
  .action(async options => withMailbox(options.mailbox, async client => output(mailboxInfo(client))));

program.command('list').description('最新メールの一覧を取得（本文は取得しない）')
  .option('--mailbox <name>', 'メールボックス名')
  .option('--limit <number>', '最大件数（受信順の新しいものから）', positiveInteger, 10)
  .action(async options => withMailbox(options.mailbox, async client => {
    output({ ...mailboxInfo(client), messages: await listMail(client, options.limit) });
  }));

program.command('show').description('UIDを指定してメール本文・添付情報を取得')
  .argument('<uid>', 'listで確認したUID', positiveInteger)
  .option('--mailbox <name>', 'メールボックス名')
  .option('--max-bytes <number>', 'メール1件の最大取得バイト数', positiveInteger, 10 * 1024 * 1024)
  .action(async (uid, options) => withMailbox(options.mailbox, async client => {
    output({ ...mailboxInfo(client), message: await getMail(client, uid, options.maxBytes) });
  }));

program.command('inspect').description('最新メールの一覧を取得後、各メールの本文を順に取得')
  .option('--mailbox <name>', 'メールボックス名')
  .option('--limit <number>', '最大件数', positiveInteger, 3)
  .option('--max-bytes <number>', 'メール1件の最大取得バイト数', positiveInteger, 10 * 1024 * 1024)
  .action(async options => withMailbox(options.mailbox, async client => {
    const messages = await listMail(client, options.limit);
    output({ ...mailboxInfo(client), messages });
    for (const message of messages) {
      output({ ...mailboxInfo(client), message: await getMail(client, message.uid, options.maxBytes) });
    }
  }));

try {
  await program.parseAsync();
} catch (error) {
  // サーバー応答に含まれる可能性のある認証情報は表示しない。
  let message = error instanceof Error ? error.message : 'メール取得に失敗しました。';
  for (const secret of [process.env.YAHOO_IMAP_PASSWORD, process.env.YAHOO_IMAP_USER]) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  console.error(`エラー: ${message}`);
  process.exitCode = 1;
}
