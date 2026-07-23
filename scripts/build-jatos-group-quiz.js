#!/usr/bin/env node
// Assembles a JATOS-ready study archive for the Group Quiz demo.
// Produces dist/group-quiz-jatos.jzip with one component (index.html) that
// contains a landing page where participants self-select Host or Player.
//
// Usage: npm run build:jatos:group-quiz    (or: node scripts/build-jatos-group-quiz.js)
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
const STUDY_DIR_NAME = "group-quiz-jatos";

// ── All assets needed by the single component ─────────────────────────────────
// jsPsych core and the stock plugins come from node_modules (they are devDependencies of this
// repo, not packages in it); only the multiplayer packages are built from source here.
const assets = [
  { src: nodeModulesAsset(root, "jspsych/css/jspsych.css"), dest: "jspsych.css" },
  { src: nodeModulesAsset(root, "jspsych/dist/index.browser.js"), dest: "jspsych.js" },
  {
    src: nodeModulesAsset(root, "@jspsych/plugin-call-function/dist/index.browser.js"),
    dest: "plugin-call-function.js",
  },
  {
    src: nodeModulesAsset(root, "@jspsych/plugin-html-button-response/dist/index.browser.js"),
    dest: "plugin-html-button-response.js",
  },
  {
    src: nodeModulesAsset(root, "@jspsych/plugin-html-keyboard-response/dist/index.browser.js"),
    dest: "plugin-html-keyboard-response.js",
  },
  { src: multiplayerAsset(root, "adapter-multiplayer-jatos"), dest: "jatos-adapter.js" },
  { src: multiplayerAsset(root, "plugin-multiplayer-sync"), dest: "plugin-multiplayer-sync.js" },
  // protocol.js and questions.js are already loaded by flat name, so they need no rewrite below.
  { src: "examples/group-quiz/protocol.js", dest: "protocol.js" },
  { src: "examples/group-quiz/questions.js", dest: "questions.js" },
];

// ── Path rewrites in the HTML ─────────────────────────────────────────────────
// Maps the example's browser-facing <script src>/<link href> values to their flat equivalents
// inside the archive. Every entry must match, or the build fails loudly.
const pathRewrites = {
  "https://unpkg.com/jspsych/css/jspsych.css": "jspsych.css",
  "https://unpkg.com/jspsych": "jspsych.js",
  "https://unpkg.com/@jspsych/plugin-call-function": "plugin-call-function.js",
  "https://unpkg.com/@jspsych/plugin-html-button-response": "plugin-html-button-response.js",
  "https://unpkg.com/@jspsych/plugin-html-keyboard-response": "plugin-html-keyboard-response.js",
  "../../packages/adapter-multiplayer-jatos/dist/index.browser.min.js": "jatos-adapter.js",
  "../../packages/plugin-multiplayer-sync/dist/index.browser.min.js": "plugin-multiplayer-sync.js",
};

// ── Build ─────────────────────────────────────────────────────────────────────
const { distDir, assetsDir, jasFileName } = buildAssetsAndMetadata({
  root,
  studyDirName: STUDY_DIR_NAME,
  assets,
  studyMeta: {
    title: "Group Quiz Multiplayer Demo",
    description: "Live quiz game demonstrating the jsPsych multiplayer packages.",
    componentTitle: "Group Quiz",
    componentComments: "Share one link. Presenter clicks 'Host', participants click 'Player'.",
  },
});

const html = rewriteAssetPaths(
  readFileSync(resolve(root, "examples/group-quiz/index.html"), "utf8"),
  pathRewrites
);
writeFileSync(resolve(assetsDir, "index.html"), html);
console.log(`  wrote   index.html`);

// ── Zip ───────────────────────────────────────────────────────────────────────
const zipName = "group-quiz-jatos.jzip";
zipStudy({ distDir, assetsDir, jasFileName, studyDirName: STUDY_DIR_NAME, zipName });

console.log(`\n  Import dist/${zipName} into JATOS.`);
console.log(`  One study link for everyone — presenter clicks Host, participants click Player.`);
printPre3694Caveat();
