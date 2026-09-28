---
"@jspsych-multiplayer/plugin-multiplayer-role": minor
---

`strategy` now takes only a preset (`"join_order"`, `"random"`, or `"rotate"`), and a custom rule moves to the new `assign_roles` parameter. `strategy` was a `FUNCTION` parameter so that jsPsych wouldn't call a custom rule before the trial, which made jsPsych warn about a non-function value every time a preset was used. An unknown preset now throws an error pointing to `assign_roles`.
