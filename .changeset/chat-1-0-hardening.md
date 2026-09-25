---
"@jspsych-multiplayer/plugin-multiplayer-chat": minor
---

Port chat to the hardened multiplayer API.

- Messages live in the trial's own scope, so each chat trial starts empty. **Removed `data_key`**; give several chat trials the same `multiplayer_scope` to continue one conversation across them.
- New data field `multiplayer_outcome` (`"completed"`, `"participant_left"`, `"connection_lost"`, or `"cancelled"` when the experiment disconnects mid-trial). **Removed `partner_left` and `connection_lost`.** `ended_by` now only says which end condition completed the trial (`"duration"`, `"button"`, or `"condition"`) and is `null` otherwise.
- With a sealed group, the trial ends when any other member who hasn't left leaves, including one who was only away when it started.
- Messages from a participant who leaves stay in the transcript.
- Uses `@jspsych-multiplayer/utils`. The "couldn't send" note is gone: the core retries failed writes.
