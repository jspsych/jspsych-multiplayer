---
"@jspsych-multiplayer/adapter-multiplayer-firebase": minor
---

Add `adapter-multiplayer-firebase`, a Firebase Realtime Database backend for the jsPsych multiplayer API — real cross-device multiplayer with essentially no server to write or host.

It implements the same `MultiplayerAdapter` contract as the local and JATOS adapters, so plugins behave identically on any of them, and sits between them on the infrastructure spectrum: broader reach than the same-browser local adapter, far less setup than a self-hosted JATOS server.

Each `connect()` opens an independent connection that mirrors the session node (everyone's data) and a sibling presence node (who is connected), and resolves once both have loaded, rejecting on a rules denial, a timeout, or a cancelled attempt. Each participant's slot is JSON-encoded as a string so pushes round-trip exactly over RTDB's JSON coercion. Presence nodes are removed by the server through `onDisconnect()` when a participant's connection drops, which is how jsPsych detects dropouts; data slots are kept. `.info/connected` drives the connection's own `reconnecting` / `connected` status, and a listener cancelled after connecting reports `closed`.

An optional `useUidAsParticipantId` mode enables the recommended session-locked security rules: uid-as-key for slots and presence (no participant can write another's) plus first-write-wins session binding — `connect()` registers a `mp-sessions-memberships/<uid> = sessionId` record that the server-evaluated rules make immutable and then require on every session read and write, so a client identity can only ever touch the session it first joined. The recommended rules ship as `database.rules.json` (with a `firebase.json` for the emulator suite). `firebase` is a peer dependency, and the adapter is unit-tested against an in-memory backend fake with no credentials.
