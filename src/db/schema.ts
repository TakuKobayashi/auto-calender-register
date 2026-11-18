import {
  bigint,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  index,
  boolean,
} from 'drizzle-orm/pg-core';
import type { CollectedMail } from '../domain/mail.js';
import type { MailPlan } from '../classify.js';
import type { CachedExtraction } from '../ollama.js';
import type { SyncRow } from '../google-calendar.js';

const recordColumns = () => ({
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const mailAccounts = pgTable(
  'mail_accounts',
  {
    ...recordColumns(),
    provider: text('provider').notNull(),
    accountKey: text('account_key').notNull(),
    label: text('label').notNull(),
  },
  (t) => [unique('mail_accounts_provider_account_key_unique').on(t.provider, t.accountKey)],
);

export const mailboxes = pgTable('mailboxes', {
  ...recordColumns(),
  mailAccountId: bigint('mail_account_id', { mode: 'number' })
    .notNull()
    .references(() => mailAccounts.id),
  scope: text('scope').notNull().unique(),
  mailbox: text('mailbox').notNull(),
  providerMailboxId: text('provider_mailbox_id').notNull(),
  generation: text('generation'),
  checkpoint: jsonb('checkpoint').$type<{ lastMessageId?: string; cursor?: string }>(),
  lastCompleteScanAt: timestamp('last_complete_scan_at', { withTimezone: true }),
  since: timestamp('since', { withTimezone: true }).notNull(),
});

export const mails = pgTable(
  'mails',
  {
    ...recordColumns(),
    mailboxId: bigint('mailbox_id', { mode: 'number' })
      .notNull()
      .references(() => mailboxes.id),
    providerMessageId: text('provider_message_id').notNull(),
    internetMessageId: text('internet_message_id'),
    from: text('from').notNull().default(''),
    subject: text('subject').notNull().default(''),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    data: jsonb('data').$type<CollectedMail>(),
    fetchError: text('fetch_error'),
    plan: jsonb('plan').$type<MailPlan>(),
  },
  (t) => [
    unique('mails_mailbox_id_provider_message_id_unique').on(t.mailboxId, t.providerMessageId),
    index('mails_internet_message_id_index').on(t.internetMessageId),
  ],
);

export const extractions = pgTable('extractions', {
  ...recordColumns(),
  key: text('key').notNull().unique(),
  model: text('model').notNull(),
  data: jsonb('data').$type<CachedExtraction>().notNull(),
});

export const runs = pgTable(
  'runs',
  {
    ...recordColumns(),
    kind: text('kind').notNull(),
    scope: text('scope').notNull(),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    summary: jsonb('summary'),
  },
  (t) => [index('runs_scope_started_at_index').on(t.scope, t.startedAt)],
);

export const calendarStates = pgTable(
  'calendar_states',
  {
    ...recordColumns(),
    target: text('target').notNull(),
    calendarId: text('calendar_id').notNull(),
    eventKey: text('event_key').notNull(),
    sourceMailId: bigint('source_mail_id', { mode: 'number' })
      .notNull()
      .references(() => mails.id),
    title: text('title').notNull(),
    start: timestamp('start', { withTimezone: true }).notNull(),
    action: text('action').notNull(),
    shouldRegister: boolean('should_register').notNull(),
    reason: text('reason'),
    googleEventId: text('google_event_id'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    unique('calendar_states_target_event_key_unique').on(t.target, t.eventKey),
    index('calendar_states_source_mail_id_index').on(t.sourceMailId),
    index('calendar_states_action_start_index').on(t.action, t.start),
  ],
);

export const syncAttempts = pgTable(
  'sync_attempts',
  {
    ...recordColumns(),
    runId: bigint('run_id', { mode: 'number' })
      .notNull()
      .references(() => runs.id),
    calendarStateId: bigint('calendar_state_id', { mode: 'number' })
      .notNull()
      .references(() => calendarStates.id),
    row: jsonb('row').$type<SyncRow>().notNull(),
  },
  (t) => [
    unique('sync_attempts_run_id_calendar_state_id_unique').on(t.runId, t.calendarStateId),
    index('sync_attempts_calendar_state_id_index').on(t.calendarStateId),
  ],
);
