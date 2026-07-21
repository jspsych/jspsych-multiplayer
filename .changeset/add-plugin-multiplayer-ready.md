---
"@jspsych-multiplayer/plugin-multiplayer-ready": minor
---

Add `plugin-multiplayer-ready`, a participant-facing ready / check-in barrier for the jsPsych multiplayer API.

It packages the common lobby / waiting-room pattern into a single declarative trial: show a prompt and a ready button, push `{ ready: true }` (optionally merged with `push_data`) into the shared group session when the participant clicks, display a waiting message, and end the trial once `expected_players` members are ready (or an optional `timeout` elapses while waiting for the rest of the group). Unlike `plugin-multiplayer-sync`, it owns the check-in UI and the "everyone is ready" condition, and standardizes on a `ready: true` flag so other plugins and examples can reliably gate on group readiness. Built against a local interface mirroring the multiplayer API (jsPsych#3694), so it carries no build-time dependency on the unreleased core.
