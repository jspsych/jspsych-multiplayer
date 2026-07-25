# @jspsych-multiplayer/plugin-multiplayer-role

## 0.1.1

### Patch Changes

- [#45](https://github.com/jspsych/jspsych-multiplayer/pull/45) [`fc1a842`](https://github.com/jspsych/jspsych-multiplayer/commit/fc1a8428551e8af5f90918ee96db76a09862337a) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Update for jsPsych#3694's removal of `MultiplayerAPI.communicate()`: the plugin now calls `push()` followed by `wait()` directly instead of the removed fused convenience method. Also fixes the same timeout-mislabeling bug already patched in `plugin-multiplayer-sync`/`plugin-multiplayer-ready` — only a rejection whose `error.name === "MultiplayerTimeoutError"` is now recorded as `timed_out: true`; any other `wait()`/`push()` rejection (a throwing `ready` predicate, an adapter/backend error) propagates and fails the trial loudly instead.

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.

## 0.1.0

### Minor Changes

- [#15](https://github.com/jspsych/jspsych-multiplayer/pull/15) [`aba23cd`](https://github.com/jspsych/jspsych-multiplayer/commit/aba23cda671752fd63d9c51d65f7c2cc53a51a4c) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `plugin-multiplayer-role`, a role-assignment plugin for the jsPsych multiplayer API.

  It deterministically maps participants in a shared group session to roles, so every client computes the **same** assignment without a coordinator — the consensus problem researchers otherwise hand-roll. Declare role names and counts (e.g. `["proposer", "responder"]` or `{ leader: 1, follower: 3 }`) and choose an assignment strategy: `join_order`, shared-seeded `random`, `rotate` (per-round), attribute/outcome ranking via `rankBy`, direct lookup via `roleFrom`, or a fully custom function. Downstream trials read the result with `getMyRole()` / `getRoleMap()` (plus a `participantsByRole()` helper for role→id lookup), replacing the hand-rolled `myRole` pattern in the ultimatum-game example.
