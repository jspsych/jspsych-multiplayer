---
"@jspsych-multiplayer/plugin-multiplayer-role": minor
---

The `random` strategy now draws from the session's shared randomness (`jsPsych.multiplayer.shuffle`), so each group gets its own assignment, and you can pin it across groups with the `randomSeed` connect option. `seed` now picks a different assignment within the session.
