/** Converts raw API records into the compact daily format stored in data/<kind>/<slug>/daily. */

export interface TrimmedUser {
  id: number;
  login: string;
  credits: number;
  interactions: number;
  code_gen: number;
  code_accept: number;
  loc_added: number;
  loc_deleted: number;
  /** used_* flags that were true, without the prefix (agent, chat, cli, …). */
  used: string[];
  /** Reported tokens; by_source keys: cli, copilot_app, or any other report section carrying token_usage. */
  tokens: { prompt: number; output: number; by_source: Record<string, number> };
  /** Interactions (or generations when no interactions) per model. */
  models: Record<string, number>;
  phase: string | null;
}

export interface TrimmedTeam {
  id: string;
  slug: string;
  members: number[];
}

export interface DailyFile {
  version: 1;
  day: string;
  target: string;
  kind: string;
  users: TrimmedUser[];
  teams: TrimmedTeam[];
  /** user id → login for everyone seen that day (active users and team members). */
  logins: Record<string, string>;
}

type Rec = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Recursively finds every `token_usage` object and sums prompt/output tokens per source.
 * Picks up documented sections (CLI, Copilot app) and any future/undocumented ones (e.g. IDE).
 */
export function collectTokenUsage(rec: unknown): TrimmedUser['tokens'] {
  const out = { prompt: 0, output: 0, by_source: {} as Record<string, number> };
  const walk = (node: unknown, parentKey: string) => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, parentKey);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Rec)) {
      if (k === 'token_usage' && v && typeof v === 'object' && !Array.isArray(v)) {
        const tu = v as Rec;
        const p = num(tu.prompt_tokens_sum);
        const o = num(tu.output_tokens_sum);
        if (p || o) {
          const source = parentKey.replace(/^totals_by_/, '') || 'root';
          out.prompt += p;
          out.output += o;
          out.by_source[source] = (out.by_source[source] ?? 0) + p + o;
        }
      } else if (v && typeof v === 'object') {
        walk(v, k);
      }
    }
  };
  walk(rec, '');
  return out;
}

function modelUsage(rec: Rec): Record<string, number> {
  const fromRows = (rows: unknown, field: string) => {
    const m: Record<string, number> = {};
    if (!Array.isArray(rows)) return m;
    for (const r of rows as Rec[]) {
      const model = typeof r.model === 'string' ? r.model : '';
      const v = num(r[field]);
      if (model && v) m[model] = (m[model] ?? 0) + v;
    }
    return m;
  };
  const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
  for (const field of ['user_initiated_interaction_count', 'code_generation_activity_count']) {
    const m = fromRows(rec.totals_by_model_feature, field);
    if (sum(m) > 0) return m;
  }
  for (const field of ['user_initiated_interaction_count', 'code_generation_activity_count']) {
    const m = fromRows(rec.totals_by_language_model, field);
    if (sum(m) > 0) return m;
  }
  return {};
}

function phaseOf(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Rec;
    for (const k of ['phase', 'name', 'cohort', 'value']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return null;
}

export function trimUser(rec: Rec): TrimmedUser {
  const used = Object.entries(rec)
    .filter(([k, v]) => k.startsWith('used_') && v === true)
    .map(([k]) => k.slice(5))
    .sort();
  return {
    id: num(rec.user_id),
    login: String(rec.user_login ?? rec.user_id ?? ''),
    credits: num(rec.ai_credits_used),
    interactions: num(rec.user_initiated_interaction_count),
    code_gen: num(rec.code_generation_activity_count),
    code_accept: num(rec.code_acceptance_activity_count),
    loc_added: num(rec.loc_added_sum),
    loc_deleted: num(rec.loc_deleted_sum),
    used,
    tokens: collectTokenUsage(rec),
    models: modelUsage(rec),
    phase: phaseOf(rec.ai_adoption_phase),
  };
}

export function isActive(u: TrimmedUser): boolean {
  return u.interactions > 0 || u.code_gen > 0 || u.credits > 0 || u.used.length > 0 || u.tokens.prompt + u.tokens.output > 0;
}

export function trimTeams(rows: Rec[]): { teams: TrimmedTeam[]; logins: Record<string, string> } {
  const byId = new Map<string, TrimmedTeam>();
  const logins: Record<string, string> = {};
  for (const r of rows) {
    const id = String(r.team_id ?? r.slug ?? '');
    const uid = num(r.user_id);
    if (!id || !uid) continue;
    if (typeof r.user_login === 'string') logins[uid] = r.user_login;
    let t = byId.get(id);
    if (!t) byId.set(id, (t = { id, slug: String(r.slug ?? r.team_slug ?? id), members: [] }));
    if (!t.members.includes(uid)) t.members.push(uid);
  }
  const teams = [...byId.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const t of teams) t.members.sort((a, b) => a - b);
  return { teams, logins };
}

export function buildDailyFile(day: string, target: string, kind: string, userRecs: Rec[], teamRecs: Rec[]): DailyFile {
  // A user can appear in more than one record (e.g. multiple download files); merge by summing.
  const users = new Map<number, TrimmedUser>();
  for (const rec of userRecs) {
    const u = trimUser(rec);
    if (!u.id) continue;
    const prev = users.get(u.id);
    if (!prev) {
      users.set(u.id, u);
      continue;
    }
    for (const k of ['credits', 'interactions', 'code_gen', 'code_accept', 'loc_added', 'loc_deleted'] as const) prev[k] += u[k];
    prev.used = [...new Set([...prev.used, ...u.used])].sort();
    prev.tokens.prompt += u.tokens.prompt;
    prev.tokens.output += u.tokens.output;
    for (const [s, v] of Object.entries(u.tokens.by_source)) prev.tokens.by_source[s] = (prev.tokens.by_source[s] ?? 0) + v;
    for (const [m, v] of Object.entries(u.models)) prev.models[m] = (prev.models[m] ?? 0) + v;
  }
  const { teams, logins } = trimTeams(teamRecs);
  for (const u of users.values()) logins[u.id] = u.login;
  return {
    version: 1,
    day,
    target,
    kind,
    users: [...users.values()].sort((a, b) => a.id - b.id),
    teams,
    logins,
  };
}

/** Diff-friendly serialisation: one user / team per line. */
export function serializeDailyFile(f: DailyFile): string {
  const lines = [
    '{',
    `"version":1,"day":${JSON.stringify(f.day)},"target":${JSON.stringify(f.target)},"kind":${JSON.stringify(f.kind)},`,
    '"users":[',
    f.users.map((u) => JSON.stringify(u)).join(',\n'),
    '],',
    '"teams":[',
    f.teams.map((t) => JSON.stringify(t)).join(',\n'),
    '],',
    `"logins":${JSON.stringify(f.logins)}`,
    '}',
  ];
  return lines.join('\n') + '\n';
}
