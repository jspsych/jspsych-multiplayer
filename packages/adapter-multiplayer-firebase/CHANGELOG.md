# @jspsych-multiplayer/adapter-multiplayer-firebase

## 0.2.0

### Minor Changes

- [#107](https://github.com/jspsych/jspsych-multiplayer/pull/107) [`af1f9b6`](https://github.com/jspsych/jspsych-multiplayer/commit/af1f9b66b7dea9151810bcbc594a2aeed522889f) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Implement the hardened multiplayer adapter contract. `getAll()` returns each stored payload unchanged, and the connection calls `onResumed()` when the server removed its presence without the connection seeing a drop. With matchmaking, every member now sees the seal and the final roster.

  Breaking changes:

  - `pathPrefix` is renamed to `namespace`, and `connectTimeoutMs` is removed: pass `connectTimeout` to `jsPsych.multiplayer.connect()` instead. Passing either old option throws.
  - The default participant id is now kept per tab in `sessionStorage` (`persistParticipant`, default `true`), so a reload comes back as the same participant, in the same group, and jsPsych reports it as a restart. Pass `persistParticipant: false` for a new participant on every page load.
  - `sessionBinding` now defaults to `true` in every identity mode.
  - New security rules. Each connection claims its participant id (`<namespace>-owners/<session>/<id> = uid`), and only that uid can write the participant's data and presence, whatever the identity mode. Matchmaking groups are stored as per-seat entries tied to the holder's uid, plus a sealed roster that must match the seats. The lobby can only move off a sealed group. Update your database rules from the README (the quick-start rules now cover every node too). Groups formed by an earlier version aren't read.
  - Uses `@jspsych-multiplayer/utils` for session ids, id generation, and id validation. Invalid-id errors now read "must be a non-empty string without any of : / . # $ [ ]".

- [#105](https://github.com/jspsych/jspsych-multiplayer/pull/105) [`3f2f35c`](https://github.com/jspsych/jspsych-multiplayer/commit/3f2f35c0545c485e27e6e677708e80eb5139b246) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Report a `sessionId` on each connection, as the jsPsych multiplayer contract now requires. The local and Firebase adapters report their `sessionId` option (the `?mp_session=` value by default); the JATOS adapter reports the JATOS group result ID and rejects `connect()` if the channel opens without one. jsPsych seeds shared randomness (`jsPsych.multiplayer.random()` and related methods) with it, so every participant in a group gets the same values.

- [#43](https://github.com/jspsych/jspsych-multiplayer/pull/43) [`565ff2f`](https://github.com/jspsych/jspsych-multiplayer/commit/565ff2f67a7dbda4cc86a81b3c2b361ba91225da) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `adapter-multiplayer-firebase`, a Firebase Realtime Database backend for the jsPsych multiplayer API — real cross-device multiplayer with essentially no server to write or host.

  It implements the same `MultiplayerAdapter` contract as the local and JATOS adapters, so plugins behave identically on any of them, and sits between them on the infrastructure spectrum: broader reach than the same-browser local adapter, far less setup than a self-hosted JATOS server.

  Each `connect()` opens an independent connection that mirrors the session node (everyone's data) and a sibling presence node (who is connected), and resolves once both have loaded, rejecting on a rules denial, a timeout, or a cancelled attempt. Each participant's slot is JSON-encoded as a string so pushes round-trip exactly over RTDB's JSON coercion. Presence nodes are removed by the server through `onDisconnect()` when a participant's connection drops, which is how jsPsych detects dropouts; data slots are kept. `.info/connected` drives the connection's own `reconnecting` / `connected` status, and a listener cancelled after connecting reports `closed`.

  An optional `useUidAsParticipantId` mode enables the recommended session-locked security rules: uid-as-key for slots and presence (no participant can write another's) plus first-write-wins session binding — `connect()` registers a `mp-sessions-memberships/<uid> = sessionId` record that the server-evaluated rules make immutable and then require on every session read and write, so a client identity can only ever touch the session it first joined. The recommended rules ship as `database.rules.json` (with a `firebase.json` for the emulator suite). `firebase` is a peer dependency, and the adapter is unit-tested against an in-memory backend fake with no credentials.

- [#94](https://github.com/jspsych/jspsych-multiplayer/pull/94) [`ffebbe6`](https://github.com/jspsych/jspsych-multiplayer/commit/ffebbe6bf850185a021e82de5ccd475d29e9f043) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Adopt the redesigned jsPsych multiplayer adapter contract (jsPsych#3694): `connect(options)` returns a new connection each time, change notifications go through `onChange()` / `onStatus()` instead of adapter-side `subscribe()`, and `connect()` honors the cancellation signal. Presence now lives in a separate `<pathPrefix>-presence` node (add it to your security rules; see the README), and `disconnect()` or a dropped connection no longer deletes the participant's data slot. The `removeOnDisconnect` option is removed.

- [#106](https://github.com/jspsych/jspsych-multiplayer/pull/106) [`bba1dc2`](https://github.com/jspsych/jspsych-multiplayer/commit/bba1dc2def3418b167e570ef305b54747c6a935c) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Add `matchmaking: { lobby, groupSize }`: everyone opens the same link, and the adapter fills groups of `groupSize` as participants arrive, instead of grouping them by `?mp_session=` link. Each step of joining is a Realtime Database transaction, so two participants who arrive together can't both take the last place. A group is sealed when its last place is taken (or early, with `jsPsych.multiplayer.sealGroup()`), and the adapter reports it through the core's `group()`, so `jsPsych.multiplayer.waitForGroup()` can hold participants in a waiting room. While a group is filling, a participant who leaves gives up their place. The recommended rules gain `mp-sessions-lobby` and `mp-sessions-groups` entries; redeploy them to use matchmaking.

### Patch Changes

- [#103](https://github.com/jspsych/jspsych-multiplayer/pull/103) [`c875c70`](https://github.com/jspsych/jspsych-multiplayer/commit/c875c70def25fdec4675c400490daf46771c7ae1) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Document and test rejoining: a participant whose connection drops and recovers on the same page rejoins (`onParticipantRejoined`), while a reload under the same participant id is reported as a restart (`onParticipantRestarted`). No behavior change was needed.

- [#90](https://github.com/jspsych/jspsych-multiplayer/pull/90) [`e698fc5`](https://github.com/jspsych/jspsych-multiplayer/commit/e698fc56c84aa507bd73bc0ddfb376840e475e6f) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Stop cleanly when the experiment ends or is aborted.

  A pending `wait()` now rejects with a `MultiplayerCancelledError` when the experiment ends or is
  aborted, instead of hanging. The plugins that wait on the group (choice, match, ready, role,
  scoreboard, sync) stop quietly on that error rather than treating it as a timeout or a backend
  failure. `plugin-multiplayer-scoreboard` previously logged an error and drew a final board over the
  cleared display, leaving a Continue button that called `finishTrial` after the run had ended.

  Fixes found alongside that work: `plugin-multiplayer-countdown` and `plugin-multiplayer-draw`
  registered their repeating timers with a raw `setInterval`, which survived `abortExperiment()` — the
  countdown could call `finishTrial` after the run ended and draw kept writing to the session forever;
  both now tick through jsPsych's own timer registry. `plugin-multiplayer-chat` and
  `plugin-multiplayer-reference-game` could drop a message when a participant sent two in quick
  succession; they no longer do. `adapter-multiplayer-firebase` marked itself connected before arming
  its disconnect cleanup, so a failure there left a connected-looking adapter with a leaked listener
  and a retry that silently did nothing; a failed `connect()` now releases everything it opened.

- Updated dependencies [[`403bfc4`](https://github.com/jspsych/jspsych-multiplayer/commit/403bfc482be7162b45432b0c7836af43c1eac919)]:
  - @jspsych-multiplayer/utils@0.1.0
