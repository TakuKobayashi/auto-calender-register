export const DEFAULT_DATABASE_URL =
  'postgresql://auto_calender_register@127.0.0.1:55432/auto_calender_register';

export function databaseUrl() {
  return process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}
