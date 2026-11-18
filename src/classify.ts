import { createHash } from 'node:crypto';
import * as chrono from 'chrono-node';
import { DateTime, FixedOffsetZone } from 'luxon';
import * as ical from 'node-ical';
import type { CollectedMail } from './domain/mail.js';
import { mailLabel, type MessageSource } from './domain/mail.js';

export type Decision = 'candidate' | 'review' | 'excluded' | 'duplicate' | 'error' | 'pending';
export type EventPlan = {
  allDayDate?: string;
  kind?: 'appointment' | 'deadline';
  title: string;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  endTimeZone?: string | null;
  location: string;
  evidence: string;
  reasons: string[];
  decision: Decision;
  identity?: string;
  sequence?: number;
  localStart?: string;
  cancelled?: boolean;
  intent?: import('./ollama.js').Intent;
  eventKey?: string;
  payload?: {
    allDayDate?: string;
    summary: string;
    location: string;
    description: string;
    start: { dateTime: string; timeZone?: string };
    end: { dateTime: string; timeZone?: string };
    extendedProperties: {
      private: { sourceEventKey: string; eventKind?: string; sourceReferenceKeys?: string };
    };
  };
};
export type MailPlan = {
  uid: number;
  subject: string;
  from: string;
  receivedAt: string | null;
  messageId: string | null;
  decision: Decision;
  reasons: string[];
  events: EventPlan[];
  bookingIds?: string[];
  cancelled?: boolean;
  intent?: import('./ollama.js').Intent;
  source?: MessageSource;
  shouldRegister?: boolean;
};

const confirmed =
  /(?:ご?予約(?:が|は|を)?(?:完了|確定|確認|確保|変更完了)|予約詳細|ご予約内容|ご宿泊日が近づ|宿泊日が近づ|ご予約確認書|申[し込込み]{1,4}(?:完了|ありがとう)|参加登録が承認|booking confirmation|booking.{0,20}confirmed|registration.{0,20}confirmed|your (?:booking|ticket)|旅程詳細|^📍.*\bTicket\b|ご利用バウチャー)/i;
const cancellation =
  /(?:予約.{0,12}キャンセル(?:され|しま|の確認)|ご予約をキャンセルしました|予約キャンセルの確認|cancellation confirmation|booking.{0,40}cancell?ed)/i;
const eventHint =
  /予約|受験|試験|参加|開催|セミナー|ウェビナー|イベント|面談|面接|搭乗|旅程|宿泊|flight|booking|meeting|appointment|webinar|invitation|ticket|reminder/i;
const dateLabel =
  /受験日(?:時)?|試験開始時刻|開始日時|開催日時|予約時間|ご利用日時|利用日時|出発日時|到着日時|チェックイン|チェックアウト|日時\s*[:：]|Date\s*[:：]|Start\s*[:：]/i;
const marketing =
  /メルマガ|メールマガジン|ソラマガ|キャンペーン|クーポン|セール|ご招待|出展|今週の新着|ご案内|受付中|募集中|参加無料|新規オープン|OFF|割引/i;

function normalize(text: string) {
  return text.normalize('NFKC').replace(/\r/g, '');
}
function clean(text: string) {
  return normalize(text).replace(/https?:\/\/[^\s<>]+/g, '[URL]');
}
function activeText(text: string) {
  return clean(text).split(
    /\n(?:\s*>|\s*-{2,}\s*(?:Original Message|引用元メッセージ|Forwarded message))/i,
  )[0]!;
}

function bookingIds(mail: CollectedMail) {
  const sender = mail.from.match(/@([^\s>]+)/)?.[1]?.toLowerCase() ?? mail.from;
  const text = normalize(`${mail.subject}\n${mail.text.slice(0, 5000)}`);
  return [
    ...new Set(
      [
        ...text.matchAll(
          /(?:予約(?:番号|ID)|Booking(?:\s*(?:ID|reference))?|受付番号)\s*[:：#\-]?\s*([A-Z0-9][A-Z0-9-]{5,})|\b(GYG[A-Z0-9]{7,})\b/gi,
        ),
      ].map((m) => `${sender}:${(m[1] || m[2])!.toUpperCase()}`),
    ),
  ];
}
function textValue(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'val' in value
      ? String(value.val)
      : '';
}

export function parseSince(value: string) {
  const date = DateTime.fromISO(value, { zone: 'Asia/Tokyo', setZone: true });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !date.isValid)
    throw new Error('--since は有効な YYYY-MM-DD を指定してください（日本時間の受信日）。');
  return date.toJSDate();
}

function zoneFromText(text: string): { zone: string; reason: string } | null {
  const zones = new Map<string, string>();
  for (const match of text.matchAll(
    /\b(?:Africa|America|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g,
  )) {
    if (DateTime.now().setZone(match[0]).isValid)
      zones.set(match[0], `本文のIANAタイムゾーン: ${match[0]}`);
  }
  if (/\bJST\b|日本時間|日本標準時/i.test(text))
    zones.set('Asia/Tokyo', '本文に日本時間/JSTの明示あり');
  // 送信元の日本語やメール送信日時のオフセットだけでは日本時間と判断しない。
  if (zones.size === 1) {
    const [zone, reason] = [...zones.entries()][0]!;
    return { zone, reason };
  }
  return null;
}

function eventKey(plan: EventPlan) {
  return createHash('sha256')
    .update(
      plan.identity ||
        [
          plan.title
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[\s\p{P}\p{S}]/gu, ''),
          plan.start ? new Date(plan.start).toISOString() : '',
          plan.location.normalize('NFKC').replace(/\s/g, ''),
        ].join('|'),
    )
    .digest('hex');
}

export function finalize(plan: EventPlan, now: Date, mail: CollectedMail): EventPlan {
  if (plan.cancelled) {
    plan.decision = 'excluded';
    plan.reasons.push('キャンセル通知');
  } else if (
    plan.start &&
    new Date(plan.allDayDate ? plan.end! : plan.start).getTime() <= now.getTime()
  ) {
    plan.decision = 'excluded';
    plan.reasons.push(plan.allDayDate ? '期限が実行時点以前' : '開始日時が実行時点以前');
  }
  if (plan.decision === 'candidate' && plan.start && plan.end) {
    plan.eventKey = eventKey(plan);
    const zone =
      plan.timeZone && !plan.timeZone.startsWith('UTC') ? { timeZone: plan.timeZone } : {};
    plan.payload = {
      ...(plan.allDayDate ? { allDayDate: plan.allDayDate } : {}),
      summary: plan.title,
      location: plan.location,
      description: `メールから抽出した予定\n送信元: ${mail.from}\n件名: ${mail.subject}\nMessage-ID: ${mail.messageId ?? ''}\n根拠: ${plan.evidence}\n${plan.reasons.join('\n')}`,
      start: { dateTime: plan.start, ...zone },
      end: {
        dateTime: plan.end,
        ...(plan.endTimeZone && !plan.endTimeZone.startsWith('UTC')
          ? { timeZone: plan.endTimeZone }
          : zone),
      },
      extendedProperties: { private: { sourceEventKey: plan.eventKey } },
    };
  }
  return plan;
}

function calendarEvents(mail: CollectedMail, now: Date): EventPlan[] {
  const plans: EventPlan[] = [];
  for (const source of mail.calendarParts ?? []) {
    const parsed = ical.sync.parseICS(source);
    for (const event of Object.values(parsed)) {
      if (!event || event.type !== 'VEVENT') continue;
      const block =
        [...source.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)]
          .map((m) => m[0])
          .find((b) => b.includes(`UID:${event.uid}`)) ?? '';
      const explicitZone =
        /^DTSTART(?:;[^:\r\n]*)?:(?:\d{8}T\d{6}Z)/m.test(block) ||
        /^DTSTART;[^\r\n]*TZID=/m.test(block);
      const isRecurring = Boolean(event.rrule || event.recurrenceid || event.recurrences);
      const allDay = event.datetype === 'date' || event.start?.dateOnly;
      const start =
        event.start instanceof Date && Number.isFinite(event.start.getTime())
          ? event.start.toISOString()
          : null;
      const end =
        event.end instanceof Date && Number.isFinite(event.end.getTime())
          ? event.end.toISOString()
          : null;
      const reasons = ['ICSのVEVENTから抽出'];
      let decision: Decision = 'candidate';
      if (allDay || !explicitZone || !start) {
        decision = 'review';
        reasons.push('終日予定またはタイムゾーンが未確定');
      }
      if (isRecurring) {
        decision = 'review';
        reasons.push('繰り返し・例外予定は未対応。個別の確認が必要');
      }
      if (!end || (start && end <= start)) {
        decision = 'review';
        reasons.push('終了日時が未確定または不正');
      }
      if (event.start?.tz && !DateTime.now().setZone(event.start.tz).isValid) {
        decision = 'review';
        reasons.push('対応するIANAタイムゾーンを確認できない');
      }
      if (!confirmed.test(normalize(mail.subject))) {
        decision = 'review';
        reasons.push('参加・予約の確定をメール件名から確認できない');
      }
      const plan: EventPlan = {
        title: textValue(event.summary) || mail.subject,
        start: explicitZone && !allDay ? start : null,
        end: explicitZone && !allDay ? end : null,
        timeZone: explicitZone ? event.start.tz || 'UTC' : null,
        location: textValue(event.location),
        evidence: block.slice(0, 700),
        reasons,
        decision,
        identity: `ics:${event.uid}:${event.recurrenceid?.toISOString() ?? ''}`,
        sequence: event.sequence ?? 0,
        cancelled:
          event.status === 'CANCELLED' ||
          parsed.vcalendar?.method === 'CANCEL' ||
          cancellation.test(normalize(mail.subject)),
      };
      if (isRecurring && !plan.cancelled) {
        plans.push(plan);
        continue;
      }
      plans.push(finalize(plan, now, mail));
    }
  }
  return plans;
}

function textEvents(mail: CollectedMail, now: Date): EventPlan[] {
  const text = activeText(mail.text);
  const subject = normalize(mail.subject);
  const reference = new Date(mail.date ?? mail.receivedAt ?? now.toISOString());
  // 日付と時刻が別行の予約等を同じ日時表現として解析する。
  const prepared = text
    .replace(/(\d{4}年\d{1,2}月\d{1,2}日[^\n]*)\n\s*試験開始時刻\s*[:：]\s*/g, '$1 ')
    .replace(/(日)\s*\([^\n)]*(?:祝|振休)[^\n)]*\)/g, '$1 ');
  const results = [
    ...chrono.ja.parse(prepared, { instant: reference, timezone: 0 }),
    ...chrono.en.parse(prepared, { instant: reference, timezone: 0 }),
  ]
    .filter((r) => r.start.isCertain('day') && r.start.isCertain('month'))
    .sort((a, b) => a.index - b.index || b.text.length - a.text.length)
    .filter(
      (r, i, a) =>
        !a
          .slice(0, i)
          .some((p) => p.index <= r.index && p.index + p.text.length >= r.index + r.text.length),
    );
  const plans: EventPlan[] = [];
  for (const result of results) {
    const lineStart = prepared.lastIndexOf('\n', result.index - 1) + 1;
    const prefix = prepared.slice(lineStart, result.index);
    if (!dateLabel.test(prefix)) continue;
    const before = prepared.slice(Math.max(0, lineStart - 250), result.index);
    const after = prepared.slice(
      result.index + result.text.length,
      result.index + result.text.length + 400,
    );
    const heading = [...before.matchAll(/^■([^\n]+)/gm)].at(-1)?.[1];
    // 直前の別会場や署名の住所からタイムゾーンを引き継がない。
    const localBlock = `${prefix}${result.text}\n${after}`;
    const precedingVenue = before.includes('【開催場所】')
      ? before.slice(before.lastIndexOf('【開催場所】'))
      : '';
    const location =
      localBlock
        .match(/(?:テストセンター住所|(?:開催)?住所|会場住所)\s*[:：]\s*([^\n]+)/)?.[1]
        ?.trim() ??
      precedingVenue.match(/住所\s*[:：]\s*([^\n]+)/)?.[1]?.trim() ??
      localBlock.match(/(?:開催場所|会場|場所)\s*[:：]\s*([^\n]+)/)?.[1]?.trim() ??
      '';
    let zone = zoneFromText(localBlock) ?? zoneFromText(prepared);
    if (
      !zone &&
      /(?:東京都|北海道|(?:大阪|京都)府|神奈川県|千葉県|埼玉県|[^\s]{2,3}県)[^\n]*(?:市|区|町|村)/.test(
        location,
      )
    ) {
      zone = { zone: 'Asia/Tokyo', reason: '予定の会場住所が日本国内' };
    }
    const offset = result.start.isCertain('timezoneOffset')
      ? result.start.get('timezoneOffset')
      : null;
    const resolvedZone = offset !== null ? FixedOffsetZone.instance(offset) : zone?.zone;
    const reasons = ['日時ラベルに続く本文の日付から抽出'];
    let decision: Decision = 'candidate';
    if (!confirmed.test(subject)) {
      decision = 'review';
      reasons.push('予約・参加確定を件名から確認できない');
    }
    if (!result.start.isCertain('year')) {
      decision = 'review';
      reasons.push('年が明示されていない（未来の年を推測しない）');
    }
    if (!result.start.isCertain('hour')) {
      decision = 'review';
      reasons.push('開始時刻が明示されていない');
    }
    if (!resolvedZone) {
      decision = 'review';
      reasons.push('タイムゾーンを本文から確定できない');
    }
    if (zone) reasons.push(zone.reason);
    if (offset !== null) reasons.push(`日時にUTCオフセット明示: ${offset}分`);
    const toDateTime = (component: chrono.ParsedComponents) =>
      DateTime.fromObject(
        {
          year: component.get('year')!,
          month: component.get('month')!,
          day: component.get('day')!,
          hour: component.get('hour') ?? 0,
          minute: component.get('minute') ?? 0,
        },
        { zone: resolvedZone ?? 'UTC' },
      );
    const start = toDateTime(result.start);
    let end = result.end ? toDateTime(result.end) : null;
    const duration = heading?.match(/\((\d+)分\)/)?.[1];
    if (!end && duration) {
      end = start.plus({ minutes: Number(duration) });
      reasons.push(`見出しの試験時間${duration}分から終了を算出`);
    }
    if (
      !end &&
      resolvedZone &&
      start.isValid &&
      result.start.isCertain('year') &&
      result.start.isCertain('hour') &&
      confirmed.test(subject)
    ) {
      end = start.plus({ minutes: 15 });
      reasons.push('終了時刻未記載。開始通知用の15分表示枠であり実際の所要時間ではありません');
    }
    if (!end) {
      decision = 'review';
      reasons.push('終了日時・所要時間が未確定');
    }
    const nonExistentTime =
      start.isValid &&
      (start.hour !== (result.start.get('hour') ?? 0) || start.day !== result.start.get('day'));
    if (
      !start.isValid ||
      nonExistentTime ||
      (end && (!end.isValid || end <= start)) ||
      start.getPossibleOffsets().length !== 1
    ) {
      decision = 'review';
      reasons.push('不正な日時または夏時間の重複時刻');
    }
    const product = prepared.match(/商\s*品\s*[:：]\s*([^\n]+)/)?.[1];
    const title = heading && /試験|科目/.test(heading) ? heading : product || mail.subject;
    const plan: EventPlan = {
      title,
      start:
        resolvedZone &&
        result.start.isCertain('hour') &&
        result.start.isCertain('year') &&
        start.isValid
          ? start.toISO()
          : null,
      end: resolvedZone && end?.isValid ? end.toISO() : null,
      timeZone: typeof resolvedZone === 'string' ? resolvedZone : (resolvedZone?.name ?? null),
      localStart:
        result.start.isCertain('year') && result.start.isCertain('hour') && start.isValid
          ? start.toFormat("yyyy-MM-dd'T'HH:mm")
          : undefined,
      location,
      evidence: prepared.slice(lineStart, result.index + result.text.length).trim(),
      reasons,
      decision,
    };
    // タイムゾーン不明でも、UTC-12の当日終了を過ぎていれば確実に過去。
    if (
      result.start.isCertain('year') &&
      Date.UTC(
        result.start.get('year')!,
        result.start.get('month')! - 1,
        result.start.get('day')! + 1,
        12,
      ) <= now.getTime()
    ) {
      plan.decision = 'excluded';
      plan.reasons.push('どのタイムゾーンでも既に過去の日付');
    }
    plans.push(finalize(plan, now, mail));
  }
  return plans;
}

export function classifyMail(mail: CollectedMail, now: Date): MailPlan {
  const result: MailPlan = {
    uid: mail.uid,
    subject: mail.subject,
    from: mail.from,
    receivedAt: mail.receivedAt,
    messageId: mail.messageId,
    decision: 'excluded',
    reasons: [],
    events: [],
    bookingIds: bookingIds(mail),
    cancelled: cancellation.test(normalize(mail.subject)),
    source: mail.source,
  };
  if (cancellation.test(normalize(mail.subject))) {
    result.reasons.push('件名が予約キャンセル通知。新規登録対象外');
    result.events = calendarEvents(mail, now);
    return result;
  }
  if (
    /キャンセル待ち|予約リクエストを|waitlist/i.test(mail.subject) ||
    /予約はまだ確定ではありません|予約は未確定|抽選結果をお待ち|選考結果をお待ち|参加(?:の可否|可否)は後日/.test(
      activeText(mail.text),
    )
  ) {
    result.decision = 'pending';
    result.intent = 'pending';
    result.reasons.push('予約・参加が未確定。確定通知を受信するまで登録しない');
    return result;
  }
  if (
    !mail.calendarParts?.length &&
    !confirmed.test(normalize(mail.subject)) &&
    (marketing.test(mail.subject) ||
      /ログイン通知|支払|請求|アンケート|review|survey/i.test(mail.subject))
  ) {
    result.reasons.push('広告・案内・通知であり、予約や参加の確定通知ではない');
    return result;
  }
  if (!eventHint.test(mail.subject) && !mail.calendarParts?.length) {
    // 件名だけでは捨てず、本文に具体的な日時ラベルがあれば確認対象にする。
    if (!dateLabel.test(clean(mail.text))) {
      result.reasons.push('予定・予約の件名や本文の日時ラベルなし');
      return result;
    }
  }
  const fromCalendar = calendarEvents(mail, now);
  result.events = fromCalendar.length ? fromCalendar : textEvents(mail, now);
  if (
    !confirmed.test(normalize(mail.subject)) &&
    !mail.calendarParts?.length &&
    result.events.length &&
    !/お申[し込込み]{1,4}|ご予約.{0,12}(?:ありがとう|確定)|予約が成功|受験|ご参加.{0,8}ありがとう/.test(
      activeText(mail.text).slice(0, 1800),
    )
  ) {
    result.events = [];
    result.reasons.push('本人の予約・参加確定を本文で確認できない一般案内。登録対象外');
    return result;
  }
  if (result.events.some((e) => e.decision === 'candidate')) result.decision = 'candidate';
  else if (result.events.some((e) => e.decision === 'review')) result.decision = 'review';
  else if (result.events.length) result.decision = 'excluded';
  else if (
    confirmed.test(normalize(mail.subject)) ||
    (dateLabel.test(clean(mail.text)) && eventHint.test(mail.subject))
  ) {
    result.decision = 'review';
    result.reasons.push('予定の可能性あり。対応ルールで日時を確定できない');
  } else result.reasons.push('予約・参加の確定や具体的な予定日時を確認できない（広告・案内等）');
  return result;
}

export function classifyAll(
  messages: CollectedMail[],
  now: Date,
  overrides = new Map<number, MailPlan>(),
) {
  const plans = messages.map((mail) => {
    const override = overrides.get(mail.uid);
    if (override) return structuredClone(override);
    try {
      return classifyMail(mail, now);
    } catch {
      return {
        uid: mail.uid,
        subject: mail.subject,
        from: mail.from,
        receivedAt: mail.receivedAt,
        messageId: mail.messageId,
        source: mail.source,
        decision: 'error' as const,
        reasons: ['メールの予定解析に失敗'],
        events: [],
      };
    }
  });
  const identities = new Map<string, { plan: MailPlan; event: EventPlan }[]>();
  for (const plan of plans)
    for (const event of plan.events) {
      const key = event.identity || event.eventKey;
      if (!key) continue;
      const group = identities.get(key) ?? [];
      group.push({ plan, event });
      identities.set(key, group);
    }
  for (const group of identities.values()) {
    group.sort(
      (a, b) =>
        (b.event.sequence ?? 0) - (a.event.sequence ?? 0) ||
        new Date(b.plan.receivedAt ?? 0).getTime() - new Date(a.plan.receivedAt ?? 0).getTime() ||
        b.plan.uid - a.plan.uid,
    );
    for (const older of group.slice(1)) {
      older.event.decision = 'duplicate';
      delete older.event.payload;
      older.event.reasons.push(`同一予定の最新通知: ${mailLabel(group[0]!.plan)}`);
    }
  }
  // 同一事業者の予約番号に後続のキャンセル・変更があれば古い登録案を止める。
  for (const plan of plans)
    for (const event of plan.events) {
      if (event.decision !== 'candidate') continue;
      const newer = plans.filter(
        (p) =>
          (Date.parse(p.receivedAt ?? '') > Date.parse(plan.receivedAt ?? '') ||
            (p.receivedAt === plan.receivedAt && p.uid > plan.uid)) &&
          p.bookingIds?.some((id) => plan.bookingIds?.includes(id)),
      );
      const latest = newer.sort(
        (a, b) => Date.parse(b.receivedAt ?? '') - Date.parse(a.receivedAt ?? '') || b.uid - a.uid,
      )[0];
      if (!latest) continue;
      if (latest.cancelled) {
        event.decision = 'excluded';
        event.reasons.push(`後続通知で取消・受取完了: ${mailLabel(latest)}`);
        delete event.payload;
      } else if (
        latest.events.some(
          (e) =>
            e.title === event.title &&
            e.localStart &&
            e.localStart === event.localStart &&
            (!e.timeZone || e.timeZone === event.timeZone),
        )
      ) {
        // リマインダーに住所が省略されても、元の予約番号・科目・現地日時が一致すれば同じ予定。
        event.reasons.push(
          `後続通知でも同じ予約番号・予定名・現地開始日時を確認: ${mailLabel(latest)}`,
        );
        for (const other of latest.events.filter(
          (e) => e.title === event.title && e.localStart === event.localStart,
        )) {
          other.decision = 'duplicate';
          delete other.payload;
          other.reasons.push(`詳細情報のあるメールと同じ予約の通知: ${mailLabel(plan)}`);
        }
      } else if (
        !latest.events.some((e) => e.start === event.start && e.decision === 'candidate')
      ) {
        event.decision = 'review';
        event.reasons.push(
          `同じ予約の後続通知から確定できないため登録しない: ${mailLabel(latest)}`,
        );
        delete event.payload;
      }
    }
  for (const plan of plans) {
    if (plan.events.length && plan.decision !== 'error') {
      plan.decision = plan.events.some((e) => e.decision === 'candidate')
        ? 'candidate'
        : plan.events.some((e) => e.decision === 'review')
          ? 'review'
          : plan.events.some((e) => e.decision === 'duplicate')
            ? 'duplicate'
            : 'excluded';
    }
  }
  return plans;
}
