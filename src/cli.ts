import 'dotenv/config';
import { Command } from 'commander';
import { positiveInteger } from './config.js';
import { getMail, listMail, mailboxInfo, withMailbox } from './mail.js';
import { DateTime } from 'luxon';
import { parseSince } from './classify.js';
import { collect } from './collect.js';
import { readCollection, writeDryRun } from './dry-run.js';
import { auditForwards, collectForwards, type ForwardCache } from './forward-audit.js';
import { readFile } from 'node:fs/promises';

const program = new Command()
  .name('yahoo-mail')
  .description('Yahoo! JAPANメールを読み取り専用で取得（JSON出力）')
  .version('0.1.0');

const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

program
  .command('check')
  .description('接続とメールボックス情報を確認')
  .option('--mailbox <name>', 'メールボックス名')
  .action(async (options) =>
    withMailbox(options.mailbox, async (client) => output(mailboxInfo(client))),
  );

program
  .command('list')
  .description('最新メールの一覧を取得（本文は取得しない）')
  .option('--mailbox <name>', 'メールボックス名')
  .option('--limit <number>', '最大件数（受信順の新しいものから）', positiveInteger, 10)
  .action(async (options) =>
    withMailbox(options.mailbox, async (client) => {
      output({ ...mailboxInfo(client), messages: await listMail(client, options.limit) });
    }),
  );

program
  .command('show')
  .description('UIDを指定してメール本文・添付情報を取得')
  .argument('<uid>', 'listで確認したUID', positiveInteger)
  .option('--mailbox <name>', 'メールボックス名')
  .option('--max-bytes <number>', 'メール1件の最大取得バイト数', positiveInteger, 10 * 1024 * 1024)
  .action(async (uid, options) =>
    withMailbox(options.mailbox, async (client) => {
      output({ ...mailboxInfo(client), message: await getMail(client, uid, options.maxBytes) });
    }),
  );

program
  .command('inspect')
  .description('最新メールの一覧を取得後、各メールの本文を順に取得')
  .option('--mailbox <name>', 'メールボックス名')
  .option('--limit <number>', '最大件数', positiveInteger, 3)
  .option('--max-bytes <number>', 'メール1件の最大取得バイト数', positiveInteger, 10 * 1024 * 1024)
  .action(async (options) =>
    withMailbox(options.mailbox, async (client) => {
      const messages = await listMail(client, options.limit);
      output({ ...mailboxInfo(client), messages });
      for (const message of messages) {
        output({
          ...mailboxInfo(client),
          message: await getMail(client, message.uid, options.maxBytes),
        });
      }
    }),
  );

program
  .command('dry-run')
  .description('指定受信日以降のメールを選別し、登録候補と判定理由を保存（カレンダー書き込みなし）')
  .option(
    '--since <date>',
    '受信開始日 YYYY-MM-DD（日本時間）',
    DateTime.now().setZone('Asia/Tokyo').minus({ months: 1 }).startOf('month').toISODate()!,
  )
  .option('--mailbox <name>', 'メールボックス名')
  .option('--max-bytes <number>', 'メール1件の最大取得バイト数', positiveInteger, 10 * 1024 * 1024)
  .option('--output-dir <directory>', '個人情報を含むレポートの保存先', 'reports')
  .option('--from-cache <file>', '取得済みmail-cache.jsonで再判定（メール接続なし）')
  .option(
    '--existing-events <file>',
    '既存Google予定のJSONスナップショットで重複照合（省略時は未確認）',
  )
  .option('--ollama-model <name>', 'ローカルOllamaで文脈を再判定（実験機能・モデル指定必須）')
  .action(async (options) => {
    const since = parseSince(options.since);
    const collection = options.fromCache
      ? await readCollection(options.fromCache, since)
      : await withMailbox(options.mailbox, (client) =>
          collect(client, since, options.outputDir, options.maxBytes),
        );
    const report = await writeDryRun(
      collection,
      options.outputDir,
      options.existingEvents,
      new Date(),
      options.ollamaModel,
    );
    output({
      mode: report.mode,
      complete: report.complete,
      calendarWrites: 0,
      calendarDuplicateCheck: report.calendarDuplicateCheck,
      summary: report.summary,
      report: `${options.outputDir}/dry-run.md`,
      json: `${options.outputDir}/dry-run.json`,
      proposed: report.proposed,
    });
    if (!report.complete) process.exitCode = 2;
  });

program
  .command('audit-forwards')
  .description('Gmail宛Fwを見本に予定判定を監査（送信・登録しない）')
  .option('--since <date>', '転送受信開始日 YYYY-MM-DD', '2026-10-01')
  .option('--from-cache <file>', '取得済みsent-forward-cache.json')
  .option('--inbox-cache <file>', '取得済み受信キャッシュ', 'reports/mail-cache.json')
  .option('--recipient <email>', 'Gmail転送先（1種類だけなら自動検出）')
  .option('--output-dir <directory>', '監査レポート保存先', 'reports')
  .option('--ollama-model <name>', 'ローカルOllamaで見本を検証')
  .option('--sample-uids <uids>', 'LLM検証するSent UID（カンマ区切り）')
  .option('--limit <number>', 'LLM検証の最大件数（ルール監査は全件）', positiveInteger, 6)
  .action(async (options) => {
    const since = parseSince(options.since);
    const sampleUids = options.sampleUids?.split(',').map(positiveInteger);
    const inbox = await readCollection(options.inboxCache, since);
    const forwards: ForwardCache = options.fromCache
      ? JSON.parse(await readFile(options.fromCache, 'utf8'))
      : await collectForwards(since, options.outputDir, options.recipient);
    if (forwards.since !== since.toISOString())
      throw new Error('転送キャッシュと --since が一致しません。');
    const report = await auditForwards(forwards, inbox, options.outputDir, {
      recipient: options.recipient,
      model: options.ollamaModel,
      sampleUids,
      limit: options.limit,
    });
    output({
      referenceCount: report.referenceCount,
      matchedOriginals: report.matchedOriginals,
      missingOrAmbiguousOriginals: report.missingOrAmbiguousOriginals,
      llmChecked: report.llmChecked,
      llmErrors: report.llmErrors,
      report: `${options.outputDir}/forward-audit.md`,
      calendarWrites: 0,
    });
    if (report.llmErrors) process.exitCode = 2;
  });

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
