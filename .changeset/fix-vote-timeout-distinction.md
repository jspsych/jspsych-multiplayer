---
"@jspsych-multiplayer/plugin-multiplayer-vote": patch
---

Distinguish a genuine barrier timeout from other `wait()` rejections. jsPsych#3694 rejects a timeout with a typed `MultiplayerTimeoutError`; a `wait()` can otherwise reject because the condition predicate threw or the backend failed. Only a timeout now proceeds with a partial tally (`timed_out: true`, runs `on_timeout`); any other rejection rethrows so the trial halts loudly instead of masquerading as a timeout.
