# @jspsych-multiplayer/adapter-multiplayer-local

## 0.2.0

### Minor Changes

- [#107](https://github.com/jspsych/jspsych-multiplayer/pull/107) [`af1f9b6`](https://github.com/jspsych/jspsych-multiplayer/commit/af1f9b66b7dea9151810bcbc594a2aeed522889f) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Port to the hardened multiplayer adapter contract.

  - **Breaking:** the `keyPrefix` option is renamed `namespace`, matching the other adapters. Passing `keyPrefix` logs a warning and is ignored.
  - **Breaking:** `persistParticipant` now defaults to `true`, so a reload keeps the tab's participant ID (in `sessionStorage`) and the group can tell that participant restarted instead of seeing a new stranger. Pass `persistParticipant: false` for a fresh ID on every page load, as before.
  - A lapsed heartbeat now calls the contract's `onResumed()` instead of reporting a synthetic `reconnecting` → `connected` blip.
  - Session and participant IDs are checked with `validateId` from `@jspsych-multiplayer/utils`: they may not contain any of `: / . # $ [ ]` (previously only `:` was rejected). The namespace may not contain `:`.
  - `getAll()` returns each participant's payload exactly as it was pushed.
  - The session ID, participant ID, and tab-ID helpers now come from `@jspsych-multiplayer/utils`, a new dependency.

- [#94](https://github.com/jspsych/jspsych-multiplayer/pull/94) [`362774c`](https://github.com/jspsych/jspsych-multiplayer/commit/362774c09f779073e65682cb1a219b0f995f7095) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Implement jsPsych's redesigned multiplayer adapter contract (jsPsych#3694): `connect()` now returns a new, independent connection each time, and the adapter reports changes through the `onChange()` callback instead of its own `subscribe()` / `get()`.

  Add presence: each tab writes a heartbeat, removes it on `pagehide` or disconnect, and drops out after `presenceTimeoutMs` (default 70 s) if it stops. New options `heartbeatIntervalMs` and `presenceTimeoutMs`. `disconnect()` no longer deletes the participant's data slot. An injected `signal` is no longer closed by the adapter, and `ChangeSignal.onChange()` now returns a function that removes the handler.

- [#103](https://github.com/jspsych/jspsych-multiplayer/pull/103) [`4687f75`](https://github.com/jspsych/jspsych-multiplayer/commit/4687f75fe77f9ee83e160a982b6835d75a420192) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Support rejoining. A tab whose heartbeat lapsed for longer than `presenceTimeoutMs` (a throttled background tab, or a page frozen in the back/forward cache) now reports `reconnecting` and then `connected` when its next heartbeat runs, so the other tabs count it as back (`onParticipantRejoined`) instead of leaving it `left`. A refresh is still a restart: with `persistParticipant: true` the same id returns from a new page load and the other tabs report it through `onParticipantRestarted`.

- [#105](https://github.com/jspsych/jspsych-multiplayer/pull/105) [`3f2f35c`](https://github.com/jspsych/jspsych-multiplayer/commit/3f2f35c0545c485e27e6e677708e80eb5139b246) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Report a `sessionId` on each connection, as the jsPsych multiplayer contract now requires. The local and Firebase adapters report their `sessionId` option (the `?mp_session=` value by default); the JATOS adapter reports the JATOS group result ID and rejects `connect()` if the channel opens without one. jsPsych seeds shared randomness (`jsPsych.multiplayer.random()` and related methods) with it, so every participant in a group gets the same values.

### Patch Changes

- Updated dependencies [[`403bfc4`](https://github.com/jspsych/jspsych-multiplayer/commit/403bfc482be7162b45432b0c7836af43c1eac919)]:
  - @jspsych-multiplayer/utils@0.1.0

## 0.1.0

### Minor Changes

- [#22](https://github.com/jspsych/jspsych-multiplayer/pull/22) [`2adafca`](https://github.com/jspsych/jspsych-multiplayer/commit/2adafcabe316cbbf588e9ba92805d52f9f09e417) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `adapter-multiplayer-local`, a zero-infrastructure multiplayer adapter backed by `localStorage` and signalled cross-tab.

  Swap it in for the JATOS adapter (`jsPsych.multiplayer.connect(new LocalAdapter())`) to run multiplayer experiments by opening two browser tabs — no server, no account. It is a development/demo/tutorial/CI tool only: `localStorage` and its cross-tab signalling are same-origin, same-browser, same-machine, so it cannot cross devices, browsers, or machines and must not be used to collect real data.

  It implements the same local `MultiplayerAdapter` mirror the JATOS adapter uses (no build-time dependency on the unreleased jsPsych#3694). The store is one key per participant (`mp:<session>:<participantId>`), reproducing JATOS's REPLACE-the-whole-slot semantics so plugins behave identically across adapters; a fresh session id per run (carried in the `?mp_session=` URL) namespaces keys to avoid stale "ghost" participants; and `push` self-notifies on a microtask so a tab's own waits resolve without reentrancy.
