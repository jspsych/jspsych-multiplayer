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

## ⚠️ Known blocker: the tutorial code does not run yet

**Do not merge this site as "ready for readers" until the package migration below lands.**

The docs are written against `jsPsych.multiplayer.*`. Nothing currently runs that:

| | `jsPsych.multiplayer` | `pluginAPI` |
| --- | --- | --- |
| preview build `7b1d96a` (pinned by every example and by the first tutorial) | absent | present |
| `@jspsych-multiplayer/*@0.1.0` as published | absent | present |
| jsPsych#3694 at its current head | present | **removed** |

So there is no combination of jsPsych core and published plugins that runs these
tutorials: against the pinned build `jsPsych.multiplayer` is `undefined`, and against a
namespaced build the published plugins stop finding the API. The packages in this repo are
simply stale relative to the PR they exist to support — true independent of this branch.

Unblocking it is one atomic change, landing **before** this branch:

1. migrate `packages/*/src` from `jsPsych.pluginAPI` to `jsPsych.multiplayer` (about one
   line per plugin, plus doc comments and the `*.spec.ts` test doubles, which graft the
   mock onto `pluginAPI`);
2. re-pin all 14 `examples/*.html` to a preview build off #3694's current head **in the
   same change** — otherwise migrating the packages breaks every example;
3. republish the packages, then update the pin in
   `docs/tutorials/first-multiplayer-trial.mdx`.

Worth confirming the `pluginAPI` → `multiplayer` rename is settled in review before
starting: it has moved once already, which is how the packages went stale.

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
