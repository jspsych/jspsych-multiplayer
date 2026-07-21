---
"@jspsych-multiplayer/plugin-multiplayer-countdown": minor
---

Add `plugin-multiplayer-countdown`, a synchronized group timer (countdown or count-up) for the jsPsych multiplayer API.

Every participant pushes its own start timestamp into its own slot, and each client derives the displayed time from the **minimum** timestamp across all slots — a coordination-free consensus (no elected anchor, no single point of failure) in the same spirit as `plugin-multiplayer-role`'s ordering. Late joiners and refreshes resume at the group's actual remaining time for free, and the pure consensus core (`startedAtKey` / `resolveStartedAt` / `computeRemaining` / `computeElapsed` / `formatTime`) is exposed as statics on the default export so demos can render their own synced display. Built against a local interface mirroring the multiplayer API (jsPsych#3694), so it carries no build-time dependency on the unreleased core.
