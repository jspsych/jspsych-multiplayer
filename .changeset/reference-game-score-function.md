---
"@jspsych-multiplayer/plugin-multiplayer-reference-game": minor
---

`scoring` now takes only a preset (`"per_slot"` or `"all_or_nothing"`), and a custom scoring function moves to the new `score_function` parameter. `prompt` takes an HTML string, or an object with one entry per role (`{ director, matcher }`), in place of a `(role) => html` function. Both parameters were `FUNCTION` parameters so that jsPsych wouldn't call a function before the trial, which made jsPsych warn about a non-function value every time a string was used.
