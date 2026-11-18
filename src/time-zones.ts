import { rawTimeZones } from '@vvo/tzdb';
import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';

const cities = JSON.parse(
  readFileSync(new URL('./data/timezone-cities.json', import.meta.url), 'utf8'),
) as Record<string, string[]>;
const normalize = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export function zoneSupported(zone: string, evidence: string) {
  if (!DateTime.now().setZone(zone).isValid) return false;
  const text = normalize(evidence);
  const contains = (s: string) => {
    const value = normalize(s);
    if (value.length < (/^[a-z]/.test(value) ? 3 : 2)) return false;
    return /^[a-z\s/_-]+$/.test(value)
      ? new RegExp(`(?:^|[^a-z])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`).test(
          text,
        )
      : text.includes(value);
  };
  if (contains(zone)) return true;
  const records = rawTimeZones.filter((r) => r.name === zone || r.group.includes(zone));
  for (const record of records) {
    if (
      [...record.mainCities, ...record.group.flatMap((name) => cities[name] ?? [])].some(contains)
    )
      return true;
    const sameCountry = rawTimeZones.filter((r) => r.countryCode === record.countryCode);
    if (
      sameCountry.length === 1 &&
      [
        record.countryName,
        new Intl.DisplayNames(['ja'], { type: 'region' }).of(record.countryCode) ?? '',
      ].some(contains)
    )
      return true;
    if (
      rawTimeZones
        .filter((r) => r.abbreviation === record.abbreviation)
        .every((r) => r.name === record.name) &&
      contains(record.abbreviation)
    )
      return true;
  }
  return false;
}
