import 'dotenv/config';
import { Command } from 'commander';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Store } from './store.js';
import { dumpDatabase, pruneDatabaseDumps, restoreDatabase } from './dump.js';

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
  .command('decisions')
  .description('Mail decisions with sender and subject')
  .action(() => withStore(async (s) => output(await s.decisions())));
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
program
  .command('prune')
  .description('最新のSQLダンプを残して古いスナップショットを削除')
  .option('--directory <path>', 'ダンプ保存先', 'db/dumps')
  .action((o) => withStore(async (s) => output(await pruneDatabaseDumps(s, o.directory))));
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
