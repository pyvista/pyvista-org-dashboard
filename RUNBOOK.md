# Runbook for pyvista-org-dashboard

Operational guide for keeping the PyVista org dashboard healthy.

## Architecture in 3 lines

1. A scheduled GitHub Actions workflow (`refresh.yml`) mints a GitHub App installation token, runs the Node fetcher against the org, and writes JSON snapshots into `docs/orgs/<org>/`.
2. The same workflow uploads `docs/` as a Pages artifact and deploys via `actions/deploy-pages`. Nothing is committed to git.
3. The static frontend in `docs/` reads `data.json` in the browser and renders four tiers plus a critical alerts banner.

## When the dashboard goes red

The red alert pill at the top of the page is driven by `critical_alerts` in `data.json`. Each entry is a Tier 0 watched workflow whose latest run on the default branch concluded in `failure` or `cancelled`.

To drill into a failed Tier 0 workflow:

1. Click the red chip on the offending repo's card. It links to the workflow run on github.com.
2. Read the failing job logs.
3. If the failure is real, file or update an issue on the upstream repo, not this dashboard.
4. If the failure is stale and the workflow has since recovered, trigger a manual refresh of this dashboard (see below). The chip will turn green on the next snapshot.

## When the workflow fails

If `refresh.yml` itself fails, the final step opens (or comments on) a tracking issue titled `Dashboard refresh failed: YYYY-MM-DD` with the `dashboard-failure` label.

To recover:

1. Open the most recent issue with label `dashboard-failure`.
2. Follow the linked workflow run and read the failed step's logs.
3. Common causes are listed below in "Common failure modes".
4. After a fix, re-run via **Actions -> Refresh dashboard data -> Run workflow** (`workflow_dispatch`).
5. Close the issue when the next scheduled or manual run succeeds.

The `dashboard-failure` label must exist on the repo before the first failure. Create it once under **Issues -> Labels** with any color.

## Rotating the GitHub App private key

Do this if the key is suspected leaked, on a regular cadence, or when rotating maintainers.

1. Go to <https://github.com/organizations/pyvista/settings/apps> and open the `pyvista-org-dashboard` App.
2. Under **Private keys**, click **Generate a private key**. Download the new PEM.
3. In `pyvista/pyvista-org-dashboard` open **Settings -> Secrets and variables -> Actions** and update the secret `PYVISTA_DASHBOARD_APP_PRIVATE_KEY` with the full new PEM contents.
4. Trigger the refresh workflow manually to confirm the new key works.
5. Back on the App's settings page, delete the old private key.

The numeric App ID does not change during key rotation. Variable `PYVISTA_DASHBOARD_APP_ID` stays as is.

## Adding a new repo to a tier

1. Edit `config/orgs/<org>.json`.
2. Add the repo's short name (no org prefix) to the desired tier array. Tier 0 is critical infrastructure, Tier 1 is the core ecosystem, Tier 2 is companion or experimental, Tier 3 is computed automatically from `archived` so it is not edited by hand.
3. If the repo is Tier 0 and has specific workflows that should drive the alert pill, add an entry under top-level `watched_workflows.<repo-name>` listing the full workflow paths (e.g. `".github/workflows/integration-tests.yml"`).
4. Commit, open a PR, merge. The next scheduled run picks it up. Trigger `workflow_dispatch` if you need it sooner.

## Adding a new watched workflow

1. Open `config/orgs/pyvista.json`.
2. Locate or add the `watched_workflows.<repo-name>` array (keyed at the top of the config, not nested inside the tier list).
3. Append the full workflow path, for example `".github/workflows/integration-tests.yml"`. Paths are matched against the workflow's `path` field, which is stable across renames of the workflow's display `name`.
4. Commit and merge. The next run renders a chip for it.

If a Tier 0 repo has no `watched_workflows` entry the fetcher falls back to all active workflows on the default branch and uses the worst non-success conclusion.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Workflow fails on `Mint GitHub App installation token` | App private key rotated, expired, or secret unset | Rotate per the section above and update `PYVISTA_DASHBOARD_APP_PRIVATE_KEY`. |
| Workflow fails on `Mint GitHub App installation token` with 404 | App uninstalled from the org or org name changed | Reinstall the App on the org with access to all repositories. |
| Fetcher logs many `403` or `Secondary rate limit` warnings | Throttling kicked in mid-run | The Octokit throttling plugin retries automatically. If the run still completes, no action needed. If it fails, re-run later. |
| Per-repo entry shows `error` field and grey chip | One repo's CI fetch failed | Check the repo on github.com. If transient, next run will recover. |
| Pages deploy step fails with permission error | Pages source is set to "Deploy from a branch" instead of "GitHub Actions" | Switch under **Settings -> Pages** to source "GitHub Actions". |
| Site is stale but workflow is green | Browser or CDN cache | Hard refresh. The artifact deploy is atomic so the site updates the moment the deploy step finishes. |
| `npm audit` step fails on CI | New high-severity advisory | Either bump the offending dependency or accept and document. Do not paper over with `continue-on-error`. |

## Rolling back a bad data.json

The site is now deployed via Pages artifact, not via committed `data.json` files. To roll back:

1. Find the previous successful run under **Actions -> Refresh dashboard data**.
2. Click the run, then **Re-run all jobs**. This re-fetches and redeploys.
3. If the bad state is caused by upstream data (for example a real Tier 0 failure), there is nothing to roll back. Fix upstream.
4. If you need to pin to a known-good snapshot you must check out the commit at which the fetcher last produced good output and run `workflow_dispatch` against that ref. The workflow accepts manual dispatch from any ref.

If for any reason `data.json` files are committed to git (legacy or manual), `git revert` the offending commit and trigger a manual refresh to redeploy.
