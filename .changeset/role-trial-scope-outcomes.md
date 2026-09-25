---
"@jspsych-multiplayer/plugin-multiplayer-role": minor
---

Port to the hardened multiplayer API. The trial now writes its data into its own scope of the shared data, and the snapshot the strategies see holds the participants who have reached this trial, each with their session data merged under their data from the trial. `joinedAt` is written once to the session scope, so `join_order` stays stable across rounds. `push_data` is renamed `write_data` and is no longer nested under `rounds[round]` (read `entry.score`, not `entry.rounds[round].score`). The trial records `multiplayer_outcome` and `left_participant` in place of `timed_out`, `partner_left`, and `connection_lost`, and a `timeout` of `0` now means no limit. The role accessors now read the last role trial's data instead of a module-level store; they take an optional `jsPsych` instance for pages that run several.
