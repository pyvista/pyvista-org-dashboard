#!/usr/bin/env node
/**
 * fetch-data.js
 *
 * Fetches repo data for a GitHub org and writes it to docs/data.json.
 * Runs in GitHub Actions with a secret PAT — the token never reaches the browser.
 *
 * Usage:
 *   GH_TOKEN=ghp_xxx GH_ORG=myorg node scripts/fetch-data.js
 *
 * Required env vars:
 *   GH_ORG   - GitHub organization slug (e.g. "vercel")
 *   GH_TOKEN - Personal access token with read:org + repo scope
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const ORG   = process.env.GH_ORG;
const TOKEN = process.env.GH_TOKEN;

if (!ORG || !TOKEN) {
  console.error("Error: GH_ORG and GH_TOKEN environment variables are required.");
  process.exit(1);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function ghGet(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: apiPath,
      headers: {
        "Authorization":        `Bearer ${TOKEN}`,
        "Accept":               "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent":           "gh-org-dashboard/1.0",
      },
    };

    https.get(options, (res) => {
      let body = "";
      res.on("data", chunk => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 404) return resolve({ data: null, headers: res.headers });
        if (res.statusCode >= 400) {
          const msg = (() => { try { return JSON.parse(body).message; } catch { return body; } })();
          return reject(new Error(`GitHub API ${res.statusCode}: ${msg} (${apiPath})`));
        }
        try {
          resolve({ data: JSON.parse(body), headers: res.headers });
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${apiPath}: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

// ─── Paginated fetch ──────────────────────────────────────────────────────────

async function fetchAllPages(basePath) {
  let results = [];
  let page    = 1;

  while (true) {
    const sep  = basePath.includes("?") ? "&" : "?";
    const { data } = await ghGet(`${basePath}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results = results.concat(data);
    if (data.length < 100) break;
    page++;
  }

  return results;
}

// ─── PR count (single request via Link header) ────────────────────────────────

async function fetchPRCount(repoName) {
  try {
    const { data, headers } = await ghGet(
      `/repos/${ORG}/${repoName}/pulls?state=open&per_page=1`
    );
    const link  = headers["link"] || "";
    const match = link.match(/[?&]page=(\d+)>; rel="last"/);
    if (match) return parseInt(match[1], 10);
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

// ─── Latest release ───────────────────────────────────────────────────────────

async function fetchLatestRelease(repoName) {
  try {
    const { data } = await ghGet(`/repos/${ORG}/${repoName}/releases/latest`);
    if (!data) return null;
    return {
      tag:          data.tag_name     || null,
      published_at: data.published_at || null,
      url:          data.html_url     || null,
    };
  } catch {
    return null;
  }
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let   index   = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching repos for org: ${ORG}`);

  const repos = await fetchAllPages(`/orgs/${ORG}/repos`);
  console.log(`Found ${repos.length} repos. Fetching PR counts and releases…`);

  // Enrich repos concurrently (limit 6 to be a good API citizen)
  const tasks = repos.map(r => async () => {
    const [prCount, release] = await Promise.all([
      fetchPRCount(r.name),
      fetchLatestRelease(r.name),
    ]);

    return {
      name:          r.name,
      url:           r.html_url,
      description:   r.description || null,
      archived:      r.archived,
      fork:          r.fork,
      private:       r.private,
      open_issues:   Math.max(0, r.open_issues_count - prCount),
      open_prs:      prCount,
      pushed_at:     r.pushed_at,
      created_at:    r.created_at,
      language:      r.language || null,
      stars:         r.stargazers_count,
      release,
    };
  });

  const enriched = await runWithConcurrency(tasks, 6);
  console.log("Done enriching repos.");

  const output = {
    org:        ORG,
    fetched_at: new Date().toISOString(),
    repos:      enriched,
  };

  const outDir  = path.join(__dirname, "..", "docs");
  const outFile = path.join(outDir, "data.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`Wrote ${enriched.length} repos to ${outFile}`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
