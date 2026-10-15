import {
  compositeScore,
  computeSubscores,
  emptyShares,
  makeClassifier,
  maturityLevel,
  median,
  modelMixHealth,
  normalizeShares,
} from '../../shared/scoring';
import type {
  DailyPoint,
  GroupMonth,
  HistoryFile,
  MetricValues,
  MonthFile,
  PersonMonth,
  TeamMonth,
  Tier,
  TierShares,
  TokenSource,
} from '../../shared/types';
import { ALL_TIERS } from '../../shared/types';
import { summarizeBilling, type BillingMonthFile, type ModelUsage } from '../collect/billing';
import { isActive, type DailyFile, type TrimmedUser } from '../collect/trim';
import type { DashboardConfig } from '../lib/config';
import { countWorkingDays, dayDiff, monthEnd, monthStart } from '../lib/dates';

type Classifier = (model: string) => Tier;

interface Ctx {
  cfg: DashboardConfig;
  classify: Classifier;
  alias: (login: string) => string;
  today: string;
}

/** Built-in GitHub report sections whose token_usage does not cover IDE chat/agent usage. */
const NON_IDE_TOKEN_SOURCES = new Set(['cli', 'copilot_app']);

export function tierShareOfModels(models: Record<string, number>, classify: Classifier): TierShares {
  const raw: Partial<Record<Tier, number>> = {};
  for (const [m, v] of Object.entries(models)) {
    const t = classify(m);
    raw[t] = (raw[t] ?? 0) + v;
  }
  return normalizeShares(raw);
}

/**
 * Tokens for one user-day.
 * - If the report carries token_usage outside CLI/Copilot app (i.e. IDE), all tokens are taken as reported (exact).
 * - Otherwise reported CLI/app tokens are kept and the remaining credit spend is converted to tokens with the
 *   blended per-tier price table (estimated).
 */
export function userDayTokens(u: TrimmedUser, cfg: DashboardConfig, classify: Classifier): { tokens: number; exact: number; estimated: number } {
  const reported = u.tokens.prompt + u.tokens.output;
  const ideReported = Object.entries(u.tokens.by_source)
    .filter(([s]) => !NON_IDE_TOKEN_SOURCES.has(s))
    .reduce((a, [, v]) => a + v, 0);
  if (ideReported > 0) return { tokens: reported, exact: reported, estimated: 0 };

  const prices = cfg.pricing.estimate_usd_per_million_tokens;
  const shares = tierShareOfModels(u.models, classify);
  let blended = ALL_TIERS.reduce((s, t) => s + shares[t] * (prices[t] ?? 0), 0);
  if (!(blended > 0)) blended = prices.unclassified || 2;
  const usd = u.credits * cfg.pricing.usd_per_credit;
  const remainingUsd = Math.max(0, usd - (reported / 1e6) * blended);
  const estimated = (remainingUsd / blended) * 1e6;
  return { tokens: reported + estimated, exact: reported, estimated };
}

interface Acc {
  login: string;
  activeDays: Set<string>;
  credits: number;
  interactions: number;
  exactTokens: number;
  estTokens: number;
  models: Record<string, number>;
}

const newAcc = (login: string): Acc => ({ login, activeDays: new Set(), credits: 0, interactions: 0, exactTokens: 0, estTokens: 0, models: {} });

function addDay(acc: Acc, u: TrimmedUser, day: string, tok: { exact: number; estimated: number }) {
  acc.activeDays.add(day);
  acc.credits += u.credits;
  acc.interactions += u.interactions;
  acc.exactTokens += tok.exact;
  acc.estTokens += tok.estimated;
  for (const [m, v] of Object.entries(u.models)) acc.models[m] = (acc.models[m] ?? 0) + v;
}

function sourceOf(exact: number, est: number): TokenSource {
  if (exact > 0 && est > 0) return 'mixed';
  if (exact > 0) return 'exact';
  if (est > 0) return 'estimated';
  return 'none';
}

function combineSources(sources: TokenSource[]): TokenSource {
  const s = new Set(sources.filter((x) => x !== 'none'));
  if (!s.size) return 'none';
  if (s.size === 1) return [...s][0];
  return 'mixed';
}

interface PersonCalc extends PersonMonth {
  shareWeight: number;
}

function person(acc: Acc, workingDays: number, billing: Record<string, ModelUsage> | undefined, ctx: Ctx): PersonCalc {
  const { cfg, classify } = ctx;
  const cost = acc.credits * cfg.pricing.usd_per_credit;
  let tokens = acc.exactTokens + acc.estTokens;
  let source = sourceOf(acc.exactTokens, acc.estTokens);
  let shares: TierShares;

  // Model mix = share of user-initiated interactions per tier (usage, not spend). Billing credits per model are
  // only used when the usage report carries no model breakdown.
  const interactionsByModel = Object.values(acc.models).reduce((s, v) => s + v, 0);
  const billingCredits = billing ? Object.values(billing).reduce((s, b) => s + b.credits, 0) : 0;
  if (interactionsByModel > 0 || !billing || billingCredits <= 0) {
    shares = tierShareOfModels(acc.models, classify);
  } else {
    const perModel: Record<string, number> = {};
    for (const [m, b] of Object.entries(billing)) perModel[m] = b.credits;
    shares = tierShareOfModels(perModel, classify);
  }
  if (billing && billingCredits > 0 && acc.credits > 0 && Object.values(billing).some((b) => b.tokens != null)) {
    // Billing reports token units: exact tokens. Billing is monthly per user, so scale to the share of credits in this group.
    const billingTokens = Object.values(billing).reduce((s, b) => s + (b.tokens ?? 0), 0);
    tokens = billingTokens * Math.min(1, acc.credits / billingCredits);
    source = 'exact';
  }

  const metrics: MetricValues = {
    tokens_per_dollar: cost > 0 ? tokens / cost : null,
    model_mix_health: modelMixHealth(shares, cfg.model_mix_target),
    active_day_ratio: workingDays > 0 ? Math.min(1, acc.activeDays.size / workingDays) : 0,
    tokens_per_dev: tokens,
  };
  return {
    key: ctx.alias(acc.login),
    active_days: acc.activeDays.size,
    tokens: Math.round(tokens),
    credits: round(acc.credits, 2),
    cost_usd: round(cost, 2),
    interactions: acc.interactions,
    model_shares: roundShares(shares),
    token_source: source,
    metrics: roundMetrics(metrics),
    subscores: roundMetrics(computeSubscores(metrics, cfg.metric_targets)),
    maturity: maturityLevel(metrics, cfg.maturity_levels),
    shareWeight: interactionsByModel || billingCredits,
  };
}

const round = (v: number, d = 0) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
function roundMetrics<T extends Record<string, number | null>>(m: T): T {
  const out = { ...m };
  for (const k of Object.keys(out) as (keyof T)[]) {
    const v = out[k];
    if (typeof v === 'number') (out as Record<keyof T, number | null>)[k] = Math.abs(v) >= 1000 ? Math.round(v) : round(v, 4);
  }
  return out;
}
function roundShares(s: TierShares): TierShares {
  const out = emptyShares();
  for (const t of ALL_TIERS) out[t] = round(s[t], 4);
  return out;
}

function group(
  id: string,
  slug: string,
  name: string,
  people: PersonCalc[],
  daily: Map<string, DailyPoint>,
  ctx: Ctx,
): GroupMonth {
  const { cfg } = ctx;
  const active = people.filter((p) => p.active_days > 0);
  const tokens = people.reduce((s, p) => s + p.tokens, 0);
  const credits = people.reduce((s, p) => s + p.credits, 0);
  const cost = credits * cfg.pricing.usd_per_credit;
  const interactions = people.reduce((s, p) => s + p.interactions, 0);

  const pooled: Partial<Record<Tier, number>> = {};
  for (const p of active) for (const t of ALL_TIERS) pooled[t] = (pooled[t] ?? 0) + p.model_shares[t] * p.shareWeight;
  const shares = normalizeShares(pooled);

  const metrics: MetricValues = {
    tokens_per_dollar: cost > 0 ? tokens / cost : null,
    model_mix_health: modelMixHealth(shares, cfg.model_mix_target),
    active_day_ratio: people.length ? people.reduce((s, p) => s + (p.metrics.active_day_ratio ?? 0), 0) / people.length : 0,
    tokens_per_dev: median(active.map((p) => p.tokens)),
  };
  const maxLevel = Math.max(0, ...cfg.maturity_levels.map((l) => l.level));
  const dist = new Array(maxLevel + 1).fill(0);
  for (const p of people) dist[p.maturity] = (dist[p.maturity] ?? 0) + 1;

  return {
    id,
    slug,
    name,
    seats: people.length,
    active: active.length,
    tokens: Math.round(tokens),
    credits: round(credits, 2),
    cost_usd: round(cost, 2),
    interactions,
    model_shares: roundShares(shares),
    token_source: combineSources(active.map((p) => p.token_source)),
    metrics: roundMetrics(metrics),
    subscores: roundMetrics(computeSubscores(metrics, cfg.metric_targets)),
    maturity: maturityLevel(metrics, cfg.maturity_levels),
    maturity_distribution: dist,
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, tokens: Math.round(d.tokens), cost_usd: round(d.cost_usd, 2) })),
  };
}

export function prettifySlug(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function bumpDaily(map: Map<string, DailyPoint>, day: string, tokens: number, cost: number) {
  const p = map.get(day) ?? { day, active_users: 0, tokens: 0, cost_usd: 0 };
  p.active_users += 1;
  p.tokens += tokens;
  p.cost_usd += cost;
  map.set(day, p);
}

export function aggregateMonth(target: string, month: string, days: DailyFile[], billing: BillingMonthFile | undefined, ctx: Ctx): MonthFile {
  const { cfg, today } = ctx;
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const mEnd = monthEnd(month);
  const complete = mEnd < today;
  const lastDay = sorted.at(-1)?.day ?? null;
  const periodEnd = complete ? mEnd : (lastDay ?? monthStart(month));
  const workingDays = Math.max(1, countWorkingDays(monthStart(month), periodEnd, cfg.working_days));
  const usdPerCredit = cfg.pricing.usd_per_credit;

  const logins = new Map<number, string>();
  const orgAcc = new Map<number, Acc>();
  const orgDaily = new Map<string, DailyPoint>();
  const everInTeam = new Set<number>();
  const teams = new Map<string, { slug: string; lastDay: string; lastMembers: Set<number>; accs: Map<number, Acc>; daily: Map<string, DailyPoint> }>();

  for (const d of sorted) {
    for (const [id, login] of Object.entries(d.logins)) logins.set(Number(id), login);
    const activeToday = new Map<number, { u: TrimmedUser; tok: ReturnType<typeof userDayTokens> }>();
    for (const u of d.users) {
      if (!isActive(u)) continue;
      const tok = userDayTokens(u, cfg, ctx.classify);
      activeToday.set(u.id, { u, tok });
      let acc = orgAcc.get(u.id);
      if (!acc) orgAcc.set(u.id, (acc = newAcc(u.login)));
      addDay(acc, u, d.day, tok);
      bumpDaily(orgDaily, d.day, tok.tokens, u.credits * usdPerCredit);
    }
    for (const t of d.teams) {
      let info = teams.get(t.id);
      if (!info) teams.set(t.id, (info = { slug: t.slug, lastDay: '', lastMembers: new Set(), accs: new Map(), daily: new Map() }));
      if (d.day >= info.lastDay) {
        info.lastDay = d.day;
        info.lastMembers = new Set(t.members);
        info.slug = t.slug;
      }
      for (const id of t.members) {
        everInTeam.add(id);
        const a = activeToday.get(id);
        if (!a) continue;
        let acc = info.accs.get(id);
        if (!acc) info.accs.set(id, (acc = newAcc(a.u.login)));
        addDay(acc, a.u, d.day, a.tok);
        bumpDaily(info.daily, d.day, a.tok.tokens, a.u.credits * usdPerCredit);
      }
    }
  }

  const billingByLogin = new Map<string, Record<string, ModelUsage>>();
  for (const [login, items] of Object.entries(billing?.users ?? {})) billingByLogin.set(login.toLowerCase(), summarizeBilling(items, usdPerCredit));
  const personFor = (id: number, acc: Acc | undefined) => {
    const a = acc ?? newAcc(logins.get(id) ?? String(id));
    return person(a, workingDays, billingByLogin.get(a.login.toLowerCase()), ctx);
  };
  const byKey = (a: PersonMonth, b: PersonMonth) => b.tokens - a.tokens || a.key.localeCompare(b.key);
  const strip = (p: PersonCalc): PersonMonth => {
    const { shareWeight: _w, ...rest } = p;
    return rest;
  };

  const teamOut: TeamMonth[] = [];
  for (const [id, info] of teams) {
    const seatIds = new Set([...info.lastMembers, ...info.accs.keys()]);
    const people = [...seatIds].map((uid) => personFor(uid, info.accs.get(uid)));
    const g = group(id, info.slug, cfg.team_names[info.slug] ?? prettifySlug(info.slug), people, info.daily, ctx);
    teamOut.push({ ...g, people: people.map(strip).sort(byKey) });
  }
  teamOut.sort((a, b) => b.seats - a.seats || a.name.localeCompare(b.name));

  const unassignedIds = [...orgAcc.keys()].filter((id) => !everInTeam.has(id));
  let unassigned: TeamMonth | null = null;
  if (unassignedIds.length) {
    const people = unassignedIds.map((uid) => personFor(uid, orgAcc.get(uid)));
    const daily = new Map<string, DailyPoint>();
    for (const d of sorted)
      for (const u of d.users)
        if (!everInTeam.has(u.id) && isActive(u)) bumpDaily(daily, d.day, userDayTokens(u, cfg, ctx.classify).tokens, u.credits * usdPerCredit);
    const g = group('unassigned', 'unassigned', 'Not in a reported team', people, daily, ctx);
    unassigned = { ...g, people: people.map(strip).sort(byKey) };
  }

  const orgIds = new Set([...everInTeam, ...orgAcc.keys()]);
  const orgPeople = [...orgIds].map((uid) => personFor(uid, orgAcc.get(uid)));
  const org = group('org', target, target, orgPeople, orgDaily, ctx);

  return {
    target,
    month,
    generated_at: new Date().toISOString(),
    coverage: {
      days_collected: sorted.length,
      days_expected: dayDiff(monthStart(month), periodEnd) + 1,
      first_day: sorted[0]?.day ?? null,
      last_day: lastDay,
      working_days: workingDays,
      complete: complete && sorted.length === dayDiff(monthStart(month), mEnd) + 1,
    },
    billing: !!billing && Object.keys(billing.users).length > 0,
    org,
    teams: teamOut,
    unassigned,
  };
}

export function buildHistory(target: string, months: MonthFile[]): HistoryFile {
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const point = (month: string, g: GroupMonth) => ({
    month,
    seats: g.seats,
    active: g.active,
    metrics: g.metrics,
    subscores: g.subscores,
    maturity: g.maturity,
  });
  const teams: HistoryFile['teams'] = {};
  for (const m of sorted) {
    for (const t of m.teams) {
      const entry = (teams[t.id] ??= { name: t.name, points: [] });
      entry.name = t.name;
      entry.points.push(point(m.month, t));
    }
  }
  return { target, months: sorted.map((m) => m.month), org: sorted.map((m) => point(m.month, m.org)), teams };
}

export function makeContext(cfg: DashboardConfig, alias: (login: string) => string, today: string): Ctx {
  return { cfg, classify: makeClassifier(cfg.model_tiers), alias, today };
}

/** Convenience used in tests/logging: composite with the configured default weights. */
export function defaultComposite(g: GroupMonth, cfg: DashboardConfig) {
  return compositeScore(g.subscores, cfg.weights);
}
