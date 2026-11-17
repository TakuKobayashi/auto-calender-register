import 'dotenv/config';
import { Command, Option } from 'commander';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Store } from './store.js';
import { dumpDatabase, restoreDatabase } from './dump.js';

const program = new Command().name('calendar-db');
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function withStore<T>(fn: (store: Store) => Promise<T>) {
  const store = new Store();
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}
program
  .command('migrate')
  .description('DrizzleのSQLマイグレーションを適用')
  .action(() =>
    withStore(async (s) => {
      const unlock = await s.lock('calendar-db:maintenance');
      try {
        await migrate(s.db, { migrationsFolder: './drizzle' });
        output({ migrated: true });
      } finally {
        await unlock();
      }
    }),
  );
program
  .command('status')
  .description('確認済みUID・取得失敗数・直近の実行履歴')
  .action(() => withStore(async (s) => output(await s.status())));
program
  .command('holds')
  .description('カレンダー照合の保留・登録失敗一覧')
  .action(() => withStore(async (s) => output(await s.holds())));
program
  .command('reviews')
  .description('メール判定の要確認・未確定・解析失敗一覧')
  .action(() => withStore(async (s) => output(await s.reviews())));
program
  .command('resolve')
  .description('保留に手動判断を記録（targetはdb:holdsの値）')
  .requiredOption('--target <hash>', '照合対象の識別子')
  .requiredOption('--event-key <key>', '予定の識別キー')
  .addOption(
    new Option(
      '--decision <decision>',
      'skip=登録不要、retry=判断を解除、duplicate=既存予定に紐付け',
    )
      .choices(['skip', 'retry', 'duplicate'])
      .makeOptionMandatory(),
  )
  .option('--google-event-id <id>', '重複先のGoogle予定ID')
  .action((o) =>
    withStore(async (s) => {
      const unlock = await s.lock(`calendar:${o.target}`);
      try {
        output(await s.resolve(o.target, o.eventKey, o.decision, o.googleEventId));
      } finally {
        await unlock();
      }
    }),
  );
program
  .command('dump')
  .description('テーブル別SQLへ出力（1レコード1 INSERT文）')
  .option('--directory <path>', 'ダンプ保存先', 'db/dumps')
  .action((o) => withStore(async (s) => output(await dumpDatabase(s, o.directory))));
program
  .command('restore')
  .description('ダンプの全テーブルを一括復元（通常は空DBのみ）')
  .option('--directory <path>', 'ダンプ保存先またはスナップショット', 'db/dumps')
  .option('--replace', '既存のアプリ用テーブルの全データを置き換える', false)
  .action((o) => withStore(async (s) => output(await restoreDatabase(s, o.directory, o.replace))));
try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(
    /^(DBにデータ|ダンプの|指定した予定|duplicateには|同じ対象|DBテーブル|復元件数)/.test(message)
      ? message
      : 'DB操作に失敗しました。接続・マイグレーション・入力を確認してください（認証情報とSQL本文は表示しません）。',
  );
  process.exitCode = 1;
}
