---
"@jspsych-multiplayer/plugin-multiplayer-countdown": minor
---

Port to the hardened multiplayer API. The start timestamp now lives in the trial's own scope of the shared data under `countdown_started_at`, so every countdown starts a fresh clock and the `name` parameter is removed. To run one clock across several trials, give them the same `multiplayer_scope`. The trial records `multiplayer_outcome` (`"completed"` or `"connection_lost"`) and `left_participant` in place of `connection_lost`.
