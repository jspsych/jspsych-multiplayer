---
"@jspsych-multiplayer/plugin-multiplayer-match": minor
---

The `"random"` strategy now shuffles with `jsPsych.multiplayer.shuffle`, so it is seeded by the session ID (or the `randomSeed` connect option) and each group of participants gets its own grouping. `seed` now picks a different grouping within the session.
