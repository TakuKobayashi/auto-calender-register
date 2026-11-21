import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SelectedEvent, Selection } from './selection.js';
import { DateTime } from 'luxon';

export function escapeIcsText(text: string) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

export function foldIcsLine(line: string) {
  const lines: string[] = [];
  let current = '',
    size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > 75) {
      lines.push(current);
      current = ' ';
      size = 1;
    }
    current += char;
    size += bytes;
  }
  lines.push(current);
  return lines.join('\r\n');
}

const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

export function createIcs(events: SelectedEvent[], now = new Date()) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//auto-calendar-register//Mail calendar//JA',
    'CALSCALE:GREGORIAN',
  ];
  for (const event of events) {
    // UTC形式なのでVTIMEZONEに依存せず、海外の予定も同じ瞬間を他アプリへ移せる。
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(event.iCalUID)}`,
      `DTSTAMP:${stamp(now)}`,
      event.payload.allDayDate
        ? `DTSTART;VALUE=DATE:${event.payload.allDayDate.replaceAll('-', '')}`
        : `DTSTART:${stamp(new Date(event.payload.start.dateTime))}`,
      event.payload.allDayDate
        ? `DTEND;VALUE=DATE:${DateTime.fromISO(event.payload.end.dateTime, { setZone: true }).toISODate()!.replaceAll('-', '')}`
        : `DTEND:${stamp(new Date(event.payload.end.dateTime))}`,
      `SUMMARY:${escapeIcsText(event.payload.summary)}`,
      `LOCATION:${escapeIcsText(event.payload.location)}`,
      `DESCRIPTION:${escapeIcsText(event.payload.description)}`,
      'STATUS:CONFIRMED',
      `X-SOURCE-EVENT-KEY:${event.eventKey}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

export async function exportIcs(selection: Selection, file: string, now = new Date()) {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, createIcs(selection.events, now), { mode: 0o600 });
  return {
    path,
    events: selection.events.length,
    pastSkipped: selection.pastSkipped,
    repeatedSkipped: selection.repeatedSkipped,
  };
}
