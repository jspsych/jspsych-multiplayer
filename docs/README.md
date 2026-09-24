# jsPsych Multiplayer documentation site

The user-facing docs at <https://multiplayer.jspsych.org>. Built with
[Docusaurus](https://docusaurus.io/) on `@jspsych/docusaurus-preset`, the shared config factory
used by the other jsPsych-family sites ([saccade.js](https://saccade.jspsych.org),
[metadata](https://metadata.jspsych.org)).

This is a **standalone project, deliberately not a workspace of the repo root** — it has its own
`package.json` and lockfile, so the docs dependency tree stays out of the published packages'
graph. Run every command below from `docs/`.

```sh
npm install
npm start      # dev server with hot reload
npm run build  # production build into build/
npm run serve  # preview the production build
npm run typecheck
```

Deployment is automatic: pushing to `main` with changes under `docs/` triggers
`.github/workflows/publish-docs.yml`, which builds and publishes to GitHub Pages. Pull requests
touching `docs/` build without deploying. The custom domain comes from `static/CNAME`.

## What goes here

Only **user-facing** documentation, written for researchers who know jsPsych. Internal design
notes live next to what they document (e.g. `examples/group-quiz/DESIGN.md`) and are not
published here.

The landing page is `src/pages/index.tsx`, a React page rather than a doc. Everything else is
in `docs/`, at the root of the site (`routeBasePath: "/"`), matching the navbar:

| Path | Navbar |
| --- | --- |
| `getting-started.mdx` | Getting started |
| `examples.md` | Examples |
| `guides/` | Guides |
| `reference/` | Reference: the core API, then one page per adapter and per plugin |

`sidebars.ts` defines one sidebar per tab. Getting started and Examples are single pages linked
directly from the navbar: they have no sidebar and are navigated by the table of contents.
`src/components/Steps` is the numbered walkthrough used in Getting started and the ultimatum
guide.

Pages that moved in the 2026 reorganization are redirected with
`@docusaurus/plugin-client-redirects` (see `docusaurus.config.ts`). Add a redirect whenever you
rename or move a page.

## Notes for editors

- **Reference pages follow the source, not the package READMEs.** Parameter names, defaults and
  data fields come from each package's `src/index.ts` (`info.parameters` and `info.data`). When
  a plugin's parameters change, change its reference page in the same PR.
- **Every package has a page, and every page has the same shape**: intro, "What the
  participant sees", a snippet, the Package / Browser global / Trial type table, then
  Parameters, Data, any topic sections, and Example. Adapter pages have Options, Setup, and
  Presence and dropouts instead. A new package needs a page and a sidebar entry, and a line in
  the package list on the landing page.
- **The API is not released yet.** The docs are written against `jsPsych.multiplayer` from
  [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is still an open PR, and
  most packages are not on npm. That is why there is an `announcementBar` in
  `docusaurus.config.ts` and a "Before the release" section in Getting started. When a
  `jspsych` release carries the API and the packages are published, remove both, change the
  script tags in Getting started to unpkg URLs, and re-check the pages against the API as
  merged.
- **The preview build is pinned** in Getting started (the jsDelivr URLs). Keep the SHA the same
  as the one in `examples/`; `examples/README.md` explains how to re-pin it.
- **`overrides.webpack` is pinned** in `package.json`. webpack ≥ 5.102 tightened the
  `ProgressPlugin` options schema, which Docusaurus 3.9's `webpackbar` fails validation
  against. Docusaurus packages are pinned to 3.9.2 to match `@jspsych/docusaurus-preset`; a
  mismatch nests a second copy of the classic preset and breaks the build.
