import {
  METRIC_KEYS,
  SCORED_TIERS,
  type MaturityLevelDef,
  type MetricKey,
  type MetricValues,
  type ModelTierRule,
  type ScoredTier,
  type Subscores,
  type Tier,
  type TierShares,
  type Weights,
} from './types';

export const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

/** Log-scale subscore: value == target → 100, value == target/10 → 0. */
export function logScore(value: number | null, target: number): number | null {
  if (value == null) return null;
  if (!(value > 0) || !(target > 0)) return 0;
  return clamp(100 * (Math.log10(value / target) + 1));
}

export function linearScore(value: number | null, target: number): number | null {
  if (value == null) return null;
  if (!(target > 0)) return 0;
  return clamp((100 * value) / target);
}

export function emptyShares(): TierShares {
  return { frontier: 0, standard: 0, lightweight: 0, unclassified: 0 };
}

export function normalizeShares(raw: Partial<Record<Tier, number>>): TierShares {
  const out = emptyShares();
  const keys = Object.keys(out) as Tier[];
  const total = keys.reduce((s, k) => s + (raw[k] ?? 0), 0);
  if (total <= 0) return out;
  for (const k of keys) out[k] = (raw[k] ?? 0) / total;
  return out;
}

/**
 * Model mix health (0..100) = 100 × (1 − ½ Σ|share − target|) over the scored tiers.
 * Unclassified usage is ignored; returns null when there is no classified usage.
 */
export function modelMixHealth(shares: Partial<Record<Tier, number>>, target: Record<ScoredTier, number>): number | null {
  const total = SCORED_TIERS.reduce((s, t) => s + (shares[t] ?? 0), 0);
  const tTotal = SCORED_TIERS.reduce((s, t) => s + (target[t] ?? 0), 0);
  if (total <= 0 || tTotal <= 0) return null;
  let dist = 0;
  for (const t of SCORED_TIERS) dist += Math.abs((shares[t] ?? 0) / total - (target[t] ?? 0) / tTotal);
  return clamp(100 * (1 - dist / 2));
}

export function computeSubscores(m: MetricValues, targets: Record<MetricKey, number>): Subscores {
  return {
    tokens_per_dollar: logScore(m.tokens_per_dollar, targets.tokens_per_dollar),
    model_mix_health: linearScore(m.model_mix_health, targets.model_mix_health),
    active_day_ratio: linearScore(m.active_day_ratio, targets.active_day_ratio),
    tokens_per_dev: logScore(m.tokens_per_dev, targets.tokens_per_dev),
  };
}

/** Weighted mean of subscores. Missing subscores count as 0 so that unused seats never score well. */
export function compositeScore(sub: Subscores, weights: Weights): number {
  let sw = 0;
  let s = 0;
  for (const k of METRIC_KEYS) {
    const w = Math.max(0, weights[k] ?? 0);
    sw += w;
    s += w * (sub[k] ?? 0);
  }
  return sw > 0 ? s / sw : 0;
}

/** Highest level whose minimums (and those of all lower levels) are met. Absolute, not relative to the org. */
export function maturityLevel(m: MetricValues, levels: MaturityLevelDef[]): number {
  const sorted = [...levels].sort((a, b) => a.level - b.level);
  let reached = sorted.length ? sorted[0].level : 0;
  for (const lvl of sorted) {
    const ok = (Object.entries(lvl.min) as [MetricKey, number][]).every(([k, min]) => {
      const v = m[k];
      return v != null && v >= min;
    });
    if (ok) reached = lvl.level;
    else break;
  }
  return reached;
}

/** Unmet requirements to reach the next maturity level. */
export function nextLevelGaps(m: MetricValues, current: number, levels: MaturityLevelDef[]) {
  const next = [...levels].sort((a, b) => a.level - b.level).find((l) => l.level > current);
  if (!next) return null;
  const gaps = (Object.entries(next.min) as [MetricKey, number][])
    .filter(([k, min]) => m[k] == null || (m[k] as number) < min)
    .map(([metric, required]) => ({ metric, required, actual: m[metric] }));
  return { level: next, gaps };
}

export function makeClassifier(rules: ModelTierRule[]) {
  const compiled = rules.map((r) => ({ tier: r.tier, res: r.patterns.map((p) => new RegExp(p, 'i')) }));
  const cache = new Map<string, Tier>();
  return (model: string): Tier => {
    const key = (model ?? '').trim();
    let hit = cache.get(key);
    if (hit) return hit;
    hit = compiled.find((r) => r.res.some((re) => re.test(key)))?.tier ?? 'unclassified';
    cache.set(key, hit);
    return hit;
  };
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
