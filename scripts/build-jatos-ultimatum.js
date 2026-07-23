#!/usr/bin/env node
// Assembles a JATOS-ready study archive for the multiplayer ultimatum game.
// Copies built dist files into a flat folder, rewrites the example's <script src> paths,
// then zips the result for import into JATOS.
//
// Usage: npm run build:jatos:ultimatum    (or: node scripts/build-jatos-ultimatum.js)
// Output: dist/ultimatum-jatos.jzip
//
// NOTE: this copies pre-built dist files from packages/. If you changed any package source
// since the last build, run `npm run build` first or the jzip will contain stale output.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAssetsAndMetadata,
  multiplayerAsset,
  nodeModulesAsset,
  printPre3694Caveat,
  rewriteAssetPaths,
  zipStudy,
} from "./lib/build-jatos-study.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUDY_DIR_NAME = "ultimatum-jatos";

// ── Assets to bundle ─────────────────────────────────────────────────────────
// jsPsych core and the stock plugins come from node_modules (they are devDependencies of this
// repo, not packages in it); only the multiplayer packages are built from source here.
const assets = [
  { src: nodeModulesAsset(root, "jspsych/css/jspsych.css"), dest: "jspsych.css" },
  { src: nodeModulesAsset(root, "jspsych/dist/index.browser.js"), dest: "jspsych.js" },
  {
    src: nodeModulesAsset(root, "@jspsych/plugin-html-button-response/dist/index.browser.js"),
    dest: "plugin-html-button-response.js",
  },
  {
    src: nodeModulesAsset(root, "@jspsych/plugin-html-keyboard-response/dist/index.browser.js"),
    dest: "plugin-html-keyboard-response.js",
  },
  { src: multiplayerAsset(root, "adapter-multiplayer-jatos"), dest: "jatos-adapter.js" },
  { src: multiplayerAsset(root, "plugin-multiplayer-role"), dest: "plugin-multiplayer-role.js" },
  { src: multiplayerAsset(root, "plugin-multiplayer-sync"), dest: "plugin-multiplayer-sync.js" },
];

// ── Path rewrites in the HTML ─────────────────────────────────────────────────
const pathRewrites = {
  "https://unpkg.com/jspsych/css/jspsych.css": "jspsych.css",
  "https://unpkg.com/jspsych": "jspsych.js",
  "https://unpkg.com/@jspsych/plugin-html-button-response": "plugin-html-button-response.js",
  "https://unpkg.com/@jspsych/plugin-html-keyboard-response": "plugin-html-keyboard-response.js",
  "../packages/adapter-multiplayer-jatos/dist/index.browser.min.js": "jatos-adapter.js",
  "../packages/plugin-multiplayer-role/dist/index.browser.min.js": "plugin-multiplayer-role.js",
  "../packages/plugin-multiplayer-sync/dist/index.browser.min.js": "plugin-multiplayer-sync.js",
};

// ── Build ─────────────────────────────────────────────────────────────────────
// JATOS 3.x archive structure:
//   ultimatum-jatos.jas   ← study metadata at zip root (must have .jas extension)
//   ultimatum-jatos/      ← study assets folder (must match dirName)
//     index.html
//     jspsych.js
//     ...

const { distDir, assetsDir, jasFileName } = buildAssetsAndMetadata({
  root,
  studyDirName: STUDY_DIR_NAME,
  assets,
  studyMeta: {
    title: "Multiplayer Ultimatum Game",
    description: "Two-player ultimatum game built with the jsPsych multiplayer packages.",
    componentTitle: "Ultimatum Game",
    // Deliberately UNCAPPED, unlike the two-member cap the original version of this script used.
    // This repo's ultimatum demo models OPEN recruitment: plugin-multiplayer-role assigns the first
    // two arrivals as proposer/responder and gives every later arrival the `spectator` overflow
    // role, routed to a "game is full" screen. A JATOS batch capped at 2 active members would keep
    // extras out of the group entirely, so that whole documented path would be unreachable in the
    // packaged study. Cap it here only if you actually want JATOS to enforce exactly two.
    batch: { maxActiveMembers: null, maxTotalMembers: null },
  },
});

const html = rewriteAssetPaths(
  readFileSync(resolve(root, "examples/ultimatum-game-jatos.html"), "utf8"),
  pathRewrites
);
writeFileSync(resolve(assetsDir, "index.html"), html);
console.log(`  wrote   index.html`);

// ── Zip ───────────────────────────────────────────────────────────────────────
const zipName = "ultimatum-jatos.jzip";
zipStudy({ distDir, assetsDir, jasFileName, studyDirName: STUDY_DIR_NAME, zipName });

console.log(`\n  Import dist/${zipName} into JATOS via the Import Study button.`);
printPre3694Caveat();
