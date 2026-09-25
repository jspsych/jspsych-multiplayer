---
"@jspsych-multiplayer/plugin-multiplayer-scoreboard": minor
---

Port to the hardened multiplayer API (trial scopes, `MultiplayerError` codes).

**Breaking:**

- Each trial has its own part of the shared data, so boards no longer need their own keys: the `data_key` parameter and data field are removed, and scores are written under `scoreboard` in the trial's data.
- `timed_out`, `partner_left`, and `connection_lost` are replaced by `multiplayer_outcome` (`"completed"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`; `null` when reporting failed some other way, which `error` describes); `left_participant` and `error` stay.
- `display_label`'s second argument is now the session's shared data (what participants wrote with `{ scope: "session" }`, e.g. names chosen in earlier trials) instead of the whole group snapshot.

A timeout of `0` or less now means no limit, like the other plugins. The board no longer waits for the backend to confirm this client's score before its timeout starts.
