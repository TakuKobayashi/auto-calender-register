import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as tables from './schema.js';
import type { Collection, CollectedMail } from '../collect.js';
import type { MailPlan } from '../classify.js';
import type { CachedExtraction } from '../ollama.js';
import type { SelectedEvent } from '../selection.js';
import type { SyncRow } from '../google-calendar.js';
import { databaseUrl } from './connection.js';

export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function mailScope(account: string, mailbox: string, uidValidity: string) {
  return hash({ account, mailbox, uidValidity });
}
export function calendarTarget(account: string, calendarId: string) {
  return hash({ account, calendarId });
}

export class Store {
  readonly pool: pg.Pool;
  readonly db;
  constructor(url = databaseUrl()) {
    this.pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 10_000 });
    this.pool.on('error', () => {});
    this.db = drizzle(this.pool, { schema: tables });
  }
  async close() {
    await this.pool.end();
  }

  // Hold a session advisory lock for the entire CLI operation, including API calls.
  async lock(key: string, shared = false) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        shared
          ? 'select pg_try_advisory_lock_shared(hashtextextended($1, 0)) as locked'
          : 'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
        [key],
      );
      if (!result.rows[0]?.locked) throw new Error('同じ対象の処理が別プロセスで実行中です。');
      return async () => {
        try {
          await client.query(
            shared
              ? 'select pg_advisory_unlock_shared(hashtextextended($1, 0))'
              : 'select pg_advisory_unlock(hashtextextended($1, 0))',
            [key],
          );
        } finally {
          client.release();
        }
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }
  async startRun(kind: string, scope: string) {
    const [run] = await this.db
      .insert(tables.runs)
      .values({ kind, scope })
      .returning({ id: tables.runs.id });
    return run!.id;
  }
  async finishRun(id: number, status: string, summary: unknown) {
    await this.db
      .update(tables.runs)
      .set({ status, summary, finishedAt: new Date() })
      .where(eq(tables.runs.id, id));
  }
  async ensureMailbox(
    scope: string,
    collection: Pick<Collection, 'mailbox' | 'uidValidity' | 'since'>,
  ) {
    await this.db
      .insert(tables.mailboxes)
      .values({ scope, ...collection, since: new Date(collection.since) })
      .onConflictDoUpdate({
        target: tables.mailboxes.scope,
        set: {
          since: sql`least(${tables.mailboxes.since}, ${collection.since}::timestamptz)`,
          updatedAt: new Date(),
        },
      });
  }
  async scanSince(scope: string, requested: Date) {
    const row = (
      await this.db.select().from(tables.mailboxes).where(eq(tables.mailboxes.scope, scope))
    )[0];
    return row && row.since < requested ? row.since : requested;
  }
  private async mailboxId(scope: string) {
    const [row] = await this.db
      .select({ id: tables.mailboxes.id })
      .from(tables.mailboxes)
      .where(eq(tables.mailboxes.scope, scope));
    if (!row)
      throw new Error('メールボックスの記録がありません。先にメール取得・選別を実行してください。');
    return row.id;
  }
  async requireSourceMails(scope: string, events: SelectedEvent[]) {
    if (!events.length) return;
    const mailboxId = await this.mailboxId(scope);
    const uids = [...new Set(events.map((e) => e.sourceUid))];
    const rows = await this.db
      .select({ uid: tables.mails.uid })
      .from(tables.mails)
      .where(and(eq(tables.mails.mailboxId, mailboxId), inArray(tables.mails.uid, uids)));
    if (rows.length !== uids.length)
      throw new Error(
        '元メールがDBにありません。先にDBを有効にしてメール取得・選別を実行してください。',
      );
  }
  async cachedMails(scope: string) {
    const mailboxId = await this.mailboxId(scope);
    return new Map(
      (await this.db.select().from(tables.mails).where(eq(tables.mails.mailboxId, mailboxId)))
        .filter((r) => r.data !== null)
        .map((r) => [r.uid, r.data!]),
    );
  }
  async saveMail(scope: string, mail: CollectedMail) {
    const mailboxId = await this.mailboxId(scope);
    await this.db
      .insert(tables.mails)
      .values({
        mailboxId,
        uid: mail.uid,
        data: mail,
        receivedAt: mail.receivedAt ? new Date(mail.receivedAt) : null,
      })
      .onConflictDoUpdate({
        target: [tables.mails.mailboxId, tables.mails.uid],
        set: { data: mail, fetchError: null, updatedAt: new Date() },
      });
  }
  async fetchError(scope: string, uid: number, reason: string) {
    const mailboxId = await this.mailboxId(scope);
    await this.db
      .insert(tables.mails)
      .values({ mailboxId, uid, fetchError: reason })
      .onConflictDoUpdate({
        target: [tables.mails.mailboxId, tables.mails.uid],
        set: { fetchError: reason, updatedAt: new Date() },
      });
  }
  async completeScan(scope: string, lastObservedUid: number, complete: boolean) {
    await this.db
      .update(tables.mailboxes)
      .set({
        lastObservedUid: sql`greatest(${tables.mailboxes.lastObservedUid}, ${lastObservedUid})`,
        ...(complete ? { lastCompleteScanAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tables.mailboxes.scope, scope));
  }
  async savePlans(scope: string, plans: MailPlan[]) {
    const mailboxId = await this.mailboxId(scope);
    for (const plan of plans)
      await this.db
        .update(tables.mails)
        .set({ plan, updatedAt: new Date() })
        .where(and(eq(tables.mails.mailboxId, mailboxId), eq(tables.mails.uid, plan.uid)));
  }
  async getExtraction(key: string) {
    return (
      await this.db.select().from(tables.extractions).where(eq(tables.extractions.key, key))
    )[0]?.data;
  }
  async saveExtraction(key: string, model: string, data: CachedExtraction) {
    await this.db
      .insert(tables.extractions)
      .values({ key, model, data })
      .onConflictDoUpdate({ target: tables.extractions.key, set: { model, data } });
  }
  async resolution(target: string, eventKey: string) {
    return (
      await this.db
        .select()
        .from(tables.calendarStates)
        .where(
          and(
            eq(tables.calendarStates.target, target),
            eq(tables.calendarStates.eventKey, eventKey),
          ),
        )
    )[0];
  }
  async saveSync(
    runId: number,
    target: string,
    calendarId: string,
    sourceScope: string,
    selected: SelectedEvent,
    row: SyncRow,
  ) {
    const mailboxId = await this.mailboxId(sourceScope);
    const [sourceMail] = await this.db
      .select({ id: tables.mails.id })
      .from(tables.mails)
      .where(and(eq(tables.mails.mailboxId, mailboxId), eq(tables.mails.uid, selected.sourceUid)));
    if (!sourceMail)
      throw new Error('元メールがDBにありません。先にメール取得・選別を実行してください。');
    await this.db.transaction(async (tx) => {
      const [state] = await tx
        .insert(tables.calendarStates)
        .values({
          target,
          calendarId,
          sourceMailId: sourceMail.id,
          eventKey: row.eventKey,
          title: selected.payload.summary,
          start: new Date(selected.payload.start.dateTime),
          action: row.action,
          reason: row.reason,
          googleEventId: row.googleEventId,
          attempts: 1,
        })
        .onConflictDoUpdate({
          target: [tables.calendarStates.target, tables.calendarStates.eventKey],
          set: {
            action: row.action,
            sourceMailId: sourceMail.id,
            reason: row.reason ?? null,
            googleEventId: row.googleEventId ?? null,
            attempts: sql`${tables.calendarStates.attempts} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: tables.calendarStates.id });
      await tx
        .insert(tables.syncAttempts)
        .values({ runId, calendarStateId: state!.id, row })
        .onConflictDoUpdate({
          target: [tables.syncAttempts.runId, tables.syncAttempts.calendarStateId],
          set: { row },
        });
    });
  }
  async resolve(
    target: string,
    eventKey: string,
    decision: 'skip' | 'retry' | 'duplicate',
    googleEventId?: string,
  ) {
    if (decision === 'duplicate' && !googleEventId)
      throw new Error('duplicateには --google-event-id が必要です。');
    const rows = await this.db
      .update(tables.calendarStates)
      .set({
        resolution: decision === 'retry' ? null : decision,
        resolvedGoogleEventId: decision === 'duplicate' ? googleEventId : null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(tables.calendarStates.target, target), eq(tables.calendarStates.eventKey, eventKey)),
      )
      .returning();
    if (!rows.length) throw new Error('指定した予定の記録がありません。');
    return rows[0];
  }
  async status() {
    return {
      mailboxes: await this.db.select().from(tables.mailboxes),
      mailCounts: await this.db
        .select({
          mailboxId: tables.mails.mailboxId,
          count: sql<number>`count(*)::int`,
          errors: sql<number>`count(*) filter (where fetch_error is not null)::int`,
        })
        .from(tables.mails)
        .groupBy(tables.mails.mailboxId),
      runs: await this.db.select().from(tables.runs).orderBy(desc(tables.runs.startedAt)).limit(20),
    };
  }
  async holds() {
    return this.db
      .select()
      .from(tables.calendarStates)
      .where(
        and(
          inArray(tables.calendarStates.action, ['possible_duplicate', 'error']),
          sql`${tables.calendarStates.start} > now()`,
          sql`(${tables.calendarStates.resolution} is null or (${tables.calendarStates.resolution} = 'duplicate' and ${tables.calendarStates.action} = 'possible_duplicate'))`,
        ),
      );
  }
  async reviews() {
    return this.db
      .select({
        id: tables.mails.id,
        mailboxId: tables.mails.mailboxId,
        uid: tables.mails.uid,
        plan: tables.mails.plan,
      })
      .from(tables.mails)
      .where(sql`${tables.mails.plan}->>'decision' in ('review', 'pending', 'error')`);
  }
}
