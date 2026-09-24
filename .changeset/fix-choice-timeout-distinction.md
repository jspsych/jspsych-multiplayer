---
"@jspsych-multiplayer/plugin-multiplayer-choice": patch
---

Distinguish a genuine barrier timeout from other `wait()` rejections. jsPsych#3694 rejects a timeout with a typed `MultiplayerTimeoutError`; a `wait()` can otherwise reject because the condition predicate threw or the backend failed. Only a timeout now proceeds with a partial snapshot as a timeout (`timed_out: true`, runs `on_timeout`); a throwing predicate or a backend failure rethrows, so the trial halts loudly instead of masquerading as a timeout.
