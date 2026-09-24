---
"@jspsych-multiplayer/plugin-multiplayer-ready": minor
---

Add `plugin-multiplayer-ready`, a participant-facing ready / check-in barrier for the jsPsych multiplayer API.

It packages the common lobby / waiting-room pattern into a single declarative trial: show a prompt and a ready button, merge `{ ready: true }` and a key for this gate (plus any `push_data`) into the participant's slot when they click, display a waiting message, and end the trial once `expected_players` members are ready (or an optional `timeout` elapses while waiting for the rest of the group). Unlike `plugin-multiplayer-sync`, it owns the check-in UI and the "everyone is ready" condition, and standardizes on a `ready: true` flag so other plugins and examples can reliably gate on group readiness. Requires a jsPsych with the multiplayer API from jsPsych#3694.
