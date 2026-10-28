---
"@jspsych-multiplayer/extension-presence-check": minor
---

Add `extension-presence-check`, an "Are you still with us?" inactivity check as a jsPsych extension. A warning appears after `prompt_after` ms without trusted activity; a configurable set of inputs (or its button) dismisses it, and unanswered warnings count as consecutive misses that can persist across trials. When they reach `max_consecutive_misses`, the experiment's `on_expire(summary)` callback decides what happens. Dismissing input still reaches the page, and button-only mode keeps a focus-trapping modal. Each warning records whether the tab was hidden when it appeared and for how long while it was open (`hidden_at_show`, `hidden_ms`, and the trial's `presence_hidden_ms`); an opt-in `title_alert` changes the tab title while a warning is open. Expiry starts the consecutive-miss count over. It does not depend on the multiplayer API or any adapter.
