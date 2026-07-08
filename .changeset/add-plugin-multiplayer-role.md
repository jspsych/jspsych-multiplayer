---
"@jspsych-multiplayer/plugin-multiplayer-role": minor
---

Add `plugin-multiplayer-role`, a role-assignment plugin for the jsPsych multiplayer API.

It deterministically maps participants in a shared group session to roles, so every client computes the **same** assignment without a coordinator — the consensus problem researchers otherwise hand-roll. Declare role names and counts (e.g. `["proposer", "responder"]` or `{ leader: 1, follower: 3 }`) and choose an assignment strategy: `join_order`, shared-seeded `random`, `rotate` (per-round), attribute/outcome ranking via `rankBy`, direct lookup via `roleFrom`, or a fully custom function. Downstream trials read the result with `getMyRole()` / `getRoleMap()` (plus a `participantsByRole()` helper for role→id lookup), replacing the hand-rolled `myRole` pattern in the ultimatum-game example.
