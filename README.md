# Copilot Maturity Dashboard

A white-label, GitHub-styled dashboard that shows **GitHub Copilot token consumption and maturity per team**.
Everything runs in your own repository:

- **GitHub Actions** collect the data.
- The **repository** stores the history.
- **GitHub Pages** hosts the static site.

There is no server or database, and no data leaves GitHub.

| | |
|---|---|
| **Scopes** | **Enterprise:** one dashboard for the whole enterprise (`/enterprises/{enterprise}/…`). **Organization:** one dashboard per organization (`/orgs/{org}/…`), with an org switcher when you configure several. |
| **Tiles** | A treemap with one tile per team. Tile size is the number of Copilot users in the team. Tile colour shows the composite score above (green) or below (red) the org/enterprise average. |
| **Score** | Four equally weighted metrics: tokens per dollar, model-mix health, active working days and token volume. Viewers can change the weights in the UI. |
| **Maturity** | 4 fixed levels (Exploring, Practicing, Agentic, Autonomous) based on absolute thresholds, per team and per person. |
| **Details** | Click a tile to see a property pane with each metric red or green against the org, the gaps to the next maturity level, a history chart and a per-person table. |
| **History** | Complete calendar months, built from daily 1-day reports and kept in `data/` in this repository. |

> **Try it without credentials:** run `npm ci && npm run testdata:dev`. This starts the dashboard on generated test
> data for a fictional company: 3 months, 20 reported teams, 304 developers, 2 orgs. See [Test data](#test-data).

---

## Contents
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Authentication & permissions](#authentication--permissions) (required)
- [Configuration](#configuration)
- [Metrics, score & maturity](#metrics-score--maturity)
- [Covering full months (the 28-day limit)](#covering-full-months-the-28-day-limit)
- [Data layout & privacy](#data-layout--privacy)
- [Test data](#test-data)
- [Local development & scripts](#local-development--scripts)
- [Troubleshooting](#troubleshooting)

## How it works

```
 ┌────────────────────────── collect-usage.yml (daily) ──────────────────────────┐
 │ auth:check → for every day not yet in the ledger:                              │
 │   GET …/copilot/metrics/reports/users-1-day?day=D        (per-user activity)   │
 │   GET …/copilot/metrics/reports/user-teams-1-day?day=D   (team membership)     │
 │   (+ optional billing AI-credit usage per user/model)                          │
 │ → data/<kind>/<slug>/{raw,daily,billing}/…  + ledger.json → git commit         │
 └───────────────────────────────────┬────────────────────────────────────────────┘
                                     │ workflow_run
 ┌──────────────────────── build-dashboard.yml ──────────────────────────────────┐
 │ aggregate data/ → public/data/*.json (intermediate build data)                 │
 │ vite build embeds data, CSS and JS → dist/index.html → GitHub Pages            │
 └────────────────────────────────────────────────────────────────────────────────┘
```

The API endpoints are documented in [REST API endpoints for Copilot usage metrics](https://docs.github.com/en/rest/copilot/copilot-usage-metrics).

## Quick start

1. **Create a repository from this one**, either by using it as a template or by copying the files. Private repositories are recommended because `data/` contains per-user usage.
2. **Configure** it with `npm ci && npm run configure`, an interactive wizard. You can also edit [`config/dashboard.config.yml`](config/dashboard.config.yml) directly:
   ```yaml
   scope: organization        # or: enterprise
   organizations: [my-org]    # or: enterprise: my-enterprise
   ```
3. **Create credentials**, either a GitHub App (recommended) or a PAT. See [Authentication & permissions](#authentication--permissions).
4. **Add repository secrets** under *Settings › Secrets and variables › Actions*:

   | Secret | When |
   |---|---|
   | `COPILOT_APP_ID`, `COPILOT_APP_PRIVATE_KEY` | GitHub App auth |
   | `COPILOT_METRICS_TOKEN` | PAT auth (instead of the App) |
   | `COPILOT_BILLING_TOKEN` | Optional: billing data for enterprise scope or a different billing account |
   | `PSEUDONYM_SALT` | Required while `privacy.pseudonymize: true` (the default). Use any long random string. |

5. **Enable Pages:** go to *Settings › Pages › Source* and choose **GitHub Actions**.
6. **Run the workflows:**
   - Go to *Actions › Collect Copilot usage › Run workflow*. The first run back-fills `collect.backfill_days`, which defaults to 120 days.
   - *Build dashboard* starts automatically when the collection succeeds and publishes the site.

   The collect workflow then runs every day. Each run commits new data and rebuilds the dashboard.

To preview the deployed site before connecting real data, run *Build dashboard* manually with `source = demo-orgs` or `demo-enterprise`.

For a step-by-step checklist, see [docs/SETUP.md](docs/SETUP.md).

## Authentication & permissions

The collector **requires** a GitHub App installation or a personal access token. Copilot usage metrics are not available to the built-in `GITHUB_TOKEN` of Actions, so the workflows refuse to run without one of these credentials:

- Every collect run first executes `npm run auth:check`.
- The check verifies the credentials against every configured org or enterprise and fails with a list of the missing permissions.

Pick **one** option. When both are configured, the App is used.

### Option A: GitHub App (recommended)

A GitHub App is not tied to a person, uses short-lived installation tokens, and has read-only, narrowly scoped permissions.

| Scope | App permissions (all **Read-only**) | Install on |
|---|---|---|
| Organization | **Organization permissions › Organization Copilot metrics**: Read. Also **Organization permissions › Administration**: Read, needed only for per-model billing data (`collect.billing: true`). | every configured organization |
| Enterprise | **Enterprise permissions › Enterprise Copilot metrics**: Read | the enterprise (enterprise-owned App) |

- No webhook, callback URL or repository permissions are needed.
- [`docs/github-app-manifest.json`](docs/github-app-manifest.json) lists the exact settings.
- Secrets:
  - `COPILOT_APP_ID`: the App ID, a number.
  - `COPILOT_APP_PRIVATE_KEY`: the full `.pem` contents. Base64-encoded or `\n`-escaped values also work.
  - `COPILOT_APP_INSTALLATION_ID` (optional): set it to pin one installation. By default the installation is found automatically per org or enterprise.
- Enterprise billing endpoints are not available to GitHub Apps. In enterprise scope, add a `COPILOT_BILLING_TOKEN` (classic PAT with `manage_billing:enterprise`) if you want exact per-model costs. Without it, the dashboard still works using credits from the metrics reports.

### Option B: Personal access token

| Scope | Fine-grained PAT | Classic PAT |
|---|---|---|
| Organization | Resource owner = **the organization**. **Organization Copilot metrics**: Read, plus **Administration**: Read for billing data. | `read:org` (billing: `manage_billing:copilot` or owner/billing manager) |
| Enterprise | not supported for enterprise endpoints | `read:enterprise` (or `manage_billing:copilot`); billing: `manage_billing:enterprise` |

- Secret: `COPILOT_METRICS_TOKEN`.
- **Several organizations, one token per org:** add `COPILOT_METRICS_TOKEN_<ORG>`. The name is the org slug in upper case, with every character other than A–Z or 0–9 replaced by `_`; for example `my-org` becomes `COPILOT_METRICS_TOKEN_MY_ORG`. Map each secret in the `env:` block of [`collect-usage.yml`](.github/workflows/collect-usage.yml).
- Fine-grained PATs can only target one organization. For several orgs, either create one per org or use a classic PAT.

### Who can read the metrics

Both options also need the following:

- **The Copilot usage metrics policy is enabled** for the enterprise or organization: *Copilot › Policies › Copilot usage metrics*.
- **For a PAT, its owner is allowed to view metrics.** This means an enterprise owner, a billing manager or an org owner, or someone who has a custom role that includes **View Enterprise/Organization Copilot Metrics**.

Check everything locally before pushing secrets:

```bash
COPILOT_METRICS_TOKEN=ghp_xxx npm run auth:check
# ✓ *               credentials        personal access token
# ✓ org/my-org      users-1-day        HTTP 200 for 2026-10-12, 412 records
# ✓ org/my-org      user-teams-1-day   HTTP 200 for 2026-10-12, 389 records
# ! org/my-org      billing (optional) …
```

The same table is written to the workflow run summary. All tokens are masked in the logs. The collector stops on HTTP 401 or 403 rather than recording empty days.

## Configuration

All settings live in [`config/dashboard.config.yml`](config/dashboard.config.yml). The file is validated against [`config/schema.json`](config/schema.json), so editors such as VS Code autocomplete it. Only `scope` and `enterprise`/`organizations` are required.

| Key | Purpose |
|---|---|
| `scope`, `enterprise`, `organizations` | Which endpoint family to use and which targets to collect. In organization scope, every org gets its own dashboard with a switcher. |
| `branding.title/subtitle/logo/footer` | White label. `logo` is a file in the repo or an https URL. The GitHub mark is shown when it is empty. |
| `collect.backfill_days` / `start_date` | How far back the first run goes. The API keeps 1 year of history. |
| `collect.billing` | Fetch per-user/per-model AI-credit usage for exact costs and model mix. Needs the billing permission. |
| `collect.keep_raw`, `raw_retention_months` | Keep the full gzipped NDJSON reports, so metrics can be re-derived later. |
| `pricing.usd_per_credit` | 1 AI credit = $0.01 by default. |
| `pricing.estimate_usd_per_million_tokens` | Used only to **estimate** tokens when the API reports credits but no tokens. |
| `model_tiers` | Regex rules (case-insensitive, first match wins) that classify models as frontier, standard or lightweight. Use `\b` for word boundaries, e.g. `'\bmini\b'`, so that `gemini` is not matched. |
| `model_mix_target` | The healthy mix. The default is 20 % frontier, 60 % standard, 20 % lightweight. |
| `metric_targets` | The absolute value at which a metric scores 100. |
| `weights` | The default weights. Viewers can override them in the UI; overrides are stored in the URL and in localStorage. |
| `maturity_levels` | Fixed thresholds per level. |
| `working_days` | Weekdays and holidays used for the active-day ratio. |
| `team_names` | Display names for team slugs. |
| `privacy.pseudonymize` | Replace logins with stable aliases in the published site. |

## Metrics, score & maturity

| Metric | Definition | Sub-score (0–100) |
|---|---|---|
| **Tokens per dollar** | tokens ÷ (AI credits × `usd_per_credit`), pooled over the team | log scale, 100 at `metric_targets.tokens_per_dollar` |
| **Model-mix health** | 100 × (1 − ½·Σ\|share − target\|) over frontier/standard/lightweight. Shares come from billing credits per model, otherwise from interactions per model. | the value itself |
| **Active working days** | active days ÷ working days in the month, averaged over **all** team members (inactive members count) | linear, 100 at `metric_targets.active_day_ratio` |
| **Token volume** | median tokens per active developer per month | log scale, 100 at `metric_targets.tokens_per_dev` |

- **Composite score:** the weighted mean of the four sub-scores, with 25 / 25 / 25 / 25 by default. Viewers can change the weights in **Weights**.
- **Colour:** a diverging red–grey–green scale centred on the org/enterprise composite, computed the same way over all users. In the property pane each metric is shown as above, at or below the org value. That makes it obvious which lever will improve a team.
- **Maturity:** this is *not* relative to the average. A team (or person) reaches a level only when it meets **all** of that level's minimums:

| Level | Active-day ratio | Tokens / dev / month | Model-mix health | Tokens per $ |
|---|---|---|---|---|
| 1 Exploring | – | – | – | – |
| 2 Practicing | ≥ 0.30 | ≥ 5 M | – | – |
| 3 Agentic | ≥ 0.55 | ≥ 25 M | ≥ 60 | – |
| 4 Autonomous | ≥ 0.75 | ≥ 60 M | ≥ 75 | ≥ 400 k |

**Where token counts come from:**

1. The collector sums every `token_usage` node in a user record, including CLI, Copilot app and any newer surface.
2. If billing data reports tokens, those exact values win.
3. Otherwise, spend that has no reported tokens is converted to an estimate with `pricing.estimate_usd_per_million_tokens`.

Each team shows whether its tokens are *exact*, *mixed* or *estimated*. Run `npm run probe` to see which token fields your account actually receives. It prints field names and types only, never values.

**GitHub limits:**

- Teams with fewer than 5 Copilot users are not included in the `user-teams` report. Their users appear under *Unassigned*, which you can toggle in the UI.
- Users can belong to several teams and are counted in each.

## Covering full months (the 28-day limit)

The *28-day* reports only cover a rolling window. This dashboard does not use them. Instead:

1. **Daily 1-day reports:** the `users-1-day` and `user-teams-1-day` endpoints accept any `day` up to one year back. The collector downloads **one report per calendar day** and stores it under `data/`.
2. **A ledger records every day's state.** `data/<kind>/<slug>/ledger.json` marks each day as `ok`, `partial`, `pending` or `missing`:
   - *ok*: collected.
   - *partial*: the team report was not ready yet.
   - *pending*: GitHub has not published the day yet.
   - *missing*: the day still returned nothing after `pending_retry_limit` attempts and more than 7 days of waiting.

   Every run retries *pending* and *partial* days and back-fills gaps automatically.
3. **Months are assembled from days.** The build turns the daily files into calendar months. The current month is shown as *partial*, with its coverage, until it is complete.
4. **The history stays in git:** the daily files are small, trimmed JSON. Raw reports are gzipped and optional.

As a result every month is complete, even though GitHub only shows a rolling window. Missed runs are harmless: the next run fills the gap as long as it is less than a year old. To re-collect a range, run *Collect Copilot usage* manually with `since`, `until` and `force`.

## Data layout & privacy

```
data/
  org/<org>/ or enterprise/<enterprise>/
    ledger.json                          state per day
    daily/YYYY/MM/YYYY-MM-DD.json        trimmed per-user metrics + team memberships
    raw/YYYY/MM/YYYY-MM-DD.*.ndjson.gz   full API reports (collect.keep_raw)
    billing/YYYY-MM.json                 per-user, per-model credits (collect.billing)
public/data/                              generated intermediate data (git-ignored)
dist/index.html                           self-contained page: data + styles + app code
```

- `data/` contains logins and per-user usage. **Keep the repository private.** GitHub Pages for private repositories can be restricted to members on Enterprise Cloud.
- With `privacy.pseudonymize: true`, the published site shows `dev-xxxxxxxx` aliases. They are HMAC-SHA256 of the login keyed by the `PSEUDONYM_SALT` secret: stable across months but not reversible without the salt. Builds in Actions fail when the salt is missing.

## Test data

Committed fixtures in `testdata/fixtures/` describe the fictional company **Contoso**:

- July to September 2026 (3 months).
- 20 reported developer teams with different personas, 304 developers, 2 orgs (`contoso-apps`, `contoso-data`) and 1 enterprise (`contoso`). Two additional 3-seat teams are intentionally suppressed by the mock API, matching GitHub's behavior for teams with fewer than 5 seats.
- Both report types plus billing data.

A local **mock GitHub API** serves the fixtures using the real endpoint shapes, signed download links and auth checks. The real collector and build scripts run against it, so no credentials are needed.

```bash
npm run testdata                          # both scopes: collect → aggregate → vite build (testdata/out/<scope>/dist/index.html)
npm run testdata:dev                      # dev server on the org-scope test data (org switcher)
npm run testdata:dev -- --scope enterprise
npm run testdata:collect -- --scope orgs  # only run the collector against the mock API
npm run testdata:build   -- --scope orgs  # only aggregate + build
npm run testdata:generate                 # regenerate fixtures (seeded, deterministic)
```

The generated `dist/index.html` in each scope is self-contained and opens directly in a browser.

The collector runs twice:

1. As of the day after the dataset ends. The newest days are still *pending* and one team report is late (*partial*).
2. Three days later, when it back-fills them.

That exercises the full-month logic. The configs are in `config/test.orgs.yml` and `config/test.enterprise.yml`. `npm test` runs the same pipeline and compares the team metrics against a golden snapshot.

## Local development & scripts

| Command | What it does |
|---|---|
| `npm run configure` | Interactive wizard: scope, orgs/enterprise, branding, auth method and the permissions to grant |
| `npm run auth:check` | Verifies credentials and permissions for every target |
| `npm run probe` | Prints the field shape of your real `users-1-day` report, with no values |
| `npm run collect -- [--since D] [--until D] [--force]` | Collects into `data/` (uses `COPILOT_*` env vars) |
| `npm run build` | Aggregates `data/` and builds the standalone `dist/index.html` |
| `npm run dev` | Vite dev server on `public/data` (run `npm run aggregate` first) |
| `npm run typecheck` / `npm test` | TypeScript check / unit and pipeline tests |

**Environment variables:**

- `COPILOT_API_URL`: use it for GHE.com data residency, e.g. `https://api.SUBDOMAIN.ghe.com`. In Actions, set it as a repository *variable*.
- `DATA_DIR`
- `DASHBOARD_CONFIG`
- `PSEUDONYM_SALT`

The stack is TypeScript scripts (tsx), and a static site built with Vite, D3 and [Primer CSS](https://primer.style/css), in light and dark mode.
The production build embeds the dashboard JSON, JavaScript and CSS in one HTML file. You can publish `dist/` with GitHub Pages or open `dist/index.html` directly in a browser; no server or sibling data files are required. Development mode still uses `public/data/` and Vite's local server.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No GitHub credentials configured` | Add `COPILOT_APP_ID` + `COPILOT_APP_PRIVATE_KEY`, or `COPILOT_METRICS_TOKEN`, as repository secrets. |
| HTTP **401** | Invalid or expired token, or a wrong App private key. |
| HTTP **403** | A permission is missing (the error lists the required ones), the token owner may not view metrics, or SSO authorization is needed for the PAT (*Configure SSO*). |
| HTTP **404** on the reports | The Copilot usage metrics policy is disabled, the slug is wrong, or the scope is wrong (enterprise vs organization). |
| `The GitHub App … is not installed on …` | Install the App on that org or enterprise, or set `COPILOT_APP_INSTALLATION_ID`. |
| Days stay *pending* | Normal for the most recent ~2 days. GitHub publishes reports with a delay. |
| Team missing | Teams with fewer than 5 Copilot users are excluded by GitHub. Its members appear under *Unassigned*. |
| Build fails with `PSEUDONYM_SALT` | Add the secret, or set `privacy.pseudonymize: false`. |
| Tokens marked *estimated* | Your account does not report tokens for some surfaces. Enable `collect.billing` or tune `pricing.estimate_usd_per_million_tokens`. |
