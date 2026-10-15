import fs from 'node:fs';
import path from 'node:path';
import type { Target } from '../../shared/types';
import { isMain, parseArgs, str } from '../lib/args';
import { AuthConfigError, createTokenProvider } from '../lib/auth';
import { ApiError, GitHubClient } from '../lib/client';
import { getTargets, loadConfig, type DashboardConfig } from '../lib/config';
import { addDays, earliestAvailableDay, monthEnd, monthOf, utcToday } from '../lib/dates';
import {
  appendStepSummary,
  billingFilePath,
  dailyPath,
  ensureDir,
  ledgerPath,
  listDailyFiles,
  rawPath,
  readJson,
  targetDir,
  writeGz,
  writeJson,
} from '../lib/storage';
import { fetchUserBilling, type BillingItem, type BillingMonthFile } from './billing';
import { daysToFetch, emptyLedger, recordOutcome, summarizeLedger, type Ledger } from './ledger';
import { fetchDailyReport } from './reports';
import { buildDailyFile, isActive, serializeDailyFile, type DailyFile } from './trim';

export interface CollectOptions {
  config?: DashboardConfig;
  configPath?: string;
  dataDir?: string;
  apiUrl?: string;
  since?: string;
  until?: string;
  force?: boolean;
  skipBilling?: boolean;
  env?: Record<string, string | undefined>;
  today?: string;
  log?: (msg: string) => void;
}

export interface TargetSummary {
  target: string;
  range: [string, string];
  fetched: string[];
  partial: string[];
  pending: string[];
  missing: string[];
  billing: { months: string[]; users: number; note?: string };
  requests: number;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

function activeLoginsForMonth(dataDir: string, t: Target, month: string): string[] {
  const logins = new Set<string>();
  for (const f of listDailyFiles(dataDir, t)) {
    if (!path.basename(f).startsWith(month)) continue;
    const d = readJson<DailyFile>(f);
    for (const u of d.users) if (isActive(u) && u.login) logins.add(u.login);
  }
  return [...logins].sort();
}

function pruneRaw(dataDir: string, t: Target, months: number, today: string) {
  if (!months) return;
  const cutoff = monthOf(addDays(today, -months * 31));
  const root = path.join(targetDir(dataDir, t), 'raw');
  if (!fs.existsSync(root)) return;
  for (const y of fs.readdirSync(root)) {
    for (const m of fs.readdirSync(path.join(root, y))) {
      if (`${y}-${m}` < cutoff) fs.rmSync(path.join(root, y, m), { recursive: true, force: true });
    }
  }
}

async function collectTarget(cfg: DashboardConfig, t: Target, opts: Required<Pick<CollectOptions, 'dataDir' | 'apiUrl' | 'today' | 'log'>> & CollectOptions): Promise<TargetSummary> {
  const { dataDir, apiUrl, today, log } = opts;
  const tokens = createTokenProvider(cfg.scope, apiUrl, opts.env ?? process.env);
  const client = new GitHubClient({ apiUrl, apiVersion: cfg.api.version, token: tokens.metrics(t), log });

  const lp = ledgerPath(dataDir, t);
  const ledger = readJson<Ledger>(lp, emptyLedger(`${t.kind}/${t.slug}`));
  const earliest = earliestAvailableDay(today);
  let since = opts.since ?? cfg.collect.start_date ?? addDays(today, -cfg.collect.backfill_days);
  if (since < earliest) since = earliest;
  const until = opts.until ?? addDays(today, -1);
  const days = daysToFetch(ledger, since, until, opts.force);
  log(`▶ ${t.kind} "${t.slug}" via ${tokens.describe()} – ${days.length} day(s) to fetch in ${since}…${until}`);

  const fetched: string[] = [];
  for (const day of days) {
    const users = await fetchDailyReport(client, t, 'users-1-day', day);
    if (users.status === 'unavailable') {
      recordOutcome(ledger, day, { kind: 'unavailable', error: `users-1-day HTTP ${users.code}` }, today, cfg.collect.pending_retry_limit);
      writeJson(lp, ledger);
      log(`  ${day}: not available yet (HTTP ${users.code})`);
      continue;
    }
    const teams = await fetchDailyReport(client, t, 'user-teams-1-day', day);
    const teamRecs = teams.status === 'ok' ? teams.records : [];
    if (cfg.collect.keep_raw) {
      writeGz(rawPath(dataDir, t, day, 'users'), users.ndjson);
      if (teams.status === 'ok') writeGz(rawPath(dataDir, t, day, 'user-teams'), teams.ndjson);
    }
    const daily = buildDailyFile(day, t.slug, t.kind, users.records, teamRecs);
    const dp = dailyPath(dataDir, t, day);
    ensureDir(path.dirname(dp));
    fs.writeFileSync(dp, serializeDailyFile(daily));
    if (teams.status === 'ok') {
      recordOutcome(ledger, day, { kind: 'ok', users: daily.users.length, teams: daily.teams.length }, today, cfg.collect.pending_retry_limit);
      log(`  ${day}: ${daily.users.length} users, ${daily.teams.length} teams`);
    } else {
      recordOutcome(ledger, day, { kind: 'partial', users: daily.users.length, error: 'user-teams-1-day not available' }, today, cfg.collect.pending_retry_limit);
      log(`  ${day}: ${daily.users.length} users, team report not available yet (will retry)`);
    }
    fetched.push(day);
    writeJson(lp, ledger);
  }

  // Billing: refresh months that received new data, plus the month-to-date.
  const billing: TargetSummary['billing'] = { months: [], users: 0 };
  const billingToken = tokens.billing(t);
  if (opts.skipBilling || !cfg.collect.billing) billing.note = 'disabled';
  else if (!billingToken) billing.note = 'no billing credentials for this scope (set COPILOT_BILLING_TOKEN)';
  else {
    const billingClient = new GitHubClient({ apiUrl, apiVersion: cfg.api.version, token: billingToken, log });
    const months = new Set(fetched.map(monthOf));
    const lastMonth = monthOf(until);
    if (ledger.days[until]?.status === 'ok' || fetched.length) months.add(lastMonth);
    // Re-fetch any month whose billing was captured before it was complete.
    for (const [m, b] of Object.entries(ledger.billing)) if (!b.complete && b.available) months.add(m);
    for (const month of [...months].sort()) {
      const logins = activeLoginsForMonth(dataDir, t, month);
      if (!logins.length) continue;
      const users: Record<string, BillingItem[]> = {};
      try {
        const results = await mapLimit(logins, 4, async (login) => [login, await fetchUserBilling(billingClient, t, month, login)] as const);
        for (const [login, items] of results) if (items) users[login] = items;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
          billing.note = `billing API not accessible: ${err.hint()}`;
          ledger.billing[month] = { fetched_at: new Date().toISOString(), users: 0, complete: false, available: false };
          break;
        }
        throw err;
      }
      const complete = monthEnd(month) < addDays(today, -2);
      const file: BillingMonthFile = { month, fetched_at: new Date().toISOString(), complete, users };
      writeJson(billingFilePath(dataDir, t, month), file);
      ledger.billing[month] = { fetched_at: file.fetched_at, users: Object.keys(users).length, complete, available: true };
      billing.months.push(month);
      billing.users += Object.keys(users).length;
      log(`  billing ${month}: ${Object.keys(users).length}/${logins.length} users`);
    }
    writeJson(lp, ledger);
  }

  pruneRaw(dataDir, t, cfg.collect.raw_retention_months, today);

  const s = summarizeLedger(ledger);
  if (!s.ok.length && !s.partial.length && s.pending.length + s.missing.length > 0) {
    throw new Error(
      `No data could be retrieved for ${t.kind} "${t.slug}" (every day returned 404). ` +
        'Check the slug, that the App/token can access it, and that the "Copilot usage metrics" policy is enabled. Run "npm run auth:check".',
    );
  }
  return {
    target: `${t.kind}/${t.slug}`,
    range: [since, until],
    fetched,
    partial: s.partial,
    pending: s.pending,
    missing: s.missing,
    billing,
    requests: client.requests,
  };
}

export async function runCollect(opts: CollectOptions = {}): Promise<TargetSummary[]> {
  const cfg = opts.config ?? loadConfig(opts.configPath);
  const env = opts.env ?? process.env;
  const resolved = {
    ...opts,
    dataDir: opts.dataDir ?? (env.DATA_DIR || 'data'),
    apiUrl: opts.apiUrl ?? (env.COPILOT_API_URL || cfg.api.url),
    today: opts.today ?? utcToday(),
    log: opts.log ?? ((m: string) => console.log(m)),
  };
  const out: TargetSummary[] = [];
  for (const t of getTargets(cfg)) out.push(await collectTarget(cfg, t, resolved));
  return out;
}

export function summaryMarkdown(rows: TargetSummary[]): string {
  const lines = [
    '## Copilot usage collection',
    '',
    '| Target | Range | Fetched | Partial | Pending | Missing | Billing | API calls |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.target} | ${r.range[0]} … ${r.range[1]} | ${r.fetched.length} | ${r.partial.length} | ${r.pending.length}${r.pending.length ? ` (${r.pending.slice(-3).join(', ')})` : ''} | ${r.missing.length} | ${r.billing.note ?? `${r.billing.months.join(', ') || '–'} (${r.billing.users} users)`} | ${r.requests} |`,
    );
  }
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const { flags } = parseArgs();
  runCollect({
    configPath: str(flags.config),
    dataDir: str(flags['data-dir']),
    apiUrl: str(flags['api-url']),
    since: str(flags.since),
    until: str(flags.until),
    force: flags.force === true || flags.force === 'true',
    skipBilling: flags['skip-billing'] === true,
  })
    .then((rows) => {
      const md = summaryMarkdown(rows);
      console.log('\n' + md);
      appendStepSummary(md);
    })
    .catch((err) => {
      if (err instanceof AuthConfigError) console.error(`\n✖ ${err.message}`);
      else if (err instanceof ApiError) console.error(`\n✖ ${err.url}: ${err.hint()}`);
      else console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}
