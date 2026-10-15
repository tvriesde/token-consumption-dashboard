import { describe, expect, it } from 'vitest';
import { userDayTokens } from '../scripts/build/aggregate';
import { makeAlias } from '../scripts/build/index';
import type { TrimmedUser } from '../scripts/collect/trim';
import { AuthConfigError, createTokenProvider, permissionsHelp, readAuthSettings, targetEnvSuffix } from '../scripts/lib/auth';
import { DEFAULT_CONFIG, parseConfig, validateConfig } from '../scripts/lib/config';
import { compositeScore, computeSubscores, makeClassifier, maturityLevel, modelMixHealth, nextLevelGaps } from '../shared/scoring';

const cfg = DEFAULT_CONFIG;
const classify = makeClassifier(cfg.model_tiers);

describe('model tiers', () => {
  it.each([
    ['claude-opus-4.1', 'frontier'],
    ['gpt-5', 'frontier'],
    ['o3', 'frontier'],
    ['gemini-2.5-pro', 'frontier'],
    ['claude-sonnet-4.5', 'standard'],
    ['gpt-5-codex', 'standard'],
    ['gpt-4.1', 'standard'],
    ['gpt-5-mini', 'lightweight'],
    ['claude-haiku-4.5', 'lightweight'],
    ['gemini-2.0-flash', 'lightweight'],
    ['gemini-3-pro', 'frontier'],
    ['gemini-3-flash', 'lightweight'],
    ['o4-mini', 'lightweight'],
    ['gpt-4.1-nano', 'lightweight'],
    ['some-new-model', 'unclassified'],
  ])('%s → %s', (model, tier) => expect(classify(model)).toBe(tier));
});

describe('scoring', () => {
  it('scores the target mix as 100 and drifts linearly', () => {
    expect(modelMixHealth({ frontier: 0.2, standard: 0.6, lightweight: 0.2 }, cfg.model_mix_target)).toBeCloseTo(100);
    expect(modelMixHealth({ frontier: 1 }, cfg.model_mix_target)).toBeCloseTo(20);
    expect(modelMixHealth({}, cfg.model_mix_target)).toBeNull();
  });

  it('uses log scales for tokens and linear for active days', () => {
    const s = computeSubscores({ tokens_per_dollar: 50_000, model_mix_health: 50, active_day_ratio: 0.4, tokens_per_dev: 60_000_000 }, cfg.metric_targets);
    expect(s.tokens_per_dollar).toBeCloseTo(0);
    expect(s.model_mix_health).toBeCloseTo(50);
    expect(s.active_day_ratio).toBeCloseTo(50);
    expect(s.tokens_per_dev).toBeCloseTo(100);
  });

  it('weights the composite and counts missing sub-scores as 0', () => {
    const sub = { tokens_per_dollar: 100, model_mix_health: 50, active_day_ratio: null, tokens_per_dev: 50 };
    expect(compositeScore(sub, cfg.weights)).toBeCloseTo(50);
    expect(compositeScore(sub, { tokens_per_dollar: 1, model_mix_health: 0, active_day_ratio: 0, tokens_per_dev: 0 })).toBeCloseTo(100);
  });

  it('assigns fixed maturity levels and lists the gaps to the next level', () => {
    const m = { tokens_per_dollar: 300_000, model_mix_health: 80, active_day_ratio: 0.6, tokens_per_dev: 30_000_000 };
    expect(maturityLevel(m, cfg.maturity_levels)).toBe(3);
    const next = nextLevelGaps(m, 3, cfg.maturity_levels)!;
    expect(next.level.level).toBe(4);
    expect(next.gaps.map((g) => g.metric).sort()).toEqual(['active_day_ratio', 'tokens_per_dev', 'tokens_per_dollar']);
    expect(maturityLevel({ ...m, active_day_ratio: 0.1 }, cfg.maturity_levels)).toBe(1);
    expect(nextLevelGaps({ tokens_per_dollar: 1e6, model_mix_health: 100, active_day_ratio: 1, tokens_per_dev: 1e9 }, 4, cfg.maturity_levels)).toBeNull();
  });
});

describe('token estimation', () => {
  const user = (over: Partial<TrimmedUser>): TrimmedUser => ({
    id: 1,
    login: 'a',
    credits: 0,
    interactions: 0,
    code_gen: 0,
    code_accept: 0,
    loc_added: 0,
    loc_deleted: 0,
    used: [],
    tokens: { prompt: 0, output: 0, by_source: {} },
    models: {},
    phase: null,
    ...over,
  });

  it('estimates tokens from credits with the blended tier price', () => {
    // $2 of standard-tier usage at $2 / M tokens → 1M tokens.
    const r = userDayTokens(user({ credits: 200, models: { 'claude-sonnet-4.5': 5 } }), cfg, classify);
    expect(r.exact).toBe(0);
    expect(r.estimated).toBeCloseTo(1_000_000);
  });

  it('keeps reported CLI tokens and estimates only the remaining spend', () => {
    const r = userDayTokens(
      user({ credits: 200, models: { 'claude-sonnet-4.5': 5 }, tokens: { prompt: 400_000, output: 100_000, by_source: { cli: 500_000 } } }),
      cfg,
      classify,
    );
    expect(r.exact).toBe(500_000);
    expect(r.tokens).toBeCloseTo(1_000_000);
  });

  it('trusts reported IDE tokens as exact', () => {
    const r = userDayTokens(user({ credits: 999, tokens: { prompt: 10, output: 5, by_source: { ide: 15 } } }), cfg, classify);
    expect(r).toEqual({ tokens: 15, exact: 15, estimated: 0 });
  });
});

describe('auth', () => {
  it('requires credentials and explains the permissions', () => {
    expect(readAuthSettings({})).toBeNull();
    expect(() => createTokenProvider('organization', 'https://api.github.com', {})).toThrow(AuthConfigError);
    expect(permissionsHelp('organization')).toMatch(/organization_copilot_metrics|Copilot metrics/i);
    expect(permissionsHelp('enterprise')).toMatch(/enterprise/i);
  });

  it('prefers a GitHub App over a PAT and validates both parts', () => {
    expect(() => readAuthSettings({ COPILOT_APP_ID: '1' })).toThrow(AuthConfigError);
    expect(() => readAuthSettings({ COPILOT_APP_ID: '1', COPILOT_APP_PRIVATE_KEY: 'x', COPILOT_APP_INSTALLATION_ID: 'abc' })).toThrow(/numeric/);
    const s = readAuthSettings({ COPILOT_APP_ID: '1', COPILOT_APP_PRIVATE_KEY: 'k', COPILOT_METRICS_TOKEN: 'pat' });
    expect(s?.mode).toBe('app');
    expect(readAuthSettings({ COPILOT_METRICS_TOKEN: ' pat ' })).toEqual({ mode: 'pat', token: 'pat' });
  });

  it('supports per-organization PATs', async () => {
    expect(targetEnvSuffix('my-org.io')).toBe('MY_ORG_IO');
    const p = createTokenProvider('organization', 'https://api.github.com', { COPILOT_METRICS_TOKEN: 'default', COPILOT_METRICS_TOKEN_MY_ORG: 'special' });
    expect(await p.metrics({ kind: 'org', slug: 'my-org', label: 'my-org' })()).toBe('special');
    expect(await p.metrics({ kind: 'org', slug: 'other', label: 'other' })()).toBe('default');
  });
});

describe('config & privacy', () => {
  it('validates the scope settings', () => {
    expect(validateConfig(parseConfig('scope: organization\norganizations: [acme]'))).toEqual([]);
    expect(() => parseConfig('scope: organization\norganizations: []')).toThrow(/at least one organization/);
    expect(() => parseConfig('scope: enterprise')).toThrow(/enterprise slug is required/);
    expect(() => parseConfig('scope: organization\norganizations: [acme]\nmodel_tiers: [{tier: frontier, patterns: ["("]}]')).toThrow(/invalid regex/);
  });

  it('pseudonymizes logins stably and case-insensitively', () => {
    const a = makeAlias(true, 'salt');
    expect(a('Octocat')).toMatch(/^dev-[0-9a-f]{8}$/);
    expect(a('Octocat')).toBe(a('octocat'));
    expect(makeAlias(true, 'other')('octocat')).not.toBe(a('octocat'));
    expect(makeAlias(false, undefined)('octocat')).toBe('octocat');
  });
});
