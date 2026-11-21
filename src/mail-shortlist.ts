import { DateTime } from 'luxon';
import type { CollectedMail } from './domain/mail.js';

const clock = /\b\d{1,2}:\d{2}\b|\d{1,2}\s*時(?:\s*\d{1,2}\s*分)?/;
const confirmation =
  /(?:予約|日程|参加|申[し込込み]+|登録|面接)[^\n。]{0,24}(?:確定|完了|承認)|(?:booking|appointment|meeting|registration|interview).{0,24}confirm|(?:booking|appointment|registration) confirmation/i;
const attendee = /参加者\s*(?:各位|の皆様)|(?:dear|to)\s+(?:all\s+)?(?:attendees|participants)/i;
const logistics = /会場|受付開始|当日スケジュール|venue|agenda/i;
const itinerary = /発券|e[\s-]*チケット|航空券予約|e[\s-]*ticket|ticketed/i;
const flight = /\b[A-Z][A-Z0-9]\s?\d{2,4}\b/;
const route = /\b[A-Z]{3}\s*\/\s*[A-Z]{3}\b|空港.{0,25}空港/;
const due = /締[め切]+|期限|までに|deadline|\bdue\b/i;
const action = /提出|返却|受取|受け取り|手続|更新|支払|submit|verify|collect|return|renew|payment/i;
const request =
  /(?:して|行って|済ませて)ください|must be|please (?:submit|verify|complete|collect|return)/i;
const explicitDate =
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日|\b\d{1,2}\/\d{1,2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/gi;

export function shortlistReason(mail: CollectedMail, now: Date): string | undefined {
  const body = mail.text
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/gi, ' ')
    .split(/\n\s*>/)[0]!;
  const text = `${mail.subject}\n${body}`;
  const today = DateTime.fromJSDate(now, { zone: 'Asia/Tokyo' });
  const mayBeUpcoming = [...text.matchAll(explicitDate)].some(([hint]) => {
    const numbers = hint.match(/\d+/g)!.map(Number);
    const [year, month, day] =
      numbers.length === 3
        ? numbers
        : numbers.length === 2
          ? [today.year, ...numbers]
          : [today.year, DateTime.fromFormat(hint, 'MMMM d', { locale: 'en' }).month, numbers[0]];
    if (!year || !month || !day) return false;
    const date = DateTime.fromObject({ year, month, day }, { zone: today.zone });
    return date.isValid && date >= today.startOf('day');
  });
  if (!mayBeUpcoming) return;

  if (clock.test(body)) {
    if (confirmation.test(text)) return '日程・予約等の確定表現と時刻あり';
    if (attendee.test(body) && logistics.test(text)) return '参加者向けの開催案内と時刻あり';
    if (itinerary.test(text) && flight.test(body) && route.test(body))
      return '航空券の便名・区間・時刻あり';
  }
  if (due.test(text) && action.test(body) && request.test(body))
    return '対応を求める期限の手掛かりあり';
}
