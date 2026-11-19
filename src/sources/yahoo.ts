import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectSource, type Collection } from '../collect.js';
import { withMailbox, listSinceMail, parseMail, mailboxInfo } from '../mail.js';
import type { ImapFlow } from 'imapflow';
import type { MailboxReader, MailHeader } from './port.js';
import type { CollectedMail } from '../domain/mail.js';
import { mergeMessages, sourceScope, type MailAccount } from '../domain/mail.js';
import type { Store } from '../db/store.js';

export function yahooAccount(): MailAccount {
  return {
    provider: 'yahoo-japan',
    key: (process.env.YAHOO_IMAP_USER ?? '').trim().toLowerCase(),
    label: 'Yahoo! JAPAN',
  };
}

export function normalizeYahooCache(collection: Collection, account = yahooAccount()): Collection {
  return {
    ...collection,
    messages: collection.messages.map((mail) => ({
      ...mail,
      source: mail.source ?? {
        account,
        id: collection.mailbox,
        name: collection.mailbox,
        generation: collection.uidValidity,
        messageId: String(mail.uid),
      },
    })),
  };
}

export function yahooMailboxes(names: string[] = ['INBOX']) {
  const folders = [
    ...new Set(
      names
        .flatMap((name) => name.split(','))
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => (name.toUpperCase() === 'INBOX' ? 'INBOX' : name)),
    ),
  ];
  if (!folders.length) throw new Error('対象フォルダーを1つ以上指定してください。');
  return folders;
}

export function selectYahooMailbox(collection: Collection, mailboxes?: string[]): Collection {
  const folders = yahooMailboxes(mailboxes);
  const matches = (name: string) =>
    folders.includes(name.toUpperCase() === 'INBOX' ? 'INBOX' : name);
  const messages = collection.messages.filter((mail) =>
    matches(mail.source?.id ?? collection.mailbox),
  );
  const errors = collection.errors.filter((error) =>
    matches(error.source?.id ?? collection.mailbox),
  );
  return {
    ...collection,
    mailbox: folders.join(', '),
    ...(folders.length > 1
      ? { uidValidity: 'multiple', source: undefined, sourceScope: undefined }
      : {}),
    messages: mergeMessages(messages),
    errors,
    matched: messages.length + errors.length,
  };
}

export function imapReader(client: ImapFlow, account: MailAccount): MailboxReader {
  const info = mailboxInfo(client);
  const source = { account, id: info.mailbox, name: info.mailbox, generation: info.uidValidity };
  return {
    source,
    async list(since) {
      const index = await listSinceMail(client, since);
      const address = (items: { name?: string; address?: string }[]) =>
        items
          .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
          .join(', ');
      const messages: MailHeader[] = index.map((m) => ({
        ...m,
        from: address(m.from),
        to: [address(m.to)],
        source: { ...source, messageId: String(m.uid) },
      }));
      return {
        messages,
        checkpoint: { lastMessageId: String(Math.max(0, ...index.map((m) => m.uid))) },
      };
    },
    async readBatch(headers, maxBytes) {
      const values = await client.fetchAll(
        headers.map((h) => Number(h.source.messageId)),
        { uid: true, source: true },
        { uid: true },
      );
      const parsed = new Map<string, CollectedMail | Error>();
      for (const header of headers) {
        try {
          const data = values.find((m) => String(m.uid) === header.source.messageId)?.source;
          if (!data || data.length > maxBytes) throw new Error('本文の取得上限超過または本文なし');
          parsed.set(header.source.messageId, { ...header, ...(await parseMail(data)) });
        } catch {
          parsed.set(header.source.messageId, new Error('本文解析失敗'));
        }
      }
      return parsed;
    },
  };
}

export function collectImapMailbox(
  client: ImapFlow,
  since: Date,
  directory: string,
  maxBytes: number,
  persistence: { store: Store; scope: string; account: MailAccount },
) {
  return collectSource(
    imapReader(client, persistence.account),
    since,
    directory,
    maxBytes,
    persistence.store,
  );
}

export async function collectYahoo(
  since: Date,
  directory: string,
  maxBytes: number,
  mailboxes?: string[],
  store?: Store,
): Promise<Collection> {
  const account = yahooAccount();
  const folders = yahooMailboxes(mailboxes);
  const collections: Collection[] = [];
  for (const mailbox of folders) {
    console.error(`取得フォルダー: ${mailbox}`);
    collections.push(
      await withMailbox(mailbox, async (client) => {
        const reader = imapReader(client, account);
        return collectSource(
          reader,
          since,
          join(directory, 'sources', sourceScope(reader.source)),
          maxBytes,
          store,
        );
      }),
    );
  }
  const result: Collection = {
    ...collections[0]!,
    mailbox: folders.join(', '),
    ...(folders.length > 1
      ? { uidValidity: 'multiple', source: undefined, sourceScope: undefined }
      : {}),
    since: collections.map((collection) => collection.since).sort()[0]!,
    collectedAt: new Date().toISOString(),
    matched: collections.reduce((count, collection) => count + collection.matched, 0),
    complete: collections.every((collection) => collection.complete),
    messages: mergeMessages(collections.flatMap((collection) => collection.messages)),
    errors: collections
      .flatMap((collection) => collection.errors)
      .map((error, i) => ({ ...error, uid: -(i + 1) })),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'mail-cache.json'), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  return result;
}
