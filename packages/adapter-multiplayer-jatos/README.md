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

await jsPsych.pluginAPI.connect(new JatosAdapter());
await jsPsych.run(timeline);
```

Once connected, multiplayer plugins and the raw `jsPsych.pluginAPI` (`push`, `wait`, `get`, `getAll`, `subscribe`, `communicate`) work against the JATOS group session.

## How it works

- **Participant namespace.** Each participant's pushed data is stored under `groupSession[groupMemberId]` (the JATOS group member id, stringified as `participantId`), so writes from different participants never collide. The group member id is used rather than the worker id because it is unique per group membership — the same `workerId` can recur across runs of the same worker. If `jatos.groupMemberId` is not populated, the adapter falls back to `jatos.workerId`.
- **Write concurrency.** The JATOS group session uses optimistic concurrency, so simultaneous writes can hit version conflicts. `push()` makes up to 8 attempts (1 initial + 7 retries) with exponential backoff + jitter, then throws — preserving the underlying error as `cause` — if it still can't commit. Each attempt re-sends the same `participantId → data` write, so retrying can never lose or double-apply another participant's update. If the channel closes mid-retry, `push()` stops early and reports the closed channel rather than spinning out the full backoff against a dead connection.
- **Connection lifecycle.** `connect()` resolves when the group channel opens and rejects with a diagnostic if joining fails or if JATOS reports nothing within 20 s (a dropped handshake — configurable via `new JatosAdapter({ connectTimeoutMs })`), so it never hangs silently. Calling `connect()` again while a connect is in flight (or already settled) returns the same promise instead of joining the group twice; after a failed attempt, `connect()` can be retried. If JATOS closes and later reopens the channel, the adapter picks the connection back up — `push()` works again after the reopen. If the channel later closes — `jatos` fires `onClose`, or delivers an error after the channel was already open — the adapter marks itself disconnected, so a subsequent `push()` fails loudly with an accurate "channel closed" message instead of retrying a dead connection. Subscriptions are left intact across a close (the channel may reopen); full teardown happens only via `disconnect()`.
- **Updates.** `jatos`'s `onGroupSession` accepts only one callback, so the adapter registers a single dispatcher and fans out to all `subscribe()` listeners. Subscriptions are **future-only** — they fire on the next update and do not replay the current snapshot on registration. The core MultiplayerAPI handles replay-on-registration itself (it emits the current snapshot once when wrapping this adapter's `subscribe()`), so keeping the adapter future-only is exactly what core expects — replaying here too would double the initial emit.

## Notes

This package provides the network backend only. Synchronization logic (barriers, lobbies) and role assignment live in the multiplayer plugins; this adapter just moves data.
