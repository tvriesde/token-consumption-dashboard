import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAuthCheck } from '../scripts/check-auth';
import { runCollect } from '../scripts/collect/index';
import type { Ledger } from '../scripts/collect/ledger';
import { addDays } from '../scripts/lib/dates';
import { ensureFixtures } from '../scripts/testdata/generate';
import { startMockServer } from '../scripts/testdata/mock-server';
import { buildTestData, collectTestData, TEST_CONFIGS, type TestScope } from '../scripts/testdata/run-pipeline';
import { compositeScore } from '../shared/scoring';
import type { MonthFile } from '../shared/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pipeline-'));
const meta = ensureFixtures();
const quiet = () => {};

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function summarize(month: MonthFile) {
  const r = (v: number | null) => (v == null ? null : Number(v.toPrecision(3)));
  return {
    month: month.month,
    complete: month.coverage.complete,
    org: { seats: month.org.seats, maturity: month.org.maturity },
    unassigned: month.unassigned?.seats ?? 0,
    teams: Object.fromEntries(
      month.teams.map((t) => [
        t.slug,
        {
          seats: t.seats,
          active: t.active,
          maturity: t.maturity,
          score: Math.round(compositeScore(t.subscores, { tokens_per_dollar: 1, model_mix_health: 1, active_day_ratio: 1, tokens_per_dev: 1 })),
          tokens_per_dollar: r(t.metrics.tokens_per_dollar),
          model_mix_health: r(t.metrics.model_mix_health),
          active_day_ratio: r(t.metrics.active_day_ratio),
          tokens_per_dev: r(t.metrics.tokens_per_dev),
        },
      ]),
    ),
  };
}

describe.each<TestScope>(['enterprise', 'orgs'])('test-data pipeline: %s', (scope) => {
  let collected: Awaited<ReturnType<typeof collectTestData>>;
  let built: ReturnType<typeof buildTestData>;

  beforeAll(async () => {
    collected = await collectTestData(scope, { root, quiet: true });
    built = buildTestData(scope, { root, quiet: true });
  });

  it('first pass leaves the most recent days pending/partial, second pass back-fills them', () => {
    const [p1, p2] = collected.passes;
    const inRange = (days: string[]) => days.filter((d) => d <= meta.end);
    expect(p1.every((t) => inRange(t.pending).length === 2 && t.partial.length === 1)).toBe(true);
    // Days after the fixture range stay pending, exactly like days GitHub has not published yet.
    expect(p2.every((t) => inRange(t.pending).length === 0 && t.partial.length === 0 && t.missing.length === 0)).toBe(true);
    for (const t of p2) {
      const ledger = JSON.parse(fs.readFileSync(path.join(collected.dirs.data, t.target.replace('/', path.sep), 'ledger.json'), 'utf8')) as Ledger;
      expect(Object.entries(ledger.days).filter(([d, e]) => d <= meta.end && e.status === 'ok')).toHaveLength(92);
    }
  });

  it('builds complete calendar months from the 1-day reports', () => {
    expect(meta.users).toHaveLength(304);
    expect(meta.teams).toHaveLength(22);
    for (const t of built.targets) {
      expect(t.months.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
      expect(t.months.every((m) => m.coverage.complete)).toBe(true);
      expect(t.history.months).toEqual(['2026-07', '2026-08', '2026-09']);
      expect(t.months.at(-1)!.teams).toHaveLength(scope === 'enterprise' ? 20 : 10);
      // Teams below 5 seats are not reported by GitHub → no "design" team.
      expect(t.months.at(-1)!.teams.some((x) => x.slug === 'design')).toBe(false);
      expect(t.months.at(-1)!.unassigned?.seats ?? 0).toBeGreaterThan(0);
    }
    expect(built.manifest.pseudonymized).toBe(scope === 'orgs');
    const people = built.targets[0].months.at(-1)!.teams[0].people;
    const alias = /^dev-[0-9a-f]{8}$/;
    if (scope === 'orgs') expect(people.every((p) => alias.test(p.key))).toBe(true);
    else expect(people.every((p) => !alias.test(p.key))).toBe(true);
  });

  it('writes the site data contract', () => {
    const pub = path.join(root, scope, 'public', 'data');
    expect(fs.existsSync(path.join(pub, 'manifest.json'))).toBe(true);
    for (const t of built.manifest.targets) {
      for (const f of ['index.json', 'history.json', '2026-09.json']) expect(fs.existsSync(path.join(pub, t.slug, f))).toBe(true);
    }
  });

  it('produces the expected team metrics (golden snapshot)', () => {
    const snap = Object.fromEntries(built.targets.map((t) => [t.target.slug, summarize(t.months.at(-1)!)]));
    expect(snap).toMatchSnapshot();
  });
});

describe('authentication against the mock API', () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  beforeAll(async () => {
    mock = await startMockServer({ forbiddenTokens: ['no-permission'], invalidTokens: ['revoked'] });
  });
  afterAll(() => mock.close());

  it('passes the preflight with a token that has the permissions', async () => {
    const r = await runAuthCheck({ configPath: TEST_CONFIGS.orgs, apiUrl: mock.url, day: meta.end, env: { COPILOT_METRICS_TOKEN: 'ok' }, log: quiet });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('pat');
    expect(r.rows.filter((x) => x.status === 'fail')).toEqual([]);
  });

  it('fails the preflight and names the missing permission on 403', async () => {
    const r = await runAuthCheck({ configPath: TEST_CONFIGS.orgs, apiUrl: mock.url, day: meta.end, env: { COPILOT_METRICS_TOKEN: 'no-permission' }, log: quiet });
    expect(r.ok).toBe(false);
    expect(r.rows.find((x) => x.status === 'fail')?.detail).toMatch(/organization_copilot_metrics|read:org/);
  });

  it('fails without credentials', async () => {
    const r = await runAuthCheck({ configPath: TEST_CONFIGS.enterprise, apiUrl: mock.url, day: meta.end, env: {}, log: quiet });
    expect(r.ok).toBe(false);
    expect(r.mode).toBeNull();
  });

  it('stops the collector on 401/403 instead of recording empty days', async () => {
    const dataDir = path.join(root, 'forbidden');
    const window = { today: addDays(meta.end, 1), since: addDays(meta.end, -2) };
    await expect(
      runCollect({ configPath: TEST_CONFIGS.orgs, dataDir, apiUrl: mock.url, ...window, env: { COPILOT_METRICS_TOKEN: 'revoked' }, log: quiet }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      runCollect({ configPath: TEST_CONFIGS.orgs, dataDir, apiUrl: mock.url, ...window, env: { COPILOT_METRICS_TOKEN: 'no-permission' }, log: quiet }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fs.existsSync(path.join(dataDir, 'org', 'contoso-apps', 'daily'))).toBe(false);
  });
});
