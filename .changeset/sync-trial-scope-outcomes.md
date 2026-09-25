---
"@jspsych-multiplayer/plugin-multiplayer-sync": minor
---

Port to the hardened multiplayer API (trial scopes, `MultiplayerError` codes).

**Breaking:**

- `push_data` is renamed `write_data`, and it is merged into this participant's data with `update()` instead of replacing it. It goes to the trial's own part of the shared data, which is also what `wait_for` sees, so values written in an earlier trial never satisfy a later barrier.
- `participants` now defaults to `null`: the other members of a sealed group who haven't left, or else the others who are connected when the wait starts. Pass `participants: []` to keep the old behavior of ignoring departures (e.g. in a lobby).
- The trial's shared data is saved in `group` only with the new `save_group: true` parameter.
- `timed_out`, `partner_left`, `connection_lost`, and `wait_error` are replaced by `multiplayer_outcome` (`"completed"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`); `left_participant` stays.

A timeout of `0` or less still means no limit. The barrier no longer waits for the backend to confirm `write_data` before its timeout starts.
