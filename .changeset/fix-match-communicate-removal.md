---
"@jspsych-multiplayer/plugin-multiplayer-match": patch
---

Adopt the push-then-wait pattern after `communicate()` was removed from the jsPsych multiplayer API (jsPsych#3694). The match barrier now calls `push()` then `wait()`, and distinguishes a genuine readiness timeout (`MultiplayerTimeoutError`, matched by error name) from other rejections: a real timeout ends the trial gracefully (`timed_out: true`), while a backend/push failure now propagates loudly instead of being mislabelled as a timeout.
