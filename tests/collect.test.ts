import { describe, expect, it } from 'vitest';
import { addDays, countWorkingDays, dayDiff, daysInRange, earliestAvailableDay, monthEnd, monthOf } from '../scripts/lib/dates';
import { completeMonths, daysToFetch, emptyLedger, recordOutcome } from '../scripts/collect/ledger';
import { buildDailyFile, collectTokenUsage, isActive, trimTeams } from '../scripts/collect/trim';

describe('dates', () => {
  it('handles month and leap-year boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthOf('2026-07-31')).toBe('2026-07');
    expect(dayDiff('2026-07-01', '2026-07-31')).toBe(30);
    expect(daysInRange('2026-06-29', '2026-07-02')).toEqual(['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02']);
  });

  it('counts working days with holidays', () => {
    // July 2026: 23 weekdays.
    expect(countWorkingDays('2026-07-01', '2026-07-31', { weekdays: [1, 2, 3, 4, 5], holidays: [] })).toBe(23);
    expect(countWorkingDays('2026-07-01', '2026-07-31', { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-07-01', '2026-07-04'] })).toBe(22);
  });

  it('limits back-fill to the API retention window', () => {
    expect(earliestAvailableDay('2026-01-01')).toBe('2025-10-10');
    expect(earliestAvailableDay('2027-06-01')).toBe('2026-06-01');
  });
});

describe('ledger (full-month coverage)', () => {
  it('re-fetches pending and partial days only', () => {
    const l = emptyLedger('acme');
    recordOutcome(l, '2026-07-01', { kind: 'ok', users: 3, teams: 1 }, '2026-07-05', 5);
    recordOutcome(l, '2026-07-02', { kind: 'partial', users: 3, error: 'teams 404' }, '2026-07-05', 5);
    recordOutcome(l, '2026-07-03', { kind: 'unavailable', error: '404' }, '2026-07-05', 5);
    expect(daysToFetch(l, '2026-07-01', '2026-07-04')).toEqual(['2026-07-02', '2026-07-03', '2026-07-04']);
    expect(daysToFetch(l, '2026-07-01', '2026-07-02', true)).toEqual(['2026-07-01', '2026-07-02']);
  });

  it('gives up on a day only after the retry limit and once it is more than a week old', () => {
    const l = emptyLedger('acme');
    for (let i = 0; i < 5; i++) recordOutcome(l, '2026-07-01', { kind: 'unavailable', error: '404' }, '2026-07-05', 5);
    expect(l.days['2026-07-01'].status).toBe('pending');
    recordOutcome(l, '2026-07-01', { kind: 'unavailable', error: '404' }, '2026-07-20', 5);
    expect(l.days['2026-07-01'].status).toBe('missing');
  });

  it('reports months where every day is ok', () => {
    const l = emptyLedger('acme');
    for (const d of daysInRange('2026-06-01', '2026-06-30')) recordOutcome(l, d, { kind: 'ok', users: 1, teams: 1 }, '2026-07-10', 5);
    for (const d of daysInRange('2026-07-01', '2026-07-08')) recordOutcome(l, d, { kind: 'ok', users: 1, teams: 1 }, '2026-07-10', 5);
    expect(completeMonths(l)).toEqual(['2026-06']);
  });
});

describe('trim', () => {
  const rec = {
    user_id: 7,
    user_login: 'octocat',
    day: '2026-07-01',
    ai_credits_used: 120,
    user_initiated_interaction_count: 10,
    code_generation_activity_count: 4,
    used_agent: true,
    used_chat: false,
    totals_by_cli: { token_usage: { prompt_tokens_sum: 1000, output_tokens_sum: 200 } },
    totals_by_copilot_app: { token_usage: { prompt_tokens_sum: 50, output_tokens_sum: 5 } },
    totals_by_ide: [{ ide: 'vscode', token_usage: { prompt_tokens_sum: 10, output_tokens_sum: 1 } }],
    totals_by_model_feature: [
      { model: 'claude-sonnet-4.5', feature: 'agent', user_initiated_interaction_count: 6 },
      { model: 'gpt-5-mini', feature: 'chat', user_initiated_interaction_count: 4 },
    ],
  };

  it('sums every token_usage node per source', () => {
    expect(collectTokenUsage(rec)).toEqual({ prompt: 1060, output: 206, by_source: { cli: 1200, copilot_app: 55, ide: 11 } });
  });

  it('merges duplicate user records and joins teams', () => {
    const f = buildDailyFile('2026-07-01', 'acme', 'org', [rec, { ...rec, ai_credits_used: 30, used_agent: false, used_cli: true }], [
      { user_id: 7, user_login: 'octocat', team_id: 11, slug: 'web' },
      { user_id: 8, user_login: 'hubot', team_id: 11, slug: 'web' },
      { user_id: 7, team_id: 11, slug: 'web' },
    ]);
    expect(f.users).toHaveLength(1);
    expect(f.users[0].credits).toBe(150);
    expect(f.users[0].used).toEqual(['agent', 'cli']);
    expect(f.users[0].models).toEqual({ 'claude-sonnet-4.5': 12, 'gpt-5-mini': 8 });
    expect(f.teams).toEqual([{ id: '11', slug: 'web', members: [7, 8] }]);
    expect(f.logins).toEqual({ 7: 'octocat', 8: 'hubot' });
    expect(isActive(f.users[0])).toBe(true);
  });

  it('ignores team rows without a user', () => {
    expect(trimTeams([{ team_id: 1, slug: 'x' }]).teams).toEqual([]);
  });
});
