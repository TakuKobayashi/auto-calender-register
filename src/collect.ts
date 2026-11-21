import { mkdir, writeFile } from 'node:fs/promises';
import {
  sourceScope,
  type CollectedMail,
  type MailboxSource,
  type MessageSource,
} from './domain/mail.js';
import type { Store } from './db/store.js';
import type { MailboxReader } from './sources/port.js';
export type { CollectedMail } from './domain/mail.js';

export type Collection = {
  version: 1;
  mailbox: string;
  uidValidity: string;
  since: string;
  collectedAt: string;
  matched: number;
  complete: boolean;
  messages: CollectedMail[];
  errors: { uid: number; subject: string; reason: string; from?: string; source?: MessageSource }[];
  sourceScope?: string;
  source?: MailboxSource;
};

export async function collectSource(
  reader: MailboxReader,
  since: Date,
  directory: string,
  maxBytes: number,
  store?: Store,
): Promise<Collection> {
  const scope = sourceScope(reader.source);
  if (store) since = await store.scanSince(scope, since);
  const { messages: index, checkpoint } = await reader.list(since);
  const result: Collection = {
    version: 1,
    mailbox: reader.source.name,
    uidValidity: reader.source.generation ?? '',
    since: since.toISOString(),
    collectedAt: new Date().toISOString(),
    matched: index.length,
    complete: false,
    messages: [],
    errors: [],
    sourceScope: scope,
    source: reader.source,
  };
  if (store) await store.ensureMailbox(scope, { ...result, source: reader.source });
  const cached = store ? await store.cachedMails(scope) : new Map<string, CollectedMail>();
  const indexed = new Set(index.map((m) => m.source.messageId));
  const retained = [...cached.values()].filter(
    (m) =>
      !indexed.has(m.source!.messageId) &&
      m.receivedAt &&
      Date.parse(m.receivedAt) >= since.getTime(),
  );
  result.messages.push(...retained);
  result.matched += retained.length;
  await mkdir(directory, { recursive: true });
  const save = () =>
    writeFile(`${directory}/mail-cache.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
  await save();
  const reused = index.filter((header) => cached.has(header.source.messageId)).length;
  console.error(
    `対象メール: ${index.length}件（${reader.source.name}） / 本文再利用: ${reused}件 / 未取得: ${index.length - reused}件`,
  );
  for (let i = 0; i < index.length; i += 5) {
    const batch = index.slice(i, i + 5);
    for (const header of batch) {
      const previous = cached.get(header.source.messageId);
      if (previous)
        result.messages.push({
          ...previous,
          uid: header.uid,
          source: header.source,
          flags: header.flags,
          size: header.size,
        });
    }
    const missing = batch.filter((m) => !cached.has(m.source.messageId));
    const allowed = missing.filter((m) => m.size !== undefined && m.size <= maxBytes);
    const values = allowed.length
      ? await reader.readBatch(allowed, maxBytes)
      : new Map<string, CollectedMail | Error>();
    for (const header of missing) {
      const value = values.get(header.source.messageId);
      if (value && !(value instanceof Error)) {
        // Storage failures are operational failures, not mail parsing results.
        if (store) await store.saveMail(scope, value);
        result.messages.push(value);
      } else {
        const reason = !allowed.includes(header)
          ? 'サイズ不明または取得上限超過'
          : '本文の取得・解析失敗';
        result.errors.push({
          uid: header.uid,
          from: header.from,
          subject: header.subject,
          source: header.source,
          reason,
        });
        if (store) await store.fetchError(scope, header.source.messageId, reason);
      }
    }
    if ((i + 5) % 25 === 0 || i + 5 >= index.length) {
      if (!store) await save();
      console.error(
        `取得: ${Math.min(i + 5, index.length)}/${index.length}件（${reader.source.name}）`,
      );
    }
  }
  result.complete = result.errors.length === 0;
  if (store) await store.completeScan(scope, checkpoint, result.complete);
  await save();
  return result;
}
