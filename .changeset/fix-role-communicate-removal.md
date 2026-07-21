---
"@jspsych-multiplayer/plugin-multiplayer-role": patch
---

Update for jsPsych#3694's removal of `MultiplayerAPI.communicate()`: the plugin now calls `push()` followed by `wait()` directly instead of the removed fused convenience method. Also fixes the same timeout-mislabeling bug already patched in `plugin-multiplayer-sync`/`plugin-multiplayer-ready` — only a rejection whose `error.name === "MultiplayerTimeoutError"` is now recorded as `timed_out: true`; any other `wait()`/`push()` rejection (a throwing `ready` predicate, an adapter/backend error) propagates and fails the trial loudly instead.
