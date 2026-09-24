---
id: multiplayer-api
title: jsPsych.multiplayer
sidebar_label: jsPsych.multiplayer
sidebar_position: 1
description: The core multiplayer API — the methods plugins and experiments use.
---

# `jsPsych.multiplayer`

The multiplayer API is a module on the jsPsych instance, alongside `jsPsych.data`. It does
nothing until you connect an adapter.

Most experiments use it only for `connect()`; the plugins call the rest. It is available
directly for the cases plugins do not cover. This page summarizes the API; the complete
reference ships with jsPsych itself, in
[jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694).

## The shared data

Each participant has a **slot**: an object that only they write and that everyone in the
group can read. Together the slots form the group's **shared data**, a map from participant
ID to slot (type `GroupSessionData`).

- **Your own writes show up at once.** `push()` and `update()` change your slot immediately,
  so your own reads, subscribers, and `wait()` calls see the new data before the backend
  confirms it. The promise a write returns resolves when the backend confirms it.
- **Only the latest value is sent.** One write is sent at a time; writes made while one is
  in flight are combined into the next. Others always end up with your latest data but may
  never see a value you replaced before it was sent. Keep _state_ in your slot; for _events_
  every participant must see (chat messages, individual clicks), append to a list or keep a
  counter.
- **Data is plain JSON.** Each write is copied as JSON when you make it. `BigInt` and
  circular data make the write reject, `Date` values become strings, and `undefined` values
  are dropped.
- **Reads are frozen and shared.** `getAll()`, `get()`, subscribers, and `wait()` all receive
  the same frozen object. Changing it throws a `TypeError`; copy it first if you need a
  modified version.

## Presence

The session tracks whether each participant is still in the group:

| Status      | Meaning                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `connected` | The participant is connected.                                                                              |
| `away`      | The participant's connection dropped. Brief network interruptions look like this.                          |
| `left`      | The participant has been away longer than the dropout timeout (10 s by default). This status is permanent. |

A participant's slot stays in the shared data after they leave, so count participants by
presence, not by slot. While your own connection is down, the session pauses everyone
else's dropout timers. See [Handling dropouts](/guides/handling-dropouts) for how the
plugins use presence.

## Methods

### `connect(adapter, options?): Promise<MultiplayerSession>`

Opens a session with the adapter and makes it the current session. Must resolve **before**
`jsPsych.run()`.

```js
const jsPsych = initJsPsych();

async function runExperiment() {
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal(), {
    onParticipantLeft: () => jsPsych.abortExperiment("Your partner left the study."),
  });
  await jsPsych.run(timeline);
}

runExperiment();
```

Top-level `await` only works in `<script type="module">`, so wrap the two calls in an
`async` function for a classic `<script>` tag.

| Option              | Description                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `dropoutTimeout`    | How long, in ms, a participant can stay disconnected before they count as `left`. Default `10000`; `null` or `Infinity` means never. |
| `onParticipantLeft` | Called with a participant's ID when they become `left`.                                                                              |
| `onStatusChange`    | Called with this participant's new connection status.                                                                                |
| `signal`            | An `AbortSignal` that cancels a `connect()` still in progress.                                                                       |

`connect()` rejects if a session is already open or connecting; call `disconnect()` first. A
session whose connection was lost can be replaced directly. A cancelled `connect()` rejects
with a `MultiplayerCancelledError` once the adapter has closed anything it opened.

### `participantId`, `status`, `session`

- `participantId: string | null` — this participant's ID; `null` without a session.
- `status: "connected" | "reconnecting" | "closed" | null` — this participant's connection.
- `session: MultiplayerSession | null` — the current session, the object `connect()`
  returned. It has the same methods as `jsPsych.multiplayer`, except `connect()`.

### `push(data): Promise<void>`

**Replaces** your slot with `data`. Any key the call omits is gone, for you and for everyone
reading the shared data. Whatever fields other participants depend on must be carried
forward; see the [ultimatum tutorial](/tutorials/ultimatum-game) for the failure this causes.

### `update(data): Promise<void>`

Shallow-**merges** `data` into your slot: top-level keys in `data` replace the same keys,
and other keys are kept. A nested object replaces the whole nested object.

### `get(participantId)`, `getAll()`, `presence()`

`get()` returns one participant's slot, or `undefined`. `getAll()` returns the whole shared
data. `presence()` returns each participant's presence status, including your own (`away`
while reconnecting, `left` once closed). All three are frozen.

### `subscribe(callback, options?): Unsubscribe`

Calls `callback(data, presence)` immediately with the current state, then after every
change: another participant's write, your own write, or a change in presence. Returns a
function that removes the subscription; aborting `options.signal` does the same.

When the session closes, by `disconnect()` or a lost connection, each callback is called
one last time, with your own presence `left`, and then removed. A plugin that only
subscribes uses this call to learn that the session has closed.

jsPsych removes all subscriptions when the timeline finishes (before `on_finish`, so
`on_finish` can still write) and when `abortExperiment()` is called. A plugin should still
remove its own subscriptions when its trial ends; one `AbortController` per trial, passed as
`signal` and aborted at the end, does that.

```js
const controller = new AbortController();
jsPsych.multiplayer.subscribe((group, presence) => render(group, presence), {
  signal: controller.signal,
});
// When the trial ends:
controller.abort();
```

### `wait(condition, options?): Promise<GroupSessionData>`

Resolves with the shared data once `condition(data, presence)` returns true. It checks the
current state first, so an already-true condition resolves at once.

| Option         | Description                                                                             |
| -------------- | --------------------------------------------------------------------------------------- |
| `timeout`      | The longest time to wait, in ms. `null`, negative, and non-finite values mean no limit. |
| `participants` | Participants the wait depends on. If one of them leaves first, the wait rejects.        |
| `signal`       | An `AbortSignal` that cancels the wait.                                                 |

The second argument must be an object. The older `wait(condition, 30000)` form rejects with
a `TypeError` instead of silently waiting forever.

The promise rejects with one of these errors, or with whatever `condition` throws:

| `error.name`                       | Cause                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `MultiplayerTimeoutError`          | `timeout` elapsed.                                                                                            |
| `MultiplayerParticipantLeftError`  | A participant in `participants` left; `error.participantId` says who.                                         |
| `MultiplayerCancelledError`        | The wait was cancelled by `signal`, `cancelAllSubscriptions()`, `disconnect()`, or the end of the experiment. |
| `MultiplayerConnectionClosedError` | This participant's connection was lost for good.                                                              |

Compare `error.name`, not `instanceof`, which fails when a page loads two copies of jsPsych.

`push()` followed by `wait()` is the **synchronization barrier** most turn-based paradigms
reduce to. `plugin-multiplayer-sync` packages that pair as one declarative trial, and is
usually the better choice for experiment code.

### `cancelAllSubscriptions(): void`

Removes every subscription on the current session and rejects its pending `wait()` calls
with a `MultiplayerCancelledError`. The connection stays open.

### `disconnect(): Promise<void>`

Closes the current session, or cancels a `connect()` in progress. Subscribers get their
last call, pending `wait()` calls reject with a `MultiplayerCancelledError`, and
unconfirmed writes reject. Your slot stays in the shared data; the others see you as `left`.

## The adapter contract

An adapter has two parts. The **adapter** holds configuration; each call to its
`connect()` opens a new, independent **connection**:

```ts
interface MultiplayerAdapter {
  connect(options: {
    signal: AbortSignal;
    onChange(): void; // call when getAll() or connectedParticipants() may have changed
    onStatus(status: "connected" | "reconnecting" | "closed"): void;
  }): Promise<MultiplayerConnection>;
}

interface MultiplayerConnection {
  readonly participantId: string;
  getAll(): GroupSessionData;
  connectedParticipants(): string[];
  push(data: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
}
```

`getAll()` and `connectedParticipants()` are **synchronous**: an adapter over an
asynchronous backend keeps an in-memory mirror and fills it during `connect()`. Presence
comes from `connectedParticipants()`, which lists open connections, not participants who
have data. `update()`, `wait()`, subscriptions, copying, and presence are all built by the
API on top of these methods, so an adapter does not implement them. jsPsych's
"Multiplayer Adapter Development" page, part of
[jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), covers each method in detail.

## The rules of the group session

1. **A participant can write only their own slot.** Write conflicts are impossible by
   construction.
2. **Every participant can read every slot**, by snapshot or subscription.
3. **Shared decisions are computed, not negotiated** — every client runs the same
   deterministic function over the same data and reaches the same conclusion, with no
   coordinator to lose.
