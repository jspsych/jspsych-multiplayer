---
"@jspsych-multiplayer/plugin-multiplayer-chat": patch
"@jspsych-multiplayer/plugin-multiplayer-choice": patch
"@jspsych-multiplayer/plugin-multiplayer-countdown": patch
"@jspsych-multiplayer/plugin-multiplayer-draw": patch
"@jspsych-multiplayer/plugin-multiplayer-match": patch
"@jspsych-multiplayer/plugin-multiplayer-ready": patch
"@jspsych-multiplayer/plugin-multiplayer-reference-game": patch
"@jspsych-multiplayer/plugin-multiplayer-role": patch
"@jspsych-multiplayer/plugin-multiplayer-scoreboard": patch
"@jspsych-multiplayer/plugin-multiplayer-sync": patch
"@jspsych-multiplayer/adapter-multiplayer-firebase": patch
---

Track jsPsych#3694's updated multiplayer contract.

A pending `wait()` now rejects with a `MultiplayerCancelledError` when the experiment ends or is
aborted, instead of hanging. Plugins that wait on the group (choice, match, ready, role, scoreboard,
sync) stop quietly on that error rather than treating it as a timeout or a backend failure —
`plugin-multiplayer-scoreboard` previously logged an error and drew a final board over the cleared
display, leaving a Continue button that called `finishTrial` after the run had ended. Reads
(`get`, `getAll`, subscriber arguments and the `wait()` result) are now JSON copies, so session data
must be JSON-serializable; `push`, `update` and `wait` reject rather than throwing when the API is
not connected, and `participantId` is `null` until `connect()` resolves.

Fixes found alongside that work: `plugin-multiplayer-countdown` and `plugin-multiplayer-draw`
registered their repeating timers with a raw `setInterval`, which survived `abortExperiment()` — the
countdown could call `finishTrial` after the run ended and draw kept writing to the session forever;
both now tick through jsPsych's own timer registry. `plugin-multiplayer-chat` and
`plugin-multiplayer-reference-game` rebuilt this client's whole message list from the adapter's
cache on every send, so two quick sends could drop a message; each now keeps its own messages in a
local array. `adapter-multiplayer-firebase` marked itself connected before arming its disconnect
cleanup, so a failure there left a connected-looking adapter with a leaked listener and a retry that
silently did nothing; a failed `connect()` now releases everything it opened.

Where a plugin hand-rolled read-merge-write against its own slot it now calls `update()`, which
merges onto this client's last write and coalesces writes issued faster than the backend confirms
them.
