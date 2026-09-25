# @jspsych-multiplayer/adapter-multiplayer-jatos

## 0.2.0

### Minor Changes

- [#107](https://github.com/jspsych/jspsych-multiplayer/pull/107) [`af1f9b6`](https://github.com/jspsych/jspsych-multiplayer/commit/af1f9b66b7dea9151810bcbc594a2aeed522889f) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Port to the hardened multiplayer adapter contract.

  - **Breaking:** the `connectTimeoutMs` and `closeAfterReconnectingMs` options are removed; the adapter warns and ignores them. Use jsPsych's own options instead: `jsPsych.multiplayer.connect(adapter, { connectTimeout, reconnectTimeout })`. The adapter now honours the AbortSignal jsPsych passes to `connect()`, which also ends a join jatos.js keeps refusing while an old socket closes.
  - The adapter now relays a group seal itself. JATOS confirms `setGroupFixed()` only to the member who asked, so that member writes the sorted final roster into the group session under the reserved key `$sealed`. Every member that reads a record it trusts reports `sealed: true` with that roster, and rosters are merged so members who drop out after the seal stay on it. A record is trusted only if its writer and the reader are on it, it includes everyone `jatos.groupMembers` lists at the time, and everyone on it has been seen as a member or has written data.
  - `getAll()` returns only participant payloads, unchanged; group session keys starting with `$` are left out.
  - `sealGroup()` is left off the connection when jatos.js has no `setGroupFixed()`, so `jsPsych.multiplayer.sealGroup()` reports `unsupported` instead of the adapter throwing.
  - `push()` rejects at once while the group channel is down, and after 3 quick attempts (was 8) on repeated version conflicts; jsPsych retries with backoff and resends once the channel reopens. A push no longer waits indefinitely for the channel, which blocked every later write.
  - The participant ID (the study result ID) is checked with `validateId` from `@jspsych-multiplayer/utils`, a new dependency.

- [#105](https://github.com/jspsych/jspsych-multiplayer/pull/105) [`3f2f35c`](https://github.com/jspsych/jspsych-multiplayer/commit/3f2f35c0545c485e27e6e677708e80eb5139b246) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Report a `sessionId` on each connection, as the jsPsych multiplayer contract now requires. The local and Firebase adapters report their `sessionId` option (the `?mp_session=` value by default); the JATOS adapter reports the JATOS group result ID and rejects `connect()` if the channel opens without one. jsPsych seeds shared randomness (`jsPsych.multiplayer.random()` and related methods) with it, so every participant in a group gets the same values.

- [#106](https://github.com/jspsych/jspsych-multiplayer/pull/106) [`cba1c47`](https://github.com/jspsych/jspsych-multiplayer/commit/cba1c47ae3fa177085983ac7ea3e17c77061a5c5) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Report the JATOS group through the core's `group()` and `sealGroup()`: the size is the batch's `maxActiveMembers`, the members are `jatos.groupMembers`, and sealing fixes the group with `jatos.setGroupFixed()`. By default the adapter fixes the group once it is full (`sealWhenFull: true`), so a member who leaves mid-study counts as a dropout instead of freeing their place for a newcomer. Experiments can hold participants in a waiting room with `jsPsych.multiplayer.waitForGroup()`.

- [#103](https://github.com/jspsych/jspsych-multiplayer/pull/103) [`d54626d`](https://github.com/jspsych/jspsych-multiplayer/commit/d54626dcff02a4608c1913f52c58157cae541aeb) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Support rejoining the group from the same page.

  - **Behavior change:** `closeAfterReconnectingMs` now defaults to `null` (never give up) instead of 30 s, so a participant whose group channel reopens after a long outage rejoins instead of having their session closed. Set a limit to restore the old behavior.
  - `connect()` right after `disconnect()` no longer fails while the old socket is still closing: the adapter retries jatos.js's "not in readyState CLOSED" refusal until the socket has closed, within `connectTimeoutMs`.
  - A `connect()` made while a closed connection is still leaving the group, or while a cancelled join is still in flight, now waits for it instead of rejecting. The page-wide guard is also held until an opened channel has finished leaving, so a quick reconnect no longer hits jatos.js's "can't open group channel while leaving a group".

- [#94](https://github.com/jspsych/jspsych-multiplayer/pull/94) [`baf23da`](https://github.com/jspsych/jspsych-multiplayer/commit/baf23da3440954985f2facf9d6265922acf72218) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - **Breaking:** implement the redesigned multiplayer adapter contract from jsPsych#3694.

  - `connect(options)` now returns a new `MultiplayerConnection` for each call, with `getAll()`, `connectedParticipants()`, `push()`, and `disconnect()`. The adapter's own `subscribe()` and `get()` are gone; the adapter reports changes through `options.onChange()`, and jsPsych's multiplayer session handles subscriptions.
  - **Presence:** `connectedParticipants()` returns the members with an open group channel (`jatos.groupChannels`), and member join/leave/open/close events are reported, so jsPsych can mark participants who drop out as `away` and then `left`.
  - **Connection status:** a dropped group channel is reported as `reconnecting` and a reopened one as `connected`. A channel that stays down longer than the new `closeAfterReconnectingMs` option (default 30000 ms) is reported as `closed`. While the channel is down, reads return the last group session data instead of the empty data jatos.js holds.
  - `push()` waits for a dropped channel to reopen instead of failing.
  - `connect()` honors the abort signal, rejects promptly when jatos.js refuses to open a channel, and rejects while another connection on the page is open or still joining (jatos.js supports one group channel per page). If a cancelled connect's channel opens anyway, the adapter leaves the group.

### Patch Changes

- Updated dependencies [[`403bfc4`](https://github.com/jspsych/jspsych-multiplayer/commit/403bfc482be7162b45432b0c7836af43c1eac919)]:
  - @jspsych-multiplayer/utils@0.1.0

## 0.1.0

### Minor Changes

- [#17](https://github.com/jspsych/jspsych-multiplayer/pull/17) [`4d26f2e`](https://github.com/jspsych/jspsych-multiplayer/commit/4d26f2ec9c441f812f214bb30ced318f15749dab) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `adapter-multiplayer-jatos`, a JATOS group-study backend for the jsPsych multiplayer API.

  It implements the `MultiplayerAdapter` contract (`connect` / `push` / `getAll` / `get` / `subscribe` / `disconnect`) over JATOS's group session and WebSocket channel, so multiplayer plugins (`plugin-multiplayer-sync`, `plugin-multiplayer-role`) run unchanged on JATOS. Each participant's data is namespaced under `groupSession[studyResultId]` (JATOS's group member id, unique per study run and — unlike `workerId` — never repeated across runs of the same worker; falls back to `workerId` if absent); `push()` retries on the group session's optimistic-concurrency version conflicts with exponential backoff + jitter. Ported from the reference implementation in jsPsych#3694; built against a local interface mirroring the adapter contract so it carries no build-time dependency on the unreleased core, and tested against an in-memory mock of the `jatos` global.
