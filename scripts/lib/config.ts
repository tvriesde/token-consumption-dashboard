import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type {
  Branding,
  MaturityLevelDef,
  MetricKey,
  ModelTierRule,
  Scope,
  ScoredTier,
  Target,
  Tier,
  Weights,
} from '../../shared/types';
import { METRIC_KEYS } from '../../shared/types';

export interface DashboardConfig {
  scope: Scope;
  enterprise?: string;
  organizations?: string[];
  branding: Branding;
  api: { url: string; version: string };
  collect: {
    /** First day to collect (YYYY-MM-DD). Defaults to today − backfill_days. */
    start_date?: string;
    backfill_days: number;
    /** After this many failed attempts a day older than 7 days is marked "missing". */
    pending_retry_limit: number;
    billing: boolean;
    keep_raw: boolean;
    /** Delete raw gz files older than N months (0 = keep forever). */
    raw_retention_months: number;
  };
  pricing: { usd_per_credit: number; estimate_usd_per_million_tokens: Record<Tier, number> };
  model_tiers: ModelTierRule[];
  model_mix_target: Record<ScoredTier, number>;
  metric_targets: Record<MetricKey, number>;
  weights: Weights;
  maturity_levels: MaturityLevelDef[];
  working_days: { weekdays: number[]; holidays: string[] };
  team_names: Record<string, string>;
  privacy: { pseudonymize: boolean };
}

export const DEFAULT_CONFIG: DashboardConfig = {
  scope: 'organization',
  organizations: [],
  branding: {
    title: 'Copilot Maturity Dashboard',
    subtitle: 'Token consumption insights per team',
    logo: '',
    footer: '',
  },
  api: { url: 'https://api.github.com', version: '2026-03-10' },
  collect: {
    backfill_days: 120,
    pending_retry_limit: 5,
    billing: true,
    keep_raw: true,
    raw_retention_months: 0,
  },
  pricing: {
    usd_per_credit: 0.01,
    estimate_usd_per_million_tokens: { frontier: 6, standard: 2, lightweight: 0.4, unclassified: 2 },
  },
  model_tiers: [
    { tier: 'lightweight', patterns: ['haiku', '\\bmini\\b', '\\bnano\\b', 'flash', '\\blite\\b', 'grok-code-fast'] },
    { tier: 'frontier', patterns: ['opus', '^o[1-9](-pro)?$', '^gpt-5(\\.\\d+)?(-pro)?$', 'gemini-[\\d.]+-pro', 'gpt-4\\.5'] },
    { tier: 'standard', patterns: ['sonnet', 'codex', 'gpt-4\\.1', 'gpt-4o', 'gpt-5', 'gemini', 'claude', 'grok'] },
  ],
  model_mix_target: { frontier: 0.2, standard: 0.6, lightweight: 0.2 },
  metric_targets: {
    tokens_per_dollar: 500_000,
    model_mix_health: 100,
    active_day_ratio: 0.8,
    tokens_per_dev: 60_000_000,
  },
  weights: { tokens_per_dollar: 25, model_mix_health: 25, active_day_ratio: 25, tokens_per_dev: 25 },
  maturity_levels: [
    { level: 1, name: 'Exploring', description: 'Has seats, occasional or experimental use.', min: {} },
    { level: 2, name: 'Practicing', description: 'Regular use in daily work.', min: { active_day_ratio: 0.3, tokens_per_dev: 5_000_000 } },
    {
      level: 3,
      name: 'Agentic',
      description: 'Frequent, deep (agent) usage with a sensible model mix.',
      min: { active_day_ratio: 0.55, tokens_per_dev: 25_000_000, model_mix_health: 60 },
    },
    {
      level: 4,
      name: 'Autonomous',
      description: 'Copilot is part of every working day, at scale and cost-efficient.',
      min: { active_day_ratio: 0.75, tokens_per_dev: 60_000_000, model_mix_health: 75, tokens_per_dollar: 400_000 },
    },
  ],
  working_days: { weekdays: [1, 2, 3, 4, 5], holidays: [] },
  team_names: {},
  privacy: { pseudonymize: true },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

export function validateConfig(c: DashboardConfig): string[] {
  const errors: string[] = [];
  const slug = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (c.scope !== 'enterprise' && c.scope !== 'organization') errors.push(`scope must be "enterprise" or "organization" (got "${c.scope}")`);
  if (c.scope === 'enterprise' && (!c.enterprise || !slug.test(c.enterprise))) errors.push('enterprise: a valid enterprise slug is required when scope=enterprise');
  if (c.scope === 'organization') {
    if (!Array.isArray(c.organizations) || c.organizations.length === 0) errors.push('organizations: at least one organization is required when scope=organization');
    else for (const o of c.organizations) if (typeof o !== 'string' || !slug.test(o)) errors.push(`organizations: invalid org name "${o}"`);
  }
  if (!(c.pricing.usd_per_credit > 0)) errors.push('pricing.usd_per_credit must be > 0');
  for (const k of METRIC_KEYS) {
    if (!(c.metric_targets[k] > 0)) errors.push(`metric_targets.${k} must be > 0`);
    if (!(c.weights[k] >= 0)) errors.push(`weights.${k} must be >= 0`);
  }
  for (const rule of c.model_tiers) {
    if (!['frontier', 'standard', 'lightweight'].includes(rule.tier)) errors.push(`model_tiers: unknown tier "${rule.tier}"`);
    for (const p of rule.patterns ?? []) {
      try {
        new RegExp(p, 'i');
      } catch {
        errors.push(`model_tiers: invalid regex "${p}"`);
      }
    }
  }
  const levels = new Set<number>();
  for (const l of c.maturity_levels) {
    if (levels.has(l.level)) errors.push(`maturity_levels: duplicate level ${l.level}`);
    levels.add(l.level);
    for (const k of Object.keys(l.min ?? {})) if (!METRIC_KEYS.includes(k as MetricKey)) errors.push(`maturity_levels[${l.level}].min: unknown metric "${k}"`);
  }
  if (c.collect.start_date && !/^\d{4}-\d{2}-\d{2}$/.test(c.collect.start_date)) errors.push('collect.start_date must be YYYY-MM-DD');
  for (const h of c.working_days.holidays) if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) errors.push(`working_days.holidays: "${h}" must be YYYY-MM-DD`);
  return errors;
}

export function parseConfig(text: string, source = 'config'): DashboardConfig {
  const raw = YAML.parse(text) ?? {};
  // Arrays replace defaults entirely (e.g. model_tiers, maturity_levels).
  const cfg = merge(DEFAULT_CONFIG, raw);
  cfg.collect.start_date = cfg.collect.start_date ? String(cfg.collect.start_date) : undefined;
  cfg.working_days.holidays = (cfg.working_days.holidays ?? []).map(String);
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`Invalid ${source}:\n  - ${errors.join('\n  - ')}`);
  return cfg;
}

export function loadConfig(configPath = process.env.DASHBOARD_CONFIG || 'config/dashboard.config.yml'): DashboardConfig {
  const p = path.resolve(configPath);
  if (!fs.existsSync(p)) throw new Error(`Config file not found: ${p}. Run "npm run configure" or copy config/dashboard.config.yml.`);
  return parseConfig(fs.readFileSync(p, 'utf8'), p);
}

export function getTargets(c: DashboardConfig): Target[] {
  if (c.scope === 'enterprise') return [{ kind: 'enterprise', slug: c.enterprise!, label: c.enterprise! }];
  return (c.organizations ?? []).map((o) => ({ kind: 'org', slug: o, label: o }));
}
