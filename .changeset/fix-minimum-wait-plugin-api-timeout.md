---
"@jspsych-multiplayer/plugin-multiplayer-sync": patch
---

Route the `minimum_wait` delay through `jsPsych.pluginAPI.setTimeout()` instead of a raw `setTimeout` so the pending timeout is registered with jsPsych and cleaned up automatically if the trial or experiment is aborted mid-wait.
