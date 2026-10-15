import type { Target } from '../../shared/types';
import { parseRecords, type GitHubClient } from '../lib/client';

export type ReportName = 'users-1-day' | 'user-teams-1-day';

export function reportEndpoint(t: Target, report: ReportName): string {
  const base = t.kind === 'enterprise' ? `/enterprises/${encodeURIComponent(t.slug)}` : `/orgs/${encodeURIComponent(t.slug)}`;
  return `${base}/copilot/metrics/reports/${report}`;
}

export type ReportResult =
  | { status: 'ok'; records: Record<string, unknown>[]; ndjson: string }
  | { status: 'unavailable'; code: number };

/**
 * Calls the 1-day report endpoint, then downloads every signed link immediately (links expire).
 * 404 = report not (yet) available for that day; 204 = no content (no activity).
 */
export async function fetchDailyReport(client: GitHubClient, t: Target, report: ReportName, day: string): Promise<ReportResult> {
  const res = await client.get<{ download_links?: string[]; report_day?: string }>(reportEndpoint(t, report), { day }, [404]);
  if (res.status === 404) return { status: 'unavailable', code: 404 };
  if (res.status === 204 || !res.data) return { status: 'ok', records: [], ndjson: '' };
  const records: Record<string, unknown>[] = [];
  for (const link of res.data.download_links ?? []) records.push(...parseRecords(await client.download(link)));
  return { status: 'ok', records, ndjson: records.map((r) => JSON.stringify(r)).join('\n') };
}
