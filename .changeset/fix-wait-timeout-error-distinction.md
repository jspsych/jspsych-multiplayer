---
"@jspsych-multiplayer/plugin-multiplayer-sync": patch
"@jspsych-multiplayer/plugin-multiplayer-ready": patch
---

Fix `wait_error`/`timed_out` mislabeling a non-timeout `wait()` failure as a timeout. Both plugins previously treated every `wait()` rejection as a timeout (a leftover from before jsPsych#3694 exported a typed `MultiplayerTimeoutError`), so a throwing `wait_for` predicate or an adapter/backend error would silently finish the trial with `timed_out: true` and call `on_timeout`, hiding the real failure in `wait_error`'s message.

Now only a rejection whose `error.name === "MultiplayerTimeoutError"` is recorded as a timeout; any other rejection propagates and fails the trial, matching how a `push()` failure is already handled.
