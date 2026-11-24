import type { ExistingCalendarEvent } from './domain/calendar.js';
import { googleEventId, type SelectedEvent } from './selection.js';

export type Match = {
  kind: 'duplicate' | 'previously_deleted';
  event: ExistingCalendarEvent;
  reason: string;
};

const points = {
  title: 45,
  description: 60,
  start: 20,
  nearbyStart: 12,
  end: 10,
  location: 10,
  reference: 60,
  differentDescription: -25,
  differentLocation: -15,
};
const duplicateThreshold = 65;
const minimumContentPointsForReference = 20;
const nearbyStartMs = 15 * 60_000;
const labeledReferencePattern =
  /\b\d{3}-\d{7}-\d{7}\b|(?:(?:参照|受付|予約|注文)[ \t]*(?:番号|ID)|booking[ \t]*(?:id|reference))[ \t]*[:#：＃]?[ \t]*([A-Z0-9][A-Z0-9-]{3,})/gi;

function normalizeText(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function normalizedTitle(value: string) {
  return normalizeText(
    value
      .normalize('NFKC')
      .replace(/^(?:(?:fw|fwd|re)\s*:\s*)+/i, '')
      .replace(/\((?:\d+分|受験開始|開始)\)/g, ''),
  );
}

function references(event: { summary?: string; description?: string }) {
  const text = `${event.summary ?? ''}\n${event.description ?? ''}`.normalize('NFKC');
  return new Set(
    [...text.matchAll(labeledReferencePattern)].map((m) => (m[1] ?? m[0]).toUpperCase()),
  );
}

function normalizedDescription(value: string, location: string) {
  const description = normalizeText(
    value
      .normalize('NFKC')
      .replace(/<[^>]+>|https?:\/\/[^\s<]+/gi, ' ')
      .replace(labeledReferencePattern, ' ')
      .replace(
        /(?:\d{4}年)?\d{1,2}月\d{1,2}日|\b(?:\d{4}[-/.])?\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|\d{1,2}時(?:\d{1,2}分)?/g,
        ' ',
      ),
  );
  return location.length >= 4 ? description.replaceAll(location, '') : description;
}

function trigrams(text: string) {
  const chars = Array.from(text);
  const result = new Set<string>();
  for (let index = 2; index < chars.length; index++) {
    result.add(chars.slice(index - 2, index + 1).join(''));
  }
  return result;
}

function similarity(a: string, b: string, { allowPartial = false } = {}) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const first = trigrams(a);
  const second = trigrams(b);
  if (!first.size || !second.size) return 0;
  const shared = [...first].filter((gram) => second.has(gram)).length;
  if (allowPartial && shared >= 6) return shared / Math.min(first.size, second.size);
  return (2 * shared) / (first.size + second.size);
}

function locationScore(location: string, otherLocation: string, title: string, otherTitle: string) {
  if (!location || !otherLocation) return 0;
  if (similarity(location, otherLocation) >= 0.85) return points.location;
  const venueNameInBothTitles = [location, otherLocation].some(
    (place) => place.length >= 4 && title.includes(place) && otherTitle.includes(place),
  );
  return venueNameInBothTitles ? 0 : points.differentLocation;
}

export function matchExisting(
  selected: SelectedEvent,
  existing: ExistingCalendarEvent[],
): Match | null {
  const id = googleEventId(selected.eventKey);
  const start = Date.parse(selected.payload.start.dateTime);
  const end = Date.parse(selected.payload.end.dateTime);
  const day = selected.payload.allDayDate;
  const title = normalizedTitle(selected.payload.summary);
  const location = normalizeText(selected.payload.location);
  const description = normalizedDescription(selected.payload.description, location);
  const refs = references(selected.payload);
  let exactReferenceMatch: Match | undefined;
  let best: { event: ExistingCalendarEvent; score: number } | undefined;

  for (const event of existing) {
    if (
      event.id === id ||
      event.extendedProperties?.private?.sourceEventKey === selected.eventKey ||
      event.iCalUID === selected.iCalUID
    ) {
      return {
        kind: event.status === 'cancelled' ? 'previously_deleted' : 'duplicate',
        event,
        reason: '予定ID・予定キー・ICS UIDの一致',
      };
    }
    if (event.status === 'cancelled' || exactReferenceMatch) continue;

    const otherDay = event.start?.date;
    if (day !== otherDay) continue;
    const difference = day ? 0 : Math.abs(start - Date.parse(event.start?.dateTime ?? ''));
    if (!Number.isFinite(difference) || difference > nearbyStartMs) continue;

    const otherRefs = references(event);
    const sharedReference = [...refs].some((ref) => otherRefs.has(ref));
    if (refs.size && otherRefs.size && !sharedReference) continue;

    const sameEnd = day
      ? selected.payload.end.dateTime.slice(0, 10) === event.end?.date
      : end === Date.parse(event.end?.dateTime ?? '');
    if (sharedReference && difference === 0 && sameEnd) {
      exactReferenceMatch = {
        kind: 'duplicate',
        event,
        reason: '予約・受付・注文番号と開始・終了日時が一致',
      };
      continue;
    }

    const otherTitle = normalizedTitle(event.summary ?? '');
    const otherLocation = normalizeText(event.location ?? '');
    const otherDescription = normalizedDescription(event.description ?? '', otherLocation);
    let contentScore = points.title * similarity(title, otherTitle, { allowPartial: true });
    if (description.length >= 12 && otherDescription.length >= 12) {
      const overlap = similarity(description, otherDescription);
      contentScore += overlap < 0.15 ? points.differentDescription : points.description * overlap;
    }

    let score = contentScore;
    score += difference === 0 ? points.start : points.nearbyStart;
    if (sameEnd) score += points.end;
    if (sharedReference && sameEnd && contentScore >= minimumContentPointsForReference)
      score += points.reference;
    score += locationScore(location, otherLocation, title, otherTitle);

    if (score < duplicateThreshold) continue;
    if (!best || score > best.score) best = { event, score };
  }

  if (exactReferenceMatch) return exactReferenceMatch;
  if (!best) return null;
  return {
    kind: 'duplicate',
    event: best.event,
    reason: `予定の内容・日時を照合して一致（${Math.round(best.score)}点）`,
  };
}
