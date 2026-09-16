# @jspsych-multiplayer/adapter-multiplayer-jatos

A multiplayer **adapter** that backs the jsPsych multiplayer API with [JATOS](https://www.jatos.org/) group studies. It implements the `MultiplayerAdapter` contract — `connect` / `push` / `getAll` / `get` / `subscribe` / `disconnect` — over JATOS's group session and WebSocket channel, so multiplayer plugins (e.g. `@jspsych-multiplayer/plugin-multiplayer-sync`, `@jspsych-multiplayer/plugin-multiplayer-role`) run unchanged on JATOS.

> **Status:** built against the multiplayer adapter contract from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. The adapter implements a local interface mirroring `MultiplayerAdapter` (`src/multiplayer-adapter.ts`) copied verbatim from that PR — the single seam to re-verify once #3694 lands. Tests run against an in-memory mock of the `jatos` global, so no live JATOS server is needed.

## Prerequisites

The experiment must run **inside JATOS as a group study**, with `jatos.js` loaded before your experiment script. The adapter throws on construction if the `jatos` global is absent.

## Usage

```js
import { initJsPsych } from "jspsych";
import JatosAdapter from "@jspsych-multiplayer/adapter-multiplayer-jatos";

const jsPsych = initJsPsych({
  on_finish: () => jatos.endStudy(jsPsych.data.get().json()),
});

await jsPsych.multiplayer.connect(new JatosAdapter());
await jsPsych.run(timeline);
```

Once connected, multiplayer plugins and the raw `jsPsych.multiplayer` (`push`, `wait`, `get`, `getAll`, `subscribe`, `update`) work against the JATOS group session.

## Presence and fixed groups

JATOS distinguishes three concepts that must not be conflated:

- `groupSession` is retained shared data. `getAll()` continues to return a participant's records after their channel closes.
- `groupMembers` is the set currently assigned to the group.
- `groupChannels` is the ephemeral set whose WebSocket channels are currently open.

The standard `MultiplayerAdapter` contract covers the first concept. `JatosAdapter` additionally
exposes JATOS-specific lifecycle capabilities without changing that contract:

```js
const adapter = new JatosAdapter();
await jsPsych.multiplayer.connect(adapter);

console.log(adapter.groupId); // stable groupResultId shared by the dyad
console.log(adapter.getPresence());

const unsubscribe = adapter.subscribePresence((event) => {
  // Called immediately with `snapshot`, then for member/channel/local lifecycle events.
  console.log(event.type, event.snapshot.assignedMemberIds, event.snapshot.openChannelMemberIds);
});

// Once the required live participants are present, prevent later replacement.
await adapter.sealGroup();
unsubscribe();
```

`getPresence()` and every event snapshot are frozen copies; they never expose JATOS's mutable
`groupMembers` or `groupChannels` arrays. `subscribePresence()` replays immediately and returns an
unsubscribe function. A peer channel close removes that peer only from `openChannelMemberIds`; it
does not modify group-session data or by itself remove group membership.

`groupId` is cached on the first successful channel open because jatos.js clears its group globals
during a transient channel loss. The cached ID remains available through close/reopen and explicit
disconnect. An automatic reopen must report the same ID or the adapter emits `local-error` and stays
closed. A later explicit `connect()` after `disconnect()` may join another group and replace the
cached ID.

`sealGroup()` wraps `jatos.setGroupFixed()`. It requires an open local channel, deduplicates
concurrent/repeated successful calls, and rejects with the JATOS failure as `cause`. A fixed group
may lose members but cannot admit replacements. Configure the JATOS batch's `maxActiveMembers` for
the simultaneous group size (two for a dyad); choose `maxTotalMembers` deliberately depending on
whether pre-game replacement is allowed, then call `sealGroup()` at the transition from lobby to
game. Allocation and reassignment remain JATOS responsibilities.

### Lifecycle semantics

- Initial `onOpen` and an automatic reopen emit `local-open`; local close/error emits
  `local-close`/`local-error`. Presence subscribers survive automatic reconnects.
- Peer join/open/close/leave callbacks emit distinct events after taking a new snapshot.
- `disconnect()` immediately emits `local-disconnect`, invalidates stale reconnect callbacks, and
  then emits `left-group` or `leave-failed`. It continues to fulfill the existing adapter contract
  by resolving after either leave outcome; consumers that need to distinguish them subscribe to
  lifecycle events. All presence subscribers are cleared after that terminal event.
- A timed-out/failed `connect()` can be retried, and callbacks from the abandoned attempt are
  ignored so they cannot revive a torn-down adapter.
- Calling `disconnect()` while `connect()` is pending rejects the connection attempt as cancelled
  before leaving the group, so neither operation can leave an unresolved promise behind.

## How it works

- **Participant namespace.** Each participant's pushed data is stored under `groupSession[studyResultId]` (the JATOS study result id, stringified as `participantId`), so writes from different participants never collide. The study result id is used rather than the worker id because it is unique per study run — the same `workerId` can recur across runs of the same worker. It is also exactly what JATOS calls the group member id: jatos.js assigns `jatos.groupMemberId = jatos.studyResultId` once group messages arrive — but `groupMemberId` itself stays `null` until after `joinGroup()`, so the adapter reads `studyResultId`, which carries the same value and is available at construction time. If `jatos.studyResultId` is not populated, the adapter falls back to `jatos.workerId`.
- **Write concurrency.** The JATOS group session uses optimistic concurrency, so simultaneous writes can hit version conflicts. `push()` makes up to 8 attempts (1 initial + 7 retries) with exponential backoff + jitter, then throws — preserving the underlying error as `cause` — if it still can't commit. Each attempt re-sends the same `participantId → data` write, so retrying can never lose or double-apply another participant's update. If the channel closes mid-retry, `push()` stops early and reports the closed channel rather than spinning out the full backoff against a dead connection.
- **Connection lifecycle.** `connect()` resolves when the group channel opens and rejects with a diagnostic if joining fails or if JATOS reports nothing within 20 s (a dropped handshake — configurable via `new JatosAdapter({ connectTimeoutMs })`), so it never hangs silently. Calling `connect()` again while a connect is in flight (or already settled) returns the same promise instead of joining the group twice; after a failed attempt, `connect()` can be retried. If JATOS closes and later reopens the channel, the adapter picks the connection back up — `push()` works again after the reopen. If the channel later closes — `jatos` fires `onClose`, or delivers an error after the channel was already open — the adapter marks itself disconnected, so a subsequent `push()` fails loudly with an accurate "channel closed" message instead of retrying a dead connection. Subscriptions are left intact across a close (the channel may reopen); full teardown happens only via `disconnect()`.
- **Updates.** `jatos`'s `onGroupSession` accepts only one callback, so the adapter registers a single dispatcher and fans out to all `subscribe()` listeners. Subscriptions are **future-only** — they fire on the next update and do not replay the current snapshot on registration. The core MultiplayerAPI handles replay-on-registration itself (it emits the current snapshot once when wrapping this adapter's `subscribe()`), so keeping the adapter future-only is exactly what core expects — replaying here too would double the initial emit.

## Notes

This package provides transport, JATOS lifecycle/presence, and the JATOS group-fixing primitive.
Lobby UI, timeouts, participant routing, payments, and role assignment do not belong in the adapter.
