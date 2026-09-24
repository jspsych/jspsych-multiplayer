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

Read the multiplayer API from `jsPsych.multiplayer` (jsPsych#3694's namespace), and throw an error that says so when it is absent. Builds that exposed these methods on `jsPsych.pluginAPI` predate the current API and are not supported.
