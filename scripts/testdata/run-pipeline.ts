/**
 * Runs the real collector + aggregator against the mock GitHub API and the Contoso fixtures.
 *
 *   npm run testdata                       # generate (if needed) → collect → aggregate → vite build, both scopes
 *   npm run testdata:collect -- --scope enterprise
 *   npm run testdata:build   -- --scope orgs
 *   npm run testdata:dev     -- --scope orgs    # aggregate + vite dev server on the test data
 *
 * Output: testdata/out/<scope>/{data,public,dist}
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runBuild } from '../build/index';
import { runCollect, summaryMarkdown } from '../collect/index';
import { isMain, parseArgs, str } from '../lib/args';
import { addDays } from '../lib/dates';
import { ensureFixtures, DEFAULT_FIXTURES_DIR } from './generate';
import { startMockServer } from './mock-server';

export type TestScope = 'enterprise' | 'orgs';
export const TEST_CONFIGS: Record<TestScope, string> = {
  enterprise: 'config/test.enterprise.yml',
  orgs: 'config/test.orgs.yml',
};
export const TEST_SALT = 'contoso-test-salt';

export function outDirs(scope: TestScope, root = 'testdata/out') {
  const base = path.join(root, scope);
  return { base, data: path.join(base, 'data'), public: path.join(base, 'public'), dist: path.join(base, 'dist') };
}

/** Env for the collector: dummy PAT, no App credentials (so a developer's real secrets are never used). */
export function testEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('COPILOT_')) delete env[k];
  env.COPILOT_METRICS_TOKEN = 'test-token';
  env.COPILOT_BILLING_TOKEN = 'test-billing-token';
  return env;
}

export async function collectTestData(scope: TestScope, opts: { fixturesDir?: string; root?: string; quiet?: boolean } = {}) {
  const meta = ensureFixtures(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR);
  const dirs = outDirs(scope, opts.root);
  fs.rmSync(dirs.data, { recursive: true, force: true });
  process.env.RETRY_BASE_MS ??= '5';
  const log = opts.quiet ? () => {} : (m: string) => console.log(m);

  // Pass 1: the day after the dataset ends. GitHub has not published the last 2 days yet and the team report for
  // the 3rd-last day is late → exercises "pending" and "partial" handling.
  const mock = await startMockServer({
    fixturesDir: opts.fixturesDir,
    availableUntil: addDays(meta.end, -2),
    teamsUnavailable: [addDays(meta.end, -2)],
    failEvery: 53,
  });
  try {
    const env = testEnv();
    log(`\n=== ${scope}: collect pass 1 (as of ${addDays(meta.end, 1)}) ===`);
    const r1 = await runCollect({ configPath: TEST_CONFIGS[scope], dataDir: dirs.data, apiUrl: mock.url, today: addDays(meta.end, 1), env, log });
    log(summaryMarkdown(r1));

    // Pass 2: three days later everything is available; the collector back-fills pending/partial days.
    mock.setAvailableUntil(undefined);
    mock.setTeamsUnavailable([]);
    log(`\n=== ${scope}: collect pass 2 (as of ${addDays(meta.end, 3)}) ===`);
    const r2 = await runCollect({ configPath: TEST_CONFIGS[scope], dataDir: dirs.data, apiUrl: mock.url, today: addDays(meta.end, 3), env, log });
    log(summaryMarkdown(r2));
    return { meta, dirs, passes: [r1, r2], requests: mock.requests.length };
  } finally {
    await mock.close();
  }
}

export function buildTestData(scope: TestScope, opts: { fixturesDir?: string; root?: string; quiet?: boolean } = {}) {
  const meta = ensureFixtures(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR);
  const dirs = outDirs(scope, opts.root);
  if (!fs.existsSync(dirs.data)) throw new Error(`No collected data in ${dirs.data}. Run "npm run testdata:collect -- --scope ${scope}" first.`);
  return runBuild({
    configPath: TEST_CONFIGS[scope],
    dataDir: dirs.data,
    outDir: dirs.public,
    today: addDays(meta.end, 3),
    salt: TEST_SALT,
    env: { ...process.env, GITHUB_ACTIONS: undefined },
    log: opts.quiet ? () => {} : console.log,
  });
}

function vite(args: string[], scope: TestScope): Promise<number> {
  const dirs = outDirs(scope);
  const bin = path.resolve('node_modules/vite/bin/vite.js');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: 'inherit',
      env: { ...process.env, SITE_PUBLIC_DIR: path.resolve(dirs.public), SITE_OUT_DIR: path.resolve(dirs.dist) },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function verifyStandalonePage(dist: string) {
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory() ? files(fullPath) : [fullPath];
    });
  const outputFiles = files(dist);
  if (outputFiles.length !== 1 || path.relative(dist, outputFiles[0]) !== 'index.html')
    throw new Error(`Expected a single standalone index.html in ${dist}, found: ${outputFiles.map((f) => path.relative(dist, f)).join(', ') || '(no files)'}`);

  const html = fs.readFileSync(outputFiles[0], 'utf8');
  if (!html.includes('id="dashboard-data"') || /(?:src|href)=["'][^"']+\.(?:js|css)(?:[?#][^"']*)?["']/i.test(html))
    throw new Error(`${outputFiles[0]} is not self-contained: embedded data or inline assets are missing.`);
}

async function main() {
  const { flags, positional } = parseArgs();
  const mode = positional[0] ?? 'all';
  const scopeFlag = str(flags.scope) ?? (mode === 'dev' ? 'orgs' : 'both');
  if (!['enterprise', 'orgs', 'both'].includes(scopeFlag)) throw new Error(`--scope must be enterprise, orgs or both (got ${scopeFlag})`);
  const scopes: TestScope[] = scopeFlag === 'both' ? ['enterprise', 'orgs'] : [scopeFlag as TestScope];
  if (mode === 'dev' && scopes.length > 1) throw new Error('dev mode serves one scope at a time: use --scope enterprise or --scope orgs');

  for (const scope of scopes) {
    if (mode === 'collect' || mode === 'all' || (mode === 'dev' && !fs.existsSync(outDirs(scope).data))) await collectTestData(scope);
    if (mode === 'build' || mode === 'all' || mode === 'dev') {
      console.log(`\n=== ${scope}: aggregate → ${outDirs(scope).public} ===`);
      buildTestData(scope);
    }
    if (mode === 'build' || mode === 'all') {
      const code = await vite(['build'], scope);
      if (code !== 0) process.exit(code);
      verifyStandalonePage(outDirs(scope).dist);
      console.log(`✓ ${scope}: site built in ${outDirs(scope).dist} (preview: npx vite preview --outDir ${outDirs(scope).dist})`);
    }
    if (mode === 'dev') process.exit(await vite([], scope));
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`✖ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
