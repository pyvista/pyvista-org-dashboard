# Architecture : pyvista-org-dashboard

Static GitHub-Pages dashboard for the PyVista org. GitHub Actions runs a Node fetcher daily, writes JSON snapshots into `docs/orgs/<org>/`, GitHub Pages serves the static HTML that reads those snapshots in the browser.

## Auth : GitHub App (no PATs)

PyVista org policy disallows personal access tokens. The dashboard uses a dedicated GitHub App registered on the `pyvista` org.

- **App permissions (read-only):** Metadata, Issues, Pull requests, Contents, Actions.
- **Token minting:** `actions/create-github-app-token@v3` in the workflow. Output token is set as `GH_TOKEN` env var for the fetch script.
- **Repo secrets/vars:**
  - secret `PYVISTA_DASHBOARD_APP_PRIVATE_KEY` : App's PEM
  - variable `PYVISTA_DASHBOARD_APP_ID` : App's numeric id
  - variable `GH_ORGS` : defaults to `pyvista`; comma-separated for multi-org
- **Code-side contract:** unchanged : still reads `process.env.GH_TOKEN`. The fetcher is auth-mechanism agnostic.

## Repo tiering

Repos are classified into four tiers via `config/orgs/<org>.json` (default config shipped for `pyvista`):

- **Tier 0 : Critical infrastructure.** Always rendered first, always expanded, alerts on red CI. PyVista members: `pyvista`, `admin`, `.github`, `setup-headless-display-action`, `arc-runners`, `data`, `pyvista-docs-dynamic`.
- **Tier 1 : Core ecosystem.** Active maintained packages (`pytest-pyvista`, `pyvistaqt`, `pyvista-xarray`, `pymeshfix`, `pyacvd`, `tetgen`, `pyiges`, `fast-simplification`, `omfvista`, `scikit-gmsh`, `pytetwild`, `pyvista-stl`, `pyvista-miniply`, `pyvista-manifold`, `pyvista-trimesh`, `trame-pyvista`, `vtk-xref`, `vtkbool`, `npt-promote`, `pyvista-zstd`, `pyvista-doc-translations`, `pyvista-tutorial`, `pyvista-tutorial-translations`).
- **Tier 2 : Companion / demos / experimental.** Rendered collapsed.
- **Tier 3 : Archived / inactive.** Computed automatically (`archived === true`). Hidden by default.

Repos not listed in the config default to Tier 1 if not archived, Tier 3 if archived.

## Watched workflows (CI precedence)

Tier 0 repos can declare specific watched workflows in the config. Default branches' latest run status for each watched workflow is fetched explicitly. PyVista's watched set on `pyvista/pyvista`:

- `Unit Testing and Deployment` (`testing-and-deployment.yml`)
- `Integration Tests` (`integration-tests.yml`)
- `Build Documentation` (`docs.yml`)

For Tier 0 repos without a declared watch list (e.g. `admin`, `.github`), all workflows on the default branch are fetched and the worst non-success conclusion drives the alert.

## data.json schema (extended)

```jsonc
{
  "org": "pyvista",
  "fetched_at": "2026-05-09T06:00:00Z",
  "tiers": {
    "0": { "label": "Critical infrastructure", "repos": ["..."] },
    "1": { "label": "Core ecosystem", "repos": ["..."] },
    "2": { "label": "Companion", "repos": ["..."] },
    "3": { "label": "Archived", "repos": ["..."] }
  },
  "unclassified_repos": ["..."],         // non-archived repos not listed in any tier (defaulted to Tier 1)
  "fetch_errors": [                      // per-call errors collected from enrichment / watched-run fetches
    { "repo": "...", "endpoint": "workflow .github/workflows/x.yml", "message": "..." }
  ],
  "critical_alerts": [
    { "repo": "pyvista", "workflow": "Integration Tests", "conclusion": "failure",
      "url": "...", "updated_at": "..." }
  ],
  "repos": [
    {
      "name": "pyvista",
      "tier": 0,
      "url": "...",
      "description": "...",
      "archived": false,
      "fork": false,
      "private": false,
      "default_branch": "main",
      "open_issues": 123,
      "open_prs": 45,
      "pushed_at": "...",
      "created_at": "...",
      "language": "Python",
      "stars": 3000,
      "release": { "tag": "...", "published_at": "...", "url": "..." },
      "ci": {
        "worst_conclusion": "failure",        // "success" | "failure" | "cancelled" | "skipped" | "in_progress" | "none"
        "watched": [
          { "name": "Integration Tests", "path": ".github/workflows/integration-tests.yml",
            "conclusion": "failure", "status": "completed", "html_url": "...",
            "run_number": 1234, "updated_at": "...", "head_sha": "...", "head_branch": "main" }
        ]
      }
    }
  ]
}
```

## Fetcher

`scripts/fetch-data.js` : uses `octokit` (paginate + throttling plugins). One pass per org:

1. List org repos (paginated).
2. For each repo, in parallel (concurrency = 6):
   - issues vs PRs split (Search API or `pulls?state=open` count + `open_issues_count` subtraction, current behavior).
   - latest release.
   - For Tier 0 repos: fetch latest workflow run on default branch for each watched workflow (or all workflows if none declared).
3. Build alerts list from Tier 0 worst conclusions.
4. Write `docs/orgs/<org>/data.json`.

Error handling: per-repo errors logged but never fail the run; entries get `ci.worst_conclusion: "none"` with an `error` field. A run-level top-banner surfaces partial failures.

## Frontend

`docs/orgs/ORG_TEMPLATE/index.html` : single static HTML, no build step, plain JS. Adds:

1. **Critical alert banner** at the top : red box listing every Tier 0 failure. If empty, hidden.
2. **Tier 0 section** : always expanded card grid (one card per repo) with watched workflows shown inline as colored chips (green/red/grey).
3. **Tier 1 section** : table (current behavior), grouped under "Core ecosystem" heading.
4. **Tier 2 section** : collapsed by default, click to expand.
5. **Tier 3 section** : collapsed and de-emphasized.
6. CI status column added to the table.
7. Filters retained.

## Performance / rate limits

GitHub App installation token = 5,000 req/hr (scales with installation size). Rough budget for `pyvista`:

- ~50 repos × (1 list + 1 release + 1 PR count + ~3 workflow runs avg) ≈ 250 calls per run. Well under cap.

## Test strategy

- Unit tests for tier classification + alert builder using `node --test` and small fixture JSON.
- Schema sanity: a smoke test that runs the fetcher in dry-run mode against a minimal mocked octokit (or with `nock`) and asserts the output JSON matches a JSON schema.
- Lint: Biome (single binary, fast, formatter + linter). Also runs on HTML/CSS via Prettier override if Biome doesn't cover it (Biome v2+ does CSS).
- CI: lint + test run on every push/PR via a new `ci.yml` workflow.

## Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| App token expires mid-run | Octokit 401 | Token is fresh per workflow run; not a real risk |
| Org repo enumeration fails | Action fails | Re-run; humans alerted by Actions failure email |
| One repo's CI fetch fails | Per-repo `error` field + `ci.worst_conclusion: "none"` | Logged; banner surfaces partial-data state |
| Branch protection blocks bot push | `git push` fails | App must have Contents: write on the dashboard repo, or use a deploy workflow |
| Schedule drift | None | Daily cron suffices; manual `workflow_dispatch` available |

## Non-goals

- Private repo support (PyVista is fully public).
- Real-time updates (daily snapshot is fine).
- Per-PR or per-branch CI matrices (default branch only).
- Multi-tenant SaaS : this is a single-deployment dashboard.
