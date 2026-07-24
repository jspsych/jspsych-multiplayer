# jsPsych Multiplayer documentation site

The user-facing docs at [multiplayer.jspsych.org](https://multiplayer.jspsych.org). Built
with [Docusaurus](https://docusaurus.io/) on `@jspsych/docusaurus-preset`, the shared config
factory used by the other jsPsych-family satellite sites.

This is a **standalone project, deliberately not a workspace of the repo root** — it has its
own `package.json` and lockfile, so the docs dependency tree stays out of the published
packages' graph. Run every command below from `website/`.

```sh
npm install
npm start     # dev server with hot reload
npm run build # production build into build/
npm run serve # preview the production build
```

Deployment is automatic: pushing to `main` with changes under `website/` triggers
`.github/workflows/publish-docs.yml`, which builds and publishes to GitHub Pages. The custom
domain comes from `static/CNAME`.

## What goes here

Only **user-facing** documentation. Internal design notes live untracked in the repo-root
`docs/` directory and are neither committed nor published.

Content lives in `docs/`, in four groups matching the navbar: the single `introduction.md`
page, plus `tutorials/`, `guides/`, and `reference/`. `sidebars.ts` defines one sidebar per
tab. Tutorials are `.mdx` and use the local `<Steps>/<Step>` component from
`src/components/Steps`.

## ⚠️ One page still needs a package release

The packages and all 14 examples now run on `jsPsych.multiplayer`, pinned to preview build
`151ab52` (built by jsPsych's PR bot from #3694's current head). The **ultimatum
tutorial** therefore matches the example it points at, and runs today.

The **first tutorial** does not, and cannot be fixed here. Its premise is "one HTML file,
no clone", so it loads the plugins from a CDN — which serves the last version published to
npm, and that version predates the namespace move. Nothing local changes what a stranger
downloads. Until `@jspsych-multiplayer/*` is republished, that page carries a notice
directing readers to build from a clone instead.

So: republish the packages, then delete the notice at the top of
`docs/tutorials/first-multiplayer-trial.mdx`. Nothing else is waiting on it.

Re-pinning, when the preview build goes stale: open
[#3694](https://github.com/jspsych/jsPsych/pull/3694), find the bot comment titled
"📦 Preview build ready", and take the `jspsych` URL. The bot edits that comment in place,
so its posting date is not the build date — check the commit message on the SHA instead,
which names the head it was built from. A stale pin still loads fine and fails subtly, so
re-pin whenever the API moves. See `examples/README.md` for the full recipe.

## Two things to know before editing

- **The docs are written against `jsPsych.multiplayer`** ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)),
  which is **still an open PR** — not merged, and not in any `jspsych` release. That is why a
  site-wide `announcementBar` in `docusaurus.config.ts` and a note on the first tutorial
  point readers at a jsDelivr preview build. Remove both once a release carries the API, and
  re-check the pages against the API as merged, since it can still change in review.
- **`overrides.webpack` is pinned** in `package.json`. webpack ≥ 5.102 tightened the
  `ProgressPlugin` options schema, which Docusaurus 3.9's `webpackbar` fails validation
  against. Drop the override once that is fixed upstream. Docusaurus versions are pinned to
  3.9.2 to match what `@jspsych/docusaurus-preset` depends on; a mismatch nests a second
  copy of the classic preset and breaks the build.
