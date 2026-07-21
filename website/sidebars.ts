import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * One sidebar per navbar tab. The Introduction is a single page and therefore
 * has no sidebar of its own — it is linked directly from the navbar.
 *
 * Reference is populated in step 2 of docs/docs-site-plan.md (one page per
 * plugin and per adapter, in two categories).
 */
const sidebars: SidebarsConfig = {
  tutorials: ["tutorials/first-multiplayer-trial", "tutorials/ultimatum-game"],
  guides: ["guides/choosing-an-adapter"],
  reference: ["reference/multiplayer-api"],
};

export default sidebars;
