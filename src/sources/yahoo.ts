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
  mailbox?: string,
  store?: Store,
): Promise<Collection> {
  const account = yahooAccount();
  const folders = mailbox
    ? [mailbox]
    : await withMailbox('INBOX', async (client) =>
        (await client.list())
          .filter(
            (f) =>
              !['\\Sent', '\\Drafts', '\\Junk', '\\Trash'].includes(f.specialUse ?? '') &&
              !f.flags.has('\\Noselect'),
          )
          .map((f) => f.path),
      );
  const collections: Collection[] = [];
  for (const folder of folders) {
    console.error(`取得フォルダー: ${folder}`);
    const collected = await withMailbox(folder, async (client) => {
      const generation = String(client.mailbox && client.mailbox.uidValidity);
      const scope = sourceScope({ account, id: folder, name: folder, generation });
      return collectSource(
        imapReader(client, account),
        since,
        join(directory, 'sources', scope),
        maxBytes,
        store,
      );
    });
    collections.push(normalizeYahooCache(collected, account));
  }
  const messages = mergeMessages(collections.flatMap((c) => c.messages));
  const result: Collection = {
    version: 1,
    mailbox: mailbox ?? 'all received folders',
    uidValidity: 'multiple',
    since: collections.map((c) => c.since).sort()[0] ?? since.toISOString(),
    collectedAt: new Date().toISOString(),
    matched: collections.reduce((n, c) => n + c.matched, 0),
    complete: collections.every((c) => c.complete),
    messages,
    errors: collections
      .flatMap((c) =>
        c.errors.map((e) => ({
          ...e,
          source: e.source ?? { ...c.source!, messageId: String(e.uid) },
        })),
      )
      .map((e, i) => ({ ...e, uid: -(i + 1) })),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'mail-cache.json'), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  return result;
}
