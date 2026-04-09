# GitHub Org Dashboard

A static dashboard showing repo health across a GitHub org — open issues, PRs, activity, and releases. Hosted on **GitHub Pages**, refreshed **daily via GitHub Actions**.

## How it works

```
GitHub Actions (cron: daily)
  └── scripts/fetch-data.js   ← uses GH_TOKEN secret (server-side only)
        └── calls GitHub API
        └── writes docs/data.json
        └── commits & pushes
              └── GitHub Pages serves docs/
                    └── index.html reads data.json (no token needed)
```

Your token never reaches the browser. Visitors load a static HTML file that reads a pre-built JSON snapshot.

---

## Setup (5 steps)

### 1. Create this repo

Push this project to a new GitHub repository under your account or org.

```bash
git init
git add .
git commit -m "initial commit"
gh repo create my-org-dashboard --public --source=. --push
# or push to an existing remote
```

### 2. Create a Personal Access Token

Go to [github.com/settings/tokens](https://github.com/settings/tokens) and create a **classic token** (or fine-grained) with these scopes:

| Scope | Why |
|---|---|
| `read:org` | List org repos |
| `repo` | Access private repos (omit if public-only org) |

Copy the token — you'll add it in step 3.

### 3. Add the secret and variable to your repo

In your repo on GitHub: **Settings → Secrets and variables → Actions**

| Type | Name | Value |
|---|---|---|
| **Secret** | `GH_TOKEN` | your PAT from step 2 |
| **Variable** | `GH_ORGS` | your org slug, e.g. `mycompany,org,org_2` |

Secrets are encrypted and never logged. Variables are plain text (the org name is not sensitive).

### 4. Enable GitHub Pages

In your repo: **Settings → Pages**

- Source: **Deploy from a branch**
- Branch: `main` (or `master`)
- Folder: `/docs`

Save. GitHub will give you a URL like `https://yourname.github.io/my-org-dashboard`.

### 5. Run the workflow for the first time

Go to **Actions → Refresh dashboard data → Run workflow**.

This generates `docs/data.json` and commits it. After that it runs automatically every day at 06:00 UTC.

---

## Local development

### Preview the dashboard

`data.json` must be fetched via HTTP (not `file://`). Use any local server:

```bash
npx serve docs
# or
python3 -m http.server 8080 --directory docs
```

Then open `http://localhost:8080`.

### Run the fetch script locally

```bash
GH_TOKEN=ghp_xxx GH_ORG=myorg node scripts/fetch-data.js
```

This writes `docs/data.json`. You can then preview it with the server above.

---

## Changing the refresh schedule

Edit `.github/workflows/refresh.yml` and change the cron expression:

```yaml
schedule:
  - cron: "0 6 * * *"   # daily at 06:00 UTC
  # - cron: "0 */6 * * *" # every 6 hours
  # - cron: "0 6 * * 1"   # weekly on Mondays
```

---

## Project structure

```
.
├── .github/
│   └── workflows/
│       └── refresh.yml       # scheduled Actions workflow
├── docs/                     # GitHub Pages root
│   ├── index.html            # dashboard UI (reads data.json)
│   └── data.json             # auto-generated, committed by Actions
├── scripts/
│   └── fetch-data.js         # Node.js data fetcher (runs in Actions)
└── README.md
```

---

## Customisation

- **Refresh time**: change the `cron` in `refresh.yml`
- **Data shape**: edit `fetch-data.js` — add fields like `topics`, `license`, `default_branch`, etc.
- **UI**: edit `docs/index.html` — it's plain HTML/CSS/JS with no build step
