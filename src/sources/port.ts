import type { CollectedMail, MailboxSource, MessageSource } from '../domain/mail.js';

export type MailHeader = Omit<
  CollectedMail,
  'text' | 'attachments' | 'calendarParts' | 'source'
> & { source: MessageSource };
export type MailCheckpoint = { lastMessageId?: string; cursor?: string };
export interface MailboxReader {
  readonly source: MailboxSource;
  list(since: Date): Promise<{ messages: MailHeader[]; checkpoint: MailCheckpoint }>;
  readBatch(headers: MailHeader[], maxBytes: number): Promise<Map<string, CollectedMail | Error>>;
}
