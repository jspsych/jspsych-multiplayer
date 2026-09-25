import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * One sidebar per navbar tab. Getting started and Examples are single pages linked directly
 * from the navbar, so they have no sidebar of their own: they run full width, and their own
 * headings are the only navigation they need.
 */
const sidebars: SidebarsConfig = {
  guides: [
    "guides/how-it-works",
    "guides/choosing-a-backend",
    "guides/forming-groups",
    "guides/ultimatum-game",
    "guides/handling-dropouts",
  ],
  reference: [
    "reference/multiplayer-api",
    {
      type: "category",
      label: "Adapters",
      collapsed: false,
      items: [
        "reference/adapter-multiplayer-local",
        "reference/adapter-multiplayer-jatos",
        "reference/adapter-multiplayer-firebase",
      ],
    },
    {
      type: "category",
      label: "Waiting and grouping",
      collapsed: false,
      items: [
        "reference/plugin-multiplayer-sync",
        "reference/plugin-multiplayer-ready",
        "reference/plugin-multiplayer-role",
        "reference/plugin-multiplayer-match",
      ],
    },
    {
      type: "category",
      label: "Group decisions and scores",
      collapsed: false,
      items: [
        "reference/plugin-multiplayer-choice",
        "reference/plugin-multiplayer-scoreboard",
        "reference/plugin-multiplayer-countdown",
      ],
    },
    {
      type: "category",
      label: "Live interaction",
      collapsed: false,
      items: [
        "reference/plugin-multiplayer-chat",
        "reference/plugin-multiplayer-draw",
        "reference/plugin-multiplayer-reference-game",
      ],
    },
  ],
};

export default sidebars;
