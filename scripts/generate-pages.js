#!/usr/bin/env node
/**
 * generate-pages.js
 *
 * Materializes the dashboard HTML from the shared ORG_TEMPLATE.
 * The first org in GH_ORGS is the "primary" and is written to docs/index.html
 * (served at the site root, e.g. dashboard.pyvista.org/). Additional orgs are
 * written to docs/orgs/<org>/index.html (served at /orgs/<org>/).
 *
 * Pair with fetch-data.js, which uses the same primary/secondary split for
 * data.json placement.
 *
 * Usage:
 *   GH_ORGS=pyvista,acme node scripts/generate-pages.js
 *
 * GH_ORGS defaults to "pyvista" when unset.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

let orgs = (process.env.GH_ORGS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (orgs.length === 0) {
  console.log("Notice: GH_ORGS not set, defaulting to 'pyvista'.");
  orgs = ["pyvista"];
}

const docsDir = join(ROOT, "docs");
const templatePath = join(docsDir, "orgs", "ORG_TEMPLATE", "index.html");

if (!existsSync(templatePath)) {
  console.error(`Template not found: ${templatePath}`);
  process.exit(1);
}

const template = readFileSync(templatePath, "utf8");

for (let i = 0; i < orgs.length; i++) {
  const org = orgs[i];
  if (i === 0) {
    const outFile = join(docsDir, "index.html");
    writeFileSync(outFile, template);
    console.log(`Generated: ${outFile} (primary: ${org})`);
  } else {
    const orgDir = join(docsDir, "orgs", org);
    const outFile = join(orgDir, "index.html");
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(outFile, template);
    console.log(`Generated: ${outFile}`);
  }
}

console.log("Pages generated.");
