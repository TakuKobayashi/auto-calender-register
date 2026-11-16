export function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('1以上の整数を指定してください。');
  }
  return Number(value);
}

export function loadConfig(env = process.env) {
  const user = env.YAHOO_IMAP_USER?.trim();
  const pass = env.YAHOO_IMAP_PASSWORD;
  if (!user || !pass) {
    throw new Error('.env に YAHOO_IMAP_USER と YAHOO_IMAP_PASSWORD を設定してください。');
  }
  const port = positiveInteger(env.YAHOO_IMAP_PORT ?? '993');
  if (port > 65535) throw new Error('IMAPポートは65535以下で指定してください。');
  return {
    host: env.YAHOO_IMAP_HOST || 'imap.mail.yahoo.co.jp',
    port,
    secure: true as const,
    auth: { user, pass },
    mailbox: env.YAHOO_IMAP_MAILBOX || 'INBOX',
  };
}
