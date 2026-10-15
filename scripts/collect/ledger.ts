import { dayDiff, daysInRange } from '../lib/dates';

export type DayStatus = 'ok' | 'partial' | 'pending' | 'missing';

export interface LedgerEntry {
  status: DayStatus;
  attempts: number;
  updated_at: string;
  users?: number;
  teams?: number;
  error?: string;
}

export interface Ledger {
  version: 1;
  target: string;
  days: Record<string, LedgerEntry>;
  billing: Record<string, { fetched_at: string; users: number; complete: boolean; available: boolean }>;
}

export function emptyLedger(target: string): Ledger {
  return { version: 1, target, days: {}, billing: {} };
}

/** Days in [from, to] that still need fetching: new days, pending/partial days, or everything with force. */
export function daysToFetch(ledger: Ledger, from: string, to: string, force = false): string[] {
  if (to < from) return [];
  return daysInRange(from, to).filter((d) => {
    const e = ledger.days[d];
    if (force || !e) return true;
    return e.status === 'pending' || e.status === 'partial';
  });
}

export type FetchOutcome =
  | { kind: 'ok'; users: number; teams: number }
  | { kind: 'partial'; users: number; error: string }
  | { kind: 'unavailable'; error: string };

export function recordOutcome(ledger: Ledger, day: string, outcome: FetchOutcome, today: string, retryLimit: number, now = new Date().toISOString()) {
  const prev = ledger.days[day];
  const attempts = (prev?.attempts ?? 0) + 1;
  if (outcome.kind === 'ok') {
    ledger.days[day] = { status: 'ok', attempts, updated_at: now, users: outcome.users, teams: outcome.teams };
  } else if (outcome.kind === 'partial') {
    ledger.days[day] = { status: 'partial', attempts, updated_at: now, users: outcome.users, error: outcome.error };
  } else {
    const giveUp = attempts >= retryLimit && dayDiff(day, today) > 7;
    ledger.days[day] = { status: giveUp ? 'missing' : 'pending', attempts, updated_at: now, error: outcome.error };
  }
}

export function summarizeLedger(ledger: Ledger) {
  const by: Record<DayStatus, string[]> = { ok: [], partial: [], pending: [], missing: [] };
  for (const [d, e] of Object.entries(ledger.days)) by[e.status].push(d);
  for (const k of Object.keys(by) as DayStatus[]) by[k].sort();
  return by;
}

/** Full calendar months whose every day is ok in the ledger. */
export function completeMonths(ledger: Ledger): string[] {
  const months = new Set(Object.keys(ledger.days).map((d) => d.slice(0, 7)));
  return [...months].filter((m) => {
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    for (let i = 1; i <= last; i++) {
      const d = `${m}-${String(i).padStart(2, '0')}`;
      if (ledger.days[d]?.status !== 'ok') return false;
    }
    return true;
  });
}
