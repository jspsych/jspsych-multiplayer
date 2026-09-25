---
"@jspsych-multiplayer/plugin-multiplayer-match": minor
---

Port to the hardened multiplayer API. The trial now writes its data into its own scope of the shared data, and the snapshot it partitions holds the participants who have reached this trial, each with their session data merged under their data from the trial. `joinedAt` is written once to the session scope, so `join_order` stays stable across rounds. `push_data` is renamed `write_data`. The trial records `multiplayer_outcome` and `left_participant` in place of `timed_out`, `partner_left`, and `connection_lost`, and a `timeout` of `0` now means no limit. The match accessors now read the last match trial's data instead of a module-level store; they take an optional `jsPsych` instance for pages that run several.
