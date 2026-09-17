---
id: multiplayer-api
title: jsPsych.multiplayer
sidebar_label: jsPsych.multiplayer
sidebar_position: 1
description: The core multiplayer API — the methods plugins and experiments use.
---

# `jsPsych.multiplayer`

The multiplayer API is a module on the jsPsych instance, alongside `jsPsych.data`. It is
inert until an adapter is connected.

Most experiments use it only for `connect()`; the plugins call the rest. It is available
directly for the cases plugins do not cover.

## Methods

### `connect(adapter): Promise<void>`

Registers a backend and joins the group session. Must resolve **before** `jsPsych.run()`,
because every multiplayer trial reaches the session through the connected adapter.

```js
const jsPsych = initJsPsych();

async function runExperiment() {
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal());
  await jsPsych.run(timeline);
}

runExperiment();
```

Top-level `await` only works in `<script type="module">`, so wrap the two calls in an
`async` function for a classic `<script>` tag.

### `participantId: string | null`

This client's stable ID within the session. Keys into the group session object. Read-only:
`null` until `connect()` resolves, and again after `disconnect()`.

### `push(data): Promise<void>`

**Replaces** the calling client's slot with `data`. It does not merge: any key the call
omits is gone, both for that client and for every other client reading the session.
Rejects — rather than throwing synchronously — when the API is not connected.

```js
await jsPsych.multiplayer.push({ offer: 4, joinedAt: myJoinedAt });
```

Whatever fields other clients depend on must be carried forward on every push. This is the
most common source of multiplayer bugs; see the
[ultimatum tutorial](/tutorials/ultimatum-game) for a worked example of the failure.

### `update(data): Promise<void>`

Shallow-**merges** `data` into the calling client's slot and pushes the result — the
`get` → merge → `push` sequence in one call, for plugins and experiments that only ever
change a few keys of their own slot.

The merge starts from this client's last successful write, so it does not depend on how
quickly the backend echoes writes back. One write is in flight at a time, and calls made
while one is in flight are merged into a single follow-up write that they all share, later
calls winning per key. A trial that updates faster than the backend confirms writes — a
drawing or chat plugin, say — therefore coalesces instead of building a queue. A direct
`push()` issued while updates are pending is not part of that ordering.

### `get(participantId): Record<string, unknown> | undefined`

One participant's slot, or `undefined` if that participant is not in the session. The
returned object is a JSON copy, so changing it affects nothing else.

### `getAll(): GroupSessionData`

Synchronous snapshot of the whole group session — a map from participant ID to slot. The
snapshot is a JSON copy, so session data must be JSON-serializable: `Date` objects come back
as strings, `undefined` values are dropped, and `NaN`/`Infinity` become `null`.

### `subscribe(callback): Unsubscribe`

Registers `callback` for live updates; returns a function that cancels it. The current
state is **replayed immediately on registration**, so a component mounting mid-session
renders at once instead of waiting for the next change.

Each callback gets its own JSON copy of the snapshot, so it can keep or change what it
receives without affecting the session or the other subscribers.

Every subscription is tracked internally. jsPsych cancels them all when the experiment ends
(after `on_finish`) and when `abortExperiment()` is called, and `disconnect()` cancels them
too. That covers the end of the experiment, but not the end of a single trial: a continuous
plugin must still release its own handle when its trial finishes, or it keeps rendering into
a display element that has moved on. An experiment should still `disconnect()` when it is
done, to release the slot.

```js
const unsubscribe = jsPsych.multiplayer.subscribe((group) => {
  render(group);
});
```

### `wait(condition, timeout?): Promise<GroupSessionData>`

Resolves with the group session once `condition(group)` returns true.

- Event-driven, built on `subscribe` — no polling.
- Fast-path: an already-true condition resolves immediately.
- With `timeout` (ms), rejects with a typed `MultiplayerTimeoutError`, so an experiment can
  detect an abandoned partner instead of hanging forever. `null`, `undefined`, negative and
  non-finite values all mean no timeout; `0` times out immediately.
- Rejects with a `MultiplayerCancelledError` if the wait is cancelled before its condition is
  met — by `cancelAllSubscriptions()`, `disconnect()`, `abortExperiment()`, or the end of
  `jsPsych.run()`. Match on `error.name`, which survives two loaded copies of jspsych where
  `instanceof` does not.
- A `condition` that throws rejects the promise rather than being silently swallowed.
- Resolves with a JSON copy of the snapshot, so later updates never change it.
- Rejects — rather than throwing synchronously — when the API is not connected.

`push()` followed by `wait()` is the **synchronization barrier** most turn-based paradigms
reduce to. `plugin-multiplayer-sync` packages that pair as one declarative trial, and is
usually the better choice for experiment code than calling these directly.

### `cancelAllSubscriptions(): void`

Releases every subscription registered through `subscribe()`, and rejects any pending
`wait()` with a `MultiplayerCancelledError`. jsPsych calls it for you when the experiment
ends and when `abortExperiment()` is called, so call it yourself only to stop listening
partway through an experiment.

### `disconnect(): Promise<void>`

Leaves the group session, cancelling all active subscriptions first.

## The adapter contract

An adapter is any object implementing:

```ts
interface MultiplayerAdapter {
  readonly participantId: string;

  connect(): Promise<void>;
  push(data: Record<string, unknown>): Promise<void>;
  getAll(): GroupSessionData;
  get(participantId: string): Record<string, unknown> | undefined;
  subscribe(cb: (data: GroupSessionData) => void): Unsubscribe;
  disconnect(): Promise<void>;
}
```

Note that `getAll` and `get` are **synchronous**: an adapter over an asynchronous backend
must maintain an in-memory mirror of the session and await its first snapshot during
`connect()`. `update()` and `wait()` are composed by the API on top of these six methods,
so an adapter does not implement them.

## The rules of the group session

1. **A client can write only its own slot**, and a write replaces it entirely. Write
   conflicts are impossible by construction.
2. **Every client can read every slot**, by snapshot or subscription.
3. **Shared decisions are computed, not negotiated** — every client runs the same
   deterministic function over the same session data and reaches the same conclusion, with
   no coordinator to disconnect.
