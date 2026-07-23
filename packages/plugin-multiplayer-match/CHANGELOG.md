# @jspsych-multiplayer/plugin-multiplayer-match

## 0.2.0

### Minor Changes

- [#38](https://github.com/jspsych/jspsych-multiplayer/pull/38) [`cda5411`](https://github.com/jspsych/jspsych-multiplayer/commit/cda54112a9f047179b12f0c8e4eef20e7acd2dfe) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Add `plugin-multiplayer-match`: partition a multiplayer group into matched sub-groups (pairs by default, or triads/larger) by deterministic consensus — every client independently computes the same partition from the shared group-session snapshot, with no coordinator. It is the foundational primitive under pairwise/small-group paradigms (trust game, ultimatum, dyadic negotiation) and composes with `plugin-multiplayer-role` (assign roles _within_ a group via `position`). Runs as a short barrier (like `plugin-multiplayer-role`), supports `ordered`/`join_order`/`random` (seeded, per-round) pairing strategies and `error`/`spectator`/`smaller_group` leftover policies for non-divisible counts, fails loud on timeout, and exposes the pure core (`buildMatches`) plus partner accessors (`getMyPartners`/`getMyGroup`/`getMyPosition`/`getMatchMap`) as statics for downstream trials.

### Patch Changes

- [#38](https://github.com/jspsych/jspsych-multiplayer/pull/38) [`cd7f8fe`](https://github.com/jspsych/jspsych-multiplayer/commit/cd7f8fef7517918691cae5b1b71fdd56393e55c7) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Adopt the push-then-wait pattern after `communicate()` was removed from the jsPsych multiplayer API (jsPsych#3694). The match barrier now calls `push()` then `wait()`, and distinguishes a genuine readiness timeout (`MultiplayerTimeoutError`, matched by error name) from other rejections: a real timeout ends the trial gracefully (`timed_out: true`), while a backend/push failure now propagates loudly instead of being mislabelled as a timeout.

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.
