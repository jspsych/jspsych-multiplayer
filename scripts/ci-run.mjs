/**
 * Bootstrap shim for the root `build` and `test` scripts.
 *
 * While `packages/` is empty (before the first plugin/adapter is contributed), both
 * `npm run build --workspaces` and `jest` hard-error ("No workspaces found!" / no projects
 * matched). This wrapper makes those scripts a clean no-op until at least one package exists,
 * so CI stays green on a tooling-only repo. Once any package under `packages/` has a
 * package.json it delegates to the real command — identical to jspsych-contrib's behavior —
 * forwarding any extra CLI args (e.g. `--ci --coverage --maxWorkers=2`).
 *
 * Usage: node scripts/ci-run.mjs <build|test> [...args]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [, , kind, ...rest] = process.argv;

const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));
const hasPackages =
  existsSync(packagesDir) &&
  readdirSync(packagesDir).some((entry) =>
    existsSync(fileURLToPath(new URL(`../packages/${entry}/package.json`, import.meta.url)))
  );

if (!hasPackages) {
  console.log(`No packages in /packages yet — skipping ${kind}.`);
  process.exit(0);
}

const command =
  kind === "build"
    ? ["npm", "run", "build", "--workspaces", "--if-present", ...rest]
    : ["jest", ...rest];

const result = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
