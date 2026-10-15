/** Date helpers. All days are UTC calendar days in YYYY-MM-DD form. */

export const API_FIRST_DAY = '2025-10-10';

export function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export function utcToday(): string {
  return toDay(new Date());
}

export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
}

export function dayDiff(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

export function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return toDay(new Date(Date.UTC(y, m, 0)));
}

export function weekday(day: string): number {
  return parseDay(day).getUTCDay();
}

export interface WorkingDaysConfig {
  weekdays: number[];
  holidays: string[];
}

export function isWorkingDay(day: string, cfg: WorkingDaysConfig): boolean {
  return cfg.weekdays.includes(weekday(day)) && !cfg.holidays.includes(day);
}

export function countWorkingDays(from: string, to: string, cfg: WorkingDaysConfig): number {
  if (to < from) return 0;
  return daysInRange(from, to).filter((d) => isWorkingDay(d, cfg)).length;
}

/** Earliest day still retrievable: max(API start, today − 1 year). */
export function earliestAvailableDay(today: string): string {
  const yearAgo = addDays(today, -365);
  return yearAgo > API_FIRST_DAY ? yearAgo : API_FIRST_DAY;
}
