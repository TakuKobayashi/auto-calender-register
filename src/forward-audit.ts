import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { classifyMail, finalize } from './classify.js';
import { listSinceMail, mailboxInfo, parseMail, withMailbox } from './mail.js';
import type { Collection } from './collect.js';
import type { CollectedMail } from './domain/mail.js';
import {
  extractWithOllama,
  extractionCacheKey,
  localModelDigest,
  extractionToPlan,
  modelText,
  unwrapForward,
  type Extraction,
} from './ollama.js';
import { reconcileModelPlan } from './dry-run.js';
import { mailLabel } from './domain/mail.js';

export type ForwardCache = {
  since: string;
  messages: CollectedMail[];
  mailbox?: string;
  uidValidity?: string;
};

export function normalizeSubject(subject: string) {
  return subject
    .normalize('NFKC')
    .replace(/^(?:\s*(?:fw|fwd|re)\s*[:：])+/gi, '')
    .replace(/\s/g, '')
    .toLowerCase();
}

export function filterGmailForwards(messages: CollectedMail[], recipient?: string) {
  const forwards = messages.filter((m) => /^\s*(fw|fwd)\s*[:：]/i.test(m.subject));
  const address = (value: string) =>
    [...value.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com\b/gi)].map((m) =>
      m[0].toLowerCase(),
    );
  const addresses = new Set(forwards.flatMap((m) => m.to.flatMap(address)));
  if (!recipient && addresses.size !== 1)
    throw new Error('Gmail転送先が一意でありません。--recipient で指定してください。');
  const target = recipient?.trim().toLowerCase() ?? [...addresses][0]!;
  if (!/^[^\s@]+@gmail\.com$/.test(target)) throw new Error('Gmail転送先の形式が不正です。');
  return {
    recipient: target,
    messages: forwards.filter((m) => m.to.flatMap(address).includes(target)),
  };
}

export async function collectForwards(
  since: Date,
  directory: string,
  recipient?: string,
): Promise<ForwardCache> {
  return withMailbox('Sent', async (client) => {
    const info = mailboxInfo(client);
    const index = (await listSinceMail(client, since)).filter((m) =>
      /^\s*(?:fw|fwd)\s*[:：]/i.test(m.subject),
    );
    const messages: CollectedMail[] = [];
    for (let i = 0; i < index.length; i += 5) {
      const batch = index.slice(i, i + 5);
      if (batch.some((m) => m.size === undefined || m.size > 10 * 1024 * 1024))
        throw new Error('転送メールに取得上限超過あり。全件取得を中止します。');
      const data = await client.fetchAll(
        batch.map((m) => m.uid),
        { uid: true, source: true },
        { uid: true },
      );
      for (const m of batch) {
        const source = data.find((x) => x.uid === m.uid)?.source;
        if (!source) throw new Error(`送信済みUID ${m.uid} を取得できませんでした。`);
        messages.push({ ...m, ...(await parseMail(source)) });
      }
    }
    const selected = filterGmailForwards(messages, recipient);
    const cache: ForwardCache = {
      since: since.toISOString(),
      mailbox: info.mailbox,
      uidValidity: info.uidValidity,
      messages: selected.messages,
    };
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'sent-forward-cache.json'), JSON.stringify(cache, null, 2), {
      mode: 0o600,
    });
    return cache;
  });
}

export function matchOriginal(forward: CollectedMail, originals: CollectedMail[]) {
  const text = modelText(forward).replace(/\s/g, '');
  const sender = unwrapForward(forward)
    .from.match(/[\w.+-]+@[^\s>]+/)?.[0]
    ?.toLowerCase();
  const candidates = originals.filter(
    (m) =>
      normalizeSubject(m.subject) === normalizeSubject(forward.subject) &&
      (!sender || m.from.toLowerCase().includes(sender)) &&
      new Date(m.receivedAt ?? 0) <= new Date(forward.receivedAt ?? forward.date ?? 0),
  );
  if (candidates.length === 1) return candidates;
  return candidates
    .map((mail) => {
      const normalized = modelText(mail).replace(/\s/g, '');
      const chunks = Array.from(
        { length: Math.min(20, Math.floor(normalized.length / 100)) },
        (_, i) => normalized.slice(i * 100, (i + 1) * 100),
      );
      return { mail, match: chunks.filter((c) => c.length >= 30 && text.includes(c)).length >= 2 };
    })
    .filter((x) => x.match)
    .map((x) => x.mail);
}

export async function auditForwards(
  cache: ForwardCache,
  inbox: Collection,
  directory: string,
  options: { recipient?: string; model?: string; sampleUids?: number[]; limit: number },
  now = new Date(),
) {
  const selected = filterGmailForwards(cache.messages, options.recipient);
  const rows = [];
  let modelCalls = 0;
  await mkdir(directory, { recursive: true });
  const inferenceCachePath = resolve(directory, 'ollama-cache.json');
  let inferenceCache: Record<string, Extraction> = {};
  try {
    inferenceCache = JSON.parse(await readFile(inferenceCachePath, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  for (const forwarded of selected.messages) {
    const original = unwrapForward(forwarded);
    const matches = matchOriginal(forwarded, inbox.messages);
    const source = matches.length === 1 ? matches[0]! : original;
    const current = classifyMail(source, now);
    const historical = classifyMail(
      source,
      new Date(forwarded.receivedAt ?? forwarded.date ?? now),
    );
    const row = {
      sentUid: forwarded.uid,
      subject: original.subject,
      originalInboxUids: matches.map((m) => m.uid),
      referenceMeaning: 'user_selected_for_monitoring_not_a_confirmation_label',
      currentRules: current,
      rulesAtForwardTime: historical,
      llm: null as null | {
        model: string;
        extraction?: Extraction;
        current?: ReturnType<typeof extractionToPlan>;
        atForwardTime?: ReturnType<typeof extractionToPlan>;
        hybridCurrent?: ReturnType<typeof reconcileModelPlan>;
        hybridAtForwardTime?: ReturnType<typeof reconcileModelPlan>;
        error?: string;
        elapsedMs: number;
      },
    };
    if (
      options.model &&
      modelCalls < options.limit &&
      (!options.sampleUids || options.sampleUids.includes(forwarded.uid))
    ) {
      modelCalls++;
      console.error(`メール判定 ${modelCalls}: ${mailLabel(forwarded)} (${options.model})`);
      const begin = Date.now();
      try {
        const key = extractionCacheKey(
          source,
          options.model,
          await localModelDigest(options.model),
        );
        const extraction = inferenceCache[key] ?? (await extractWithOllama(source, options.model));
        inferenceCache[key] = extraction;
        row.llm = {
          model: options.model,
          extraction,
          current: extractionToPlan(source, extraction, now, finalize),
          atForwardTime: extractionToPlan(
            source,
            extraction,
            new Date(forwarded.receivedAt ?? forwarded.date ?? now),
            finalize,
          ),
          elapsedMs: Date.now() - begin,
        };
        row.llm.hybridCurrent = reconcileModelPlan(current, row.llm.current!);
        row.llm.hybridAtForwardTime = reconcileModelPlan(historical, row.llm.atForwardTime!);
        await writeFile(inferenceCachePath, JSON.stringify(inferenceCache, null, 2), {
          mode: 0o600,
        });
      } catch (error) {
        row.llm = {
          model: options.model,
          error: error instanceof Error ? error.message : '推論失敗',
          elapsedMs: Date.now() - begin,
        };
      }
    }
    rows.push(row);
    await writeFile(
      resolve(directory, 'forward-audit.json'),
      JSON.stringify({ now: now.toISOString(), complete: false, rows }, null, 2),
      { mode: 0o600 },
    );
  }
  const report = {
    executedAt: now.toISOString(),
    complete: true,
    referenceCount: rows.length,
    matchedOriginals: rows.filter((r) => r.originalInboxUids.length === 1).length,
    missingOrAmbiguousOriginals: rows.filter((r) => r.originalInboxUids.length !== 1).length,
    llmChecked: modelCalls,
    llmErrors: rows.filter((r) => r.llm?.error).length,
    note: '転送は監視したい意図の見本。未転送は負例ではなく、転送済みも確定済みとは限らない。正解率・再現率は算出しない。',
    rows,
  };
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const lines = [
    '# Gmail転送履歴を用いた判定監査',
    '',
    `転送メール ${rows.length}件 / 受信キャッシュ内の原本を一意に照合 ${report.matchedOriginals}件 / 原本未収録・曖昧 ${report.missingOrAmbiguousOriginals}件`,
    `LLM検証 ${modelCalls}件 / 推論・検証エラー ${report.llmErrors}件`,
    '',
    report.note,
    '過去の旅行を現在の登録候補から除くことと、予定の抽出に失敗することは別です。転送時点の判定も併記します。',
    '',
    '| Sent UID | 件名 | 原本INBOX UID | ルール・転送時点 | ルール・現在 | LLM意図 | 統合・転送時点 | 統合・現在 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.sentUid} | ${escape(r.subject)} | ${r.originalInboxUids.join(', ') || 'キャッシュ内に一意の原本なし'} | ${r.rulesAtForwardTime.decision} | ${r.currentRules.decision} | ${r.llm?.extraction?.intent ?? (r.llm?.error ? 'error' : '未評価')} | ${r.llm?.hybridAtForwardTime?.decision ?? '—'} | ${r.llm?.hybridCurrent?.decision ?? '—'} |`,
    ),
    '',
    '詳しい根拠・推論エラーは forward-audit.json にあります。Googleカレンダーへの書き込みはありません。',
    '',
  ];
  await writeFile(resolve(directory, 'forward-audit.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await writeFile(resolve(directory, 'forward-audit.md'), lines.join('\n'), { mode: 0o600 });
  return report;
}
