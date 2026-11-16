import { mkdir, writeFile } from 'node:fs/promises';
import type { ImapFlow } from 'imapflow';
import { listSinceMail, mailboxInfo, parseMail, summary } from './mail.js';

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
};

export async function collect(client: ImapFlow, since: Date, directory: string, maxBytes: number) {
  const index = await listSinceMail(client, since);
  const info = mailboxInfo(client);
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
  await mkdir(directory, { recursive: true });
  const save = () =>
    writeFile(`${directory}/mail-cache.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.error(`対象メール: ${index.length}件。本文を読み取り専用で取得します。`);
  for (let i = 0; i < index.length; i += 5) {
    const batch = index.slice(i, i + 5);
    const allowed = batch.filter((m) => m.size !== undefined && m.size <= maxBytes);
    for (const m of batch.filter((m) => !allowed.includes(m))) {
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
          result.messages.push({ ...m, ...(await parseMail(source)) });
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
  await save();
  return result;
}
