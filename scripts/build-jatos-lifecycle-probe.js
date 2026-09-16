#!/usr/bin/env node
// Assembles a minimal, direct JATOS group-study lifecycle probe for the adapter.
// Usage: npm run build:jatos:lifecycle-probe

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAssetsAndMetadata,
  multiplayerAsset,
  rewriteAssetPaths,
  zipStudy,
} from "./lib/build-jatos-study.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const studyDirName = "jatos-lifecycle-probe";
const assets = [
  { src: multiplayerAsset(root, "adapter-multiplayer-jatos"), dest: "jatos-adapter.js" },
];

const { distDir, assetsDir, jasFileName } = buildAssetsAndMetadata({
  root,
  studyDirName,
  assets,
  studyMeta: {
    title: "JATOS Adapter Lifecycle Probe",
    description: "Temporary direct probe for JATOS group lifecycle events.",
    componentTitle: "Lifecycle Probe",
    componentComments: "Open the same link in multiple browsers; save each participant's trace.",
    batch: { maxActiveMembers: 2, maxTotalMembers: null },
  },
});

const html = rewriteAssetPaths(
  readFileSync(resolve(root, "examples/jatos-lifecycle-probe.html"), "utf8"),
  {
    "../packages/adapter-multiplayer-jatos/dist/index.browser.js": "jatos-adapter.js",
  },
);
writeFileSync(resolve(assetsDir, "index.html"), html);
console.log("  wrote   index.html");

const zipName = "jatos-lifecycle-probe.jzip";
zipStudy({ distDir, assetsDir, jasFileName, studyDirName, zipName });
console.log(`\n  Import dist/${zipName} into JATOS.`);
