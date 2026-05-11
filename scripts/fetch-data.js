#!/usr/bin/env node

/**
 * fetch-data.js
 *
 * Fetches repo + CI data for one or more GitHub orgs and writes each to:
 *   docs/orgs/<orgname>/data.json
 *
 * Usage:
 *   GH_TOKEN=ghp_xxx GH_ORGS=pyvista,acme node scripts/fetch-data.js
 *
 * Env vars:
 *   GH_TOKEN - Required. GitHub App installation token (or PAT).
 *   GH_ORGS  - Optional. Comma-separated org slugs. Defaults to "pyvista".
 *
 * See ARCHITECTURE.md for the data.json schema and tiering rules.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "octokit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const CONCURRENCY = 6;
const DESCRIPTION_MAX_LEN = 350;

// Conclusion priority: lower index = worse.
export const CONCLUSION_PRIORITY = [
  "fetch_error",
  "missing",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "in_progress",
  "queued",
  "skipped",
  "success",
  "none",
];

const ALERTABLE_CONCLUSIONS = new Set([
  "fetch_error",
  "missing",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);

// ───────────────────────────── pure functions (exported) ─────────────────────

export function classifyTier(repo, config) {
  if (repo.archived) return 4;
  const tiers = config?.tiers || {};
  if ((tiers["0"] || []).includes(repo.name)) return 0;
  if ((tiers["1"] || []).includes(repo.name)) return 1;
  if ((tiers["2"] || []).includes(repo.name)) return 2;
  if ((tiers["3"] || []).includes(repo.name)) return 3;
  return 3;
}

export function worstConclusion(runs) {
  if (!runs || runs.length === 0) return "none";
  let worstIdx = CONCLUSION_PRIORITY.indexOf("none");
  for (const r of runs) {
    let key;
    if (typeof r === "string") {
      key = r;
    } else if (r && typeof r === "object") {
      key = r.conclusion || r.status || "none";
    } else {
      key = "none";
    }
    let idx = CONCLUSION_PRIORITY.indexOf(key);
    if (idx === -1) idx = CONCLUSION_PRIORITY.indexOf("none");
    if (idx < worstIdx) worstIdx = idx;
  }
  return CONCLUSION_PRIORITY[worstIdx];
}

export function buildAlerts(repos) {
  const alerts = [];
  for (const repo of repos || []) {
    if (repo.tier !== 0) continue;
    const ci = repo.ci || {};
    if (ci.worst_conclusion === "fetch_error" && (!ci.watched || ci.watched.length === 0)) {
      alerts.push({
        repo: repo.name,
        workflow: "(fetch error)",
        conclusion: "fetch_error",
        url: null,
        updated_at: null,
        error: repo.error || ci.error || null,
      });
      continue;
    }
    const watched = ci.watched || [];
    for (const run of watched) {
      if (!run?.conclusion) continue;
      if (!ALERTABLE_CONCLUSIONS.has(run.conclusion)) continue;
      const alert = {
        repo: repo.name,
        workflow: run.name || run.path || "(unknown)",
        conclusion: run.conclusion,
        url: run.html_url || null,
        updated_at: run.updated_at || null,
      };
      if (run.conclusion === "fetch_error") {
        alert.error = run.error || null;
      }
      alerts.push(alert);
    }
  }
  return alerts;
}

// ───────────────────────────── octokit setup ─────────────────────────────────

function makeOctokit(token) {
  const ThrottledRetryOctokit = Octokit.plugin(throttling, retry);
  return new ThrottledRetryOctokit({
    auth: token,
    userAgent: "pyvista-org-dashboard/1.0",
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        console.warn(
          `Rate limit hit on ${options.method} ${options.url}; retrying in ${retryAfter}s (attempt ${retryCount + 1})`,
        );
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        console.warn(
          `Secondary rate limit on ${options.method} ${options.url}; retrying in ${retryAfter}s (attempt ${retryCount + 1})`,
        );
        return retryCount < 2;
      },
    },
  });
}

// ───────────────────────────── concurrency limiter ───────────────────────────

export async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  if (tasks.length === 0) return results;
  const effectiveLimit = Math.max(1, Math.min(limit, tasks.length));
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: effectiveLimit }, worker));
  return results;
}

// ───────────────────────────── per-repo fetch helpers ────────────────────────

export async function fetchPRCount(octokit, org, repoName) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: org,
      repo: repoName,
      state: "open",
      per_page: 1,
    });
    const link = res.headers?.link || "";
    const match = link.match(/[?&]page=(\d+)>; rel="last"/);
    if (match) return Number.parseInt(match[1], 10);
    return Array.isArray(res.data) ? res.data.length : 0;
  } catch (e) {
    console.warn(`[${org}/${repoName}] fetchPRCount: ${e.message}`);
    return 0;
  }
}

async function fetchLatestRelease(octokit, org, repoName) {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/releases/latest", {
      owner: org,
      repo: repoName,
    });
    if (!data) return null;
    return {
      tag: data.tag_name || null,
      published_at: data.published_at || null,
      url: data.html_url || null,
    };
  } catch (e) {
    console.warn(`[${org}/${repoName}] fetchLatestRelease: ${e.message}`);
    return null;
  }
}

async function fetchLatestRunForWorkflow(octokit, org, repoName, workflowId, branch) {
  try {
    const endpoint = "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs";
    const baseParams = { owner: org, repo: repoName, workflow_id: workflowId, per_page: 1 };
    let { data } = await octokit.request(endpoint, { ...baseParams, branch });
    let run = data.workflow_runs?.[0];
    if (!run) {
      ({ data } = await octokit.request(endpoint, baseParams));
      run = data.workflow_runs?.[0];
    }
    if (!run) return null;
    return {
      conclusion: run.conclusion || null,
      status: run.status || null,
      html_url: run.html_url || null,
      run_number: run.run_number || null,
      updated_at: run.updated_at || null,
      head_sha: run.head_sha || null,
      head_branch: run.head_branch || null,
    };
  } catch (e) {
    console.warn(`[${org}/${repoName}] fetchLatestRunForWorkflow(${workflowId}): ${e.message}`);
    return { __error: e.message || String(e) };
  }
}

export async function fetchWatchedRuns(octokit, org, repoName, defaultBranch, watchedPaths, opts) {
  const isTier0 = !!opts?.isTier0;
  let workflows;
  try {
    workflows = await octokit.paginate("GET /repos/{owner}/{repo}/actions/workflows", {
      owner: org,
      repo: repoName,
      per_page: 100,
    });
  } catch (e) {
    console.warn(`[${org}/${repoName}] fetchWatchedRuns list workflows: ${e.message}`);
    if (isTier0) {
      throw e;
    }
    return [];
  }

  const wfList = Array.isArray(workflows) ? workflows : workflows?.workflows || [];
  const active = wfList.filter((w) => w && w.state === "active");

  let selected;
  if (watchedPaths && watchedPaths.length > 0) {
    selected = watchedPaths.map((path) => {
      const wf = active.find((w) => w.path === path);
      if (!wf) {
        console.warn(`[${org}/${repoName}] watched workflow path not found: ${path}`);
      }
      return { path, wf };
    });
  } else {
    selected = active.map((w) => ({ path: w.path, wf: w }));
  }

  const results = [];
  for (const { path, wf } of selected) {
    if (!wf) {
      results.push({
        name: null,
        path,
        conclusion: isTier0 ? "missing" : "none",
        status: null,
        html_url: null,
        run_number: null,
        updated_at: null,
        head_sha: null,
        head_branch: null,
        missing: true,
      });
      continue;
    }
    const run = await fetchLatestRunForWorkflow(octokit, org, repoName, wf.id, defaultBranch);
    if (run?.__error) {
      results.push({
        name: wf.name,
        path: wf.path || path || null,
        conclusion: isTier0 ? "fetch_error" : "none",
        status: null,
        html_url: null,
        run_number: null,
        updated_at: null,
        head_sha: null,
        head_branch: null,
        error: run.__error,
      });
      continue;
    }
    results.push({
      name: wf.name,
      path: wf.path || path || null,
      conclusion: run
        ? run.conclusion || (isTier0 ? "missing" : "none")
        : isTier0
          ? "missing"
          : "none",
      status: run ? run.status : null,
      html_url: run ? run.html_url : null,
      run_number: run ? run.run_number : null,
      updated_at: run ? run.updated_at : null,
      head_sha: run ? run.head_sha : null,
      head_branch: run ? run.head_branch : null,
    });
  }
  return results;
}

// ───────────────────────────── per-repo enrichment ───────────────────────────

function truncateDescription(d) {
  if (!d) return null;
  if (d.length <= DESCRIPTION_MAX_LEN) return d;
  return d.slice(0, DESCRIPTION_MAX_LEN);
}

async function enrichRepo(octokit, org, repo, config) {
  const tier = classifyTier(repo, config);
  const base = {
    name: repo.name,
    tier,
    url: repo.html_url,
    description: truncateDescription(repo.description),
    archived: !!repo.archived,
    fork: !!repo.fork,
    private: !!repo.private,
    default_branch: repo.default_branch || "main",
    open_issues: 0,
    open_prs: 0,
    pushed_at: repo.pushed_at,
    created_at: repo.created_at,
    language: repo.language || null,
    stars: repo.stargazers_count || 0,
    release: null,
    ci: { worst_conclusion: "none", watched: [] },
  };

  try {
    const [prCount, release] = await Promise.all([
      fetchPRCount(octokit, org, repo.name),
      fetchLatestRelease(octokit, org, repo.name),
    ]);
    base.open_prs = prCount;
    base.open_issues = Math.max(0, (repo.open_issues_count || 0) - prCount);
    base.release = release;

    if (tier === 0 && !repo.archived) {
      const watchedPaths = config?.watched_workflows?.[repo.name] || [];
      const runs = await fetchWatchedRuns(
        octokit,
        org,
        repo.name,
        repo.default_branch,
        watchedPaths,
        { isTier0: true },
      );
      base.ci.watched = runs;
      base.ci.worst_conclusion = worstConclusion(runs);
    }
  } catch (e) {
    const msg = e.message || String(e);
    console.error(`[${org}/${repo.name}] enrichment failed: ${msg}`);
    if (tier === 0 && !repo.archived) {
      base.ci = { worst_conclusion: "fetch_error", watched: [], error: msg };
    } else {
      base.ci = { worst_conclusion: "none", watched: [] };
    }
    base.error = msg;
  }

  return base;
}

// ───────────────────────────── org loader ────────────────────────────────────

export async function loadOrgConfig(org) {
  const path = join(ROOT, "config", "orgs", `${org}.json`);
  if (!existsSync(path)) {
    throw new Error(`No config/orgs/${org}.json found`);
  }
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

export async function fetchOrg(octokit, org, opts) {
  const config = opts?.config || (await loadOrgConfig(org));
  console.log(`\n[${org}] Listing repos…`);
  const repos = await octokit.paginate("GET /orgs/{org}/repos", {
    org,
    per_page: 100,
  });
  console.log(`[${org}] Found ${repos.length} repos. Enriching (concurrency=${CONCURRENCY})…`);

  const tasks = repos.map((r) => () => enrichRepo(octokit, org, r, config));
  const enriched = await runWithConcurrency(tasks, CONCURRENCY);

  const labels = config?.tier_labels || {};
  const tiers = {
    0: { label: labels["0"] || "Critical infrastructure", repos: [] },
    1: { label: labels["1"] || "Core packages", repos: [] },
    2: { label: labels["2"] || "Ecosystem extensions", repos: [] },
    3: { label: labels["3"] || "Companion", repos: [] },
    4: { label: labels["4"] || "Archived", repos: [] },
  };
  for (const r of enriched) {
    tiers[r.tier].repos.push(r.name);
  }

  // Repos defaulted to Tier 3 because they were not listed in any tier and not archived.
  const listed = new Set([
    ...(config?.tiers?.["0"] || []),
    ...(config?.tiers?.["1"] || []),
    ...(config?.tiers?.["2"] || []),
    ...(config?.tiers?.["3"] || []),
  ]);
  const unclassified_repos = enriched
    .filter((r) => !r.archived && !listed.has(r.name))
    .map((r) => r.name);

  const critical_alerts = buildAlerts(enriched);
  const fetch_errors = collectFetchErrors(enriched);

  return {
    org,
    fetched_at: new Date().toISOString(),
    tiers,
    unclassified_repos,
    fetch_errors,
    critical_alerts,
    repos: enriched,
  };
}

export function collectFetchErrors(repos) {
  const errors = [];
  for (const repo of repos || []) {
    if (repo.error) {
      errors.push({ repo: repo.name, endpoint: "enrichRepo", message: repo.error });
    }
    const watched = repo.ci?.watched || [];
    for (const run of watched) {
      if (run?.error) {
        errors.push({
          repo: repo.name,
          endpoint: run.path ? `workflow ${run.path}` : "workflow run",
          message: run.error,
        });
      }
    }
  }
  return errors;
}

async function writeOrgData(data, { primary } = { primary: false }) {
  const json = JSON.stringify(data, null, 2);
  if (primary) {
    const outFile = join(ROOT, "docs", "data.json");
    await writeFile(outFile, json);
    console.log(`[${data.org}] Wrote ${data.repos.length} repos -> ${outFile} (primary)`);
    return;
  }
  const outDir = join(ROOT, "docs", "orgs", data.org);
  const outFile = join(outDir, "data.json");
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, json);
  console.log(`[${data.org}] Wrote ${data.repos.length} repos -> ${outFile}`);
}

// ───────────────────────────── main ──────────────────────────────────────────

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.error("Error: GH_TOKEN environment variable is required.");
    process.exit(1);
  }

  let orgs = (process.env.GH_ORGS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (orgs.length === 0) {
    console.log("Notice: GH_ORGS not set, defaulting to 'pyvista'.");
    orgs = ["pyvista"];
  }

  console.log(`Fetching ${orgs.length} org(s): ${orgs.join(", ")}`);
  const octokit = makeOctokit(token);

  for (let i = 0; i < orgs.length; i++) {
    const org = orgs[i];
    try {
      const data = await fetchOrg(octokit, org);
      await writeOrgData(data, { primary: i === 0 });
    } catch (e) {
      console.error(`[${org}] ERROR: ${e.message}`);
    }
  }

  console.log("\nAll done.");
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isDirectInvocation) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
