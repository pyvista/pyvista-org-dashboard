#!/usr/bin/env node
/**
 * generate-pages.js
 *
 * Copies the shared ORG_TEMPLATE/index.html into each org's folder.
 * Runs after fetch-data.js so every docs/orgs/<org>/ has both
 * data.json (from fetch) and index.html (from this script).
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

for (const org of orgs) {
  const orgDir = join(docsDir, "orgs", org);
  const outFile = join(orgDir, "index.html");
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(outFile, template);
  console.log(`Generated: ${outFile}`);
}

console.log("Pages generated.");
