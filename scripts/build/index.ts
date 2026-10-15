import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HistoryFile, Manifest, MonthFile, Target, TargetIndex } from '../../shared/types';
import type { BillingMonthFile } from '../collect/billing';
import type { DailyFile } from '../collect/trim';
import { parseArgs, isMain, str } from '../lib/args';
import { getTargets, loadConfig, type DashboardConfig } from '../lib/config';
import { monthOf, utcToday } from '../lib/dates';
import { appendStepSummary, billingFilePath, ensureDir, listDailyFiles, readJson, writeJson } from '../lib/storage';
import { aggregateMonth, buildHistory, defaultComposite, makeContext } from './aggregate';

export interface BuildOptions {
  config?: DashboardConfig;
  configPath?: string;
  dataDir?: string;
  outDir?: string;
  today?: string;
  salt?: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export interface BuildResult {
  manifest: Manifest;
  targets: { target: Target; months: MonthFile[]; history: HistoryFile }[];
}

export function makeAlias(enabled: boolean, salt: string | undefined): (login: string) => string {
  if (!enabled) return (l) => l;
  const key = salt ?? '';
  const cache = new Map<string, string>();
  return (login) => {
    const l = login.toLowerCase();
    let v = cache.get(l);
    if (!v) {
      v = 'dev-' + crypto.createHmac('sha256', key).update(l).digest('hex').slice(0, 8);
      cache.set(l, v);
    }
    return v;
  };
}

function embedLogo(cfg: DashboardConfig): string | undefined {
  const logo = cfg.branding.logo;
  if (!logo) return undefined;
  if (/^(https?:|data:)/.test(logo)) return logo;
  if (!fs.existsSync(logo)) throw new Error(`branding.logo file not found: ${logo}`);
  const ext = path.extname(logo).toLowerCase();
  const mime = ({
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  } as Record<string, string>)[ext];
  if (!mime) throw new Error(`Unsupported branding.logo file type: ${ext || '(no extension)'}`);
  return `data:${mime};base64,${fs.readFileSync(logo).toString('base64')}`;
}

export function runBuild(opts: BuildOptions = {}): BuildResult {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const cfg = opts.config ?? loadConfig(opts.configPath);
  const dataDir = opts.dataDir ?? 'data';
  const outData = path.join(opts.outDir ?? 'public', 'data');
  const today = opts.today ?? utcToday();
  const salt = opts.salt ?? env.PSEUDONYM_SALT;

  if (cfg.privacy.pseudonymize && !salt) {
    if (env.GITHUB_ACTIONS === 'true')
      throw new Error('privacy.pseudonymize is enabled but the PSEUDONYM_SALT secret is not set. Add it as a repository secret.');
    log('⚠ PSEUDONYM_SALT is not set — pseudonyms are not secret (anyone can recompute them from a login). Set it in CI.');
  }
  const alias = makeAlias(cfg.privacy.pseudonymize, salt);
  const ctx = makeContext(cfg, alias, today);

  fs.rmSync(outData, { recursive: true, force: true });
  ensureDir(outData);

  const result: BuildResult['targets'] = [];
  const summary: string[] = ['## Dashboard build', '', '| Target | Months | Teams (latest) | Latest coverage |', '|---|---|---|---|'];

  for (const t of getTargets(cfg)) {
    const byMonth = new Map<string, DailyFile[]>();
    for (const f of listDailyFiles(dataDir, t)) {
      const d = readJson<DailyFile>(f);
      const m = monthOf(d.day);
      (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(d);
    }
    const months: MonthFile[] = [];
    for (const [month, days] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
      const bf = billingFilePath(dataDir, t, month);
      const billing = fs.existsSync(bf) ? readJson<BillingMonthFile>(bf) : undefined;
      const mf = aggregateMonth(t.slug, month, days, billing, ctx);
      months.push(mf);
      writeJson(path.join(outData, t.slug, `${month}.json`), mf, false);
    }
    const history = buildHistory(t.slug, months);
    writeJson(path.join(outData, t.slug, 'history.json'), history, false);
    const index: TargetIndex = {
      target: t.slug,
      label: t.label,
      kind: t.kind,
      months: months.map((m) => ({ month: m.month, coverage: m.coverage })),
    };
    writeJson(path.join(outData, t.slug, 'index.json'), index);
    result.push({ target: t, months, history });

    const latest = months.at(-1);
    log(
      `• ${t.label}: ${months.length} month(s)` +
        (latest
          ? `, latest ${latest.month}: ${latest.teams.length} teams, ${latest.org.seats} people, org score ${defaultComposite(latest.org, cfg).toFixed(0)}`
          : ' — no daily data found (run the collector first)'),
    );
    summary.push(
      `| ${t.label} | ${months.length} | ${latest?.teams.length ?? 0} | ${latest ? `${latest.coverage.days_collected}/${latest.coverage.days_expected} days` : '—'} |`,
    );
  }

  const manifest: Manifest = {
    generated_at: new Date().toISOString(),
    scope: cfg.scope,
    branding: { ...cfg.branding, logo: embedLogo(cfg) },
    targets: getTargets(cfg),
    weights: cfg.weights,
    metric_targets: cfg.metric_targets,
    model_mix_target: cfg.model_mix_target,
    model_tiers: cfg.model_tiers,
    maturity_levels: cfg.maturity_levels,
    pricing: cfg.pricing,
    pseudonymized: cfg.privacy.pseudonymize,
  };
  writeJson(path.join(outData, 'manifest.json'), manifest);
  appendStepSummary(summary.join('\n'));
  return { manifest, targets: result };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2)).flags;
  try {
    runBuild({ configPath: str(args.config), dataDir: str(args['data-dir']), outDir: str(args.out), today: str(args.today) });
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
