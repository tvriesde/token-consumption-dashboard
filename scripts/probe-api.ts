/**
 * Prints the *shape* of the real users-1-day report (field names, types, where token_usage appears) so you can
 * verify which token fields your enterprise/org actually receives. No values, logins or ids are printed.
 *
 *   npm run probe [-- --day YYYY-MM-DD] [--target my-org] [--out probe-output.json]
 */
import fs from 'node:fs';
import { fetchDailyReport } from './collect/reports';
import { isMain, parseArgs, str } from './lib/args';
import { createTokenProvider } from './lib/auth';
import { GitHubClient } from './lib/client';
import { getTargets, loadConfig } from './lib/config';
import { addDays, utcToday } from './lib/dates';

type Shape = { types: Set<string>; count: number };

export function describeShape(records: Record<string, unknown>[]) {
  const shape = new Map<string, Shape>();
  const tokenPaths = new Map<string, number>();
  const walk = (v: unknown, p: string) => {
    const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const e = shape.get(p) ?? { types: new Set(), count: 0 };
    e.types.add(type);
    e.count++;
    shape.set(p, e);
    if (Array.isArray(v)) v.forEach((x) => walk(x, `${p}[]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const child = p ? `${p}.${k}` : k;
        if (k === 'token_usage') tokenPaths.set(child, (tokenPaths.get(child) ?? 0) + 1);
        walk(x, child);
      }
    }
  };
  for (const r of records) walk(r, '');
  shape.delete('');
  return {
    records: records.length,
    fields: [...shape].sort(([a], [b]) => a.localeCompare(b)).map(([path, s]) => ({ path, types: [...s.types].join('|'), present_in: s.count })),
    token_usage_paths: [...tokenPaths].map(([path, n]) => ({ path, records: n })),
  };
}

if (isMain(import.meta.url)) {
  const { flags } = parseArgs();
  (async () => {
    const cfg = loadConfig(str(flags.config));
    const apiUrl = str(flags['api-url']) ?? (process.env.COPILOT_API_URL || cfg.api.url);
    const targets = getTargets(cfg);
    const t = targets.find((x) => x.slug === str(flags.target)) ?? targets[0];
    const tokens = createTokenProvider(cfg.scope, apiUrl, process.env);
    const client = new GitHubClient({ apiUrl, apiVersion: cfg.api.version, token: tokens.metrics(t) });
    const day = str(flags.day) ?? addDays(utcToday(), -2);
    const res = await fetchDailyReport(client, t, 'users-1-day', day);
    if (res.status !== 'ok') throw new Error(`No users-1-day report for ${t.kind} ${t.slug} on ${day} (HTTP ${res.code}). Try --day with an older date.`);
    const out = { target: `${t.kind}/${t.slug}`, day, ...describeShape(res.records) };
    console.log(`users-1-day for ${out.target} on ${day}: ${out.records} records\n`);
    for (const f of out.fields) console.log(`  ${f.path.padEnd(70)} ${f.types.padEnd(16)} ${f.present_in}`);
    console.log('\ntoken_usage found at:');
    if (!out.token_usage_paths.length) console.log('  (none – tokens will be estimated from AI credits)');
    for (const p of out.token_usage_paths) console.log(`  ${p.path}  (${p.records} records)`);
    const file = str(flags.out);
    if (file) {
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
      console.log(`\nWritten to ${file} (contains no personal data).`);
    }
  })().catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
