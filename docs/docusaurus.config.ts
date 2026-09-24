import type { Config } from "@docusaurus/types";
import { defineJspsychConfig } from "@jspsych/docusaurus-preset";

const editUrl = "https://github.com/jspsych/jspsych-multiplayer/tree/main/docs/";

// The site is served at the root of its own domain, so this is just "/". Kept as a constant
// because raw-HTML strings (the announcement bar) do not go through `useBaseUrl` the way MDX
// links do — interpolate this rather than hardcoding "/".
const baseUrl = "/";

const config: Config = defineJspsychConfig({
  title: "jsPsych Multiplayer",
  tagline: "Experiments where several participants take part at the same time",
  // Custom domain, set by docs/static/CNAME and the repository's Pages settings.
  url: "https://multiplayer.jspsych.org",
  baseUrl,
  organizationName: "jspsych",
  projectName: "jspsych-multiplayer",
  githubUrl: "https://github.com/jspsych/jspsych-multiplayer",

  docs: {
    sidebarPath: "./sidebars.ts",
    // Docs at the root of the site; the landing page is src/pages/index.tsx.
    routeBasePath: "/",
    editUrl,
    showLastUpdateTime: true,
  },

  navbar: {
    title: "jsPsych Multiplayer",
    items: [
      { to: "/getting-started", label: "Getting started", position: "left" },
      { to: "/examples", label: "Examples", position: "left" },
      {
        type: "docSidebar",
        sidebarId: "guides",
        label: "Guides",
        position: "left",
      },
      {
        type: "docSidebar",
        sidebarId: "reference",
        label: "Reference",
        position: "left",
      },
    ],
  },

  // The multiplayer API is jsPsych#3694, which is not yet in a `jspsych` release. Remove this
  // bar, and the "Before the release" section of Getting started, once a release carries it.
  themeConfig: {
    announcementBar: {
      // Changing the id shows the bar again to readers who closed an earlier version
      id: "prerelease-3694-v2",
      content: `jsPsych Multiplayer needs a multiplayer API that is not in a jsPsych release yet. <a href="${baseUrl}getting-started#before-the-release">How to try it today</a>.`,
      isCloseable: true,
    },
  },

  extraConfig: {
    plugins: [
      [
        "@docusaurus/plugin-client-redirects",
        {
          // Pages that moved when the site was reorganized, so old links keep working.
          redirects: [
            { from: "/introduction", to: "/" },
            { from: "/tutorials/first-multiplayer-trial", to: "/getting-started" },
            { from: "/tutorials/ultimatum-game", to: "/guides/ultimatum-game" },
            { from: "/guides/choosing-an-adapter", to: "/guides/choosing-a-backend" },
          ],
        },
      ],
    ],
  },

  footerLinks: [
    {
      title: "Docs",
      items: [
        { label: "Home", to: "/" },
        { label: "Getting started", to: "/getting-started" },
        { label: "Examples", to: "/examples" },
        { label: "Reference", to: "/reference/multiplayer-api" },
      ],
    },
    {
      title: "Community",
      items: [
        {
          label: "Discussions",
          href: "https://github.com/jspsych/jsPsych/discussions",
        },
        {
          label: "Issues",
          href: "https://github.com/jspsych/jspsych-multiplayer/issues",
        },
      ],
    },
    {
      title: "More",
      items: [
        { label: "GitHub", href: "https://github.com/jspsych/jspsych-multiplayer" },
        { label: "jsPsych", href: "https://www.jspsych.org" },
      ],
    },
  ],
});

export default config;
