import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { loadConfig } from './config.js';

export async function withMailbox<T>(mailbox: string | undefined, action: (client: ImapFlow) => Promise<T>) {
  const config = loadConfig();
  const client = new ImapFlow({
    ...config,
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    disableAutoIdle: true,
  });
  // EventEmitterの未処理エラーで認証情報やプロトコルログが出ないようにする。
  client.on('error', () => {});
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox || config.mailbox, { readOnly: true });
    try {
      return await action(client);
    } finally {
      lock.release();
    }
  } finally {
    if (client.usable) await client.logout().catch(() => client.close());
    else client.close();
  }
}

export function mailboxInfo(client: ImapFlow) {
  if (!client.mailbox) throw new Error('メールボックスが開かれていません。');
  return {
    mailbox: client.mailbox.path,
    uidValidity: String(client.mailbox.uidValidity),
    total: client.mailbox.exists,
  };
}

export function summary(mail: FetchMessageObject) {
  return {
    uid: mail.uid,
    messageId: mail.envelope?.messageId ?? null,
    subject: mail.envelope?.subject ?? '',
    from: mail.envelope?.from ?? [],
    to: mail.envelope?.to ?? [],
    date: mail.envelope?.date ? new Date(mail.envelope.date).toISOString() : null,
    receivedAt: mail.internalDate instanceof Date ? mail.internalDate.toISOString() : null,
    flags: [...(mail.flags ?? [])],
    size: mail.size,
  };
}

export async function listMail(client: ImapFlow, limit: number) {
  const { total } = mailboxInfo(client);
  if (total === 0) return [];
  const mails = await client.fetchAll(`${Math.max(1, total - limit + 1)}:*`, {
    uid: true, envelope: true, flags: true, internalDate: true, size: true,
  });
  return mails.reverse().map(summary);
}

export async function getMail(client: ImapFlow, uid: number, maxBytes: number) {
  const metadata = await client.fetchOne(String(uid), {
    uid: true, envelope: true, flags: true, internalDate: true, size: true,
  }, { uid: true });
  if (!metadata) throw new Error(`UID ${uid} のメールは見つかりません。`);
  if (metadata.size === undefined) throw new Error(`UID ${uid} のメールサイズを確認できませんでした。`);
  if (metadata.size > maxBytes) throw new Error(`UID ${uid} は取得上限 ${maxBytes} bytes を超えています。--max-bytes で変更できます。`);
  const mail = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
  if (!mail || !mail.source) throw new Error(`UID ${uid} の本文を取得できませんでした。`);
  if (mail.source.length > maxBytes) throw new Error('メールサイズが取得上限を超えています。');
  const parsed = await parseMail(mail.source);
  return { ...summary(metadata), ...parsed };
}

export async function parseMail(source: Buffer) {
  const mail = await simpleParser(source, { skipHtmlToText: false, skipTextToHtml: true });
  return {
    subject: mail.subject ?? '',
    messageId: mail.messageId ?? null,
    date: mail.date?.toISOString() ?? null,
    from: mail.from?.text ?? '',
    to: (Array.isArray(mail.to) ? mail.to : mail.to ? [mail.to] : []).map(a => a.text),
    text: mail.text ?? '',
    attachments: mail.attachments.map(a => ({
      filename: a.filename ?? null, contentType: a.contentType, size: a.size,
    })),
  };
}
