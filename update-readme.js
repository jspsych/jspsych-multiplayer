/**
 * This script updates the root README.md file with the list of all packages when a new one is
 * published, or when the description/author of an existing package is updated.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

import { dest, series, src } from "gulp";
import replace from "gulp-replace";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packagesDir = path.join(__dirname, "packages");
const readmePath = path.join(__dirname, "README.md");

function getPackageInfo(packageDir) {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  return {
    name: packageJson.name,
    description: packageJson.description,
    author: packageJson.author?.name,
    authorUrl: packageJson.author?.url,
  };
}

async function updateRootReadme() {
  const packageInfos = fs
    .readdirSync(packagesDir)
    .map((dir) => path.join(packagesDir, dir))
    .filter((dir) => fs.lstatSync(dir).isDirectory())
    .map(getPackageInfo)
    .filter((info) => info !== null);

  const pluginListHead = `### Plugins\n
Plugin | Contributor | Description
----------- | ----------- | -----------\n`;

  const adapterListHead = `\n### Adapters\n
Adapter | Contributor | Description
----------- | ----------- | -----------\n`;

  const guidelinesHead = "\n## Guidelines for contributions";

  let pluginList = "";
  let adapterList = "";

  packageInfos.map((info) => {
    const packageName = info.name.replace(/^\@jspsych-multiplayer\//g, "");
    const packageReadmeLink = `https://github.com/jspsych/jspsych-multiplayer/blob/main/packages/${packageName}/README.md`;

    const authorRender = info.authorUrl != "" ? `[${info.author}](${info.authorUrl})` : info.author;
    if (info.name.match(/^\@jspsych-multiplayer\/adapter-/g)) {
      const adapterName = packageName.replace(/^adapter-/g, "");
      adapterList = adapterList.concat(
        `[${adapterName}](${packageReadmeLink}) | ${authorRender} | ${
          info.description ? info.description : `_Description for ${adapterName}._`
        } \n`
      );
    } else {
      const pluginName = packageName.replace(/^plugin-/g, "");
      pluginList = pluginList.concat(
        `[${pluginName}](${packageReadmeLink}) | ${authorRender} | ${
          info.description ? info.description : `_Description for ${pluginName}._`
        } \n`
      );
    }
  });

  const pluginTable = [pluginListHead, pluginList, adapterListHead];
  const adapterTable = [adapterListHead, adapterList, guidelinesHead];

  function generatePluginTable() {
    return src(`${__dirname}/README.md`)
      .pipe(replace(/### Plugins[\s\S]*?### Adapters/g, pluginTable.join("")))
      .pipe(dest(__dirname));
  }

  function generateAdapterTable() {
    return src(`${__dirname}/README.md`)
      .pipe(replace(/### Adapters[\s\S]*?## Guidelines for contributions/g, adapterTable.join("")))
      .pipe(dest(__dirname));
  }
  series(generatePluginTable, generateAdapterTable)();
}

export default updateRootReadme;
