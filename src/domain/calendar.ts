export type ExistingCalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  iCalUID?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};
