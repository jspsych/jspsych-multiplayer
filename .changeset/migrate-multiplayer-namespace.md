---
"@jspsych-multiplayer/plugin-multiplayer-chat": patch
"@jspsych-multiplayer/plugin-multiplayer-choice": patch
"@jspsych-multiplayer/plugin-multiplayer-countdown": patch
"@jspsych-multiplayer/plugin-multiplayer-draw": patch
"@jspsych-multiplayer/plugin-multiplayer-match": patch
"@jspsych-multiplayer/plugin-multiplayer-ready": patch
"@jspsych-multiplayer/plugin-multiplayer-reference-game": patch
"@jspsych-multiplayer/plugin-multiplayer-role": patch
"@jspsych-multiplayer/plugin-multiplayer-scoreboard": patch
"@jspsych-multiplayer/plugin-multiplayer-sync": patch
---

Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.
