import { formatMonth } from '../shared/format';
import { METRIC_META } from '../shared/metrics-meta';
import { compositeScore, nextLevelGaps } from '../shared/scoring';
import type { DailyPoint, GroupMonth, HistoryFile, Manifest, MetricKey, MonthFile, TeamMonth, Tier, Weights } from '../shared/types';
import { ALL_TIERS, METRIC_KEYS } from '../shared/types';
import { renderDaily, renderHistoryChart, type Series } from './history-chart';
import { type Baselines, formatCompact, formatMetric, formatUsd, verdict } from './scores';
import { escapeHtml } from './treemap';

export const TIER_COLORS: Record<Tier, string> = {
  frontier: '#8250df',
  standard: '#0969da',
  lightweight: '#1f883d',
  unclassified: '#8c959f',
};
export const METRIC_COLORS: Record<MetricKey, string> = {
  tokens_per_dollar: '#bf8700',
  model_mix_health: '#8250df',
  active_day_ratio: '#0969da',
  tokens_per_dev: '#bc4c00',
};
const TIER_LABEL: Record<Tier, string> = { frontier: 'Frontier', standard: 'Standard', lightweight: 'Lightweight', unclassified: 'Unclassified' };
const SOURCE_LABEL = {
  exact: 'Exact (reported by GitHub)',
  mixed: 'Partly reported, partly estimated from AI credits',
  estimated: 'Estimated from AI credits',
  none: 'No token data',
};

export interface PaneInput {
  manifest: Manifest;
  month: MonthFile;
  teams: TeamMonth[];
  team: TeamMonth | null;
  weights: Weights;
  base: Baselines;
  history: HistoryFile;
  onSelect: (id: string | null) => void;
}

const sign = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);
const levelName = (m: Manifest, level: number) => m.maturity_levels.find((l) => l.level === level)?.name ?? `Level ${level}`;

export function mixBar(shares: Record<Tier, number>, target?: Manifest['model_mix_target']): string {
  const segs = ALL_TIERS.filter((t) => shares[t] > 0.0005)
    .map(
      (t) =>
        `<span class="mix__seg" style="width:${(shares[t] * 100).toFixed(2)}%;background:${TIER_COLORS[t]}" title="${TIER_LABEL[t]}: ${(shares[t] * 100).toFixed(0)}%"></span>`,
    )
    .join('');
  const legend = ALL_TIERS.filter((t) => shares[t] > 0.0005 || (target && t !== 'unclassified'))
    .map(
      (t) =>
        `<span class="mix__key"><i style="background:${TIER_COLORS[t]}"></i>${TIER_LABEL[t]} ${(shares[t] * 100).toFixed(0)}%${
          target && t !== 'unclassified' ? ` <span class="color-fg-muted">/ ${(target[t] * 100).toFixed(0)}%</span>` : ''
        }</span>`,
    )
    .join('');
  return `<div class="mix"><div class="mix__bar">${segs || '<span class="mix__empty">no model data</span>'}</div><div class="mix__legend">${legend}</div></div>`;
}

function levelBlock(m: Manifest, g: GroupMonth, showGaps: boolean): string {
  const levels = [...m.maturity_levels].sort((a, b) => a.level - b.level);
  const def = levels.find((l) => l.level === g.maturity);
  const pips = levels.map((l) => `<span class="pip${l.level <= g.maturity ? ' pip--on' : ''}" title="L${l.level} ${escapeHtml(l.name)}"></span>`).join('');
  let gaps = '';
  if (showGaps) {
    const next = nextLevelGaps(g.metrics, g.maturity, m.maturity_levels);
    gaps = next
      ? `<div class="gaps"><div class="gaps__title">To reach L${next.level.level} ${escapeHtml(next.level.name)}:</div><ul>${next.gaps
          .map(
            (x) =>
              `<li><strong>${METRIC_META[x.metric].label}</strong> ≥ ${formatMetric(x.metric, x.required)} <span class="color-fg-muted">(now ${formatMetric(x.metric, x.actual)})</span></li>`,
          )
          .join('')}</ul></div>`
      : `<div class="gaps gaps--done">Highest maturity level reached.</div>`;
  }
  const dist = g.maturity_distribution;
  const total = dist.reduce((a, b) => a + b, 0);
  const distBar = total
    ? `<div class="dist" title="People per maturity level">${levels
        .map((l) => {
          const n = dist[l.level] ?? 0;
          return n ? `<span class="dist__seg dist__seg--l${l.level}" style="flex:${n}" title="L${l.level} ${escapeHtml(l.name)}: ${n} people">${n}</span>` : '';
        })
        .join('')}</div><div class="note">People per level (L1 → L${levels.at(-1)?.level ?? 4})</div>`
    : '';
  return `
    <div class="level">
      <div class="level__head"><span class="Label Label--large level__badge level__badge--l${g.maturity}">L${g.maturity}</span>
        <span class="level__name">${escapeHtml(def?.name ?? '')}</span><span class="pips">${pips}</span></div>
      <p class="level__desc">${escapeHtml(def?.description ?? '')}</p>
      ${gaps}
      ${distBar}
    </div>`;
}

function stats(g: GroupMonth): string {
  const items: [string, string][] = [
    ['Seats', String(g.seats)],
    ['Active', `${g.active}`],
    ['Tokens', formatCompact(g.tokens)],
    ['Spend', formatUsd(g.cost_usd)],
    ['Interactions', formatCompact(g.interactions)],
    ['AI credits', formatCompact(g.credits)],
  ];
  return `<dl class="stats">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <p class="note" title="${SOURCE_LABEL[g.token_source]}">Token source: ${g.token_source}</p>`;
}

function metricRows(input: PaneInput, g: TeamMonth): string {
  const { base, month, weights } = input;
  const wsum = METRIC_KEYS.reduce((s, k) => s + weights[k], 0) || 1;
  return METRIC_KEYS.map((k) => {
    const sub = g.subscores[k] ?? 0;
    const d = sub - base.sub[k];
    const v = verdict(sub, base.sub[k]);
    return `
      <li class="metric metric--${v}">
        <div class="metric__top">
          <span class="metric__label">${METRIC_META[k].label}</span>
          <span class="metric__weight" title="Weight">${Math.round((weights[k] / wsum) * 100)}%</span>
        </div>
        <div class="metric__value">${formatMetric(k, g.metrics[k])}
          <span class="metric__delta" title="Score difference vs. org average">${v === 'par' ? 'on par' : `${sign(d)} pts`}</span></div>
        <div class="metric__bar" title="Score ${sub.toFixed(0)} / 100 (org average ${base.sub[k].toFixed(0)})">
          <span class="metric__fill" style="width:${Math.max(0, Math.min(100, sub))}%"></span>
          <span class="metric__marker" style="left:${Math.max(0, Math.min(100, base.sub[k]))}%"></span>
        </div>
        <div class="metric__org">Score ${sub.toFixed(0)} · org avg ${base.sub[k].toFixed(0)} · org value ${formatMetric(k, month.org.metrics[k])}</div>
      </li>`;
  }).join('');
}

function fillDaily(daily: DailyPoint[], month: MonthFile): DailyPoint[] {
  const by = new Map(daily.map((d) => [d.day, d]));
  const out: DailyPoint[] = [];
  const end = month.coverage.last_day ?? `${month.month}-01`;
  for (let d = new Date(`${month.month}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    out.push(by.get(day) ?? { day, active_users: 0, tokens: 0, cost_usd: 0 });
  }
  return out;
}

/** Seat-weighted average composite of all teams per month (the org baseline over time). */
function orgBaselineSeries(h: HistoryFile, weights: Weights): (number | null)[] {
  return h.months.map((m) => {
    let s = 0;
    let n = 0;
    for (const t of Object.values(h.teams)) {
      const p = t.points.find((x) => x.month === m);
      if (!p) continue;
      s += compositeScore(p.subscores, weights) * p.seats;
      n += p.seats;
    }
    return n ? s / n : null;
  });
}

function historySection(el: HTMLElement, input: PaneInput, teamId: string | null) {
  const { history: h, weights, month } = input;
  const orgLine = orgBaselineSeries(h, weights);
  const series: Series[] = [];
  if (teamId) {
    const pts = h.teams[teamId]?.points ?? [];
    const at = (m: string) => pts.find((p) => p.month === m);
    series.push({ name: 'Team score', values: h.months.map((m) => (at(m) ? compositeScore(at(m)!.subscores, weights) : null)), color: 'var(--chart-main)', width: 2.5 });
    series.push({ name: 'Org average', values: orgLine, color: 'var(--chart-muted)', width: 1.5, dash: '4 3' });
    for (const k of METRIC_KEYS) series.push({ name: METRIC_META[k].short, values: h.months.map((m) => at(m)?.subscores[k] ?? null), color: METRIC_COLORS[k], width: 1 });
  } else {
    series.push({ name: 'Org average', values: orgLine, color: 'var(--chart-main)', width: 2.5 });
    for (const k of METRIC_KEYS) series.push({ name: METRIC_META[k].short, values: h.org.map((p) => p.subscores[k] ?? null), color: METRIC_COLORS[k], width: 1 });
  }
  renderHistoryChart(el, h.months, series, month.month);
}

export function renderPane(el: HTMLElement, input: PaneInput) {
  const { manifest, month, team, base, teams, weights } = input;
  const cov = month.coverage;
  const coverage = cov.complete
    ? ''
    : `<div class="flash flash-warn mb-2 py-2 px-3 f6">Partial month: ${cov.days_collected} of ${cov.days_expected} days${cov.last_day ? ` (through ${cov.last_day})` : ''}.</div>`;

  if (!team) {
    const ranked = [...teams].map((t) => ({ t, s: compositeScore(t.subscores, weights) })).sort((a, b) => b.s - a.s);
    const levels = [...manifest.maturity_levels].sort((a, b) => a.level - b.level);
    const teamLevels = levels
      .map((l) => {
        const n = teams.filter((t) => t.maturity === l.level).length;
        return `<li><span class="Label level__badge--l${l.level}">L${l.level}</span> ${escapeHtml(l.name)} <span class="Counter">${n}</span></li>`;
      })
      .join('');
    const link = (x: { t: TeamMonth; s: number }) =>
      `<li><button type="button" class="btn-link" data-team="${escapeHtml(x.t.id)}">${escapeHtml(x.t.name)}</button> <span class="color-fg-muted">${x.s.toFixed(0)}</span></li>`;
    el.innerHTML = `
      <div class="Box-header pane__header"><h2 class="Box-title">${escapeHtml(month.org.name === month.target ? labelFor(manifest, month.target) : month.org.name)}</h2>
        <span class="color-fg-muted f6">${formatMonth(month.month)}</span></div>
      <div class="Box-body pane__body">
        ${coverage}
        <div class="score"><span class="score__value">${base.composite.toFixed(0)}</span><span class="score__label">org average score<br><span class="color-fg-muted">seat-weighted over ${teams.length} teams</span></span></div>
        <h3 class="pane__h">Org maturity</h3>
        ${levelBlock(manifest, month.org, false)}
        <h3 class="pane__h">Teams per level</h3>
        <ul class="levels-list">${teamLevels}</ul>
        <h3 class="pane__h">Usage</h3>
        ${stats(month.org)}
        <h3 class="pane__h">Model mix <span class="color-fg-muted f6">actual / target</span></h3>
        ${mixBar(month.org.model_shares, manifest.model_mix_target)}
        <div class="split">
          <div><h3 class="pane__h">Leading</h3><ol class="rank">${ranked.slice(0, 3).map(link).join('')}</ol></div>
          <div><h3 class="pane__h">Needs attention</h3><ol class="rank">${ranked.slice(-3).reverse().map(link).join('')}</ol></div>
        </div>
        <h3 class="pane__h">Trend</h3>
        <div class="history"></div>
        <p class="note">Select a tile to see what a team can improve.</p>
      </div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((b) => b.addEventListener('click', () => input.onSelect(b.dataset.team!)));
    historySection(el.querySelector('.history')!, input, null);
    return;
  }

  const s = compositeScore(team.subscores, weights);
  const v = verdict(s, base.composite);
  el.innerHTML = `
    <div class="Box-header pane__header">
      <h2 class="Box-title">${escapeHtml(team.name)}</h2>
      <button type="button" class="btn-octicon pane__close" aria-label="Back to organization overview" title="Back to overview">✕</button>
    </div>
    <div class="Box-body pane__body">
      ${coverage}
      <div class="score score--${v}"><span class="score__value">${s.toFixed(0)}</span>
        <span class="score__label">${v === 'par' ? 'on par with' : `${sign(s - base.composite)} pts vs`} org average (${base.composite.toFixed(0)})<br>
        <span class="color-fg-muted">${team.seats} seats · ${team.active} active · ${formatMonth(month.month)}</span></span></div>
      <h3 class="pane__h">Metrics vs org average</h3>
      <ul class="metrics">${metricRows(input, team)}</ul>
      <h3 class="pane__h">Maturity</h3>
      ${levelBlock(manifest, team, true)}
      <h3 class="pane__h">Model mix <span class="color-fg-muted f6">actual / target</span></h3>
      ${mixBar(team.model_shares, manifest.model_mix_target)}
      <h3 class="pane__h">History</h3>
      <div class="history"></div>
      <h3 class="pane__h">Active developers per day</h3>
      <div class="daily"></div>
      <h3 class="pane__h">Usage</h3>
      ${stats(team)}
    </div>`;
  el.querySelector('.pane__close')!.addEventListener('click', () => input.onSelect(null));
  historySection(el.querySelector('.history')!, input, team.id === 'unassigned' ? null : team.id);
  renderDaily(el.querySelector('.daily')!, fillDaily(team.daily, month), team.seats);
}

export function labelFor(m: Manifest, slug: string) {
  return m.targets.find((t) => t.slug === slug)?.label ?? slug;
}

export { levelName };
