import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { CollectedMail } from './domain/mail.js';
import { modelText, unwrapForward } from './ollama.js';

const relativeWeek =
  /(?:今週|来週|再来週)\s*[月火水木金土日](?:曜(?:日)?)?|\b(?:this|next)\s+(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const relativeMonthEnd = /(?:今|来|再来)月末|月末|\bend of (?:this|next|the) month\b/i;
const businessDayOffset =
  /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:business|working)\s+days?\b|(\d{1,2})\s*営業日\s*(?:以内|後|まで)/gi;
const numberWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const unsubscribe = /配信停止|配信解除|登録解除|\bunsubscribe\b/i;
const footerHeading =
  /^[【［[\s■◆●※*#]*(?:配信停止|配信解除|登録解除|unsubscribe)(?:について|のご案内)?[】］\]\s:：]*$/i;

function bodyBeforeFooter(body: string) {
  const lines = body.split('\n');
  const tail = Math.max(1, Math.floor(lines.length * 0.6));
  const boundary = lines.findIndex(
    (line, index) =>
      index >= tail &&
      (/^--\s*$/.test(line) ||
        footerHeading.test(line) ||
        (unsubscribe.test(line) && line.includes('[URL]'))),
  );
  // Keep the boundary line itself: a date on a link line may still describe
  // a required action. Only subsequent lines are treated as footer text.
  return boundary === -1 ? body : lines.slice(0, boundary + 1).join('\n');
}

function upcoming(
  start: chrono.ParsedComponents,
  asOf: DateTime,
  reference: DateTime,
  text: string,
) {
  if (
    !(start.isCertain('month') && start.isCertain('day')) &&
    !(start.isCertain('weekday') && (start.isCertain('hour') || relativeWeek.test(text)))
  )
    return false;
  const year = start.get('year');
  const month = start.get('month');
  const day = start.get('day');
  if (year === null || month === null || day === null) return false;
  const date = DateTime.fromObject({ year, month, day }, { zone: reference.zone });
  if (!date.isValid) return false;
  // Resolve a yearless date around the message date, never around each new run.
  return date.toISODate()! >= asOf.toISODate()!;
}

export function shortlistReason(mail: CollectedMail, now: Date): string | undefined {
  const received = DateTime.fromISO(mail.date ?? mail.receivedAt ?? '', { setZone: true });
  const reference = received.isValid ? received : DateTime.fromJSDate(now);
  // At this stage the event's timezone is unknown. Keep dates still current
  // anywhere, even if that day has ended in the runner's timezone.
  const earliestToday = DateTime.fromJSDate(now, { zone: 'UTC-12' }).startOf('day');
  for (const part of mail.calendarParts) {
    for (const [, date] of part.matchAll(
      /^DT(?:START|END)(?:[;:][^:\r\n]*)?:(\d{8})(?:T\d{6}Z?)?\s*$/gim,
    )) {
      const day = DateTime.fromFormat(date!, 'yyyyMMdd', { zone: earliestToday.zone });
      if (day.isValid && day >= earliestToday) return 'ICSに今後の日付あり';
    }
  }

  const subject = unwrapForward(mail).subject.replace(/https?:\/\/\S+/gi, '');
  const body = bodyBeforeFooter(modelText(mail).normalize('NFKC'));
  const text = subject.normalize('NFKC') + '\n' + body;
  for (let offset = 0; offset < text.length; offset += 3800) {
    const chunk = text.slice(offset, offset + 4096);
    for (const parser of [chrono.ja, chrono.en]) {
      const dates = parser.parse(chunk, {
        instant: reference.toJSDate(),
        timezone: reference.offset,
      });
      if (
        dates.some(({ start, end, index, text: match }) => {
          const context = chunk.slice(Math.max(0, index - 6), index + match.length);
          return (
            upcoming(start, earliestToday, reference, context) ||
            (end && upcoming(end, earliestToday, reference, context))
          );
        })
      )
        return '件名・本文に今後の日時候補あり';
    }
    if (
      relativeWeek.test(chunk) &&
      reference.plus({ weeks: 3 }).toISODate()! >= earliestToday.toISODate()!
    )
      return '件名・本文に今後の相対日付候補あり';
    if (
      relativeMonthEnd.test(chunk) &&
      reference.plus({ months: 2 }).endOf('month').toISODate()! >= earliestToday.toISODate()!
    )
      return '件名・本文に今後の月末候補あり';
    for (const [, english, japanese] of chunk.matchAll(businessDayOffset)) {
      const value = english ?? japanese!;
      const count = Number(value) || numberWords.indexOf(value.toLowerCase()) + 1;
      // Holidays depend on location. Retain plausible deadlines for interpretation.
      if (reference.plus({ days: count * 2 + 7 }).toISODate()! >= earliestToday.toISODate()!)
        return '件名・本文に営業日を基準にした日時候補あり';
    }
  }
}
