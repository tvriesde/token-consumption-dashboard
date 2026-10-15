import zlib from 'node:zlib';

export class ApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    message: string,
    public acceptedPermissions: string | null = null,
    public oauthScopes: string | null = null,
    public acceptedOauthScopes: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Human readable explanation incl. the permission GitHub says is missing. */
  hint(): string {
    const parts: string[] = [`HTTP ${this.status}: ${this.message}`];
    if (this.acceptedPermissions) parts.push(`GitHub App / fine-grained permission needed: ${this.acceptedPermissions}`);
    if (this.acceptedOauthScopes) parts.push(`Classic PAT scope needed: ${this.acceptedOauthScopes} (token has: ${this.oauthScopes || 'none'})`);
    if (this.status === 401) parts.push('The token is invalid or expired.');
    if (this.status === 403 && !this.acceptedPermissions && !this.acceptedOauthScopes)
      parts.push('Access denied – check the token owner role (owner / billing manager / metrics viewer) and that the "Copilot usage metrics" policy is enabled.');
    if (this.status === 404) parts.push('Not found – wrong enterprise/org slug, the App/token has no access to it, or no data for that day yet.');
    return parts.join(' | ');
  }
}

export interface ClientOptions {
  apiUrl: string;
  apiVersion: string;
  token: () => Promise<string>;
  maxRetries?: number;
  retryBaseMs?: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHubClient {
  requests = 0;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly opts: ClientOptions) {
    this.maxRetries = opts.maxRetries ?? 5;
    this.retryBaseMs = opts.retryBaseMs ?? Number(process.env.RETRY_BASE_MS ?? 1000);
  }

  private log(msg: string) {
    (this.opts.log ?? console.log)(msg);
  }

  private backoff(attempt: number, res?: Response): number {
    const retryAfter = res?.headers.get('retry-after');
    if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const reset = res?.headers.get('x-ratelimit-reset');
    if (res?.headers.get('x-ratelimit-remaining') === '0' && reset) {
      return Math.min(15 * 60_000, Math.max(1000, Number(reset) * 1000 - Date.now() + 1000));
    }
    return this.retryBaseMs * 2 ** attempt;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}, allow: number[] = []): Promise<{ status: number; data: T | null }> {
    const url = new URL(this.opts.apiUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            authorization: `Bearer ${await this.opts.token()}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': this.opts.apiVersion,
            'user-agent': 'copilot-maturity-dashboard',
          },
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          this.log(`  network error on ${url.pathname} (${(err as Error).message}), retrying…`);
          await sleep(this.backoff(attempt));
          continue;
        }
        throw err;
      }
      this.requests++;
      if (res.status === 204) return { status: 204, data: null };
      if (res.ok) return { status: res.status, data: (await res.json()) as T };

      const body = await res.text();
      let message = body.slice(0, 300);
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message;
      } catch {
        /* not JSON */
      }
      const rateLimited =
        res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)));
      if ((res.status >= 500 || rateLimited) && attempt < this.maxRetries) {
        const wait = this.backoff(attempt, res);
        this.log(`  HTTP ${res.status} on ${url.pathname}, retry ${attempt + 1}/${this.maxRetries} in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      if (allow.includes(res.status)) return { status: res.status, data: null };
      throw new ApiError(
        res.status,
        url.pathname + url.search,
        message,
        res.headers.get('x-accepted-github-permissions'),
        res.headers.get('x-oauth-scopes'),
        res.headers.get('x-accepted-oauth-scopes'),
      );
    }
  }

  /** Downloads a signed report URL (no auth header) and returns its text, transparently gunzipping. */
  async download(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'user-agent': 'copilot-maturity-dashboard' } });
        if (!res.ok) throw new ApiError(res.status, new URL(url).pathname, `download failed: ${res.statusText}`);
        const buf = Buffer.from(await res.arrayBuffer());
        return (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (attempt < this.maxRetries && (status === 0 || status >= 500 || status === 429)) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw err;
      }
    }
  }
}

/** Parses an NDJSON file, a JSON array, or a single JSON object into records. */
export function parseRecords(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[')) return JSON.parse(t) as Record<string, unknown>[];
  const out: Record<string, unknown>[] = [];
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const v = JSON.parse(l);
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}
