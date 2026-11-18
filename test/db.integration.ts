import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { ImapFlow } from 'imapflow';
import { Store, mailScope, hash } from '../src/db/store.js';
import { dumpDatabase, restoreDatabase, dumpTables } from '../src/db/dump.js';
import { collect, type Collection, type CollectedMail } from '../src/collect.js';
import { extractionCacheKey, type Extraction } from '../src/ollama.js';
import { writeDryRun } from '../src/dry-run.js';
import { syncCalendar, type CalendarPort } from '../src/google-calendar.js';
import { googleEventId, type SelectedEvent } from '../src/selection.js';
import { databaseUrl } from '../src/db/connection.js';

test('PostgreSQL persistence and SQL dump round-trip', async (t) => {
  const admin = new pg.Pool({ connectionString: databaseUrl() });
  const name = `auto_calender_register_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  const store = new Store(url.toString());
  const directory = await mkdtemp(join(tmpdir(), 'calendar-db-test-'));
  try {
    await migrate(store.db, { migrationsFolder: './drizzle' });
    await t.test(
      'all tables have a single bigint identity id primary key and Rails timestamps',
      async () => {
        const { rows } = await store.pool.query(`
        select tc.table_name, kcu.column_name, c.data_type, c.is_identity
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu using (constraint_catalog, constraint_schema, constraint_name, table_catalog, table_schema, table_name)
        join information_schema.columns c on c.table_schema = tc.table_schema and c.table_name = tc.table_name and c.column_name = kcu.column_name
        where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' order by tc.table_name`);
        assert.equal(rows.length, dumpTables.length);
        assert.deepEqual(rows.map((r) => r.table_name).sort(), [...dumpTables].sort());
        for (const row of rows) {
          assert.equal(row.column_name, 'id');
          assert.equal(row.data_type, 'bigint');
          assert.equal(row.is_identity, 'YES');
        }
        const timestamps = await store.pool.query(
          "select count(*)::int as count from information_schema.columns where table_schema = 'public' and column_name in ('created_at', 'updated_at') and is_nullable = 'NO'",
        );
        assert.equal(timestamps.rows[0].count, dumpTables.length * 2);
        const references = await store.pool
          .query(`select count(*)::int as count from information_schema.referential_constraints rc
        join information_schema.key_column_usage kcu on kcu.constraint_schema = rc.unique_constraint_schema and kcu.constraint_name = rc.unique_constraint_name
        where rc.constraint_schema = 'public' and kcu.column_name = 'id'`);
        assert.equal(references.rows[0].count, 4);
      },
    );
    const scope = mailScope('test-user', 'INBOX', '1');
    const since = new Date('2026-10-01T00:00:00Z');
    await store.ensureMailbox(scope, {
      mailbox: 'INBOX',
      uidValidity: '1',
      since: since.toISOString(),
    });
    await t.test(
      'different accounts, folders and UIDVALIDITY never reuse the same UID identity',
      () => {
        assert.notEqual(scope, mailScope('other', 'INBOX', '1'));
        assert.notEqual(scope, mailScope('test-user', 'Sent', '1'));
        assert.notEqual(scope, mailScope('test-user', 'INBOX', '2'));
      },
    );
    await t.test('a failed low UID is retried even after a higher UID was saved', async () => {
      let fail = true;
      let bodyDownloads = 0;
      const client = {
        mailbox: { path: 'INBOX', uidValidity: 1, exists: 2 },
        search: async () => [1, 2],
        fetchAll: async (uids: number[], query: { source?: boolean }) => {
          if (query.source) {
            bodyDownloads += uids.length;
            return uids
              .filter((uid) => !(fail && uid === 1))
              .map((uid) => ({
                uid,
                source: Buffer.from(
                  `From: test@example.com\r\nSubject: mail ${uid}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello`,
                ),
              }));
          }
          return uids.map((uid) => ({
            uid,
            size: 300,
            internalDate: new Date('2026-11-01T00:00:00Z'),
            flags: new Set(),
            envelope: { subject: `mail ${uid}` },
          }));
        },
      } as unknown as ImapFlow;
      const first = await collect(client, since, directory, 10000, { store, scope });
      assert.equal(first.complete, false);
      assert.equal(first.errors[0]?.uid, 1);
      assert.equal((await store.status()).mailboxes[0]?.lastObservedUid, 2);
      fail = false;
      const second = await collect(client, new Date('2026-11-01T00:00:00Z'), directory, 10000, {
        store,
        scope,
      });
      assert.equal(second.complete, true);
      assert.deepEqual(second.messages.map((m) => m.uid).sort(), [1, 2]);
      assert.equal(typeof second.messages[0]?.from, 'string');
      assert.equal(second.since, since.toISOString());
      assert.equal(bodyDownloads, 3); // UID 2 is not downloaded again.
      assert.equal((await store.status()).mailCounts[0]?.errors, 0);
    });
    const mail: CollectedMail = {
      ...(await store.cachedMails(scope)).get(1)!,
      subject: '予約',
      text: "引用符 ' と \\ と改行\n日本語 $$; COMMIT; --",
      receivedAt: '2026-11-01T00:00:00Z',
    };
    await store.saveMail(scope, mail);
    await t.test(
      'inference cache checks model identity and revalidates without running inference',
      async (t) => {
        const digest = 'a'.repeat(64);
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
          const path = String(input);
          if (path.endsWith('/api/tags'))
            return Response.json({ models: [{ name: 'test-model', model: 'test-model', digest }] });
          if (path.endsWith('/api/show')) return Response.json({ details: { format: 'gguf' } });
          throw new Error('保存済み抽出に対して推論を呼び出してはいけません');
        });
        const extraction: Extraction = {
          intent: 'not_event',
          reason: '予定ではない',
          evidence: '',
          events: [],
        };
        const key = extractionCacheKey(mail, 'test-model', digest);
        await store.saveExtraction(key, 'test-model', extraction);
        const collection: Collection = {
          version: 1,
          mailbox: 'INBOX',
          uidValidity: '1',
          since: since.toISOString(),
          collectedAt: new Date().toISOString(),
          matched: 1,
          complete: true,
          messages: [mail],
          errors: [],
          sourceScope: scope,
        };
        const report = await writeDryRun(
          collection,
          directory,
          undefined,
          new Date('2026-11-17T00:00:00Z'),
          'test-model',
          store,
        );
        assert.equal(report.complete, true);
        assert.notEqual(extractionCacheKey(mail, 'test-model', 'b'.repeat(64)), key);
        assert.equal((await store.cachedMails(scope)).size, 2);
      },
    );
    await t.test('concurrent processors cannot acquire the same target lock', async () => {
      const unlock = await store.lock('same-calendar');
      try {
        await assert.rejects(store.lock('same-calendar'), /実行中/);
      } finally {
        await unlock();
      }
      await (
        await store.lock('same-calendar')
      )();
    });
    await t.test(
      'output-limit reviews are cached and explicit retry can replace them with a valid extraction',
      async (t) => {
        let inferenceCalls = 0;
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
          if (String(input).endsWith('/api/tags'))
            return Response.json({ models: [{ name: 'length-test', digest: 'c'.repeat(64) }] });
          if (String(input).endsWith('/api/show'))
            return Response.json({ details: { format: 'gguf' } });
          inferenceCalls++;
          return new Response(
            JSON.stringify(
              inferenceCalls === 1
                ? { message: { content: '{' }, done: true, done_reason: 'length' }
                : {
                    message: {
                      content: JSON.stringify({
                        intent: 'not_event',
                        reason: '予定なし',
                        evidence: '',
                        events: [],
                      }),
                    },
                    done: true,
                    done_reason: 'stop',
                  },
            ) + '\n',
          );
        });
        const collection: Collection = {
          version: 1,
          mailbox: 'INBOX',
          uidValidity: '1',
          since: since.toISOString(),
          collectedAt: new Date().toISOString(),
          matched: 1,
          complete: true,
          messages: [mail],
          errors: [],
          sourceScope: scope,
        };
        const first = await writeDryRun(
          collection,
          directory,
          undefined,
          new Date('2026-11-17T00:00:00Z'),
          'length-test',
          store,
        );
        assert.equal(first.complete, true);
        assert.equal(first.summary.review, 1);
        assert.equal(first.proposed.length, 0);
        const second = await writeDryRun(
          collection,
          directory,
          undefined,
          new Date('2026-11-17T00:00:00Z'),
          'length-test',
          store,
        );
        assert.equal(second.summary.review, 1);
        assert.equal(inferenceCalls, 1);
        const third = await writeDryRun(
          collection,
          directory,
          undefined,
          new Date('2026-11-17T00:00:00Z'),
          'length-test',
          store,
          { retryReviews: true },
        );
        assert.equal(third.complete, true);
        assert.equal(third.summary.review, 0);
        assert.equal(inferenceCalls, 2);
      },
    );
    const eventKey = 'a'.repeat(64);
    const selected: SelectedEvent = {
      sourceUid: 1,
      eventKey,
      iCalUID: 'test@local',
      payload: {
        summary: '予約',
        location: '',
        description: '',
        start: { dateTime: '2099-11-30T09:00:00+09:00' },
        end: { dateTime: '2099-11-30T10:00:00+09:00' },
        extendedProperties: { private: { sourceEventKey: eventKey } },
      },
    };
    const target = 'test-target';
    const run = await store.startRun('calendar:apply', target);
    await store.saveSync(run, target, 'primary', scope, selected, {
      eventKey,
      sourceUid: 1,
      action: 'possible_duplicate',
      googleEventId: 'existing',
    });
    await store.finishRun(run, 'needs_attention', { possible_duplicate: 1 });
    await t.test(
      'holds are saved and rechecked, while manual skip/duplicate decisions persist',
      async () => {
        assert.equal((await store.holds()).length, 1);
        let inserts = 0;
        const port: CalendarPort = {
          get: async (id) =>
            id === 'existing'
              ? { id, summary: 'different name', start: selected.payload.start }
              : null,
          list: async () => [
            { id: 'existing', summary: 'different name', start: selected.payload.start },
          ],
          insert: async (payload) => {
            inserts++;
            return payload;
          },
        };
        const selection = {
          executedAt: new Date().toISOString(),
          events: [selected],
          pastSkipped: 0,
          repeatedSkipped: 0,
        };
        const options = {
          apply: true,
          resolution: (e: SelectedEvent) => store.resolution(target, e.eventKey),
        };
        assert.equal(
          (await syncCalendar(selection, port, options))[0]?.action,
          'possible_duplicate',
        );
        await store.resolve(target, eventKey, 'skip');
        assert.equal((await syncCalendar(selection, port, options))[0]?.action, 'skipped');
        assert.equal((await store.holds()).length, 0);
        await store.resolve(target, eventKey, 'duplicate', 'existing');
        assert.equal((await syncCalendar(selection, port, options))[0]?.action, 'duplicate');
        const originalGet = port.get;
        port.get = async () => null;
        const missingLink = (await syncCalendar(selection, port, options))[0]!;
        assert.equal(missingLink.action, 'possible_duplicate');
        await store.saveSync(run, target, 'primary', scope, selected, missingLink);
        assert.equal((await store.holds()).length, 1);
        port.get = originalGet;
        await store.resolve(target, eventKey, 'retry');
        assert.equal(
          (await syncCalendar(selection, port, options))[0]?.action,
          'possible_duplicate',
        );
        port.list = async () => [];
        assert.equal((await syncCalendar(selection, port, options))[0]?.action, 'created');
        assert.equal(inserts, 1);
        assert.ok(googleEventId(eventKey));
      },
    );
    await t.test(
      'all tables dump one INSERT per row, preserve JSON/NULL/quotes and restore atomically',
      async () => {
        const dumped = await dumpDatabase(store, join(directory, 'dump'));
        const sql = await readFile(join(dumped.directory, 'mails', 'data.sql'), 'utf8');
        assert.equal((sql.match(/INSERT INTO/g) ?? []).length, 2);
        assert.equal(sql.split('\n').filter((line) => line.startsWith('INSERT INTO')).length, 2);
        assert.match(sql, /ALTER SEQUENCE .* RESTART WITH \d+;/);
        assert.doesNotMatch(sql, /COPY /);
        await assert.rejects(restoreDatabase(store, join(directory, 'dump')), /データが存在/);
        await restoreDatabase(store, join(directory, 'dump'), true);
        assert.deepEqual((await store.cachedMails(scope)).get(1), mail);
        assert.equal((await store.holds()).length, 1);
        // A valid manifest with invalid SQL must roll back the earlier truncation and INSERTs too.
        const manifestPath = join(dumped.directory, 'manifest.json');
        const manifestText = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestText);
        const attemptsPath = join(dumped.directory, 'sync_attempts', 'data.sql');
        const attemptsSql = await readFile(attemptsPath, 'utf8');
        await writeFile(attemptsPath, 'INVALID SQL;');
        manifest.tables.find((t: { name: string }) => t.name === 'sync_attempts').checksum =
          hash('INVALID SQL;');
        await writeFile(manifestPath, JSON.stringify(manifest));
        await assert.rejects(restoreDatabase(store, dumped.directory, true));
        assert.deepEqual((await store.cachedMails(scope)).get(1), mail);
        await writeFile(attemptsPath, attemptsSql);
        await writeFile(manifestPath, manifestText);
        // Exercise the default non-replacing import into an empty, migrated test database.
        await store.pool.query(
          `TRUNCATE ${dumpTables.map((name) => `"public"."${name}"`).join(', ')}`,
        );
        await restoreDatabase(store, join(directory, 'dump'));
        assert.deepEqual((await store.cachedMails(scope)).get(1), mail);
        // Explicit ids restored from SQL must not collide with the next automatic id in any table.
        const maxima = new Map<string, bigint>();
        for (const table of dumpTables) {
          const result = await store.pool.query(
            `select coalesce(max(id), 0)::text as max from "${table}"`,
          );
          maxima.set(table, BigInt(result.rows[0].max));
        }
        await store.ensureMailbox('new-scope', {
          mailbox: 'Sent',
          uidValidity: '1',
          since: since.toISOString(),
        });
        await store.saveMail(scope, { ...mail, uid: 100 });
        await store.saveExtraction('new-key', 'test-model', {
          intent: 'not_event',
          reason: '',
          evidence: '',
          events: [],
        });
        const nextRun = await store.startRun('calendar:apply', target);
        await store.saveSync(
          nextRun,
          target,
          'primary',
          scope,
          { ...selected, sourceUid: 100, eventKey: 'b'.repeat(64) },
          { eventKey: 'b'.repeat(64), sourceUid: 100, action: 'created' },
        );
        for (const table of dumpTables) {
          const result = await store.pool.query(`select max(id)::text as max from "${table}"`);
          assert.ok(
            BigInt(result.rows[0].max) > maxima.get(table)!,
            `${table}: sequence must advance`,
          );
        }
        const path = join(dumped.directory, 'mails', 'data.sql');
        await writeFile(path, sql + '-- damaged');
        await assert.rejects(restoreDatabase(store, dumped.directory, true), /チェックサム/);
        assert.deepEqual((await store.cachedMails(scope)).get(1), mail);
      },
    );
  } finally {
    await store.close();
    // This database was created by this test; never use the configured application DB for destructive tests.
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
