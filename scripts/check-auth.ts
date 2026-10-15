/**
 * Preflight: verifies that the configured GitHub App / PAT can read every endpoint the collector needs.
 *
 *   npm run auth:check [-- --config config/dashboard.config.yml] [--day YYYY-MM-DD] [--api-url URL]
 *
 * Exit code 1 when credentials are missing or a required endpoint is denied.
 */
import type { Target } from '../shared/types';
import { billingEndpoint } from './collect/billing';
import { reportEndpoint, type ReportName } from './collect/reports';
import { isMain, parseArgs, str } from './lib/args';
import { AuthConfigError, createTokenProvider, permissionsHelp } from './lib/auth';
import { ApiError, GitHubClient } from './lib/client';
import { getTargets, loadConfig, type DashboardConfig } from './lib/config';
import { addDays, utcToday } from './lib/dates';
import { appendStepSummary } from './lib/storage';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface CheckRow {
  target: string;
  check: string;
  status: CheckStatus;
  detail: string;
}

export interface AuthCheckOptions {
  config?: DashboardConfig;
  configPath?: string;
  apiUrl?: string;
  day?: string;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

async function probeReport(client: GitHubClient, t: Target, report: ReportName, days: string[]): Promise<Omit<CheckRow, 'target' | 'check'>> {
  try {
    for (const day of days) {
      const res = await client.get<{ download_links?: string[] }>(reportEndpoint(t, report), { day }, [404]);
      if (res.status === 404) continue;
      const links = res.data?.download_links?.length ?? 0;
      return { status: 'ok', detail: `HTTP ${res.status} for ${day}${res.status === 200 ? ` (${links} download link${links === 1 ? '' : 's'})` : ''}` };
    }
    return {
      status: 'warn',
      detail: `404 for ${days.join(', ')} – access looks fine but no report found. Check the slug, that the "Copilot usage metrics" policy is enabled and that data exists (available from 2025-10-10, ~2 days delay).`,
    };
  } catch (err) {
    if (err instanceof ApiError) return { status: 'fail', detail: err.hint() };
    return { status: 'fail', detail: (err as Error).message };
  }
}

export async function runAuthCheck(opts: AuthCheckOptions = {}): Promise<{ rows: CheckRow[]; ok: boolean; mode: string | null }> {
  const cfg = opts.config ?? loadConfig(opts.configPath);
  const env = opts.env ?? process.env;
  const apiUrl = opts.apiUrl ?? (env.COPILOT_API_URL || cfg.api.url);
  const log = opts.log ?? console.log;
  const rows: CheckRow[] = [];
  const targets = getTargets(cfg);

  let tokens;
  try {
    tokens = createTokenProvider(cfg.scope, apiUrl, env);
  } catch (err) {
    if (err instanceof AuthConfigError) {
      rows.push({ target: '*', check: 'credentials', status: 'fail', detail: err.message });
      return { rows, ok: false, mode: null };
    }
    throw err;
  }
  rows.push({ target: '*', check: 'credentials', status: 'ok', detail: tokens.describe() });

  const base = opts.day ?? addDays(utcToday(), -2);
  const days = [base, addDays(base, -1), addDays(base, -5)];
  for (const t of targets) {
    const name = `${t.kind}/${t.slug}`;
    let client: GitHubClient;
    try {
      client = new GitHubClient({ apiUrl, apiVersion: cfg.api.version, token: tokens.metrics(t), log, maxRetries: 2 });
    } catch (err) {
      rows.push({ target: name, check: 'token', status: 'fail', detail: (err as Error).message });
      continue;
    }
    for (const report of ['users-1-day', 'user-teams-1-day'] as const) {
      const r = await probeReport(client, t, report, days);
      rows.push({ target: name, check: report, ...r });
      if (r.status === 'fail') break;
    }
    if (!cfg.collect.billing) continue;
    const billing = tokens.billing(t);
    if (!billing) {
      rows.push({
        target: name,
        check: 'billing (optional)',
        status: 'warn',
        detail: 'No billing credentials (set COPILOT_BILLING_TOKEN). Costs/model mix come from the metrics reports only.',
      });
      continue;
    }
    const bc = new GitHubClient({ apiUrl, apiVersion: cfg.api.version, token: billing, log, maxRetries: 2 });
    const [y, m] = base.split('-').map(Number);
    try {
      const res = await bc.get<{ usageItems?: unknown[] }>(billingEndpoint(t), { year: y, month: m }, [404]);
      rows.push(
        res.status === 404
          ? { target: name, check: 'billing (optional)', status: 'warn', detail: 'HTTP 404 – billing usage endpoint not available for this account.' }
          : { target: name, check: 'billing (optional)', status: 'ok', detail: `HTTP ${res.status}, ${res.data?.usageItems?.length ?? 0} usage items this month` },
      );
    } catch (err) {
      rows.push({
        target: name,
        check: 'billing (optional)',
        status: 'warn',
        detail: err instanceof ApiError ? err.hint() : (err as Error).message,
      });
    }
  }
  return { rows, ok: !rows.some((r) => r.status === 'fail'), mode: tokens.mode };
}

export function renderCheck(rows: CheckRow[], markdown = false): string {
  if (markdown) {
    return [
      '## Copilot API access check',
      '',
      '| | Target | Check | Detail |',
      '|---|---|---|---|',
      ...rows.map((r) => `| ${ICON[r.status]} | ${r.target} | ${r.check} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, '<br>')} |`),
    ].join('\n');
  }
  const w = Math.max(...rows.map((r) => r.target.length));
  const c = Math.max(...rows.map((r) => r.check.length));
  return rows.map((r) => `${ICON[r.status]} ${r.target.padEnd(w)}  ${r.check.padEnd(c)}  ${r.detail}`).join('\n');
}

if (isMain(import.meta.url)) {
  const { flags } = parseArgs();
  let cfg: DashboardConfig;
  try {
    cfg = loadConfig(str(flags.config));
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
  runAuthCheck({ config: cfg, apiUrl: str(flags['api-url']), day: str(flags.day), log: () => {} })
    .then(({ rows, ok }) => {
      console.log(renderCheck(rows));
      appendStepSummary(renderCheck(rows, true));
      if (!ok) {
        console.error('\n' + permissionsHelp(cfg.scope));
        process.exit(1);
      }
      console.log('\nAll required checks passed.');
    })
    .catch((err) => {
      console.error(`✗ ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}
