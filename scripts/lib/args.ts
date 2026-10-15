import { pathToFileURL } from 'node:url';

/** Minimal --key value / --flag parser. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else positional.push(a);
  }
  return { flags: out, positional };
}

export function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function isMain(metaUrl: string): boolean {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}
