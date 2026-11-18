import { DateTime } from 'luxon';
import type { ExistingCalendarEvent } from './domain/calendar.js';
import type { SelectedEvent } from './selection.js';
import { googleEventId } from './selection.js';

export type Match = {
  kind: 'duplicate' | 'possible_duplicate' | 'previously_deleted';
  event: ExistingCalendarEvent;
  reason: string;
};
export function normalizedTitle(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(?:(?:fw|fwd|re)\s*:\s*)+/i, '')
    .replace(/\((?:\d+分|受験開始|開始)\)/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}
function references(event: { summary?: string; description?: string }) {
  const text = `${event.summary ?? ''}\n${event.description ?? ''}`.normalize('NFKC');
  return new Set(
    [
      ...text.matchAll(
        /\b\d{3}-\d{7}-\d{7}\b|(?:参照番号|受付番号|予約番号|注文番号|booking\s*(?:id|reference))\s*[:：#]?\s*([A-Z0-9][A-Z0-9-]{5,})/gi,
      ),
    ].map((m) => (m[1] ?? m[0]).toUpperCase()),
  );
}
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s: string) =>
    new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const x = grams(a),
    y = grams(b);
  return [...x].filter((g) => y.has(g)).length / Math.max(1, new Set([...x, ...y]).size);
}
export function matchExisting(
  selected: SelectedEvent,
  existing: ExistingCalendarEvent[],
): Match | null {
  const start = Date.parse(selected.payload.start.dateTime);
  const day =
    selected.payload.allDayDate ??
    DateTime.fromISO(selected.payload.start.dateTime, { setZone: true }).toISODate();
  const title = normalizedTitle(selected.payload.summary);
  const location = selected.payload.location.normalize('NFKC').replace(/\s/g, '');
  const refs = references(selected.payload);
  let possible: Match | null = null;
  for (const event of existing) {
    if (
      event.id === googleEventId(selected.eventKey) ||
      event.extendedProperties?.private?.sourceEventKey === selected.eventKey ||
      event.iCalUID === selected.iCalUID
    )
      return {
        kind: event.status === 'cancelled' ? 'previously_deleted' : 'duplicate',
        event,
        reason: '予定ID・予定キー・ICS UIDの一致',
      };
    if (event.status === 'cancelled') continue;
    const otherRefs = references(event);
    const sharedReference = [...refs].some((ref) => otherRefs.has(ref));
    if (refs.size && otherRefs.size && !sharedReference) continue;
    const otherStart = event.start?.dateTime ? Date.parse(event.start.dateTime) : NaN;
    const otherDay =
      event.start?.date ??
      (event.start?.dateTime
        ? DateTime.fromISO(event.start.dateTime)
            .setZone(selected.payload.start.timeZone ?? 'UTC')
            .toISODate()
        : null);
    const sameDay = day === otherDay;
    const otherTitle = normalizedTitle(event.summary ?? '');
    const score = similarity(title, otherTitle);
    const similarTitle =
      (title.length > 0 && title === otherTitle) ||
      (title.length >= 4 &&
        otherTitle.length >= 4 &&
        (score >= 0.65 || title.includes(otherTitle) || otherTitle.includes(title)));
    const sameLocation =
      !!location && location === event.location?.normalize('NFKC').replace(/\s/g, '');
    if (sharedReference && sameDay)
      return { kind: 'duplicate', event, reason: '同じ予約・注文番号と予定日が一致' };
    if (otherStart === start && title && title === otherTitle)
      return { kind: 'duplicate', event, reason: '正規化した予定名と開始時刻が一致' };
    if (otherStart === start)
      possible = {
        kind: 'possible_duplicate',
        event,
        reason:
          '同じ開始時刻の既存予定があり、別の予定と確定できないため重複防止を優先して登録しない',
      };
    if (selected.payload.allDayDate && sameDay && (similarTitle || sharedReference))
      return { kind: 'duplicate', event, reason: '予定日と予定名・参照番号が一致' };
    if (
      (Math.abs(otherStart - start) <= 15 * 60_000 &&
        (similarTitle || (sameLocation && score >= 0.35))) ||
      (event.start?.date === day && similarTitle)
    )
      possible = {
        kind: 'possible_duplicate',
        event,
        reason: '同じ日に類似する既存予定があるため重複防止を優先して登録しない',
      };
  }
  return possible;
}
