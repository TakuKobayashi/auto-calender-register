import { createHash } from 'node:crypto';

export type MailAccount = { provider: string; key: string; label?: string };
export type MailboxSource = { account: MailAccount; id: string; name: string; generation?: string };
export type MessageSource = MailboxSource & { messageId: string };

// uid is a collection-local ordering number. Provider identifiers are opaque strings in source.
export type CollectedMail = {
  uid: number;
  source?: MessageSource;
  subject: string;
  from: string;
  to: string[];
  date: string | null;
  receivedAt: string | null;
  messageId: string | null;
  flags: string[];
  size?: number;
  text: string;
  attachments: { filename: string | null; contentType: string; size: number }[];
  calendarParts: string[];
};

export function sourceScope(source: MailboxSource) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: source.account.provider,
        account: source.account.key,
        mailbox: source.id,
        generation: source.generation ?? null,
      }),
    )
    .digest('hex');
}

export function mailLabel(
  mail: Pick<CollectedMail, 'from' | 'subject'> & { source?: MessageSource },
) {
  const line = (text: string) =>
    text
      .replace(/[\x00-\x1f\x7f\x1b]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return `${line(mail.from || '送信元不明')} ｜ ${line(mail.subject || '(件名なし)')}${mail.source ? ` ｜ ${line(mail.source.name)}` : ''}`;
}

export function mergeMessages(messages: CollectedMail[]) {
  return [...messages]
    .sort(
      (a, b) =>
        Date.parse(a.receivedAt ?? a.date ?? '') - Date.parse(b.receivedAt ?? b.date ?? '') ||
        JSON.stringify(a.source).localeCompare(JSON.stringify(b.source)),
    )
    .map((mail, index) => ({ ...mail, uid: index + 1 }));
}
