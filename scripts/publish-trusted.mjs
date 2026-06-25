/**
 * Publishes workspace packages whose local version isn't yet on the npm registry, using npm
 * trusted publishing (OIDC) — see publish.yml. Run from CI after `npm run build`.
 *
 * Why not `changeset publish`? A brand-new package can't be published over OIDC: npm has no
 * trusted-publisher config for a package that doesn't exist yet, so `npm publish` falls back to
 * token auth and fails with ENEEDAUTH — which would red-X this workflow on every push until a
 * maintainer does the one-time bootstrap. This script instead SKIPS any package that isn't on the
 * registry yet (the new-package-reminder workflow tells maintainers to bootstrap it), so onboarding
 * a new package leaves `main` green. Once a package exists and has a trusted publisher configured,
 * its future version bumps publish here automatically over OIDC.
 *
 * Trade-off vs. `changeset publish`: this does not create git tags. Versioning is still handled by
 * changesets (the "Version Packages" PR); only the publish step differs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

function pkgJsonPath(dir) {
  return fileURLToPath(new URL(`../packages/${dir}/package.json`, import.meta.url));
}

const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));

const packages = readdirSync(packagesDir)
  .filter((dir) => existsSync(pkgJsonPath(dir)))
  .map((dir) => JSON.parse(readFileSync(pkgJsonPath(dir), "utf8")))
  .filter((json) => !json.private && json.name && json.version);

let publishedAny = false;

for (const { name, version } of packages) {
  let publishedVersions;
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const parsed = JSON.parse(out);
    publishedVersions = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // `npm view` exits non-zero (E404) when the package doesn't exist on the registry yet.
    console.log(
      `skip ${name}: not on the registry yet — needs a one-time trusted-publishing bootstrap.`
    );
    continue;
  }

  if (publishedVersions.includes(version)) {
    console.log(`skip ${name}@${version}: already published.`);
    continue;
  }

  console.log(`publishing ${name}@${version} via OIDC...`);
  execFileSync("npm", ["publish", "-w", name, "--access", "public"], { stdio: "inherit" });
  publishedAny = true;
}

if (!publishedAny) {
  console.log("Nothing to publish.");
}
