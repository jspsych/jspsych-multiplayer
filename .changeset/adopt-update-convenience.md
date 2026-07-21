---
"@jspsych-multiplayer/plugin-multiplayer-draw": patch
"@jspsych-multiplayer/plugin-multiplayer-chat": patch
---

Internal: adopt jsPsych#3694's `update()` convenience (shallow-merge into own slot, then push) at the four call sites that were hand-rolling `get() ?? {}` + spread + `push` for a top-level-key overwrite (draw's stroke pushes on flush/undo/redo, chat's message send). No behavior change; each package's local `MultiplayerApiLike` mirror gained an `update` member to match.
