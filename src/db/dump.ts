import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { hash } from './store.js';

// Parent tables precede children for restore. Drizzle's own migration journal is managed by migrate.
export const dumpTables = [
  'mailboxes',
  'mails',
  'extractions',
  'runs',
  'calendar_states',
  'sync_attempts',
] as const;
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string | null) =>
  value === null
    ? 'NULL'
    : `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}'`;
type Manifest = { version: 1; tables: { name: string; rows: number; checksum: string }[] };

export async function dumpDatabase(store: Store, directory: string) {
  const unlock = await store.lock('calendar-db:maintenance', true);
  try {
    return await dumpSnapshot(store, directory);
  } finally {
    await unlock();
  }
}

async function dumpSnapshot(store: Store, directory: string) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const snapshot = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const staging = join(root, `.${snapshot}`);
  await mkdir(staging, { recursive: true });
  const manifest: Manifest = { version: 1, tables: [] };
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL standard_conforming_strings = on');
    for (const table of dumpTables) {
      const { rows: columns } = await client.query<{ column_name: string }>(
        'select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position',
        ['public', table],
      );
      if (!columns.length)
        throw new Error('DBテーブルがありません。npm run db:migrate を実行してください。');
      const names = columns.map((c) => ident(c.column_name));
      const prefix = `INSERT INTO "public".${ident(table)} (${names.join(', ')}) VALUES (`;
      // Native text representations restore JSONB/timestamps exactly; E literals keep each INSERT on one physical line.
      const { rows } = await client.query<Record<string, string | null>>(
        `select ${names.map((c) => `${c}::text as ${c}`).join(', ')} from "public".${ident(table)} order by ${names.join(', ')}`,
      );
      const {
        rows: [sequence],
      } = await client.query<{ name: string }>("select pg_get_serial_sequence($1, 'id') as name", [
        `public.${table}`,
      ]);
      if (!sequence?.name)
        throw new Error('DBのid自動採番定義がありません。初期スキーマを確認してください。');
      const sequenceName = sequence.name.split('.').map(ident).join('.');
      const {
        rows: [sequenceState],
      } = await client.query<{ last_value: string; is_called: boolean }>(
        `select last_value::text, is_called from ${sequenceName}`,
      );
      const maxId = rows.reduce((max, row) => (BigInt(row.id!) > max ? BigInt(row.id!) : max), 0n);
      const sequenceNext = BigInt(sequenceState!.last_value) + (sequenceState!.is_called ? 1n : 0n);
      const nextId = sequenceNext > maxId ? sequenceNext : maxId + 1n;
      const sql =
        rows
          .map((r) => prefix + columns.map((c) => literal(r[c.column_name]!)).join(', ') + ');')
          .join('\n') + `\nALTER SEQUENCE ${sequenceName} RESTART WITH ${nextId};\n`;
      await mkdir(join(staging, table));
      await writeFile(join(staging, table, 'data.sql'), sql, { mode: 0o600 });
      manifest.tables.push({ name: table, rows: rows.length, checksum: hash(sql) });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  await rename(staging, join(root, snapshot));
  // An interrupted dump never replaces the last complete snapshot pointer.
  const pointer = join(root, `.latest-${randomUUID()}`);
  await writeFile(pointer, snapshot + '\n', { mode: 0o600 });
  await rename(pointer, join(root, 'latest.txt'));
  return {
    directory: join(root, snapshot),
    tables: manifest.tables.map(({ name, rows }) => ({ name, rows })),
  };
}

export async function restoreDatabase(store: Store, directory: string, replace = false) {
  const unlock = await store.lock('calendar-db:maintenance');
  try {
    return await restoreSnapshot(store, directory, replace);
  } finally {
    await unlock();
  }
}

async function restoreSnapshot(store: Store, directory: string, replace: boolean) {
  let root = resolve(directory);
  try {
    const snapshot = (await readFile(join(root, 'latest.txt'), 'utf8')).trim();
    if (!/^snapshot-[a-zA-Z0-9-]+$/.test(snapshot))
      throw new Error('ダンプのポインターが不正です。');
    root = join(root, snapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Manifest;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.tables) ||
    manifest.tables.length !== dumpTables.length ||
    manifest.tables.some((t, i) => t.name !== dumpTables[i])
  )
    throw new Error('ダンプのテーブル一覧またはバージョンが一致しません。');
  const files: string[] = [];
  for (const table of manifest.tables) {
    const sql = await readFile(join(root, table.name, 'data.sql'), 'utf8');
    if (hash(sql) !== table.checksum) throw new Error(`ダンプのチェックサム不一致: ${table.name}`);
    files.push(sql);
  }
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL standard_conforming_strings = on');
    const all = dumpTables.map((t) => `"public".${ident(t)}`).join(', ');
    await client.query(`LOCK TABLE ${all} IN ACCESS EXCLUSIVE MODE`);
    if (replace) await client.query(`TRUNCATE TABLE ${all}`);
    else
      for (const table of dumpTables) {
        if ((await client.query(`select 1 from "public".${ident(table)} limit 1`)).rowCount)
          throw new Error(
            'DBにデータが存在します。空のDBへ復元するか、置換する場合は --replace を指定してください。',
          );
      }
    for (const sql of files) if (sql.trim()) await client.query(sql);
    for (const table of manifest.tables) {
      const count = await client.query(
        `select count(*)::int as count from "public".${ident(table.name)}`,
      );
      if (count.rows[0].count !== table.rows) throw new Error('復元件数が一致しません。');
    }
    await client.query('COMMIT');
    return {
      restored: true,
      directory: root,
      tables: manifest.tables.map(({ name, rows }) => ({ name, rows })),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
