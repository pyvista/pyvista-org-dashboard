#!/usr/bin/env node
/**
 * generate-pages.js
 *
 * Copies the shared ORG_TEMPLATE/index.html into each org's folder.
 * Runs after fetch-data.js so every docs/orgs/<org>/ has both
 * data.json (from fetch) and index.html (from this script).
 *
 * Usage:
 *   GH_ORGS=acme,widgets node scripts/generate-pages.js
 */

const fs   = require("fs");
const path = require("path");

const ORGS = (process.env.GH_ORGS || "").split(",").map(s => s.trim()).filter(Boolean);

if (ORGS.length === 0) {
  console.error("Error: GH_ORGS environment variable is required.");
  process.exit(1);
}

const docsDir    = path.join(__dirname, "..", "docs");
const templatePath = path.join(docsDir, "orgs", "ORG_TEMPLATE", "index.html");

if (!fs.existsSync(templatePath)) {
  console.error(`Template not found: ${templatePath}`);
  process.exit(1);
}

const template = fs.readFileSync(templatePath, "utf8");

for (const org of ORGS) {
  const orgDir  = path.join(docsDir, "orgs", org);
  const outFile = path.join(orgDir, "index.html");
  fs.mkdirSync(orgDir, { recursive: true });
  fs.writeFileSync(outFile, template);
  console.log(`Generated: ${outFile}`);
}

console.log("Pages generated.");
