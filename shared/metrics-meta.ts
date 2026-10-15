import type { MetricKey } from './types';

export interface MetricMeta {
  key: MetricKey;
  label: string;
  short: string;
  unit: 'tokens_per_usd' | 'score' | 'ratio' | 'tokens';
  description: string;
  formula: string;
  scoring: string;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  tokens_per_dollar: {
    key: 'tokens_per_dollar',
    label: 'Cost efficiency',
    short: 'Tokens / $',
    unit: 'tokens_per_usd',
    description: 'How many tokens are processed for every dollar of AI credits spent. Higher means more work per dollar, usually by routing simple work to cheaper models.',
    formula: 'Σ tokens ÷ (Σ AI credits × USD per credit)',
    scoring: 'Log scale: target → 100, target ÷ 10 → 0.',
  },
  model_mix_health: {
    key: 'model_mix_health',
    label: 'Model mix health',
    short: 'Model mix',
    unit: 'score',
    description: 'How close the share of frontier / standard / lightweight model usage is to the configured healthy target mix.',
    formula: '100 × (1 − ½ Σ |share(tier) − target(tier)|)',
    scoring: 'Linear: target → 100.',
  },
  active_day_ratio: {
    key: 'active_day_ratio',
    label: 'Active days',
    short: 'Active-day ratio',
    unit: 'ratio',
    description: 'Share of working days on which members used Copilot. Averaged over all seated members, so inactive seats pull the team down.',
    formula: 'mean over members (active days ÷ working days in period)',
    scoring: 'Linear: target → 100.',
  },
  tokens_per_dev: {
    key: 'tokens_per_dev',
    label: 'Token volume',
    short: 'Tokens / dev',
    unit: 'tokens',
    description: 'Median number of tokens consumed per active developer in the month — a proxy for depth of (agentic) usage.',
    formula: 'median over active members (Σ tokens in month)',
    scoring: 'Log scale: target → 100, target ÷ 10 → 0.',
  },
};
