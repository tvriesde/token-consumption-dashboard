import { createAppAuth } from '@octokit/auth-app';
import { request as octoRequest } from '@octokit/request';
import type { Scope, Target } from '../../shared/types';

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export type AuthSettings =
  | { mode: 'app'; appId: string; privateKey: string; installationId?: number }
  | { mode: 'pat'; token: string };

type Env = Record<string, string | undefined>;

export const REQUIRED_PERMISSIONS: Record<Scope, { app: string[]; finePat: string[] | null; classicPat: string[]; billing: string }> = {
  enterprise: {
    app: ['Enterprise permissions › Enterprise Copilot metrics: Read (install the App on the enterprise)'],
    finePat: null,
    classicPat: ['read:enterprise  (or manage_billing:copilot)'],
    billing: 'Optional: COPILOT_BILLING_TOKEN = classic PAT with manage_billing:enterprise (enterprise billing is not available to GitHub Apps)',
  },
  organization: {
    app: [
      'Organization permissions › Organization Copilot metrics: Read',
      'Organization permissions › Administration: Read (only for per-model billing data)',
      'Install the App on every configured organization',
    ],
    finePat: ['Resource owner = the organization', 'Organization Copilot metrics: Read', 'Administration: Read (billing data)'],
    classicPat: ['read:org'],
    billing: 'Billing uses the same credentials (GitHub App Administration: Read, or an org owner / billing manager token)',
  },
};

export function permissionsHelp(scope: Scope): string {
  const p = REQUIRED_PERMISSIONS[scope];
  const lines = [
    `Required credentials for scope "${scope}" (pick ONE option):`,
    '',
    '  Option A – GitHub App (recommended): secrets COPILOT_APP_ID + COPILOT_APP_PRIVATE_KEY',
    ...p.app.map((s) => `      • ${s}`),
    '',
    '  Option B – Personal access token: secret COPILOT_METRICS_TOKEN',
    ...(p.finePat ? ['      Fine-grained PAT:', ...p.finePat.map((s) => `        • ${s}`)] : ['      Fine-grained PATs cannot access enterprise endpoints – use a classic PAT.']),
    '      Classic PAT scopes:',
    ...p.classicPat.map((s) => `        • ${s}`),
    '',
    `  Billing: ${p.billing}`,
    '  The token owner / App must be allowed to view Copilot metrics (enterprise owner, billing manager, org owner,',
    '  or the "View Enterprise/Organization Copilot Metrics" fine-grained role) and the "Copilot usage metrics"',
    '  policy must be enabled. The built-in GITHUB_TOKEN of Actions cannot read Copilot metrics.',
  ];
  return lines.join('\n');
}

function normalizePrivateKey(key: string): string {
  let k = key.trim();
  if (!k.includes('\n') && k.includes('\\n')) k = k.replace(/\\n/g, '\n');
  if (!k.startsWith('-----BEGIN')) {
    // Accept base64-encoded PEM as well.
    const decoded = Buffer.from(k, 'base64').toString('utf8');
    if (decoded.startsWith('-----BEGIN')) k = decoded;
  }
  return k;
}

export function readAuthSettings(env: Env = process.env): AuthSettings | null {
  const appId = env.COPILOT_APP_ID?.trim();
  const key = env.COPILOT_APP_PRIVATE_KEY;
  if (appId || key?.trim()) {
    if (!appId || !key?.trim()) throw new AuthConfigError('Both COPILOT_APP_ID and COPILOT_APP_PRIVATE_KEY must be set to authenticate as a GitHub App.');
    const inst = env.COPILOT_APP_INSTALLATION_ID?.trim();
    if (inst && !/^\d+$/.test(inst)) throw new AuthConfigError('COPILOT_APP_INSTALLATION_ID must be numeric.');
    return { mode: 'app', appId, privateKey: normalizePrivateKey(key), installationId: inst ? Number(inst) : undefined };
  }
  const token = env.COPILOT_METRICS_TOKEN?.trim();
  if (token) return { mode: 'pat', token };
  return null;
}

/** Per-target PAT override, e.g. COPILOT_METRICS_TOKEN_MY_ORG for org "my-org". */
export function targetEnvSuffix(slug: string): string {
  return slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

const masked = new Set<string>();
function mask(token: string, env: Env) {
  if (env.GITHUB_ACTIONS === 'true' && token && !masked.has(token)) {
    masked.add(token);
    process.stdout.write(`::add-mask::${token}\n`);
  }
}

export interface TokenProvider {
  mode: 'app' | 'pat';
  metrics(t: Target): () => Promise<string>;
  /** null when no credentials for the billing API are available for this target. */
  billing(t: Target): (() => Promise<string>) | null;
  describe(): string;
}

interface Installation {
  id: number;
  target_type?: string;
  account?: { login?: string; slug?: string; name?: string } | null;
}

export function createTokenProvider(scope: Scope, apiUrl: string, env: Env = process.env): TokenProvider {
  const settings = readAuthSettings(env);
  if (!settings) throw new AuthConfigError(`No GitHub credentials configured.\n\n${permissionsHelp(scope)}`);
  const billingPat = env.COPILOT_BILLING_TOKEN?.trim();

  if (settings.mode === 'pat') {
    const forTarget = (t: Target) => env[`COPILOT_METRICS_TOKEN_${targetEnvSuffix(t.slug)}`]?.trim() || settings.token;
    return {
      mode: 'pat',
      metrics: (t) => async () => {
        const tok = forTarget(t);
        mask(tok, env);
        return tok;
      },
      billing: (t) => {
        const tok = billingPat || forTarget(t);
        return async () => {
          mask(tok, env);
          return tok;
        };
      },
      describe: () => (billingPat ? 'personal access token (+ separate billing token)' : 'personal access token'),
    };
  }

  const auth = createAppAuth({
    appId: settings.appId,
    privateKey: settings.privateKey,
    request: octoRequest.defaults({ baseUrl: apiUrl }),
  });
  let installations: Promise<Installation[]> | null = null;

  const listInstallations = async (): Promise<Installation[]> => {
    const { token } = await auth({ type: 'app' });
    const all: Installation[] = [];
    for (let page = 1; page < 50; page++) {
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/app/installations?per_page=100&page=${page}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new AuthConfigError(`Could not list GitHub App installations (HTTP ${res.status}). Check COPILOT_APP_ID / COPILOT_APP_PRIVATE_KEY.`);
      const batch = (await res.json()) as Installation[];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };

  const installationFor = async (t: Target): Promise<number> => {
    if (settings.installationId) return settings.installationId;
    installations ??= listInstallations();
    const wantType = t.kind === 'enterprise' ? 'enterprise' : 'organization';
    const slug = t.slug.toLowerCase();
    const hit = (await installations).find((i) => {
      const names = [i.account?.login, i.account?.slug].filter(Boolean).map((s) => s!.toLowerCase());
      return names.includes(slug) && (i.target_type ?? '').toLowerCase() === wantType;
    });
    if (!hit) {
      throw new AuthConfigError(
        `The GitHub App (id ${settings.appId}) is not installed on ${wantType} "${t.slug}". ` +
          `Install it there (Settings › GitHub Apps) or set COPILOT_APP_INSTALLATION_ID.\n\n${permissionsHelp(scope)}`,
      );
    }
    return hit.id;
  };

  const installationToken = (t: Target) => async () => {
    const installationId = await installationFor(t);
    const { token } = await auth({ type: 'installation', installationId });
    mask(token, env);
    return token;
  };

  return {
    mode: 'app',
    metrics: installationToken,
    billing: (t) => {
      if (billingPat)
        return async () => {
          mask(billingPat, env);
          return billingPat;
        };
      // Enterprise billing endpoints are not available to GitHub Apps.
      return t.kind === 'enterprise' ? null : installationToken(t);
    },
    describe: () => `GitHub App ${settings.appId}${billingPat ? ' (+ separate billing token)' : ''}`,
  };
}
