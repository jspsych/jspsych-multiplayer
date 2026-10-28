---
"@jspsych-multiplayer/extension-presence-check": minor
---

Add `extension-presence-check`, an "Are you still with us?" inactivity check as a jsPsych extension. A warning appears after `prompt_after` ms without trusted activity; a configurable set of inputs (or its button) dismisses it, and unanswered warnings count as consecutive misses that can persist across trials. When they reach `max_consecutive_misses`, the experiment's `on_expire(summary)` callback decides what happens. Dismissing input still reaches the page, and button-only mode keeps a focus-trapping modal. It does not depend on the multiplayer API or any adapter.
