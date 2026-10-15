/** Team personas for the Contoso test dataset. Each persona is tuned to land in a recognisable spot on the dashboard. */

export interface MonthProfile {
  /** Probability that a seated member is active on a working day. */
  activity: number;
  /** Median tokens per active day for a member. */
  tokensPerDay: number;
}

export interface Persona {
  name: string;
  /** One profile per generated month (last one repeats when more months are generated). */
  months: MonthProfile[];
  /** Share of tokens per tier (frontier / standard / lightweight). */
  mix: { frontier: number; standard: number; lightweight: number };
  /** Fraction of tokens spent through the Copilot CLI (reported with exact token_usage). */
  cliShare: number;
  /** Fraction of tokens spent through the Copilot app (reported with exact token_usage). */
  appShare: number;
  /** Multiplier on list price: < 1 = efficient (caching, short prompts), > 1 = wasteful. */
  costFactor: number;
  adoptionPhase: string;
}

export interface TeamDef {
  slug: string;
  org: string;
  size: number;
  persona: Persona;
  /** Members that join part-way (index of month in which they join). */
  joiners?: { count: number; month: number };
  /** Members that leave part-way (index of month in which they are gone). */
  leavers?: { count: number; month: number };
}

const flat = (activity: number, tokensPerDay: number): MonthProfile[] => [{ activity, tokensPerDay }];

export const PERSONAS: Record<string, Persona> = {
  balancedL4: {
    name: 'Balanced, high activity (L4)',
    months: flat(0.9, 5_400_000),
    mix: { frontier: 0.2, standard: 0.6, lightweight: 0.2 },
    cliShare: 0.35,
    appShare: 0.1,
    costFactor: 0.75,
    adoptionPhase: 'autonomous',
  },
  frontierHeavy: {
    name: 'Frontier-heavy (high volume, poor tokens/$)',
    months: flat(0.72, 3_200_000),
    mix: { frontier: 0.75, standard: 0.2, lightweight: 0.05 },
    cliShare: 0.15,
    appShare: 0.05,
    costFactor: 1.35,
    adoptionPhase: 'agentic',
  },
  lightweightOnly: {
    name: 'Lightweight-only (cheap, low volume)',
    months: flat(0.6, 450_000),
    mix: { frontier: 0, standard: 0.05, lightweight: 0.95 },
    cliShare: 0,
    appShare: 0,
    costFactor: 1,
    adoptionPhase: 'practicing',
  },
  improving: {
    name: 'Improving month over month',
    months: [
      { activity: 0.3, tokensPerDay: 600_000 },
      { activity: 0.55, tokensPerDay: 1_500_000 },
      { activity: 0.8, tokensPerDay: 3_000_000 },
    ],
    mix: { frontier: 0.18, standard: 0.62, lightweight: 0.2 },
    cliShare: 0.2,
    appShare: 0.05,
    costFactor: 0.9,
    adoptionPhase: 'practicing',
  },
  mixed: {
    name: 'Mixed',
    months: flat(0.62, 1_400_000),
    mix: { frontier: 0.12, standard: 0.68, lightweight: 0.2 },
    cliShare: 0.1,
    appShare: 0.05,
    costFactor: 1,
    adoptionPhase: 'practicing',
  },
  declining: {
    name: 'Declining month over month',
    months: [
      { activity: 0.8, tokensPerDay: 2_600_000 },
      { activity: 0.6, tokensPerDay: 1_600_000 },
      { activity: 0.38, tokensPerDay: 800_000 },
    ],
    mix: { frontier: 0.3, standard: 0.55, lightweight: 0.15 },
    cliShare: 0.1,
    appShare: 0,
    costFactor: 1.1,
    adoptionPhase: 'agentic',
  },
  lowAdoption: {
    name: 'Low adoption (L1)',
    months: flat(0.14, 250_000),
    mix: { frontier: 0.05, standard: 0.8, lightweight: 0.15 },
    cliShare: 0,
    appShare: 0,
    costFactor: 1.05,
    adoptionPhase: 'exploring',
  },
  agenticCli: {
    name: 'Agentic, CLI-heavy',
    months: flat(0.78, 4_200_000),
    mix: { frontier: 0.4, standard: 0.45, lightweight: 0.15 },
    cliShare: 0.6,
    appShare: 0.1,
    costFactor: 0.95,
    adoptionPhase: 'agentic',
  },
  champions: {
    name: 'Champions (cost-efficient, daily)',
    months: flat(0.93, 6_200_000),
    mix: { frontier: 0.2, standard: 0.58, lightweight: 0.22 },
    cliShare: 0.45,
    appShare: 0.15,
    costFactor: 0.65,
    adoptionPhase: 'autonomous',
  },
  testers: {
    name: 'Mixed, lightweight leaning',
    months: flat(0.5, 1_000_000),
    mix: { frontier: 0.08, standard: 0.55, lightweight: 0.37 },
    cliShare: 0.05,
    appShare: 0,
    costFactor: 1,
    adoptionPhase: 'practicing',
  },
};

export const ENTERPRISE = { slug: 'contoso', id: '41000' };
export const ORGS = [
  { slug: 'contoso-apps', id: '51001' },
  { slug: 'contoso-data', id: '51002' },
];

export const TEAMS: TeamDef[] = [
  { slug: 'platform', org: 'contoso-apps', size: 24, persona: PERSONAS.balancedL4 },
  { slug: 'payments', org: 'contoso-apps', size: 18, persona: PERSONAS.frontierHeavy },
  { slug: 'mobile', org: 'contoso-apps', size: 12, persona: PERSONAS.lightweightOnly },
  { slug: 'web-frontend', org: 'contoso-apps', size: 22, persona: PERSONAS.mixed },
  { slug: 'api-gateway', org: 'contoso-apps', size: 10, persona: PERSONAS.declining, leavers: { count: 2, month: 2 } },
  { slug: 'data-eng', org: 'contoso-data', size: 16, persona: PERSONAS.improving, joiners: { count: 3, month: 1 } },
  { slug: 'security', org: 'contoso-data', size: 8, persona: PERSONAS.lowAdoption },
  { slug: 'ml-ops', org: 'contoso-data', size: 9, persona: PERSONAS.agenticCli },
  { slug: 'devex', org: 'contoso-data', size: 6, persona: PERSONAS.champions },
  { slug: 'qa-automation', org: 'contoso-data', size: 14, persona: PERSONAS.testers },
  /** Fewer than 5 seats: GitHub suppresses it from the user-teams report → members show up as "unassigned". */
  { slug: 'design', org: 'contoso-apps', size: 3, persona: PERSONAS.mixed },
  { slug: 'platform-services', org: 'contoso-apps', size: 24, persona: PERSONAS.balancedL4 },
  { slug: 'payments-risk', org: 'contoso-apps', size: 18, persona: PERSONAS.frontierHeavy },
  { slug: 'mobile-platform', org: 'contoso-apps', size: 12, persona: PERSONAS.lightweightOnly },
  { slug: 'web-experience', org: 'contoso-apps', size: 22, persona: PERSONAS.mixed },
  { slug: 'api-reliability', org: 'contoso-apps', size: 10, persona: PERSONAS.declining, leavers: { count: 2, month: 2 } },
  { slug: 'data-platform', org: 'contoso-data', size: 16, persona: PERSONAS.improving, joiners: { count: 3, month: 1 } },
  { slug: 'product-security', org: 'contoso-data', size: 8, persona: PERSONAS.lowAdoption },
  { slug: 'ml-platform', org: 'contoso-data', size: 9, persona: PERSONAS.agenticCli },
  { slug: 'developer-productivity', org: 'contoso-data', size: 6, persona: PERSONAS.champions },
  { slug: 'quality-engineering', org: 'contoso-data', size: 14, persona: PERSONAS.testers },
  { slug: 'ux-research', org: 'contoso-apps', size: 3, persona: PERSONAS.mixed },
];

/** Extra memberships (same org) to exercise team overlap: [from team, to team, count]. */
export const OVERLAPS: [string, string, number][] = [
  ['platform', 'api-gateway', 2],
  ['ml-ops', 'devex', 2],
  ['data-eng', 'qa-automation', 1],
  ['platform-services', 'api-reliability', 2],
  ['ml-platform', 'developer-productivity', 2],
  ['data-platform', 'quality-engineering', 1],
];

/** Seated users who are not in any team, per org. */
export const TEAMLESS: Record<string, number> = { 'contoso-apps': 8, 'contoso-data': 6 };

/** Model catalogue with list price (USD per 1M tokens) used to compute credits. */
export const MODELS: Record<'frontier' | 'standard' | 'lightweight', { model: string; weight: number; price: number }[]> = {
  frontier: [
    { model: 'claude-opus-4.6', weight: 0.5, price: 7.5 },
    { model: 'gpt-5.2', weight: 0.35, price: 5 },
    { model: 'gemini-3-pro', weight: 0.15, price: 4.5 },
  ],
  standard: [
    { model: 'claude-sonnet-4.6', weight: 0.5, price: 2.4 },
    { model: 'gpt-5.2-codex', weight: 0.35, price: 1.8 },
    { model: 'gpt-4.1', weight: 0.15, price: 1.6 },
  ],
  lightweight: [
    { model: 'claude-haiku-4.5', weight: 0.45, price: 0.5 },
    { model: 'gpt-5-mini', weight: 0.4, price: 0.3 },
    { model: 'gemini-3-flash', weight: 0.15, price: 0.25 },
  ],
};

export const FIRST_NAMES = [
  'ada', 'alan', 'amir', 'anna', 'ben', 'bo', 'carla', 'chen', 'dana', 'dev', 'elena', 'emil', 'farah', 'finn', 'grace',
  'hana', 'ivan', 'jade', 'jon', 'kai', 'lea', 'liam', 'maya', 'mo', 'nina', 'omar', 'pia', 'quinn', 'raj', 'rosa',
  'sam', 'sofia', 'tariq', 'tess', 'uma', 'vik', 'wen', 'yara', 'yusuf', 'zoe',
];
export const LAST_NAMES = [
  'bakker', 'berg', 'costa', 'dijk', 'evans', 'fischer', 'garcia', 'hall', 'ito', 'jansen', 'khan', 'larsen', 'meyer',
  'novak', 'okafor', 'park', 'quist', 'rossi', 'singh', 'tanaka', 'ueda', 'visser', 'wong', 'xu', 'young', 'zimmer',
];
