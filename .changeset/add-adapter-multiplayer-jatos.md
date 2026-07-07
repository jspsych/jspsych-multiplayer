---
"@jspsych-multiplayer/adapter-multiplayer-jatos": minor
---

Add `adapter-multiplayer-jatos`, a JATOS group-study backend for the jsPsych multiplayer API.

It implements the `MultiplayerAdapter` contract (`connect` / `push` / `getAll` / `get` / `subscribe` / `disconnect`) over JATOS's group session and WebSocket channel, so multiplayer plugins (`plugin-multiplayer-sync`, `plugin-multiplayer-role`) run unchanged on JATOS. Each participant's data is namespaced under `groupSession[studyResultId]` (JATOS's group member id, unique per study run and — unlike `workerId` — never repeated across runs of the same worker; falls back to `workerId` if absent); `push()` retries on the group session's optimistic-concurrency version conflicts with exponential backoff + jitter. Ported from the reference implementation in jsPsych#3694; built against a local interface mirroring the adapter contract so it carries no build-time dependency on the unreleased core, and tested against an in-memory mock of the `jatos` global.
