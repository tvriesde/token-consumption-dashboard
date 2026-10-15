import * as d3 from 'd3';
import { compositeScore } from '../shared/scoring';
import { formatCompact, formatPct, formatUsd } from '../shared/format';
import type { GroupMonth, HistoryPoint, MetricKey, Subscores, TeamMonth, Weights } from '../shared/types';
import { METRIC_KEYS } from '../shared/types';
import type { ColorBy } from './state';

export const scoreOf = (sub: Subscores, color: ColorBy, weights: Weights): number =>
  color === 'composite' ? compositeScore(sub, weights) : (sub[color] ?? 0);

/** Seat-weighted average over the teams shown – the "org average" every tile and metric is compared with. */
export function baseline(teams: TeamMonth[], fn: (t: TeamMonth) => number): number {
  const seats = d3.sum(teams, (t) => t.seats);
  return seats ? d3.sum(teams, (t) => fn(t) * t.seats) / seats : 0;
}

export interface Baselines {
  composite: number;
  sub: Record<MetricKey, number>;
}

export function baselines(teams: TeamMonth[], weights: Weights): Baselines {
  const sub = Object.fromEntries(METRIC_KEYS.map((k) => [k, baseline(teams, (t) => t.subscores[k] ?? 0)])) as Record<MetricKey, number>;
  return { composite: baseline(teams, (t) => compositeScore(t.subscores, weights)), sub };
}

export const pointScore = (p: HistoryPoint, weights: Weights) => compositeScore(p.subscores, weights);

/** Below this absolute difference (score points) a value is considered "on par" with the org average. */
export const NEUTRAL_BAND = 2;

export type Verdict = 'above' | 'below' | 'par';
export const verdict = (value: number, base: number): Verdict =>
  value - base > NEUTRAL_BAND ? 'above' : base - value > NEUTRAL_BAND ? 'below' : 'par';

function isDark(): boolean {
  const mode = document.documentElement.getAttribute('data-color-mode');
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function palette() {
  return isDark()
    ? { bad: '#da3633', neutral: '#3d444d', good: '#238636', text: '#f0f6fc' }
    : { bad: '#cf222e', neutral: '#eaeef2', good: '#1a7f37', text: '#1f2328' };
}

/** Diverging red → neutral → green scale centred on the org average. */
export function colorScale(values: number[], base: number) {
  const p = palette();
  const lo = Math.min(base - NEUTRAL_BAND * 2, d3.min(values) ?? base);
  const hi = Math.max(base + NEUTRAL_BAND * 2, d3.max(values) ?? base);
  const scale = d3
    .scaleLinear<string>()
    .domain([lo, base - NEUTRAL_BAND / 2, base + NEUTRAL_BAND / 2, hi])
    .range([p.bad, p.neutral, p.neutral, p.good])
    .interpolate(d3.interpolateLab)
    .clamp(true);
  return scale;
}

/** Black or white text depending on the background luminance. */
export function textOn(bg: string): string {
  const c = d3.rgb(bg);
  const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  return lum > 0.55 ? '#1f2328' : '#ffffff';
}

export function formatMetric(key: MetricKey, v: number | null | undefined): string {
  switch (key) {
    case 'tokens_per_dollar':
      return v == null ? '–' : `${formatCompact(v)} / $`;
    case 'model_mix_health':
      return v == null ? '–' : `${Math.round(v)} / 100`;
    case 'active_day_ratio':
      return formatPct(v);
    case 'tokens_per_dev':
      return formatCompact(v);
  }
}

export { formatCompact, formatPct, formatUsd };

export const groupLabel = (g: GroupMonth) => g.name;
