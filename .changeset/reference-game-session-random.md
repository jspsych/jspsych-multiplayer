---
"@jspsych-multiplayer/plugin-multiplayer-reference-game": minor
---

Arrangements now come from the session's shared randomness (`jsPsych.multiplayer.shuffle`), so each group gets its own arrangements, seeded by the session ID or the `randomSeed` connect option. `seed` still picks different arrangements within a session.
