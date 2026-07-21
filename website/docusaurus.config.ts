import type { Config } from "@docusaurus/types";
import { defineJspsychConfig } from "@jspsych/docusaurus-preset";

const editUrl = "https://github.com/jspsych/jspsych-multiplayer/tree/main/website/";

const config: Config = defineJspsychConfig({
  title: "jsPsych Multiplayer",
  tagline: "Run synchronous, multi-participant experiments in jsPsych",
  url: "https://multiplayer.jspsych.org",
  baseUrl: "/",
  organizationName: "jspsych",
  projectName: "jspsych-multiplayer",
  githubUrl: "https://github.com/jspsych/jspsych-multiplayer",

  docs: {
    sidebarPath: "./sidebars.ts",
    // The site is docs-only: the Introduction page is the landing page.
    routeBasePath: "/",
    editUrl,
    showLastUpdateTime: true,
  },

  navbar: {
    title: "jsPsych Multiplayer",
    items: [
      { to: "/", label: "Introduction", position: "left", activeBaseRegex: "^/$" },
      {
        type: "docSidebar",
        sidebarId: "tutorials",
        label: "Tutorials",
        position: "left",
      },
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

  // The docs are written against the `jsPsych.multiplayer` API from jsPsych#3694, which
  // is still an open PR. Remove this banner (and the "Before you start" note on the first
  // tutorial) once a `jspsych` release carries the API.
  themeConfig: {
    announcementBar: {
      id: "prerelease-3694",
      content:
        'These docs describe the <code>jsPsych.multiplayer</code> API from <a href="https://github.com/jspsych/jsPsych/pull/3694">jsPsych#3694</a>, which is still in review and not yet in any <code>jspsych</code> release. See <a href="/tutorials/first-multiplayer-trial">the first tutorial</a> for how to load a preview build.',
      isCloseable: true,
    },
  },

  footerLinks: [
    {
      title: "Docs",
      items: [
        { label: "Introduction", to: "/" },
        { label: "Tutorials", to: "/tutorials/ultimatum-game" },
      ],
    },
    {
      title: "Community",
      items: [
        {
          label: "Discussions",
          href: "https://github.com/jspsych/jsPsych/discussions",
        },
      ],
    },
    {
      title: "More",
      items: [
        {
          label: "GitHub",
          href: "https://github.com/jspsych/jspsych-multiplayer",
        },
        { label: "jsPsych", href: "https://www.jspsych.org" },
      ],
    },
  ],
});

export default config;
