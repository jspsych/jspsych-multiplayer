---
"@jspsych-multiplayer/plugin-multiplayer-choice": minor
---

Port to the hardened multiplayer API (trial scopes, `MultiplayerError` codes).

**Breaking:**

- Each trial has its own part of the shared data, so choice trials no longer need their own keys: the `data_key` parameter and data field are removed, and choices are written under `choice` in the trial's data.
- `timed_out`, `partner_left`, `connection_lost`, and `wait_error` are replaced by `multiplayer_outcome` (`"completed"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`); `left_participant` stays.

A timeout of `0` or less still means no limit. The barrier no longer waits for the backend to confirm this participant's choice before its timeout starts.
