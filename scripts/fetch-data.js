#!/usr/bin/env node
/**
 * fetch-data.js
 *
 * Fetches repo data for one or more GitHub orgs and writes each to:
 *   docs/orgs/<orgname>/data.json
 *
 * Usage:
 *   GH_TOKEN=ghp_xxx GH_ORGS=acme,widgets node scripts/fetch-data.js
 *
 * Required env vars:
 *   GH_ORGS  - Comma-separated org slugs, e.g. "acme,widgets,tools"
 *   GH_TOKEN - Personal access token with read:org + repo scope
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const TOKEN = process.env.GH_TOKEN;
const ORGS  = (process.env.GH_ORGS || "").split(",").map(s => s.trim()).filter(Boolean);

if (!TOKEN || ORGS.length === 0) {
  console.error("Error: GH_TOKEN and GH_ORGS environment variables are required.");
  console.error("  GH_ORGS should be comma-separated, e.g. \"acme,widgets\"");
  process.exit(1);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function ghGet(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path:     apiPath,
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
    const sep = basePath.includes("?") ? "&" : "?";
    const { data } = await ghGet(`${basePath}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results = results.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ─── PR count ─────────────────────────────────────────────────────────────────

async function fetchPRCount(org, repoName) {
  try {
    const { data, headers } = await ghGet(
      `/repos/${org}/${repoName}/pulls?state=open&per_page=1`
    );
    const link  = headers["link"] || "";
    const match = link.match(/[?&]page=(\d+)>; rel="last"/);
    if (match) return parseInt(match[1], 10);
    return Array.isArray(data) ? data.length : 0;
  } catch { return 0; }
}

// ─── Latest release ───────────────────────────────────────────────────────────

async function fetchLatestRelease(org, repoName) {
  try {
    const { data } = await ghGet(`/repos/${org}/${repoName}/releases/latest`);
    if (!data) return null;
    return {
      tag:          data.tag_name     || null,
      published_at: data.published_at || null,
      url:          data.html_url     || null,
    };
  } catch { return null; }
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

// ─── Fetch one org ────────────────────────────────────────────────────────────

async function fetchOrg(org) {
  console.log(`\n[${org}] Fetching repos…`);
  const repos = await fetchAllPages(`/orgs/${org}/repos`);
  console.log(`[${org}] Found ${repos.length} repos. Enriching…`);

  const tasks = repos.map(r => async () => {
    const [prCount, release] = await Promise.all([
      fetchPRCount(org, r.name),
      fetchLatestRelease(org, r.name),
    ]);
    return {
      name:        r.name,
      url:         r.html_url,
      description: r.description || null,
      archived:    r.archived,
      fork:        r.fork,
      private:     r.private,
      open_issues: Math.max(0, r.open_issues_count - prCount),
      open_prs:    prCount,
      pushed_at:   r.pushed_at,
      created_at:  r.created_at,
      language:    r.language || null,
      stars:       r.stargazers_count,
      release,
    };
  });

  const enriched = await runWithConcurrency(tasks, 6);
  console.log(`[${org}] Done.`);

  return {
    org,
    fetched_at: new Date().toISOString(),
    repos:      enriched,
  };
}

// ─── Write output ─────────────────────────────────────────────────────────────

function writeOrgData(data) {
  const outDir  = path.join(__dirname, "..", "docs", "orgs", data.org);
  const outFile = path.join(outDir, "data.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
  console.log(`[${data.org}] Wrote ${data.repos.length} repos → ${outFile}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching ${ORGS.length} org(s): ${ORGS.join(", ")}`);

  // Fetch orgs sequentially to stay well within rate limits
  for (const org of ORGS) {
    try {
      const data = await fetchOrg(org);
      writeOrgData(data);
    } catch (e) {
      console.error(`[${org}] ERROR: ${e.message}`);
      // Continue with remaining orgs rather than failing the whole run
    }
  }

  console.log("\nAll done.");
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
