export type Scope = 'enterprise' | 'organization';
export type TargetKind = 'enterprise' | 'org';

export interface Target {
  kind: TargetKind;
  slug: string;
  label: string;
}

export type Tier = 'frontier' | 'standard' | 'lightweight' | 'unclassified';
export type ScoredTier = Exclude<Tier, 'unclassified'>;
export const SCORED_TIERS: ScoredTier[] = ['frontier', 'standard', 'lightweight'];
export const ALL_TIERS: Tier[] = ['frontier', 'standard', 'lightweight', 'unclassified'];

export type MetricKey = 'tokens_per_dollar' | 'model_mix_health' | 'active_day_ratio' | 'tokens_per_dev';
export const METRIC_KEYS: MetricKey[] = ['tokens_per_dollar', 'model_mix_health', 'active_day_ratio', 'tokens_per_dev'];

export type Weights = Record<MetricKey, number>;
export type TokenSource = 'exact' | 'mixed' | 'estimated' | 'none';

export type MetricValues = Record<MetricKey, number | null>;
export type Subscores = Record<MetricKey, number | null>;
export type TierShares = Record<Tier, number>;

export interface MaturityLevelDef {
  level: number;
  name: string;
  description: string;
  min: Partial<Record<MetricKey, number>>;
}

export interface ModelTierRule {
  tier: ScoredTier;
  patterns: string[];
}

export interface DailyPoint {
  day: string;
  active_users: number;
  tokens: number;
  cost_usd: number;
}

export interface PersonMonth {
  key: string;
  active_days: number;
  tokens: number;
  credits: number;
  cost_usd: number;
  interactions: number;
  model_shares: TierShares;
  token_source: TokenSource;
  metrics: MetricValues;
  subscores: Subscores;
  maturity: number;
}

export interface GroupMonth {
  id: string;
  slug: string;
  name: string;
  seats: number;
  active: number;
  tokens: number;
  credits: number;
  cost_usd: number;
  interactions: number;
  model_shares: TierShares;
  token_source: TokenSource;
  metrics: MetricValues;
  subscores: Subscores;
  maturity: number;
  /** People per maturity level; index = level. */
  maturity_distribution: number[];
  daily: DailyPoint[];
}

export interface TeamMonth extends GroupMonth {
  people: PersonMonth[];
}

export interface Coverage {
  days_collected: number;
  days_expected: number;
  first_day: string | null;
  last_day: string | null;
  working_days: number;
  complete: boolean;
}

export interface MonthFile {
  target: string;
  month: string;
  generated_at: string;
  coverage: Coverage;
  billing: boolean;
  org: GroupMonth;
  teams: TeamMonth[];
  unassigned: TeamMonth | null;
}

export interface HistoryPoint {
  month: string;
  seats: number;
  active: number;
  metrics: MetricValues;
  subscores: Subscores;
  maturity: number;
}

export interface HistoryFile {
  target: string;
  months: string[];
  org: HistoryPoint[];
  teams: Record<string, { name: string; points: HistoryPoint[] }>;
}

export interface TargetIndex {
  target: string;
  label: string;
  kind: TargetKind;
  months: { month: string; coverage: Coverage }[];
}

export interface Branding {
  title: string;
  subtitle?: string;
  logo?: string;
  footer?: string;
}

export interface Manifest {
  generated_at: string;
  scope: Scope;
  branding: Branding;
  targets: Target[];
  weights: Weights;
  metric_targets: Record<MetricKey, number>;
  model_mix_target: Record<ScoredTier, number>;
  model_tiers: ModelTierRule[];
  maturity_levels: MaturityLevelDef[];
  pricing: { usd_per_credit: number; estimate_usd_per_million_tokens: Record<Tier, number> };
  pseudonymized: boolean;
}
