/**
 * Copy a preview build of jsPsych core into vendor/jspsych.
 *
 * The multiplayer API lives in jsPsych PR #3694, which isn't in a published
 * jsPsych release yet. The PR's preview bot publishes each build to the
 * `preview/pr-3694` branch of jspsych/jsPsych; this script copies one of
 * those builds so the root `jspsych` devDependency (file:vendor/jspsych) has
 * the real multiplayer module and its types.
 *
 * Remove vendor/ and point the devDependency back at npm once a jsPsych
 * release includes the multiplayer API.
 *
 * Usage: node scripts/vendor-jspsych-preview.mjs <preview-commit-sha>
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [, , sha] = process.argv;
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
  console.error("Usage: node scripts/vendor-jspsych-preview.mjs <full 40-character commit sha>");
  process.exit(1);
}

// Source maps and sources are left out to keep the vendored copy small
const FILES = [
  "package.json",
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.browser.js",
  "dist/index.browser.min.js",
  "css/jspsych.css",
];

const vendorDir = fileURLToPath(new URL("../vendor/jspsych/", import.meta.url));
const base = `https://raw.githubusercontent.com/jspsych/jsPsych/${sha}/packages/jspsych/`;

await rm(vendorDir, { recursive: true, force: true });

for (const file of FILES) {
  const response = await fetch(base + file);
  if (!response.ok) {
    console.error(`Failed to fetch ${file}: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  let contents = await response.text();

  if (file === "package.json") {
    const manifest = JSON.parse(contents);
    // The copy has no sources or build tooling, so drop what would try to use them
    delete manifest.scripts;
    delete manifest.source;
    delete manifest.devDependencies;
    manifest.files = ["dist", "css"];
    manifest.vendoredFrom = `jspsych/jsPsych@${sha} (preview build of PR #3694)`;
    contents = JSON.stringify(manifest, null, 2) + "\n";
  }

  const target = vendorDir + file;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  console.log(`vendor/jspsych/${file}`);
}

console.log(`\nVendored jsPsych preview ${sha}. Run npm install to relink it.`);
