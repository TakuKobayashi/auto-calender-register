import * as chrono from 'chrono-node';
import type { CollectedMail } from './domain/mail.js';
import { modelText, unwrapForward } from './ollama.js';

export type DatePresence = {
  hasDate: boolean;
  reason: string;
};

// Presence detection is deliberately broader than date extraction. An ambiguous
// date reaches the model; only the later validators can accept it for registration.
const dateHints: RegExp[] = [
  /(?:\d{2,4}|[〇零一二三四五六七八九十百]+)\s*年|(?:令和|平成|昭和)\s*(?:元|\d+|[一二三四五六七八九十]+)\s*年/u,
  /(?:\d{1,2}|[一二三四五六七八九十]+)\s*月(?:\s*(?:\d{1,2}|[一二三四五六七八九十]+)\s*日)?/u,
  /(?:^|[^\d])\d{1,4}\s*[-/.]\s*\d{1,2}(?:\s*[-/.]\s*\d{1,4})?(?!\d)/u,
  /(?:^|[^\d])(?:[12]?\d|3[01])\s*日(?:まで|迄|締切|締め切り|期限|中|の|に|から|$)/u,
  /(?:本日|今日|明日|明後日|あさって|翌日|昨日|一昨日|今夜|今朝|今晩|明朝|翌朝|当日|当夜|近日|後日|今週|来週|再来週|先週|今月|来月|再来月|先月|今年|来年|再来年|年末|年始|月末|月初|週末|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日|[月火水木金土日]曜)/u,
  /(?:\d+|[一二三四五六七八九十数]+)\s*(?:営業日|日間?|週間?|か月|ヶ月|箇月|時間)\s*(?:以内|以降|後|前|まで|経過)/u,
  /(?:上旬|中旬|下旬|翌営業日|次の営業日|次回|毎週|毎月|毎年)/u,
  /\b(?:today|tomorrow|tonight|yesterday|noon|midnight|eod|eow|eom|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i,
  /\b(?:next|this|last|following|coming|every)\s+(?:business\s+)?(?:day|week|month|year|morning|afternoon|evening|weekend)\b/i,
  /\b(?:within|in|after|before)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|several)\s+(?:business\s+|working\s+)?(?:hours?|days?|weeks?|months?|years?)\b/i,
  /\b(?:end|beginning|middle)\s+of\s+(?:(?:the|this|next)\s+)?(?:day|week|month|year)\b|\b\d{1,2}(?:st|nd|rd|th)\b/i,
];

export function inspectDatePresence(mail: CollectedMail): DatePresence {
  // Do not count transport timestamps, URLs, or dates in old quoted replies.
  const subject = unwrapForward(mail).subject.replace(/https?:\/\/\S+/gi, '');
  const body = modelText(mail);
  const text = `${subject}\n${body}`.normalize('NFKC');
  if (mail.calendarParts.some((part) => /BEGIN:VCALENDAR/i.test(part)))
    return { hasDate: true, reason: 'ICS情報あり' };
  if (dateHints.some((pattern) => pattern.test(text)))
    return { hasDate: true, reason: '日付・曜日・相対日付・期限表現あり' };

  const reference = new Date(mail.date ?? mail.receivedAt ?? '2000-01-01T00:00:00Z');
  // Bound parser inputs, but scan every chunk, including the end of long mail.
  for (let offset = 0; offset < text.length; offset += 3800) {
    const chunk = text.slice(offset, offset + 4096);
    for (const parser of [chrono.ja, chrono.en])
      if (
        parser
          .parse(chunk, Number.isFinite(reference.getTime()) ? reference : new Date(0))
          .some((result) =>
            (['year', 'month', 'day', 'weekday'] as const).some((part) =>
              result.start.isCertain(part),
            ),
          )
      )
        return { hasDate: true, reason: '日付パーサーで日付表現を検出' };
  }
  return { hasDate: false, reason: '件名・本文・ICSに日付情報なし' };
}
