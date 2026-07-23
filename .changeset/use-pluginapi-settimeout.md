---
"@jspsych-multiplayer/plugin-multiplayer-chat": patch
"@jspsych-multiplayer/plugin-multiplayer-choice": patch
"@jspsych-multiplayer/plugin-multiplayer-draw": patch
"@jspsych-multiplayer/plugin-multiplayer-ready": patch
"@jspsych-multiplayer/plugin-multiplayer-reference-game": patch
"@jspsych-multiplayer/plugin-multiplayer-scoreboard": patch
"@jspsych-multiplayer/plugin-multiplayer-sync": patch
---

Register trial timers through `jsPsych.pluginAPI.setTimeout` so they are cancelled when a trial is ended externally (`abortExperiment`, `endCurrentTimeline`, forced `finishTrial`), instead of firing into a finished trial. The plugins previously used bare `setTimeout` and only cleared handles on their own end paths, so external termination — exactly what multiplayer sync timeouts and host-ended sessions do — left timers alive.
