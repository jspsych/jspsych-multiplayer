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
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal());
jsPsych.run(timeline);
```

### `participantId: string`

This client's stable ID within the session. Keys into the group session object.

### `push(data): Promise<void>`

**Replaces** the calling client's slot with `data`. It does not merge: any key the call
omits is gone, both for that client and for every other client reading the session.

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

Not atomic against itself: overlapping calls from the same client race, so `await` each one
before issuing the next.

### `get(participantId): Record<string, unknown> | undefined`

One participant's slot, or `undefined` if that participant is not in the session.

### `getAll(): GroupSessionData`

Synchronous snapshot of the whole group session — a map from participant ID to slot.

### `subscribe(callback): Unsubscribe`

Registers `callback` for live updates; returns a function that cancels it. The current
state is **replayed immediately on registration**, so a component mounting mid-session
renders at once instead of waiting for the next change.

All subscriptions are tracked centrally and cancelled at experiment end, so a forgotten
unsubscribe cannot leave a ghost listener running.

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
  detect an abandoned partner instead of hanging forever.
- A `condition` that throws rejects the promise rather than being silently swallowed.

`push()` followed by `wait()` is the **synchronization barrier** most turn-based paradigms
reduce to. `plugin-multiplayer-sync` packages that pair as one declarative trial, and is
usually the better choice for experiment code than calling these directly.

### `disconnect(): Promise<void>`

Leaves the group session.

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
