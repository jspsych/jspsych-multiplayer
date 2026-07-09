# @jspsych-multiplayer/plugin-multiplayer-role

## 0.1.0

### Minor Changes

- [#15](https://github.com/jspsych/jspsych-multiplayer/pull/15) [`aba23cd`](https://github.com/jspsych/jspsych-multiplayer/commit/aba23cda671752fd63d9c51d65f7c2cc53a51a4c) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `plugin-multiplayer-role`, a role-assignment plugin for the jsPsych multiplayer API.

  It deterministically maps participants in a shared group session to roles, so every client computes the **same** assignment without a coordinator — the consensus problem researchers otherwise hand-roll. Declare role names and counts (e.g. `["proposer", "responder"]` or `{ leader: 1, follower: 3 }`) and choose an assignment strategy: `join_order`, shared-seeded `random`, `rotate` (per-round), attribute/outcome ranking via `rankBy`, direct lookup via `roleFrom`, or a fully custom function. Downstream trials read the result with `getMyRole()` / `getRoleMap()` (plus a `participantsByRole()` helper for role→id lookup), replacing the hand-rolled `myRole` pattern in the ultimatum-game example.
