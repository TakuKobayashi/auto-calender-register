import { mkdir, writeFile } from 'node:fs/promises';
import type { ImapFlow } from 'imapflow';
import { listSinceMail, mailboxInfo, parseMail, summary } from './mail.js';
import type { Store } from './db/store.js';

export type CollectedMail = Omit<
  ReturnType<typeof summary>,
  keyof Awaited<ReturnType<typeof parseMail>>
> &
  Awaited<ReturnType<typeof parseMail>>;
export type Collection = {
  version: 1;
  mailbox: string;
  uidValidity: string;
  since: string;
  collectedAt: string;
  matched: number;
  complete: boolean;
  messages: CollectedMail[];
  errors: { uid: number; subject: string; reason: string }[];
  sourceScope?: string;
};

export async function collect(
  client: ImapFlow,
  since: Date,
  directory: string,
  maxBytes: number,
  persistence?: { store: Store; scope: string },
) {
  const info = mailboxInfo(client);
  if (persistence) since = await persistence.store.scanSince(persistence.scope, since);
  const index = await listSinceMail(client, since);
  const result: Collection = {
    version: 1,
    mailbox: info.mailbox,
    uidValidity: info.uidValidity,
    since: since.toISOString(),
    collectedAt: new Date().toISOString(),
    matched: index.length,
    complete: false,
    messages: [],
    errors: [],
  };
  if (persistence) {
    result.sourceScope = persistence.scope;
    await persistence.store.ensureMailbox(persistence.scope, result);
  }
  const cached = persistence
    ? await persistence.store.cachedMails(persistence.scope)
    : new Map<number, CollectedMail>();
  // Keep archived/deleted source mail available for unfinished calendar checks and later cancellation matching.
  const indexed = new Set(index.map((m) => m.uid));
  const retained = [...cached.values()].filter(
    (m) => !indexed.has(m.uid) && m.receivedAt && Date.parse(m.receivedAt) >= since.getTime(),
  );
  result.messages.push(...retained);
  result.matched += retained.length;
  await mkdir(directory, { recursive: true });
  const save = () =>
    writeFile(`${directory}/mail-cache.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.error(`対象メール: ${index.length}件。本文を読み取り専用で取得します。`);
  for (let i = 0; i < index.length; i += 5) {
    const batch = index.slice(i, i + 5);
    for (const m of batch) {
      const saved = cached.get(m.uid);
      if (saved) result.messages.push({ ...m, ...saved, flags: m.flags, size: m.size });
    }
    const missing = batch.filter((m) => !cached.has(m.uid));
    const allowed = missing.filter((m) => m.size !== undefined && m.size <= maxBytes);
    for (const m of missing.filter((m) => !allowed.includes(m))) {
      result.errors.push({
        uid: m.uid,
        subject: m.subject,
        reason: 'サイズ不明または取得上限超過',
      });
    }
    if (allowed.length) {
      const fetched = await client.fetchAll(
        allowed.map((m) => m.uid),
        { uid: true, source: true },
        { uid: true },
      );
      for (const m of allowed) {
        const source = fetched.find((f) => f.uid === m.uid)?.source;
        try {
          if (!source || source.length > maxBytes) throw new Error('本文なし、または取得上限超過');
          const parsed = { ...m, ...(await parseMail(source)) };
          if (persistence) await persistence.store.saveMail(persistence.scope, parsed);
          result.messages.push(parsed);
        } catch {
          result.errors.push({ uid: m.uid, subject: m.subject, reason: '本文の取得・解析失敗' });
        }
      }
    }
    if ((i + 5) % 25 === 0 || i + 5 >= index.length) {
      await save();
      console.error(`取得: ${Math.min(i + 5, index.length)}/${index.length}件`);
    }
  }
  result.complete = result.errors.length === 0;
  if (persistence) {
    for (const error of result.errors)
      await persistence.store.fetchError(persistence.scope, error.uid, error.reason);
    await persistence.store.completeScan(
      persistence.scope,
      Math.max(0, ...index.map((m) => m.uid)),
      result.complete,
    );
  }
  await save();
  return result;
}
