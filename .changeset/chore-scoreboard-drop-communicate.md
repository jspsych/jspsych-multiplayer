---
"@jspsych-multiplayer/plugin-multiplayer-scoreboard": patch
---

Drop the now-removed `communicate()` member from the local multiplayer API mirror and test mock (`communicate()` was removed from the jsPsych multiplayer API in jsPsych#3694). The plugin already pushed and waited as two separate calls, so there is no behavior change — this only trims dead interface surface.
