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

Only **user-facing** documentation. The repo-root `docs/*-design.md` files are internal
design notes and are not published.

Content lives in `docs/`, in four groups matching the navbar: the single `introduction.md`
page, plus `tutorials/`, `guides/`, and `reference/`. `sidebars.ts` defines one sidebar per
tab. Tutorials are `.mdx` and use the local `<Steps>/<Step>` component from
`src/components/Steps`.

## Two things to know before editing

- **The docs are written against `jsPsych.multiplayer`** (jsPsych#3694), which is merged but
  not in a published `jspsych` release yet. That is why a site-wide `announcementBar` in
  `docusaurus.config.ts` and a note on the first tutorial point readers at a jsDelivr
  preview build. Remove both once a release carries the API.
- **`overrides.webpack` is pinned** in `package.json`. webpack ≥ 5.102 tightened the
  `ProgressPlugin` options schema, which Docusaurus 3.9's `webpackbar` fails validation
  against. Drop the override once that is fixed upstream. Docusaurus versions are pinned to
  3.9.2 to match what `@jspsych/docusaurus-preset` depends on; a mismatch nests a second
  copy of the classic preset and breaks the build.

The remaining plan — reference pages, more guides, embedded live demos — is in
[`docs/docs-site-plan.md`](../docs/docs-site-plan.md) at the repo root.
