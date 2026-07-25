# @jspsych-multiplayer/plugin-multiplayer-countdown

## 0.2.0

### Minor Changes

- [#41](https://github.com/jspsych/jspsych-multiplayer/pull/41) [`b4d2faa`](https://github.com/jspsych/jspsych-multiplayer/commit/b4d2faad65380f59a1afae34d7685fb8a9eb6f90) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `plugin-multiplayer-countdown`, a synchronized group timer (countdown or count-up) for the jsPsych multiplayer API.

  Every participant pushes its own start timestamp into its own slot, and each client derives the displayed time from the **minimum** timestamp across all slots — a coordination-free consensus (no elected anchor, no single point of failure) in the same spirit as `plugin-multiplayer-role`'s ordering. Late joiners and refreshes resume at the group's actual remaining time for free, and the pure consensus core (`startedAtKey` / `resolveStartedAt` / `computeRemaining` / `computeElapsed` / `formatTime`) is exposed as statics on the default export so demos can render their own synced display. Built against a local interface mirroring the multiplayer API (jsPsych#3694), so it carries no build-time dependency on the unreleased core.

### Patch Changes

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.
