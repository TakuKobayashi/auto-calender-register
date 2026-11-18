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
import { sourceScope, type MailboxSource, type MailAccount } from '../domain/mail.js';

export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function mailScope(account: MailAccount, mailbox: string, uidValidity: string) {
  return sourceScope({ account, id: mailbox, name: mailbox, generation: uidValidity || undefined });
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
    collection: Pick<Collection, 'mailbox' | 'uidValidity' | 'since'> & { source: MailboxSource },
  ) {
    const account = collection.source.account;
    const [storedAccount] = await this.db
      .insert(tables.mailAccounts)
      .values({
        provider: account.provider,
        accountKey: account.key,
        label: account.label ?? account.key,
      })
      .onConflictDoUpdate({
        target: [tables.mailAccounts.provider, tables.mailAccounts.accountKey],
        set: { label: account.label ?? account.key },
      })
      .returning({ id: tables.mailAccounts.id });
    await this.db
      .insert(tables.mailboxes)
      .values({
        scope,
        mailAccountId: storedAccount!.id,
        mailbox: collection.source.name,
        providerMailboxId: collection.source.id,
        generation: collection.source.generation,
        since: new Date(collection.since),
      })
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
  async requireSourceMails(events: SelectedEvent[]) {
    if (!events.length) return;
    for (const event of events) {
      if (!event.source)
        throw new Error('元メールの取得元情報がありません。選別を再実行してください。');
      const mailboxId = await this.mailboxId(sourceScope(event.source));
      const rows = await this.db
        .select({ id: tables.mails.id })
        .from(tables.mails)
        .where(
          and(
            eq(tables.mails.mailboxId, mailboxId),
            eq(tables.mails.providerMessageId, event.source.messageId),
          ),
        );
      if (!rows.length)
        throw new Error('元メールがDBにありません。先にメール取得・選別を実行してください。');
    }
  }
  async cachedMails(scope: string) {
    const mailboxId = await this.mailboxId(scope);
    return new Map(
      (await this.db.select().from(tables.mails).where(eq(tables.mails.mailboxId, mailboxId)))
        .filter((r) => r.data !== null)
        .map((r) => [r.providerMessageId, r.data!]),
    );
  }
  async saveMail(scope: string, mail: CollectedMail) {
    if (!mail.source) throw new Error('元メールの取得元情報がありません。');
    const mailboxId = await this.mailboxId(scope);
    await this.db
      .insert(tables.mails)
      .values({
        mailboxId,
        providerMessageId: mail.source.messageId,
        internetMessageId: mail.messageId,
        from: mail.from,
        subject: mail.subject,
        data: mail,
        receivedAt: mail.receivedAt ? new Date(mail.receivedAt) : null,
      })
      .onConflictDoUpdate({
        target: [tables.mails.mailboxId, tables.mails.providerMessageId],
        set: {
          data: mail,
          internetMessageId: mail.messageId,
          from: mail.from,
          subject: mail.subject,
          fetchError: null,
          updatedAt: new Date(),
        },
      });
  }
  async fetchError(scope: string, messageId: string, reason: string) {
    const mailboxId = await this.mailboxId(scope);
    await this.db
      .insert(tables.mails)
      .values({ mailboxId, providerMessageId: messageId, fetchError: reason })
      .onConflictDoUpdate({
        target: [tables.mails.mailboxId, tables.mails.providerMessageId],
        set: { fetchError: reason, updatedAt: new Date() },
      });
  }
  async completeScan(
    scope: string,
    checkpoint: { lastMessageId?: string; cursor?: string },
    complete: boolean,
  ) {
    await this.db
      .update(tables.mailboxes)
      .set({
        checkpoint,
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
        .where(
          and(
            eq(tables.mails.mailboxId, mailboxId),
            eq(tables.mails.providerMessageId, plan.source!.messageId),
          ),
        );
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
  async saveSync(
    runId: number,
    target: string,
    calendarId: string,
    selected: SelectedEvent,
    row: SyncRow,
  ) {
    if (!selected.source) throw new Error('元メールの取得元情報がありません。');
    const mailboxId = await this.mailboxId(sourceScope(selected.source));
    const [sourceMail] = await this.db
      .select({ id: tables.mails.id })
      .from(tables.mails)
      .where(
        and(
          eq(tables.mails.mailboxId, mailboxId),
          eq(tables.mails.providerMessageId, selected.source.messageId),
        ),
      );
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
          shouldRegister: row.shouldRegister,
          reason: row.reason,
          googleEventId: row.googleEventId,
          attempts: 1,
        })
        .onConflictDoUpdate({
          target: [tables.calendarStates.target, tables.calendarStates.eventKey],
          set: {
            action: row.action,
            shouldRegister: row.shouldRegister,
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
  async decisions() {
    return this.db
      .select({
        id: tables.mails.id,
        mailboxId: tables.mails.mailboxId,
        providerMessageId: tables.mails.providerMessageId,
        from: tables.mails.from,
        subject: tables.mails.subject,
        plan: tables.mails.plan,
      })
      .from(tables.mails)
      .orderBy(desc(tables.mails.receivedAt));
  }
}
