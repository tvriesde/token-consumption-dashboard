export function formatCompact(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(digits) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(digits) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(digits) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(digits) + 'K';
  return v.toFixed(a < 10 && a % 1 ? digits : 0);
}

export function formatPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return (v * 100).toFixed(digits) + '%';
}

export function formatUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 1000) return '$' + formatCompact(v);
  return '$' + v.toFixed(2);
}

export function formatScore(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return v.toFixed(1);
}

export function formatMonth(month: string, locale?: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
