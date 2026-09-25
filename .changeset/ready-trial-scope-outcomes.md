---
"@jspsych-multiplayer/plugin-multiplayer-ready": minor
---

Port to the hardened multiplayer API (trial scopes, `MultiplayerError` codes).

**Breaking:**

- Each trial has its own part of the shared data, so gates no longer need their own keys: the `data_key` parameter and data field are removed, and the plugin writes `ready: true` in the trial's data. The session-wide `ready: true` flag is no longer written.
- `push_data` is renamed `write_data`. It is merged into this participant's part of the trial's data, so values in it are not visible in later trials; write those with `jsPsych.multiplayer.update(data, { scope: "session" })`.
- The trial's shared data is saved in `group` only with the new `save_group: true` parameter.
- `timed_out`, `partner_left`, `connection_lost`, and `wait_error` are replaced by `multiplayer_outcome` (`"completed"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`); `left_participant` stays.

A timeout of `0` or less still means no limit. The gate no longer waits for the backend to confirm the ready flag before its timeout starts.
