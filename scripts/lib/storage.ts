import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Target } from '../../shared/types';

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string, fallback?: T): T {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`File not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown, pretty = true) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, pretty ? 2 : 0) + '\n');
}

export function writeGz(file: string, text: string) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
}

export function readGz(file: string): string {
  return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
}

export function targetDir(dataDir: string, t: Target) {
  return path.join(dataDir, t.kind, t.slug);
}

export function rawPath(dataDir: string, t: Target, day: string, report: string) {
  const [y, m] = day.split('-');
  return path.join(targetDir(dataDir, t), 'raw', y, m, `${day}.${report}.ndjson.gz`);
}

export function dailyPath(dataDir: string, t: Target, day: string) {
  const [y, m] = day.split('-');
  return path.join(targetDir(dataDir, t), 'daily', y, m, `${day}.json`);
}

export function billingFilePath(dataDir: string, t: Target, month: string) {
  return path.join(targetDir(dataDir, t), 'billing', `${month}.json`);
}

export function ledgerPath(dataDir: string, t: Target) {
  return path.join(targetDir(dataDir, t), 'ledger.json');
}

/** Lists all trimmed daily files for a target, sorted by day. */
export function listDailyFiles(dataDir: string, t: Target): string[] {
  const root = path.join(targetDir(dataDir, t), 'daily');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^\d{4}-\d{2}-\d{2}\.json$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

export function appendStepSummary(markdown: string) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, markdown + '\n');
}
