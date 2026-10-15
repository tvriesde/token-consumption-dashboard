/**
 * Interactive setup: choose enterprise or organization scope, the org(s), branding and the auth method.
 * Updates config/dashboard.config.yml in place (comments are preserved) and prints the permissions to grant.
 *
 *   npm run configure
 */
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import YAML from 'yaml';
import { permissionsHelp } from './lib/auth';
import { parseConfig } from './lib/config';

const CONFIG = process.env.DASHBOARD_CONFIG || 'config/dashboard.config.yml';
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-_.]*$/;

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string) => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def || '';
  };
  const doc = YAML.parseDocument(fs.readFileSync(CONFIG, 'utf8'));

  console.log('\nCopilot Maturity Dashboard – configuration\n');
  let scope = '';
  while (!['enterprise', 'organization'].includes(scope)) {
    scope = (await ask('Scope: (e)nterprise or (o)rganization', String(doc.get('scope') ?? 'organization'))).toLowerCase();
    if (scope === 'e') scope = 'enterprise';
    if (scope === 'o') scope = 'organization';
  }
  doc.set('scope', scope);

  if (scope === 'enterprise') {
    let slug = '';
    while (!SLUG.test(slug)) slug = await ask('Enterprise slug (github.com/enterprises/<slug>)', String(doc.get('enterprise') ?? ''));
    doc.set('enterprise', slug);
  } else {
    const current = (doc.toJS().organizations as string[] | undefined)?.join(', ');
    let orgs: string[] = [];
    while (!orgs.length || !orgs.every((o) => SLUG.test(o))) {
      orgs = (await ask('Organization login(s), comma separated (one dashboard view per org)', current)).split(/[\s,]+/).filter(Boolean);
    }
    doc.set('organizations', doc.createNode(orgs));
  }

  doc.setIn(['branding', 'title'], await ask('Dashboard title', String(doc.getIn(['branding', 'title']) ?? 'Copilot Maturity Dashboard')));
  const pseudo = (await ask('Pseudonymize developer logins on the published site? (y/n)', doc.getIn(['privacy', 'pseudonymize']) === false ? 'n' : 'y')).toLowerCase();
  doc.setIn(['privacy', 'pseudonymize'], pseudo.startsWith('y'));
  const auth = (await ask('Authenticate with a GitHub (a)pp or a (p)ersonal access token', 'a')).toLowerCase();
  rl.close();

  const text = doc.toString();
  parseConfig(text, CONFIG); // validate before writing
  fs.writeFileSync(CONFIG, text);
  console.log(`\n✓ Wrote ${CONFIG}\n`);
  console.log(permissionsHelp(scope as 'enterprise' | 'organization'));
  console.log('\nNext steps (with the GitHub CLI, in this repository):');
  if (auth.startsWith('p')) console.log('  gh secret set COPILOT_METRICS_TOKEN');
  else console.log('  gh secret set COPILOT_APP_ID --body <app id>\n  gh secret set COPILOT_APP_PRIVATE_KEY < path/to/private-key.pem');
  if (scope === 'enterprise') console.log('  gh secret set COPILOT_BILLING_TOKEN            # optional, classic PAT with manage_billing:enterprise');
  if (pseudo.startsWith('y')) console.log('  gh secret set PSEUDONYM_SALT --body "$(openssl rand -hex 32)"');
  console.log('  npm run auth:check   # locally, after exporting the same variables');
  console.log('  Settings › Pages › Source: GitHub Actions, then run the "Collect Copilot usage" workflow.\n');
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
