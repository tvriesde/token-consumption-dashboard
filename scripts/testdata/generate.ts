/**
 * Seeded, deterministic generator for the Contoso test dataset (3 months × 20 reported teams by default).
 * Writes API-shaped fixtures (users-1-day / user-teams-1-day NDJSON, billing usageItems) that the mock server serves.
 *
 *   npm run testdata:generate -- --seed 42 --start 2026-07 --months 3 --out testdata/fixtures
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isMain, parseArgs, str } from '../lib/args';
import { addDays, daysInRange, monthEnd, monthOf, monthStart, weekday } from '../lib/dates';
import { ENTERPRISE, FIRST_NAMES, LAST_NAMES, MODELS, ORGS, OVERLAPS, PERSONAS, TEAMLESS, TEAMS, type Persona } from './personas';

export const DEFAULT_FIXTURES_DIR = 'testdata/fixtures';
export const DEFAULT_START = '2026-07';
export const DEFAULT_MONTHS = 3;

type Tier = 'frontier' | 'standard' | 'lightweight';
const TIERS: Tier[] = ['frontier', 'standard', 'lightweight'];

export interface FixtureUser {
  id: number;
  login: string;
  org: string;
}
export interface FixtureMembership {
  user_id: number;
  from?: string;
  to?: string;
}
export interface FixtureTeam {
  id: number;
  slug: string;
  org: string;
  members: FixtureMembership[];
}
export interface FixtureMeta {
  version: 1;
  seed: number;
  start: string;
  end: string;
  months: string[];
  enterprise: { slug: string; id: string };
  orgs: { slug: string; id: string }[];
  users: FixtureUser[];
  teams: FixtureTeam[];
}

export function fixturePaths(dir: string) {
  return {
    meta: path.join(dir, 'meta.json'),
    users: (day: string) => path.join(dir, 'days', monthOf(day), `${day}.users.ndjson.gz`),
    teams: (day: string) => path.join(dir, 'days', monthOf(day), `${day}.user-teams.ndjson.gz`),
    billing: (month: string) => path.join(dir, 'billing', `${month}.json.gz`),
  };
}

/** mulberry32 */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return {
    next,
    normal,
    logNormal: (sigma: number) => Math.exp(normal() * sigma - (sigma * sigma) / 2),
    pick: <T>(arr: T[]) => arr[Math.floor(next() * arr.length)],
    weighted: <T extends { weight: number }>(arr: T[]) => {
      let r = next() * arr.reduce((s, x) => s + x.weight, 0);
      for (const x of arr) if ((r -= x.weight) <= 0) return x;
      return arr[arr.length - 1];
    },
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

interface SimUser extends FixtureUser {
  persona: Persona;
  activityFactor: number;
  volumeFactor: number;
  mix: Record<Tier, number>;
  absences: Set<string>;
}

export function generateDataset(opts: { seed?: number; start?: string; months?: number } = {}) {
  const seed = opts.seed ?? 42;
  const start = opts.start ?? DEFAULT_START;
  const nMonths = opts.months ?? DEFAULT_MONTHS;
  const R = rng(seed);

  const months: string[] = [];
  for (let i = 0, d = monthStart(start); i < nMonths; i++, d = addDays(monthEnd(monthOf(d)), 1)) months.push(monthOf(d));
  const firstDay = monthStart(months[0]);
  const lastDay = monthEnd(months.at(-1)!);

  // --- people -------------------------------------------------------------------------------------------------
  const usedLogins = new Set<string>();
  let nextId = 7_000_100;
  const users: SimUser[] = [];
  const newUser = (org: string, persona: Persona): SimUser => {
    let login = '';
    do login = `${R.pick(FIRST_NAMES)}-${R.pick(LAST_NAMES)}`;
    while (usedLogins.has(login));
    usedLogins.add(login);
    // Personal deviation from the team mix.
    const raw = TIERS.map((t) => Math.max(0, persona.mix[t] * R.logNormal(0.35)));
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    const absences = new Set<string>();
    // 1–2 holiday blocks of 3–10 days.
    for (let b = 0, n = 1 + Math.floor(R.next() * 2); b < n; b++) {
      const s = addDays(firstDay, Math.floor(R.next() * (daysInRange(firstDay, lastDay).length - 10)));
      for (const d of daysInRange(s, addDays(s, 3 + Math.floor(R.next() * 8)))) absences.add(d);
    }
    const u: SimUser = {
      id: nextId++,
      login,
      org,
      persona,
      activityFactor: clamp(1 + R.normal() * 0.18, 0.4, 1.3),
      volumeFactor: R.logNormal(0.55),
      mix: { frontier: raw[0] / sum, standard: raw[1] / sum, lightweight: raw[2] / sum },
      absences,
    };
    users.push(u);
    return u;
  };

  const teams: FixtureTeam[] = [];
  let teamId = 880_001;
  for (const def of TEAMS) {
    const team: FixtureTeam = { id: teamId++, slug: def.slug, org: def.org, members: [] };
    for (let i = 0; i < def.size; i++) team.members.push({ user_id: newUser(def.org, def.persona).id });
    if (def.leavers) {
      for (const m of team.members.slice(-def.leavers.count)) m.to = addDays(monthStart(months[Math.min(def.leavers.month, months.length - 1)]), -1);
    }
    if (def.joiners) {
      const from = monthStart(months[Math.min(def.joiners.month, months.length - 1)]);
      for (let i = 0; i < def.joiners.count; i++) team.members.push({ user_id: newUser(def.org, def.persona).id, from });
    }
    teams.push(team);
  }
  const bySlug = new Map(teams.map((t) => [t.slug, t]));
  for (const [fromSlug, toSlug, count] of OVERLAPS) {
    const from = bySlug.get(fromSlug)!;
    const to = bySlug.get(toSlug)!;
    for (const m of from.members.filter((m) => !m.from && !m.to).slice(0, count)) to.members.push({ user_id: m.user_id });
  }
  for (const [org, n] of Object.entries(TEAMLESS)) for (let i = 0; i < n; i++) newUser(org, PERSONAS.mixed);

  const userById = new Map(users.map((u) => [u.id, u]));
  const membershipOf = (uid: number) => teams.flatMap((t) => t.members.filter((m) => m.user_id === uid));
  const isSeated = (uid: number, day: string) => {
    const ms = membershipOf(uid);
    if (!ms.length) return true;
    return ms.some((m) => (!m.from || day >= m.from) && (!m.to || day <= m.to));
  };

  // --- daily activity --------------------------------------------------------------------------------------------
  const days = daysInRange(firstDay, lastDay);
  const usersByDay = new Map<string, Record<string, unknown>[]>();
  const teamsByDay = new Map<string, Record<string, unknown>[]>();
  const billing = new Map<string, Map<string, Map<string, { credits: number; usd: number }>>>(); // month → login → model

  const meta: FixtureMeta = {
    version: 1,
    seed,
    start: firstDay,
    end: lastDay,
    months,
    enterprise: ENTERPRISE,
    orgs: ORGS,
    users: users.map(({ id, login, org }) => ({ id, login, org })),
    teams,
  };
  const orgId = (slug: string) => ORGS.find((o) => o.slug === slug)!.id;

  for (const day of days) {
    const month = monthOf(day);
    const mi = months.indexOf(month);
    const wd = weekday(day);
    const weekend = wd === 0 || wd === 6;
    const records: Record<string, unknown>[] = [];

    for (const u of users) {
      if (!isSeated(u.id, day) || u.absences.has(day)) continue;
      const prof = u.persona.months[Math.min(mi, u.persona.months.length - 1)];
      const p = clamp(prof.activity * u.activityFactor, 0, 0.99) * (weekend ? 0.06 : 1);
      if (R.next() >= p) continue;

      const tokens = prof.tokensPerDay * u.volumeFactor * R.logNormal(0.45);
      const perModel = new Map<string, { tokens: number; interactions: number; tier: Tier; price: number }>();
      for (const tier of TIERS) {
        const tierTokens = tokens * u.mix[tier];
        if (tierTokens < 1000) continue;
        // Spread tier tokens over 1–2 models of that tier.
        const n = R.next() < 0.35 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const m = R.weighted(MODELS[tier]);
          const e = perModel.get(m.model) ?? { tokens: 0, interactions: 0, tier, price: m.price };
          e.tokens += tierTokens / n;
          perModel.set(m.model, e);
        }
      }
      if (!perModel.size) continue;
      let usd = 0;
      for (const e of perModel.values()) {
        e.interactions = Math.max(1, Math.round(e.tokens / (35_000 * R.logNormal(0.3))));
        usd += (e.tokens / 1e6) * e.price * u.persona.costFactor;
      }
      const credits = r2(usd / 0.01);
      const interactions = [...perModel.values()].reduce((s, e) => s + e.interactions, 0);
      const codeGen = Math.round(interactions * (1.5 + R.next()));
      const codeAccept = Math.round(codeGen * (0.25 + R.next() * 0.3));
      const locAdded = Math.round(codeAccept * (6 + R.next() * 10));

      const cliTokens = tokens * u.persona.cliShare * R.logNormal(0.3);
      const appTokens = tokens * u.persona.appShare * R.logNormal(0.3);
      const tokenUsage = (t: number, requests: number) => ({
        prompt_tokens_sum: Math.round(t * 0.86),
        output_tokens_sum: Math.round(t * 0.14),
        avg_tokens_per_request: Math.round(t / Math.max(1, requests)),
      });

      const modelFeature = [...perModel.entries()].map(([model, e]) => ({
        model,
        feature: e.tier === 'lightweight' ? 'chat_panel_ask_mode' : 'chat_panel_agent_mode',
        user_initiated_interaction_count: e.interactions,
        code_generation_activity_count: Math.round(e.interactions * 1.6),
        code_acceptance_activity_count: Math.round(e.interactions * 0.45),
        loc_suggested_to_add_sum: Math.round(e.interactions * 30),
        loc_added_sum: Math.round(e.interactions * 9),
        loc_deleted_sum: Math.round(e.interactions * 3),
      }));
      modelFeature.push({
        model: 'default',
        feature: 'code_completion',
        user_initiated_interaction_count: 0,
        code_generation_activity_count: Math.round(codeGen * 0.4),
        code_acceptance_activity_count: Math.round(codeAccept * 0.4),
        loc_suggested_to_add_sum: Math.round(codeGen * 4),
        loc_added_sum: Math.round(locAdded * 0.3),
        loc_deleted_sum: 0,
      });

      const rec: Record<string, unknown> = {
        report_start_day: day,
        report_end_day: day,
        day,
        enterprise_id: ENTERPRISE.id,
        organization_id: orgId(u.org),
        user_id: u.id,
        user_login: u.login,
        user_initiated_interaction_count: interactions,
        code_generation_activity_count: codeGen,
        code_acceptance_activity_count: codeAccept,
        loc_suggested_to_add_sum: codeGen * 12,
        loc_suggested_to_delete_sum: Math.round(codeGen * 2),
        loc_added_sum: locAdded,
        loc_deleted_sum: Math.round(locAdded * 0.3),
        ai_credits_used: credits,
        used_chat: true,
        used_agent: [...perModel.values()].some((e) => e.tier !== 'lightweight'),
        used_cli: cliTokens > 0,
        used_copilot_coding_agent: u.persona.appShare > 0 && R.next() < 0.3,
        ai_adoption_phase: { phase: u.persona.adoptionPhase },
        totals_by_ide: [
          {
            ide: R.next() < 0.8 ? 'vscode' : 'intellij',
            user_initiated_interaction_count: interactions,
            code_generation_activity_count: codeGen,
            code_acceptance_activity_count: codeAccept,
            loc_added_sum: locAdded,
            last_known_plugin_version: { plugin: 'copilot-chat', plugin_version: '0.40.0' },
          },
        ],
        totals_by_feature: [
          { feature: 'chat_panel_agent_mode', user_initiated_interaction_count: interactions, code_generation_activity_count: codeGen },
        ],
        totals_by_model_feature: modelFeature,
        totals_by_language_model: [...perModel.entries()].map(([model, e]) => ({
          language: R.pick(['typescript', 'python', 'go', 'java', 'csharp']),
          model,
          code_generation_activity_count: Math.round(e.interactions * 1.6),
          code_acceptance_activity_count: Math.round(e.interactions * 0.45),
        })),
      };
      if (cliTokens > 0) {
        const req = Math.max(1, Math.round(cliTokens / 28_000));
        rec.totals_by_cli = { session_count: Math.max(1, Math.round(req / 12)), request_count: req, token_usage: tokenUsage(cliTokens, req) };
      }
      if (appTokens > 0) {
        const req = Math.max(1, Math.round(appTokens / 40_000));
        rec.totals_by_copilot_app = { session_count: Math.max(1, Math.round(req / 8)), request_count: req, token_usage: tokenUsage(appTokens, req) };
      }
      records.push(rec);

      const mb = billing.get(month) ?? billing.set(month, new Map()).get(month)!;
      const ub = mb.get(u.login) ?? mb.set(u.login, new Map()).get(u.login)!;
      for (const [model, e] of perModel) {
        const usdM = (e.tokens / 1e6) * e.price * u.persona.costFactor;
        const b = ub.get(model) ?? { credits: 0, usd: 0 };
        b.usd += usdM;
        b.credits += usdM / 0.01;
        ub.set(model, b);
      }
    }
    usersByDay.set(day, records);

    const rows: Record<string, unknown>[] = [];
    for (const t of teams) {
      for (const m of t.members) {
        if ((m.from && day < m.from) || (m.to && day > m.to)) continue;
        const u = userById.get(m.user_id)!;
        rows.push({ user_id: u.id, user_login: u.login, day, organization_id: orgId(t.org), enterprise_id: ENTERPRISE.id, team_id: t.id, slug: t.slug });
      }
    }
    teamsByDay.set(day, rows);
  }

  const billingOut = new Map<string, Record<string, unknown[]>>();
  for (const [month, byUser] of billing) {
    const out: Record<string, unknown[]> = {};
    for (const [login, models] of [...byUser].sort(([a], [b]) => a.localeCompare(b))) {
      out[login] = [...models].map(([model, b]) => ({
        product: 'copilot',
        sku: 'copilot_ai_credit',
        model,
        unitType: 'ai-credits',
        pricePerUnit: 0.01,
        grossQuantity: r2(b.credits),
        grossAmount: r2(b.usd),
        discountQuantity: 0,
        discountAmount: 0,
        netQuantity: r2(b.credits),
        netAmount: r2(b.usd),
      }));
    }
    billingOut.set(month, out);
  }

  return { meta, usersByDay, teamsByDay, billing: billingOut };
}

export function writeDataset(dir: string, ds: ReturnType<typeof generateDataset>) {
  fs.rmSync(dir, { recursive: true, force: true });
  const p = fixturePaths(dir);
  const gz = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(text, { level: 9 }));
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p.meta, JSON.stringify(ds.meta, null, 1) + '\n');
  for (const [day, recs] of ds.usersByDay) gz(p.users(day), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const [day, rows] of ds.teamsByDay) gz(p.teams(day), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const [month, b] of ds.billing) gz(p.billing(month), JSON.stringify(b));
}

export function ensureFixtures(dir = DEFAULT_FIXTURES_DIR): FixtureMeta {
  const p = fixturePaths(dir);
  if (!fs.existsSync(p.meta)) {
    console.log(`Generating test fixtures in ${dir} …`);
    writeDataset(dir, generateDataset());
  }
  return JSON.parse(fs.readFileSync(p.meta, 'utf8')) as FixtureMeta;
}

if (isMain(import.meta.url)) {
  const { flags } = parseArgs();
  const dir = str(flags.out) ?? DEFAULT_FIXTURES_DIR;
  const ds = generateDataset({
    seed: flags.seed ? Number(flags.seed) : undefined,
    start: str(flags.start),
    months: flags.months ? Number(flags.months) : undefined,
  });
  writeDataset(dir, ds);
  const records = [...ds.usersByDay.values()].reduce((s, r) => s + r.length, 0);
  console.log(
    `✓ ${dir}: ${ds.meta.months.join(', ')} · ${ds.meta.users.length} users · ${ds.meta.teams.length} teams · ${ds.usersByDay.size} days · ${records} user-day records`,
  );
}
