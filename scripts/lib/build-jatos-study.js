// Shared helpers for assembling a JATOS-ready study archive (.jzip):
// resolve assets, copy them flat into a study folder, write JATOS study metadata (.jas),
// and zip both into an importable archive.
//
// Used by build-jatos-group-quiz.js and build-jatos-ultimatum.js.
//
// ── Asset resolution in THIS repo ────────────────────────────────────────────────────────────────
// The examples load two different kinds of script:
//   • the multiplayer packages, built from source in `packages/*/dist/`  → multiplayerAsset()
//   • jsPsych core and the stock plugins, which are NOT in this repo     → nodeModulesAsset()
// A JATOS study has to be self-contained (JATOS serves the study folder; it can't reach a CDN
// reliably from a lab network), so the CDN <script src> the examples use in the browser are
// resolved to their installed node_modules copies here and rewritten to flat filenames.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Absolute path to a file inside an installed npm package.
 * @param {string} root - repo root
 * @param {string} specifier - e.g. "jspsych/dist/index.browser.js"
 */
export function nodeModulesAsset(root, specifier) {
  const path = resolve(root, "node_modules", specifier);
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${specifier} in node_modules.\n` +
        `  jsPsych core and the stock plugins are devDependencies of the repo root (they are not ` +
        `packages built in this repo) — run \`npm install\` at the repo root to install them.`
    );
  }
  return path;
}

/**
 * Absolute path to a multiplayer package's browser build.
 * Uses the unminified build: a study archive is something people open and read to learn from.
 * @param {string} root - repo root
 * @param {string} packageName - e.g. "plugin-multiplayer-sync"
 */
export function multiplayerAsset(root, packageName) {
  const path = resolve(root, "packages", packageName, "dist", "index.browser.js");
  if (!existsSync(path)) {
    throw new Error(
      `Missing built output for ${packageName} (${path}).\n` +
        `  \`dist/\` is gitignored, so run \`npm run build\` at the repo root first. If it already ` +
        `exists but you changed package source since, rebuild anyway — a stale dist/ silently ships ` +
        `old behaviour.`
    );
  }
  return path;
}

/**
 * Applies `pathRewrites` to an example's HTML, mapping each original `<script src>`/`<link href>`
 * value to its flat filename inside the study folder.
 *
 * Matches on the QUOTED attribute value, not the bare substring, because some sources are prefixes
 * of others (`https://unpkg.com/jspsych` is a prefix of `https://unpkg.com/jspsych/css/jspsych.css`)
 * and an unanchored replace would corrupt the longer one depending on iteration order.
 *
 * Throws if any rewrite finds no match: a silently-missed rewrite produces a .jzip whose index.html
 * still points at a CDN or a `../packages/…` path that doesn't exist inside the archive, which fails
 * only at run time inside JATOS — long after the person who broke it has moved on.
 */
export function rewriteAssetPaths(html, pathRewrites) {
  let out = html;
  const missed = [];
  for (const [original, replacement] of Object.entries(pathRewrites)) {
    const quoted = `"${original}"`;
    if (!out.includes(quoted)) {
      missed.push(original);
      continue;
    }
    out = out.replaceAll(quoted, `"${replacement}"`);
  }
  if (missed.length > 0) {
    throw new Error(
      `These asset paths were not found in the example's HTML:\n` +
        missed.map((m) => `    ${m}`).join("\n") +
        `\n  The example's <script>/<link> tags changed. Update this build script's ` +
        `pathRewrites to match, or the archive will ship broken references.`
    );
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.root - repo root (relative asset paths resolve against this)
 * @param {string} opts.studyDirName - folder name inside the archive (must match metadata.dirName)
 * @param {Array<{src: string, dest: string}>} opts.assets - files to copy into the study folder;
 *   `src` may be absolute (as returned by the resolvers above) or relative to root
 * @param {object} opts.studyMeta - { title, description, componentTitle, componentComments, batch }
 * @returns {{ distDir: string, assetsDir: string, jasFileName: string }}
 */
export function buildAssetsAndMetadata({ root, studyDirName, assets, studyMeta }) {
  const distDir = resolve(root, "dist");
  const assetsDir = resolve(distDir, studyDirName);

  rmSync(assetsDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });

  for (const { src, dest } of assets) {
    // resolve() returns `src` unchanged when it is already absolute.
    cpSync(resolve(root, src), resolve(assetsDir, dest));
    console.log(`  copied  ${dest}`);
  }

  const metadata = {
    version: "3",
    data: {
      uuid: randomUUID(),
      title: studyMeta.title,
      description: studyMeta.description,
      groupStudy: true,
      linearStudy: false,
      allowPreview: false,
      dirName: studyDirName,
      comments: "",
      jsonData: null,
      endRedirectUrl: null,
      studyEntryMsg: null,
      componentList: [
        {
          uuid: randomUUID(),
          title: studyMeta.componentTitle,
          htmlFilePath: "index.html",
          reloadable: false,
          active: true,
          comments: studyMeta.componentComments ?? "",
          jsonData: null,
        },
      ],
      batchList: [
        {
          uuid: randomUUID(),
          title: "Default",
          active: true,
          maxActiveMembers: studyMeta.batch?.maxActiveMembers ?? null,
          maxTotalMembers: studyMeta.batch?.maxTotalMembers ?? null,
          maxTotalWorkers: null,
          allowedWorkerTypes: ["Jatos", "GeneralSingle", "GeneralMultiple"],
          comments: null,
          jsonData: null,
        },
      ],
    },
  };

  const jasFileName = `${studyDirName}.jas`;
  writeFileSync(resolve(assetsDir, "..", jasFileName), JSON.stringify(metadata, null, 2));
  console.log(`  wrote   ${jasFileName}`);

  return { distDir, assetsDir, jasFileName };
}

/**
 * Zips the study metadata + assets folder into a .jzip archive.
 * On Windows, uses .NET's ZipFile API directly (via a throwaway PowerShell script)
 * since Compress-Archive emits backslash entry names, which violates the ZIP spec.
 */
export function zipStudy({ distDir, assetsDir, jasFileName, studyDirName, zipName }) {
  const zipPath = resolve(distDir, zipName);
  rmSync(zipPath, { force: true });

  if (process.platform === "win32") {
    const metadataPath = resolve(distDir, jasFileName);
    const psLines = [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `$zip = [System.IO.Compression.ZipFile]::Open("${zipPath}", 'Create')`,
      "$comp = [System.IO.Compression.CompressionLevel]::Optimal",
      `[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "${metadataPath}", '${jasFileName}', $comp)`,
      `Get-ChildItem -Path "${assetsDir}" -File | ForEach-Object {`,
      `  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, '${studyDirName}/' + $_.Name, $comp)`,
      "}",
      "$zip.Dispose()",
    ];
    const tmpScript = resolve(distDir, "_build_zip.ps1");
    writeFileSync(tmpScript, psLines.join("\n"), "utf8");
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`);
    } finally {
      rmSync(tmpScript, { force: true });
    }
  } else {
    execSync(`cd "${distDir}" && zip -r ${zipName} ${jasFileName} ${studyDirName}/`);
  }

  console.log(`\n  zipped  dist/${zipName}`);
}

/**
 * The caveat every archive built from this repo currently carries. Printed at the end of each build
 * so it can't be missed, and mirrored in the examples' own header comments.
 */
export function printPre3694Caveat() {
  console.log(
    `\n  NOTE: the bundled jsPsych core is a published release, which does NOT yet carry the\n` +
      `  multiplayer API (jsPsych#3694). The archive imports into JATOS fine, but the study will\n` +
      `  fail at connect() until #3694 ships — or until you swap jspsych.js for a #3694 build.`
  );
}
