import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAlerts,
  CONCLUSION_PRIORITY,
  classifyTier,
  fetchOrg,
  fetchPRCount,
  fetchWatchedRuns,
  runWithConcurrency,
  worstConclusion,
} from "../scripts/fetch-data.js";

const CONFIG = {
  tier_labels: {
    0: "Critical infrastructure",
    1: "Core packages",
    2: "Ecosystem extensions",
    3: "Companion",
    4: "Archived",
  },
  tiers: {
    0: ["pyvista", "admin"],
    1: ["pyvistaqt"],
    2: ["tetgen", "pymeshfix"],
    3: ["demo-thing"],
  },
  watched_workflows: {
    pyvista: [".github/workflows/integration-tests.yml"],
  },
};

// Helper: silence console.warn for a given async block, restore after.
async function quietWarn(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = orig;
  }
}

// ───────────────────────────── classifyTier ──────────────────────────────────

test("classifyTier: archived repos are always Tier 4", () => {
  assert.equal(classifyTier({ name: "pyvista", archived: true }, CONFIG), 4);
  assert.equal(classifyTier({ name: "anything", archived: true }, CONFIG), 4);
});

test("classifyTier: Tier 0 listed repo", () => {
  assert.equal(classifyTier({ name: "pyvista", archived: false }, CONFIG), 0);
  assert.equal(classifyTier({ name: "admin", archived: false }, CONFIG), 0);
});

test("classifyTier: Tier 1 listed repo", () => {
  assert.equal(classifyTier({ name: "pyvistaqt", archived: false }, CONFIG), 1);
});

test("classifyTier: Tier 2 listed repo", () => {
  assert.equal(classifyTier({ name: "tetgen", archived: false }, CONFIG), 2);
  assert.equal(classifyTier({ name: "pymeshfix", archived: false }, CONFIG), 2);
});

test("classifyTier: Tier 3 listed repo", () => {
  assert.equal(classifyTier({ name: "demo-thing", archived: false }, CONFIG), 3);
});

test("classifyTier: unlisted non-archived repo defaults to Tier 3", () => {
  assert.equal(classifyTier({ name: "some-new-repo", archived: false }, CONFIG), 3);
});

test("classifyTier: empty config defaults all non-archived to Tier 3", () => {
  assert.equal(classifyTier({ name: "x", archived: false }, {}), 3);
  assert.equal(classifyTier({ name: "x", archived: true }, {}), 4);
});

test("classifyTier: null/undefined config does not throw", () => {
  assert.equal(classifyTier({ name: "x", archived: false }, null), 3);
  assert.equal(classifyTier({ name: "x", archived: false }, undefined), 3);
  assert.equal(classifyTier({ name: "x", archived: true }, null), 4);
});

test("classifyTier: multi-tier-membership precedence: Tier 0 wins over Tier 1", () => {
  const cfg = { tiers: { 0: ["both"], 1: ["both"] } };
  assert.equal(classifyTier({ name: "both", archived: false }, cfg), 0);
});

test("classifyTier: archived overrides Tier 0", () => {
  const cfg = { tiers: { 0: ["pyvista"] } };
  assert.equal(classifyTier({ name: "pyvista", archived: true }, cfg), 4);
});

// ───────────────────────────── CONCLUSION_PRIORITY ───────────────────────────

test("CONCLUSION_PRIORITY: every adjacent pair, worse beats better", () => {
  for (let i = 0; i < CONCLUSION_PRIORITY.length - 1; i++) {
    const worse = CONCLUSION_PRIORITY[i];
    const better = CONCLUSION_PRIORITY[i + 1];
    assert.equal(worstConclusion([worse, better]), worse, `expected ${worse} to beat ${better}`);
    assert.equal(
      worstConclusion([better, worse]),
      worse,
      `expected ${worse} to beat ${better} (reversed input)`,
    );
  }
});

test("CONCLUSION_PRIORITY: shape — fetch_error worst, none best", () => {
  assert.equal(CONCLUSION_PRIORITY[0], "fetch_error");
  assert.equal(CONCLUSION_PRIORITY[1], "missing");
  assert.equal(CONCLUSION_PRIORITY[CONCLUSION_PRIORITY.length - 1], "none");
});

// ───────────────────────────── worstConclusion ───────────────────────────────

test("worstConclusion: empty array returns 'none'", () => {
  assert.equal(worstConclusion([]), "none");
  assert.equal(worstConclusion(undefined), "none");
});

test("worstConclusion: all success", () => {
  assert.equal(worstConclusion([{ conclusion: "success" }, { conclusion: "success" }]), "success");
});

test("worstConclusion: failure beats success", () => {
  assert.equal(worstConclusion([{ conclusion: "success" }, { conclusion: "failure" }]), "failure");
});

test("worstConclusion: respects priority order failure > cancelled > timed_out", () => {
  assert.equal(
    worstConclusion([
      { conclusion: "cancelled" },
      { conclusion: "timed_out" },
      { conclusion: "failure" },
    ]),
    "failure",
  );
  assert.equal(
    worstConclusion([{ conclusion: "cancelled" }, { conclusion: "timed_out" }]),
    "cancelled",
  );
});

test("worstConclusion: in_progress run normalizes via status when conclusion is null", () => {
  assert.equal(
    worstConclusion([{ conclusion: null, status: "in_progress" }, { conclusion: "success" }]),
    "in_progress",
  );
});

test("worstConclusion: skipped beats success in priority", () => {
  assert.equal(worstConclusion([{ conclusion: "skipped" }, { conclusion: "success" }]), "skipped");
});

test("worstConclusion: accepts strings", () => {
  assert.equal(worstConclusion(["success", "failure"]), "failure");
});

test("worstConclusion: unknown conclusion is treated as 'none'", () => {
  assert.equal(worstConclusion([{ conclusion: "weird-thing" }]), "none");
});

test("worstConclusion: mixed string and object inputs", () => {
  assert.equal(
    worstConclusion(["success", { conclusion: "failure" }, { conclusion: "skipped" }]),
    "failure",
  );
  assert.equal(worstConclusion([{ conclusion: "success" }, "missing"]), "missing");
});

test("worstConclusion: non-object/non-string entries normalize to 'none'", () => {
  assert.equal(worstConclusion([null, undefined, 42, true]), "none");
  assert.equal(worstConclusion([null, "failure"]), "failure");
});

test("worstConclusion: case sensitivity (FAILURE != failure)", () => {
  assert.equal(worstConclusion([{ conclusion: "FAILURE" }]), "none");
  assert.equal(worstConclusion(["FAILURE", "success"]), "success");
});

test("worstConclusion: fetch_error is worst", () => {
  assert.equal(worstConclusion(["failure", "fetch_error"]), "fetch_error");
});

test("worstConclusion: missing beats failure", () => {
  assert.equal(worstConclusion(["failure", "missing"]), "missing");
});

// ───────────────────────────── buildAlerts ───────────────────────────────────

test("buildAlerts: emits no alerts when nothing is failing", () => {
  const alerts = buildAlerts([
    {
      name: "pyvista",
      tier: 0,
      ci: { watched: [{ name: "X", conclusion: "success", html_url: "u", updated_at: "t" }] },
    },
  ]);
  assert.deepEqual(alerts, []);
});

test("buildAlerts: emits alert for failing Tier 0 watched run", () => {
  const alerts = buildAlerts([
    {
      name: "pyvista",
      tier: 0,
      ci: {
        watched: [
          { name: "Integration Tests", conclusion: "failure", html_url: "U", updated_at: "T" },
          { name: "Other", conclusion: "success", html_url: "u2", updated_at: "t2" },
        ],
      },
    },
  ]);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    repo: "pyvista",
    workflow: "Integration Tests",
    conclusion: "failure",
    url: "U",
    updated_at: "T",
  });
});

test("buildAlerts: emits alerts for cancelled and timed_out as well", () => {
  const alerts = buildAlerts([
    {
      name: "admin",
      tier: 0,
      ci: {
        watched: [
          { name: "A", conclusion: "cancelled", html_url: "ua", updated_at: "ta" },
          { name: "B", conclusion: "timed_out", html_url: "ub", updated_at: "tb" },
          { name: "C", conclusion: "skipped", html_url: "uc", updated_at: "tc" },
        ],
      },
    },
  ]);
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    alerts.map((a) => a.workflow),
    ["A", "B"],
  );
});

test("buildAlerts: ignores Tier 1+ failures", () => {
  const alerts = buildAlerts([
    {
      name: "pyvistaqt",
      tier: 1,
      ci: { watched: [{ name: "Tests", conclusion: "failure", html_url: "u", updated_at: "t" }] },
    },
    {
      name: "old-thing",
      tier: 4,
      ci: { watched: [{ name: "Tests", conclusion: "failure", html_url: "u", updated_at: "t" }] },
    },
  ]);
  assert.deepEqual(alerts, []);
});

test("buildAlerts: handles repos without ci.watched", () => {
  const alerts = buildAlerts([
    { name: "pyvista", tier: 0 },
    { name: "admin", tier: 0, ci: {} },
  ]);
  assert.deepEqual(alerts, []);
});

test("buildAlerts: handles empty input", () => {
  assert.deepEqual(buildAlerts([]), []);
  assert.deepEqual(buildAlerts(undefined), []);
});

test("buildAlerts: preserves repo and watched-run insertion order", () => {
  const alerts = buildAlerts([
    {
      name: "first",
      tier: 0,
      ci: {
        watched: [
          { name: "wf1", conclusion: "failure", html_url: "u1", updated_at: "t1" },
          { name: "wf2", conclusion: "cancelled", html_url: "u2", updated_at: "t2" },
        ],
      },
    },
    {
      name: "second",
      tier: 0,
      ci: {
        watched: [{ name: "wf3", conclusion: "timed_out", html_url: "u3", updated_at: "t3" }],
      },
    },
  ]);
  assert.deepEqual(
    alerts.map((a) => `${a.repo}:${a.workflow}`),
    ["first:wf1", "first:wf2", "second:wf3"],
  );
});

test("buildAlerts: null/undefined conclusion does not alert", () => {
  const alerts = buildAlerts([
    {
      name: "pyvista",
      tier: 0,
      ci: {
        watched: [
          { name: "wf1", conclusion: null, html_url: "u1", updated_at: "t1" },
          { name: "wf2", conclusion: undefined, html_url: "u2", updated_at: "t2" },
        ],
      },
    },
  ]);
  assert.deepEqual(alerts, []);
});

test("buildAlerts: missing url/updated_at coerced to null", () => {
  const alerts = buildAlerts([
    {
      name: "pyvista",
      tier: 0,
      ci: { watched: [{ name: "wf", conclusion: "failure" }] },
    },
  ]);
  assert.equal(alerts[0].url, null);
  assert.equal(alerts[0].updated_at, null);
});

test("buildAlerts: includes fetch_error alerts (per-run)", () => {
  const alerts = buildAlerts([
    {
      name: "pyvista",
      tier: 0,
      ci: {
        watched: [
          {
            name: "Integration Tests",
            conclusion: "fetch_error",
            error: "boom",
            html_url: null,
            updated_at: null,
          },
        ],
      },
    },
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].conclusion, "fetch_error");
  assert.equal(alerts[0].error, "boom");
  assert.equal(alerts[0].workflow, "Integration Tests");
});

test("buildAlerts: includes fetch_error alerts (whole-repo, no watched)", () => {
  const alerts = buildAlerts([
    {
      name: "pyvista",
      tier: 0,
      error: "kaboom",
      ci: { worst_conclusion: "fetch_error", watched: [], error: "kaboom" },
    },
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].conclusion, "fetch_error");
  assert.equal(alerts[0].workflow, "(fetch error)");
  assert.equal(alerts[0].error, "kaboom");
});

test("buildAlerts: includes missing alerts", () => {
  const alerts = buildAlerts([
    {
      name: "pyvista",
      tier: 0,
      ci: {
        watched: [
          { name: null, path: ".github/workflows/foo.yml", conclusion: "missing", missing: true },
        ],
      },
    },
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].conclusion, "missing");
});

// ───────────────────────────── runWithConcurrency ────────────────────────────

test("runWithConcurrency: never exceeds limit (peak counter)", async () => {
  let inFlight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 30 }, () => async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return 1;
  });
  await runWithConcurrency(tasks, 4);
  assert.ok(peak <= 4, `peak ${peak} exceeded limit 4`);
  assert.ok(peak >= 1);
});

test("runWithConcurrency: preserves index ordering", async () => {
  const tasks = Array.from({ length: 20 }, (_, i) => async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 10));
    return i;
  });
  const results = await runWithConcurrency(tasks, 5);
  assert.deepEqual(
    results,
    Array.from({ length: 20 }, (_, i) => i),
  );
});

test("runWithConcurrency: empty input returns empty array", async () => {
  const results = await runWithConcurrency([], 4);
  assert.deepEqual(results, []);
});

// ───────────────────────────── fetchPRCount ──────────────────────────────────

function makeStubOctokit(handlers) {
  return {
    async paginate(route, params) {
      const h = handlers.paginate?.[route];
      if (!h) throw new Error(`stub: no paginate handler for ${route}`);
      return h(params);
    },
    async request(route, params) {
      const h = handlers.request?.[route];
      if (!h) throw new Error(`stub: no request handler for ${route}`);
      return h(params);
    },
  };
}

test("fetchPRCount: parses last-page from Link header", async () => {
  const stub = makeStubOctokit({
    request: {
      "GET /repos/{owner}/{repo}/pulls": async () => ({
        headers: {
          link: '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=42>; rel="last"',
        },
        data: [{}],
      }),
    },
  });
  const n = await fetchPRCount(stub, "org", "repo");
  assert.equal(n, 42);
});

test("fetchPRCount: falls back to data length when no Link header", async () => {
  const stub = makeStubOctokit({
    request: {
      "GET /repos/{owner}/{repo}/pulls": async () => ({
        headers: {},
        data: [{}, {}, {}],
      }),
    },
  });
  const n = await fetchPRCount(stub, "org", "repo");
  assert.equal(n, 3);
});

test("fetchPRCount: returns 0 on thrown error AND logs a warn", async () => {
  let warned = false;
  const orig = console.warn;
  console.warn = (msg) => {
    if (typeof msg === "string" && msg.includes("fetchPRCount")) warned = true;
  };
  try {
    const stub = makeStubOctokit({
      request: {
        "GET /repos/{owner}/{repo}/pulls": async () => {
          throw new Error("boom");
        },
      },
    });
    const n = await fetchPRCount(stub, "org", "repo");
    assert.equal(n, 0);
    assert.ok(warned, "expected console.warn to be called");
  } finally {
    console.warn = orig;
  }
});

// ───────────────────────────── fetchWatchedRuns ──────────────────────────────

test("fetchWatchedRuns: matches by path, not name", async () => {
  const stub = makeStubOctokit({
    paginate: {
      "GET /repos/{owner}/{repo}/actions/workflows": async () => [
        {
          id: 1,
          name: "Some Old Display Name",
          path: ".github/workflows/integration-tests.yml",
          state: "active",
        },
      ],
    },
    request: {
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": async () => ({
        data: {
          workflow_runs: [
            {
              conclusion: "success",
              status: "completed",
              html_url: "U",
              run_number: 1,
              updated_at: "T",
              head_sha: "S",
              head_branch: "main",
            },
          ],
        },
      }),
    },
  });
  const runs = await fetchWatchedRuns(
    stub,
    "org",
    "repo",
    "main",
    [".github/workflows/integration-tests.yml"],
    { isTier0: true },
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].name, "Some Old Display Name");
  assert.equal(runs[0].path, ".github/workflows/integration-tests.yml");
  assert.equal(runs[0].conclusion, "success");
});

test("fetchWatchedRuns: declared path missing yields conclusion='missing' for Tier 0", async () => {
  const stub = makeStubOctokit({
    paginate: {
      "GET /repos/{owner}/{repo}/actions/workflows": async () => [
        { id: 1, name: "Other", path: ".github/workflows/other.yml", state: "active" },
      ],
    },
  });
  const runs = await quietWarn(() =>
    fetchWatchedRuns(stub, "org", "repo", "main", [".github/workflows/integration-tests.yml"], {
      isTier0: true,
    }),
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, "missing");
  assert.equal(runs[0].missing, true);
  assert.equal(runs[0].path, ".github/workflows/integration-tests.yml");
});

test("fetchWatchedRuns: ignores non-active workflows", async () => {
  const stub = makeStubOctokit({
    paginate: {
      "GET /repos/{owner}/{repo}/actions/workflows": async () => [
        {
          id: 1,
          name: "X",
          path: ".github/workflows/x.yml",
          state: "disabled_manually",
        },
      ],
    },
  });
  const runs = await quietWarn(() =>
    fetchWatchedRuns(stub, "org", "repo", "main", [".github/workflows/x.yml"], { isTier0: true }),
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, "missing");
});

test("fetchWatchedRuns: per-run fetch error surfaces conclusion='fetch_error' for Tier 0", async () => {
  const stub = makeStubOctokit({
    paginate: {
      "GET /repos/{owner}/{repo}/actions/workflows": async () => [
        {
          id: 1,
          name: "Integration Tests",
          path: ".github/workflows/integration-tests.yml",
          state: "active",
        },
      ],
    },
    request: {
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": async () => {
        throw new Error("network fail");
      },
    },
  });
  const runs = await quietWarn(() =>
    fetchWatchedRuns(stub, "org", "repo", "main", [".github/workflows/integration-tests.yml"], {
      isTier0: true,
    }),
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, "fetch_error");
  assert.equal(runs[0].error, "network fail");
});

// ───────────────────────────── fetchOrg smoke test ───────────────────────────

test("fetchOrg: smoke test — top-level shape and Tier 0 alerting on fetch_error", async () => {
  const config = {
    tier_labels: { 0: "Critical", 1: "Core", 2: "Companion", 3: "Archived" },
    tiers: { 0: ["critical-repo"], 1: ["normal-repo"], 2: [] },
    watched_workflows: {
      "critical-repo": [".github/workflows/ci.yml"],
    },
  };

  const stub = makeStubOctokit({
    paginate: {
      "GET /orgs/{org}/repos": async () => [
        {
          name: "critical-repo",
          html_url: "https://example/critical",
          description: "x",
          archived: false,
          fork: false,
          private: false,
          default_branch: "main",
          open_issues_count: 5,
          pushed_at: "2026-01-01T00:00:00Z",
          created_at: "2024-01-01T00:00:00Z",
          language: "Python",
          stargazers_count: 100,
        },
        {
          name: "normal-repo",
          html_url: "https://example/normal",
          description: "y",
          archived: false,
          fork: false,
          private: false,
          default_branch: "main",
          open_issues_count: 0,
          pushed_at: "2026-01-01T00:00:00Z",
          created_at: "2024-01-01T00:00:00Z",
          language: "Python",
          stargazers_count: 0,
        },
        {
          name: "extra-repo",
          html_url: "https://example/extra",
          description: null,
          archived: false,
          fork: false,
          private: false,
          default_branch: "main",
          open_issues_count: 0,
          pushed_at: "2026-01-01T00:00:00Z",
          created_at: "2024-01-01T00:00:00Z",
          language: null,
          stargazers_count: 0,
        },
      ],
      "GET /repos/{owner}/{repo}/actions/workflows": async () => {
        // Make Tier 0 workflow listing fail to trigger fetch_error.
        throw new Error("workflows endpoint exploded");
      },
    },
    request: {
      "GET /repos/{owner}/{repo}/pulls": async () => ({ headers: {}, data: [] }),
      "GET /repos/{owner}/{repo}/releases/latest": async () => {
        throw new Error("no release");
      },
    },
  });

  const data = await quietWarn(() => fetchOrg(stub, "myorg", { config }));

  assert.equal(data.org, "myorg");
  assert.ok(typeof data.fetched_at === "string");
  assert.ok(data.tiers["0"]);
  assert.deepEqual(data.tiers["0"].repos, ["critical-repo"]);
  assert.deepEqual(data.tiers["1"].repos, ["normal-repo"]);
  assert.deepEqual(data.tiers["3"].repos, ["extra-repo"]);
  assert.deepEqual(data.unclassified_repos, ["extra-repo"]);
  assert.equal(data.repos.length, 3);

  const critical = data.repos.find((r) => r.name === "critical-repo");
  assert.equal(critical.tier, 0);
  assert.equal(critical.ci.worst_conclusion, "fetch_error");

  assert.ok(data.critical_alerts.length >= 1);
  const alert = data.critical_alerts.find((a) => a.repo === "critical-repo");
  assert.ok(alert, "expected critical-repo alert");
  assert.equal(alert.conclusion, "fetch_error");
});

test("fetchOrg: caps description at 350 chars", async () => {
  const longDesc = "a".repeat(500);
  const config = { tiers: { 0: [], 1: [], 2: [] }, watched_workflows: {} };
  const stub = makeStubOctokit({
    paginate: {
      "GET /orgs/{org}/repos": async () => [
        {
          name: "r",
          html_url: "u",
          description: longDesc,
          archived: false,
          fork: false,
          private: false,
          default_branch: "main",
          open_issues_count: 0,
          pushed_at: null,
          created_at: null,
          language: null,
          stargazers_count: 0,
        },
      ],
    },
    request: {
      "GET /repos/{owner}/{repo}/pulls": async () => ({ headers: {}, data: [] }),
      "GET /repos/{owner}/{repo}/releases/latest": async () => {
        throw new Error("none");
      },
    },
  });
  const data = await quietWarn(() => fetchOrg(stub, "o", { config }));
  assert.equal(data.repos[0].description.length, 350);
});
