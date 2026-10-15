# Setup checklist

This guide takes you from an empty repository to a published dashboard. Plan for about 15 minutes. For background, see the [README](../README.md).

## 0. Prerequisites
- [ ] GitHub Copilot Business or Enterprise with the **Copilot usage metrics** policy enabled. For an organization, go to *Settings › Copilot › Policies*. For an enterprise, go to *Enterprise › AI controls / Copilot › Policies*.
- [ ] You are an organization owner, or an enterprise owner or billing manager, so you can create the App or the PAT.
- [ ] A **private** repository holding these files. Keep it private, because `data/` stores per-user usage.

## 1. Configure the scope
Run the interactive wizard:

```bash
npm ci
npm run configure
```

Or edit `config/dashboard.config.yml` directly:

```yaml
# Organization scope (one dashboard per org, switcher when > 1)
scope: organization
organizations: [my-org, my-other-org]

# — or — enterprise scope
scope: enterprise
enterprise: my-enterprise
```

Optionally set `branding.title`, `branding.logo` and `team_names`. Commit the file.

## 2. Create credentials (choose A or B)

### A. GitHub App (recommended)

**Organization scope**

1. Go to *Organization › Settings › Developer settings › GitHub Apps › New GitHub App*.
2. Set the name to anything you like. Set the homepage URL to your repo URL.
3. Webhook: **uncheck "Active"**.
4. Set these permissions, and nothing else:
   - *Organization permissions › Organization Copilot metrics*: **Read-only**
   - *Organization permissions › Administration*: **Read-only**. This is only needed for billing data (`collect.billing: true`).
5. Set *Where can this GitHub App be installed?* to **Only on this account**. If you collect several orgs owned by different accounts, choose **Any account** instead.
6. Create the App. Note the **App ID**, then click **Generate a private key**, which downloads a `.pem` file.
7. Click **Install App** and install it on every organization listed in the config.

**Enterprise scope**

1. Go to *Enterprise › Settings › GitHub Apps › New GitHub App*. This creates an enterprise-owned App.
2. Set the permission *Enterprise permissions › Enterprise Copilot metrics* to **Read-only**. No webhook is needed.
3. Generate a private key, then install the App **on the enterprise**.
4. Optional, for exact per-model costs: create a classic PAT with `manage_billing:enterprise` and store it as `COPILOT_BILLING_TOKEN`. GitHub Apps cannot read enterprise billing.

[`github-app-manifest.json`](github-app-manifest.json) contains the same settings in manifest form.

### B. Personal access token

| Scope | Token |
|---|---|
| Organization | **Fine-grained PAT**: set the resource owner to the org. Grant *Organization Copilot metrics: Read*, plus *Administration: Read* for billing. Or a **classic PAT** with `read:org`. |
| Enterprise | **Classic PAT** with `read:enterprise` (or `manage_billing:copilot`), plus `manage_billing:enterprise` for billing. |

- The token owner must be allowed to view Copilot metrics: an owner, a billing manager, or a member of a custom role that includes *View … Copilot Metrics*.
- If your org enforces SAML SSO, authorize the token for it with *Configure SSO*.

## 3. Verify locally (optional but recommended)

```bash
# PAT
COPILOT_METRICS_TOKEN=github_pat_xxx npm run auth:check

# GitHub App
COPILOT_APP_ID=123456 COPILOT_APP_PRIVATE_KEY="$(cat my-app.private-key.pem)" npm run auth:check
```

Every row must show ✓. The *billing (optional)* row may show `!`, which only means costs come from the metrics reports.

## 4. Add repository secrets
Add these under *Repo › Settings › Secrets and variables › Actions › New repository secret*:

| Secret | Value |
|---|---|
| `COPILOT_APP_ID` | the App ID (option A) |
| `COPILOT_APP_PRIVATE_KEY` | the full contents of the `.pem` file (option A) |
| `COPILOT_METRICS_TOKEN` | the PAT (option B) |
| `COPILOT_BILLING_TOKEN` | optional billing PAT |
| `PSEUDONYM_SALT` | a long random string, e.g. the output of `openssl rand -hex 32`. Required while `privacy.pseudonymize: true`. |

- **One PAT per organization:** add `COPILOT_METRICS_TOKEN_<ORG>` secrets, then map each one in the `env:` block of `.github/workflows/collect-usage.yml`.
- **GHE.com (data residency):** add a repository **variable** `COPILOT_API_URL`, e.g. `https://api.SUBDOMAIN.ghe.com`.

## 5. Enable GitHub Pages
Go to *Repo › Settings › Pages › Build and deployment › Source* and select **GitHub Actions**.

To see the dashboard with demo data first, go to *Actions › Build dashboard › Run workflow* and choose `source: demo-orgs`.

## 6. Collect and publish
1. Go to *Actions › Collect Copilot usage › Run workflow*.
   - The first run back-fills `collect.backfill_days`, which defaults to 120 days.
   - To start from a specific date, set `since`.
2. When it succeeds, **Build dashboard** starts automatically and publishes the site. The URL appears in the deploy job.
3. From then on, the collector runs daily at 05:23 UTC. Each run commits new days and re-tries days GitHub had not published yet. After that, the dashboard rebuilds.

The production artifact is a single self-contained `dist/index.html`; the workflow publishes that file through GitHub Pages. You can also download it from the workflow artifact and open it directly in a browser.

## 7. Maintenance
- **Change scoring, tiers or branding:** edit the config and push. The dashboard rebuilds without re-collecting.
- **Re-collect a period:** run the collect workflow with `since`, `until` and `force: true`.
- **Rotate credentials:** update the secrets, then run *Collect* manually. The auth check validates them first.
- **Limit repository growth:** set `collect.raw_retention_months` to prune old raw reports. The trimmed daily files are kept.
