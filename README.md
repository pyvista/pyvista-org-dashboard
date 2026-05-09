# PyVista Org Command Dashboard

A static dashboard for the [PyVista GitHub organization](https://github.com/pyvista). It is hosted on GitHub Pages, refreshed daily by a GitHub Actions workflow, and focused on the pyvista org with critical-CI precedence and a four-tier repo classification so that infrastructure repos are surfaced first and inactive ones stay out of the way.

## How it works

```
GitHub Actions (cron: daily)
  └── actions/create-github-app-token   (mints an installation token from
        │                                the pyvista-org GitHub App)
        └── exports GH_TOKEN for the next step
              └── scripts/fetch-data.js
                    ├── lists pyvista repos
                    ├── classifies each repo into Tier 0/1/2/3
                    │   from config/orgs/pyvista.json
                    ├── for Tier 0 repos: fetches latest run of each
                    │   watched workflow on the default branch
                    ├── builds critical_alerts from Tier 0 failures
                    └── writes docs/orgs/pyvista/data.json
        └── actions/upload-pages-artifact + actions/deploy-pages
              └── GitHub Pages serves docs/ (source: GitHub Actions)
                    └── docs/index.html redirects to orgs/pyvista/
                          └── reads data.json, renders tiers + alerts

The workflow does not commit or push anything. The `main` branch can have
full branch protection. The dashboard repo's `GITHUB_TOKEN` is used only
to open or update a tracking issue on workflow failure.
```

The installation token lives only inside the workflow run. Visitors load static HTML and a JSON snapshot. No token reaches the browser.

## Setup

These steps assume the dashboard repo lives at `pyvista/pyvista-org-dashboard`.

### 1. Register a GitHub App on the pyvista org

The pyvista org disallows personal access tokens, so the dashboard authenticates as a GitHub App. Go to <https://github.com/organizations/pyvista/settings/apps> and create a new App with the following read-only repository permissions and no other permissions:

| Permission | Access |
|---|---|
| Metadata | Read |
| Issues | Read |
| Pull requests | Read |
| Contents | Read |
| Actions | Read |

Do not request any write permissions on the repository or organization. The fetcher only reads, and the dashboard is published via GitHub Pages artifact deploy rather than a git push, so no `Contents: write` is needed anywhere. Organization permissions: none.

The App does not need a webhook or a callback URL. Restrict it to the pyvista org.

### 2. Generate a private key and install the App

On the App's settings page:

1. Generate a private key. Download the PEM file and keep it safe.
2. Note the App's numeric ID at the top of the settings page.
3. Install the App on the pyvista org and grant it access to all repositories.

### 3. Configure the dashboard repo

In `pyvista/pyvista-org-dashboard` go to **Settings -> Secrets and variables -> Actions** and add:

| Type | Name | Value |
|---|---|---|
| Secret | `PYVISTA_DASHBOARD_APP_PRIVATE_KEY` | Full contents of the PEM file from step 2 |
| Variable | `PYVISTA_DASHBOARD_APP_ID` | Numeric App ID from step 2 |
| Variable (optional) | `GH_ORGS` | Comma-separated org list. Defaults to `pyvista`. |

### 4. Enable GitHub Pages

**Settings -> Pages**:

- Source: **GitHub Actions**

Do not pick "Deploy from a branch". The refresh workflow uploads `docs/` as a Pages artifact and deploys it via `actions/deploy-pages`, so there is no published branch.

The site URL will be something like `https://pyvista.github.io/pyvista-org-dashboard/`. The root `docs/index.html` redirects to `orgs/pyvista/`.

Because the workflow no longer pushes to git, you can enable strict branch protection on `main`. The App stays fully read-only.

### 5. Create the failure-tracking label

The refresh workflow opens or updates an issue with the `dashboard-failure` label whenever a run fails. Create that label once under **Issues -> Labels** with any color so the first failure can apply it.

### 6. Run the workflow once

**Actions -> Refresh dashboard data -> Run workflow**. This populates `docs/orgs/pyvista/data.json` inside the workflow runner and deploys the resulting `docs/` to GitHub Pages. The cron then runs daily.

## Local development

The fetcher reads `process.env.GH_TOKEN` and is auth-mechanism agnostic. For local previews any GitHub token works:

- A fine-grained personal access token (your account, read-only on the target org).
- A classic personal access token (legacy).
- A GitHub App installation token minted out of band, for example via `gh api` against the App.

The org-wide PAT restriction only applies to CI runs against the real `pyvista` org. Production always uses the App installation token minted inside the workflow. Local tokens never leave your machine and are never committed.

```bash
npm ci
GH_TOKEN=<your-token-or-installation-token> node scripts/fetch-data.js
python3 -m http.server 8080 --directory docs
```

Then open <http://localhost:8080/>. The root page redirects to `orgs/pyvista/`.

If you do not want to provide any token at all, you can point the fetcher at a public-data path with no auth, accepting the much lower unauthenticated rate limit (60 requests per hour). Iteration is slow but it works for spot checks.

If you want to point the fetcher at a different org while testing, prefix with `GH_ORGS=<org>`.

## Operations

For day-to-day operations, including how to read the alert pill, what to do when the workflow fails, how to rotate the App private key, and how to add a new repo or watched workflow, see [RUNBOOK.md](./RUNBOOK.md).

## Repo prominence tiers

Repos are sorted into four tiers, defined per-org in `config/orgs/<org>.json`. The shipped config lives at `config/orgs/pyvista.json`.

- **Tier 0 - Critical infrastructure.** Always rendered first, always expanded, alerts on red CI. The PyVista Tier 0 set covers the org-wide repos and the runner / docs / data infrastructure.
- **Tier 1 - Core ecosystem.** Active maintained packages. Rendered as a table.
- **Tier 2 - Companion, demos, experimental.** Rendered collapsed.
- **Tier 3 - Archived or inactive.** Computed automatically from `archived === true`, hidden by default.

Repos not listed in the config default to Tier 1 if not archived and Tier 3 if archived. To promote or demote a repo, edit the relevant tier array in `config/orgs/pyvista.json`.

## Watched CI workflows

Tier 0 repos can declare watched workflows in the org config. The `watched_workflows` object at the top of `config/orgs/<org>.json` is keyed by repo name; each value is an array of full workflow paths (e.g. `.github/workflows/integration-tests.yml`). Paths are matched against the `path` field that GitHub returns for each workflow, which is stable across renames of the workflow's display `name`.

The fetcher pulls the latest run on the default branch for each watched path and renders it as a colored chip in the Tier 0 card grid. The worst conclusion among watched runs feeds the critical alerts banner.

To add a watched workflow:

1. Open `config/orgs/pyvista.json`.
2. Add or extend the entry under `watched_workflows.<repo-name>`.
3. Append the full workflow path, e.g. `".github/workflows/integration-tests.yml"`.
4. Commit and let the next scheduled run pick it up, or trigger the workflow manually.

If a Tier 0 repo has no `watched_workflows` entry, the fetcher falls back to fetching all active workflows on the default branch and uses the worst non-success conclusion for the alert.

## Customizing

- **Refresh schedule.** Edit the `cron` field in `.github/workflows/refresh.yml`. The default is daily at 06:00 UTC.
- **Adding more orgs.** Set the repo variable `GH_ORGS` to a comma-separated list, e.g. `pyvista,some-other-org`, and write `config/orgs/<org>.json` for each new org following the schema in `config/orgs/pyvista.json`. Each org gets its own page under `docs/orgs/<org>/`.
- **UI tweaks.** The frontend is plain HTML, CSS, and JS with no build step. The template lives at `docs/orgs/ORG_TEMPLATE/index.html`; per-org pages are produced by the workflow.

## Project structure

```
.
├── .github/
│   └── workflows/
│       ├── refresh.yml           # daily cron + workflow_dispatch
│       └── ci.yml                # lint and test on push/PR
├── config/
│   └── orgs/
│       └── pyvista.json          # tier assignments + watched workflows
├── docs/                         # GitHub Pages root
│   ├── index.html                # redirect to orgs/pyvista/
│   └── orgs/
│       ├── ORG_TEMPLATE/         # source-of-truth template
│       │   └── index.html
│       └── pyvista/
│           ├── index.html        # generated from template
│           └── data.json         # generated by the workflow
├── scripts/
│   └── fetch-data.js             # Node fetcher, runs in Actions
├── tests/                        # node --test unit + smoke tests
├── ARCHITECTURE.md
├── INVENTORY.md
├── biome.json
├── package.json
└── README.md
```
