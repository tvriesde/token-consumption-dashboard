/**
 * Mock of the GitHub REST endpoints used by the collector, backed by the fixtures in testdata/fixtures.
 * Mimics the real API: auth required, signed download_links, 404 for days not yet available, suppression of
 * teams with < 5 members, enterprise vs organization filtering, and (optionally) transient 500s.
 *
 *   npx tsx scripts/testdata/mock-server.ts --port 4010 [--available-until 2026-09-28] [--fail-every 25]
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { isMain, parseArgs, str } from '../lib/args';
import { DEFAULT_FIXTURES_DIR, fixturePaths, type FixtureMeta } from './generate';

export interface MockOptions {
  fixturesDir?: string;
  port?: number;
  /** Last day for which reports are "generated" (later days → 404). Default: fixture end. */
  availableUntil?: string;
  /** Days for which the user-teams report is not available yet (→ partial day in the collector). */
  teamsUnavailable?: string[];
  /** Return HTTP 500 for every Nth API request (download links excluded). 0 = never. */
  failEvery?: number;
  /** Tokens that are rejected with 401. */
  invalidTokens?: string[];
  /** Tokens that are valid but lack the permission (→ 403 with X-Accepted-GitHub-Permissions). */
  forbiddenTokens?: string[];
  /** Records per download link (to exercise multi-file reports). */
  recordsPerLink?: number;
  log?: (msg: string) => void;
}

export interface MockServer {
  url: string;
  requests: { method: string; path: string; status: number }[];
  setAvailableUntil(day: string | undefined): void;
  setTeamsUnavailable(days: string[]): void;
  close(): Promise<void>;
}

type Rec = Record<string, unknown>;

const PERMS = {
  enterprise: { app: 'enterprise_copilot_metrics=read', classic: 'manage_billing:copilot, read:enterprise' },
  org: { app: 'organization_copilot_metrics=read', classic: 'read:org' },
  orgBilling: { app: 'administration=read', classic: 'admin:org' },
  enterpriseBilling: { app: '', classic: 'manage_billing:enterprise' },
};

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const dir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const p = fixturePaths(dir);
  if (!fs.existsSync(p.meta)) throw new Error(`No fixtures in ${dir}. Run "npm run testdata:generate" first.`);
  const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as FixtureMeta;
  const userOrg = new Map(meta.users.map((u) => [u.id, u.org]));
  const loginOrg = new Map(meta.users.map((u) => [u.login, u.org]));
  const log = opts.log ?? (() => {});
  let availableUntil = opts.availableUntil ?? meta.end;
  let teamsUnavailable = new Set(opts.teamsUnavailable ?? []);
  const perLink = opts.recordsPerLink ?? 60;
  const requests: MockServer['requests'] = [];
  let apiCount = 0;
  const cache = new Map<string, Rec[]>();

  const readNdjson = (file: string): Rec[] | null => {
    if (cache.has(file)) return cache.get(file)!;
    if (!fs.existsSync(file)) return null;
    const recs = zlib
      .gunzipSync(fs.readFileSync(file))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Rec);
    cache.set(file, recs);
    return recs;
  };

  /** Records of a report for one entity, after GitHub's filtering rules. */
  const reportRecords = (kind: 'enterprise' | 'org', slug: string, report: string, day: string): Rec[] | null => {
    if (day < meta.start || day > meta.end || day > availableUntil) return null;
    if (report === 'users-1-day') {
      const recs = readNdjson(p.users(day));
      if (!recs) return null;
      if (kind === 'enterprise') return recs.map(({ organization_id: _o, ...r }) => r);
      return recs.filter((r) => userOrg.get(r.user_id as number) === slug);
    }
    if (teamsUnavailable.has(day)) return null;
    const rows = readNdjson(p.teams(day));
    if (!rows) return null;
    const scoped = rows.filter((r) => kind === 'enterprise' || meta.teams.find((t) => t.id === r.team_id)?.org === slug);
    const counts = new Map<unknown, number>();
    for (const r of scoped) counts.set(r.team_id, (counts.get(r.team_id) ?? 0) + 1);
    return scoped
      .filter((r) => (counts.get(r.team_id) ?? 0) >= 5)
      .map((r) => {
        if (kind === 'enterprise') {
          const { organization_id: _o, ...rest } = r;
          return rest;
        }
        const { enterprise_id: _e, ...rest } = r;
        return rest;
      });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, status });
      log(`mock ${status} ${url.pathname}${url.search}`);
      if (status === 204) {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers });
      res.end(buf);
    };
    const notFound = (message = 'Not Found') => send(404, { message, documentation_url: 'https://docs.github.com/rest' });

    // Signed download links: no auth (like the real pre-signed blob URLs).
    const dl = url.pathname.match(/^\/_downloads\/(enterprise|org)\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(\d+)\.ndjson\.gz$/);
    if (dl) {
      if (!url.searchParams.get('sig')) return send(403, { message: 'Signature missing' });
      const recs = reportRecords(dl[1] as 'enterprise' | 'org', dl[2], dl[3], dl[4]);
      if (!recs) return notFound();
      const part = Number(dl[5]);
      const chunk = recs.slice(part * perLink, (part + 1) * perLink);
      return send(200, zlib.gzipSync(chunk.map((r) => JSON.stringify(r)).join('\n') + '\n'));
    }

    apiCount++;
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^(Bearer|token)\s+/i, '');
    const isEnterprise = url.pathname.startsWith('/enterprises/');
    const isBilling = url.pathname.includes('/settings/billing/');
    const perm = isBilling ? (isEnterprise ? PERMS.enterpriseBilling : PERMS.orgBilling) : isEnterprise ? PERMS.enterprise : PERMS.org;
    const permHeaders = { 'x-accepted-github-permissions': perm.app, 'x-accepted-oauth-scopes': perm.classic, 'x-oauth-scopes': '' };
    if (!token) return send(401, { message: 'Requires authentication' });
    if (opts.invalidTokens?.includes(token)) return send(401, { message: 'Bad credentials' });
    if (opts.forbiddenTokens?.includes(token)) return send(403, { message: 'Resource not accessible by integration' }, permHeaders);
    if (opts.failEvery && apiCount % opts.failEvery === 0) return send(500, { message: 'Simulated server error' });

    const rep = url.pathname.match(/^\/(enterprises|orgs)\/([^/]+)\/copilot\/metrics\/reports\/(users-1-day|user-teams-1-day)$/);
    if (rep) {
      const kind = rep[1] === 'enterprises' ? 'enterprise' : 'org';
      const slug = decodeURIComponent(rep[2]);
      const known = kind === 'enterprise' ? slug === meta.enterprise.slug : meta.orgs.some((o) => o.slug === slug);
      if (!known) return notFound();
      const day = url.searchParams.get('day') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(422, { message: 'Invalid day parameter' });
      const recs = reportRecords(kind, slug, rep[3], day);
      if (!recs) return notFound('No report available for the requested day');
      if (!recs.length && kind === 'org') return send(204, null);
      const host = `http://${req.headers.host}`;
      const parts = Math.max(1, Math.ceil(recs.length / perLink));
      const links = Array.from(
        { length: parts },
        (_, i) => `${host}/_downloads/${kind}/${encodeURIComponent(slug)}/${rep[3]}/${day}/${i}.ndjson.gz?sig=mock&se=${Date.now() + 3600_000}`,
      );
      return send(200, { download_links: links, report_day: day });
    }

    const bill = url.pathname.match(/^\/(enterprises|organizations)\/([^/]+)\/settings\/billing\/ai_credit\/usage$/);
    if (bill) {
      const kind = bill[1] === 'enterprises' ? 'enterprise' : 'org';
      const slug = decodeURIComponent(bill[2]);
      const known = kind === 'enterprise' ? slug === meta.enterprise.slug : meta.orgs.some((o) => o.slug === slug);
      if (!known) return notFound();
      const year = url.searchParams.get('year');
      const month = url.searchParams.get('month');
      const user = url.searchParams.get('user');
      const key = year && month ? `${year}-${month.padStart(2, '0')}` : '';
      const file = p.billing(key);
      if (!key || !fs.existsSync(file)) return send(200, { usageItems: [] });
      const all = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as Record<string, Rec[]>;
      const inScope = (login: string) => kind === 'enterprise' || loginOrg.get(login) === slug;
      const items = Object.entries(all)
        .filter(([login]) => inScope(login) && (!user || login === user))
        .flatMap(([, it]) => it);
      return send(200, { usageItems: items });
    }

    if (url.pathname === '/rate_limit') return send(200, { resources: { core: { limit: 5000, remaining: 4999 } } });
    return notFound();
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setAvailableUntil: (d) => {
      availableUntil = d ?? meta.end;
    },
    setTeamsUnavailable: (days) => {
      teamsUnavailable = new Set(days);
    },
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

if (isMain(import.meta.url)) {
  const { flags } = parseArgs();
  startMockServer({
    fixturesDir: str(flags.fixtures),
    port: flags.port ? Number(flags.port) : 4010,
    availableUntil: str(flags['available-until']),
    failEvery: flags['fail-every'] ? Number(flags['fail-every']) : 0,
    log: flags.verbose ? console.log : undefined,
  }).then((m) => console.log(`Mock GitHub API listening on ${m.url} (use COPILOT_API_URL=${m.url} COPILOT_METRICS_TOKEN=test)`));
}
