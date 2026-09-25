---
"@jspsych-multiplayer/plugin-multiplayer-draw": minor
---

Port draw to the hardened multiplayer API.

- Strokes live in the trial's own scope, so each draw trial starts with a blank canvas. **Removed `data_key`**; give several draw trials the same `multiplayer_scope` to keep drawing on one canvas.
- New data field `multiplayer_outcome` (`"completed"`, `"participant_left"`, `"connection_lost"`, or `"cancelled"` when the experiment disconnects mid-trial). **Removed `partner_left` and `connection_lost`.** `ended_by` now only says which end condition completed the trial (`"duration"`, `"button"`, or `"condition"`) and is `null` otherwise.
- With a sealed group, the trial ends when any other member who hasn't left leaves, including one who was only away when it started.
- Strokes from a participant who leaves stay on the canvas and in the data.
- Uses `@jspsych-multiplayer/utils`. The "connection trouble" note is gone: the core retries failed writes.
