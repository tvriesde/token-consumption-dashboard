import type { Target } from '../../shared/types';
import type { GitHubClient } from '../lib/client';

export interface BillingItem {
  product: string;
  sku: string;
  model: string;
  unitType: string;
  pricePerUnit?: number;
  grossQuantity: number;
  grossAmount: number;
  discountQuantity?: number;
  discountAmount?: number;
  netQuantity?: number;
  netAmount?: number;
}

export interface BillingMonthFile {
  month: string;
  fetched_at: string;
  complete: boolean;
  /** login → usage items for that user in that month. */
  users: Record<string, BillingItem[]>;
}

export interface ModelUsage {
  credits: number;
  usd: number;
  /** Only set when the billing API reports a token unit type. */
  tokens: number | null;
}

export function billingEndpoint(t: Target): string {
  return t.kind === 'enterprise'
    ? `/enterprises/${encodeURIComponent(t.slug)}/settings/billing/ai_credit/usage`
    : `/organizations/${encodeURIComponent(t.slug)}/settings/billing/ai_credit/usage`;
}

export async function fetchUserBilling(client: GitHubClient, t: Target, month: string, login: string): Promise<BillingItem[] | null> {
  const [year, m] = month.split('-').map(Number);
  const res = await client.get<{ usageItems?: BillingItem[] }>(billingEndpoint(t), { year, month: m, user: login }, [404]);
  if (res.status === 404) return null;
  return res.data?.usageItems ?? [];
}

/** Aggregates usage items per model. Credits come from a credit unit, or are derived from the amount. */
export function summarizeBilling(items: BillingItem[], usdPerCredit: number): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {};
  for (const it of items) {
    const model = it.model || 'unknown';
    const u = (out[model] ??= { credits: 0, usd: 0, tokens: null });
    const unit = (it.unitType ?? '').toLowerCase();
    if (unit.includes('token')) {
      u.tokens = (u.tokens ?? 0) + (it.grossQuantity ?? 0);
      u.credits += (it.grossAmount ?? 0) / usdPerCredit;
    } else if (unit.includes('credit')) u.credits += it.grossQuantity ?? 0;
    else u.credits += (it.grossAmount ?? 0) / usdPerCredit;
    u.usd += it.grossAmount ?? 0;
  }
  return out;
}
