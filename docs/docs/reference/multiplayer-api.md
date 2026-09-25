---
id: multiplayer-api
title: jsPsych.multiplayer
sidebar_label: jsPsych.multiplayer
description: The core multiplayer API — the methods plugins and experiments use.
---

# `jsPsych.multiplayer`

The multiplayer API is a module on the jsPsych instance, alongside `jsPsych.data`. It does
nothing until you connect an adapter.

Most experiments use it only for `connect()`; the plugins call the rest. It is available
directly for the cases plugins do not cover. This page summarizes the API; the complete
reference ships with jsPsych itself, in
[jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694) (the `jsPsych.multiplayer`
reference page and the "Multiplayer Adapter Development" page).

## The shared data

Each participant has their own data, which only they write and everyone in the group can
read. Together they form the group's **shared data**: an object that maps each participant ID
to that participant's data (type `GroupSessionData`).

- **Your own writes show up at once.** `update()` and `replace()` change your data
  immediately, so your own reads, subscribers, and `wait()` calls see it before the backend
  confirms it. The promise a write returns resolves when the backend confirms it. If the
  backend rejects a write, the session retries, waiting a little longer each time.
- **Only the latest value is sent.** One write is sent at a time; writes made while one is
  in flight are combined into the next. Others always end up with your latest data but may
  never see a value you replaced before it was sent. Keep _state_ in your data; for _events_
  every participant must see (chat messages, individual clicks), append to a list or keep a
  counter.
- **Wait for conditions that stay true.** For the same reason, a partner may never see an
  in-between value. If the host moves through phases, don't wait for `phase === "feedback"`;
  have the host count steps and wait for `step >= 3`.
- **Data is plain JSON.** Each write is copied as JSON when you make it. `BigInt` and
  circular data make the write reject, `Date` values become strings, and keys whose value is
  `undefined` are dropped.
- **Reads are frozen and shared.** `getAll()`, `get()`, subscribers, and `wait()` all receive
  the same frozen object. Changing it throws a `TypeError`; copy it first if you need a
  modified version.
- **Reads keep working after the session closes.** `getAll()`, `get()`, `presence()`, and
  `group()` return the last state they saw. Writes and `wait()` stop working.

## Scopes

The shared data is divided into **scopes**. During a trial, every read, write, subscription,
and wait uses that **trial's own scope** unless you say otherwise. Data written in one trial
does not appear in the next one, so a plugin can write `{ choice: "left" }` in every round
without an answer from an earlier round satisfying a new wait.

- **The trial scope's name** comes from the trial's position in the timeline, such as `#3` or
  `#2.1`. Every participant running the same timeline gets the same name for the same trial,
  so they share that trial's data. Each repetition and each pass through a loop is a new
  position, so a repeated trial gets a fresh scope every time. A skipped conditional timeline
  still counts, so skipping it for some participants doesn't shift the names of later trials.
- **The session scope** holds data that lasts the whole session, such as a nickname or a
  role. Pass `{ scope: "session" }` to use it during a trial. Outside a trial, calls use the
  session scope by default: code before `jsPsych.run()`, `on_timeline_start` and
  `on_timeline_finish`, `conditional_function` and `loop_function`, the experiment's
  `on_finish`, and dynamic parameters (functions used as trial parameters, which run just
  before the trial starts). The trial scope starts when the trial's `on_start` runs and lasts
  until its `on_finish` has finished.
- **`{ scope: "trial" }`** insists on the current trial's scope. It throws a `TypeError`
  outside a trial.

```js
// In a trial's on_finish: store the nickname for the rest of the session
await jsPsych.multiplayer.update({ nickname: data.response.nickname }, { scope: "session" });

// Later, in any trial or between trials:
const partnerName = jsPsych.multiplayer.get(partnerId, { scope: "session" })?.nickname;
```

### Naming a scope with `multiplayer_scope`

Every trial accepts a `multiplayer_scope` parameter that names its scope instead of its
position. You need it when participants' timelines differ in shape (for example, some run
more trials than others inside the same timeline), or when two trials should deliberately
share data, such as two chat trials that continue one conversation.

The name is used **exactly as written**, and trials with the same name share one scope, even
when one is a repetition of the other. So a trial that repeats needs a name that changes with
each repetition. Build it from a timeline variable:

```js
const round = {
  timeline: [
    {
      type: jsPsychMultiplayerChoice,
      choices: ["Cooperate", "Defect"],
      multiplayer_scope: () => `round-${jsPsych.evaluateTimelineVariable("round")}`,
    },
  ],
  timeline_variables: [{ round: 1 }, { round: 2 }, { round: 3 }],
};
```

The name must be a non-empty string or a number. `multiplayer_scope:
jsPsych.timelineVariable("round")` also works when the variable differs in each repetition.
If you set `multiplayer_scope` on a timeline rather than a trial, every trial in that timeline
inherits it and uses the same scope.

### Using an earlier trial's results

A later trial can't see an earlier trial's scope. Record what later trials need in jsPsych's
data, and read it from there. A trial's `on_finish` still uses the trial's scope, so it can
copy what the group wrote:

```js
const choice = {
  type: jsPsychMultiplayerChoice,
  choices: ["Cooperate", "Defect"],
  data: { task: "round" },
  on_finish: (data) => {
    data.shared = jsPsych.multiplayer.getAll();
  },
};

// In a later trial:
const lastRound = jsPsych.data.get().filter({ task: "round" }).last(1).values()[0];
```

The multiplayer plugins already record their results in the trial's data; see each plugin's
reference page. Or write the value to the session scope, as in the nickname example above.

## Lifetimes of subscriptions and waits

A subscription or `wait()` made during a trial (with the trial scope) **belongs to the
trial**. When the trial ends, its subscriptions are removed and its pending waits reject with
a `cancelled` error, so a plugin doesn't need to clean them up.

For a subscription that lasts the whole experiment, such as a scoreboard or a "your partner
left" banner, use the session scope: create it before `jsPsych.run()`, where the session scope
is the default, or pass `{ scope: "session" }` inside a trial. It sees only session-scope data,
not what trials write in their own scopes; presence and the group are the same in every scope.

```js
await jsPsych.multiplayer.connect(adapter);
jsPsych.multiplayer.subscribe((data, presence) => {
  updateScoreboard(data, presence);
});
await jsPsych.run(timeline);
```

When the experiment ends, or `abortExperiment()` is called, every subscription is removed and
every pending wait rejects with a `cancelled` error. This happens before the experiment's
`on_finish` runs, and the connection stays open, so `on_finish` can still write final data.

## How much data you can share

Every write sends **all** of your data, not only what changed: your session-scope data plus
every trial scope you have written to so far. Scopes from finished trials stay in your data
until the session ends, so the longer the experiment and the more you write, the larger each
write becomes. Share only what other participants need to see, such as a choice, a score, or a
short message. Keep response times and full trial records in jsPsych's own data, which is not
sent to the group.

Each backend limits how much it accepts. A write over the limit is rejected, and because the
session keeps retrying it, none of your later writes reach the group either. Pick a backend
with room for your study:

| Backend | Limit |
| --- | --- |
| [Firebase](adapter-multiplayer-firebase) | The recommended security rules allow each participant up to 128 KB. You can raise this in your rules; Firebase itself allows several megabytes. |
| [JATOS](adapter-multiplayer-jatos) | The whole group's data is stored together in one JATOS group session, whose size limit is set in the JATOS server's configuration. Ask your JATOS administrator. |
| [Local](adapter-multiplayer-local) | Every participant's data is stored together in the browser's `localStorage`, about 5 MB per site in most browsers. |

## Presence

The session tracks whether each participant is still in the group:

| Status | Meaning |
| --- | --- |
| `connected` | The participant is connected. |
| `away` | The participant's connection dropped. Brief network interruptions look like this, and the participant can still come back. |
| `left` | The participant was away longer than the dropout timeout (10 s by default), or reloaded the page. |

- **`left` is final.** A participant who has left stays `left`, even if their connection comes
  back.
- **The group agrees on it.** When one participant sees someone leave, they tell the rest of
  the group, and the others who have also lost sight of that participant count them as left
  at once. A participant the group counted as left finds out when their connection recovers:
  their session closes with a `connection_lost` error.
- **Your own dropouts don't count against others.** While your connection is down, the
  session pauses everyone else's dropout timers.
- **A participant's data stays after they leave,** so count participants by presence, not by
  who has data.

A participant whose connection drops and recovers **on the same page**, before the dropout
timeout, is `connected` again and their experiment is where they left it. A participant who
**reloads** the page, or opens the study again in a new tab, can't rejoin: the rest of the
group counts them as `left`, and on the reloaded page `jsPsych.multiplayer.restarted` is
`true`. Check it after connecting (see [`connect()`](#connectadapter-options-promisevoid)).
See [Handling dropouts](../guides/handling-dropouts) for how the plugins use presence.

## Groups

With a backend that puts arriving participants into groups (JATOS, or Firebase with
matchmaking), `group()` reports the group's `size` (the most it can hold, or `null`), its
`members` (including you), and whether it is `sealed`: nobody new can join, and `members` is
the final roster. Before the seal, a participant who leaves frees their place; after it, they
stay on the roster as a dropout. Every member of a sealed group appears in `presence()`, even
one who never connected: they start `away` and become `left` after the dropout timeout. With
these backends, reads include only the group members' data.

Adapters seal a group when it is full, and the adapter makes sure every member sees the seal
and the same final roster. `waitForGroup()` holds participants in a waiting room until then,
and `sealGroup()` seals it early. With a backend where you form the groups (the local and
Firebase adapters' `?mp_session=` links), `members` is everyone who has shown up, the group is
never sealed, and `sealGroup()` and `waitForGroup()` reject with an `unsupported` error. See
[Forming groups](../guides/forming-groups).

## Shared randomness

`random()`, `randomInt()`, `shuffle()`, and `sample()` give every participant in the group
the same values without sending anything, so the group can agree on a condition or a
stimulus order. `Math.random()` and `jsPsych.randomization` give each participant different
values. Each call takes a **key** that names what the value is for:

```js
const [condition] = jsPsych.multiplayer.sample("condition", ["gain", "loss"], 1);
const order = jsPsych.multiplayer.shuffle(`round-${round}-stimuli`, stimuli);
```

A value depends only on the key, the method, and the session's seed, so call order and
extra calls don't matter, and a participant who reloads gets the values they had before.
Use a new key for each random event (put the round in it), and make sure every participant
uses the same key. The seed is the adapter's session ID, so each group gets different values;
pass the same `randomSeed` to `connect()` to get the same values in every session.

## Errors

When a multiplayer operation fails, it throws or rejects with a `MultiplayerError`. Its
`name` is `"MultiplayerError"`, and its `code` says why:

| `error.code` | Cause |
| --- | --- |
| `timeout` | A `wait()`, `waitForGroup()`, or `connect()` ran out of time. |
| `cancelled` | Cancelled on purpose: by its `signal`, by `disconnect()`, or because its trial or the experiment ended. |
| `participant_left` | A participant listed in a `wait()`'s `participants` left. `error.participantId` says who. |
| `connection_lost` | This participant's connection was lost for good, or the group counted this participant as having left. |
| `not_connected` | There is no open session: `connect()` hasn't finished, or the session was disconnected. |
| `unsupported` | The adapter can't do what was asked, such as seal a group. |

Check an error by comparing `error.name` and `error.code`:

```js
if (error.name === "MultiplayerError" && error.code === "participant_left") {
  // error.participantId says who left
}
```

Don't use `instanceof`: plugins are bundled separately from jsPsych, and `instanceof` fails
when a page loads more than one copy of jsPsych. Mistakes in the arguments, such as an
unknown scope or a timeout of `0`, throw a `TypeError` or `RangeError` instead.

## Timeouts

Every timeout option (`timeout`, `connectTimeout`, `dropoutTimeout`, and `reconnectTimeout`)
takes a positive number of milliseconds, or `null` for no limit. Leaving it out uses its
default, and `Infinity` also means no limit. Any other value, including `0`, a negative
number, `NaN`, or a string such as `"5000"`, throws a `TypeError` rather than guessing what you
meant.

The plugins are more forgiving: in their own `timeout` parameters, `null`, `0`, or a negative
number all mean "no limit".

## Methods

### `connect(adapter, options?): Promise<void>`

Opens a session with the adapter and makes it the current session. Call and await it
**before** `jsPsych.run()`; until it resolves, every other method throws or rejects with a
`not_connected` error.

```js
const jsPsych = initJsPsych();

async function runExperiment() {
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal(), {
    onParticipantLeft: () => jsPsych.abortExperiment("Your partner left the study."),
  });
  if (jsPsych.multiplayer.restarted) {
    document.body.innerHTML =
      "<p>You reloaded the page, so you can't rejoin your group. Thank you for participating.</p>";
    return;
  }
  await jsPsych.run(timeline);
}

runExperiment();
```

Top-level `await` only works in `<script type="module">`, so wrap the calls in an `async`
function for a classic `<script>` tag.

| Option | Description |
| --- | --- |
| `dropoutTimeout` | How long, in ms, a participant can stay disconnected before they count as `left`. Default `10000`; `null` means never. |
| `reconnectTimeout` | How long, in ms, this participant's own connection can stay `"reconnecting"` before the session gives up and closes with a `connection_lost` error. Default `null`: keep trying as long as the adapter does. |
| `connectTimeout` | How long, in ms, to wait for the adapter to connect before rejecting with a `timeout` error. Default `20000`; `null` means no limit. |
| `randomSeed` | Seed for [shared randomness](#shared-randomness) in place of the session ID. Every participant in the group must pass the same value. |
| `recordIds` | Add `multiplayer_participant_id` and `multiplayer_session_id` columns to every row of jsPsych's data recorded while connected, so you can match up the data from the members of a group. Each row keeps the IDs of the session it was recorded in. Default `true`. |
| `onParticipantLeft` | Called with a participant's ID once, when that participant becomes `left`. |
| `onStatusChange` | Called with this participant's new connection status. |
| `signal` | An `AbortSignal` that cancels a `connect()` still in progress. |

`connect()` rejects if a session is already open or connecting; call `disconnect()` first. A
session whose status is `"closed"` is replaced directly. A cancelled `connect()` rejects with
a `cancelled` error, and a slow one with a `timeout` error, once the adapter has closed
anything it opened.

### `participantId`, `sessionId`, `status`, `restarted`

- `participantId: string | null`: this participant's ID. `null` until `connect()` resolves;
  keeps its value after the session closes.
- `sessionId: string | null`: the group session's ID, reported by the adapter. The same for
  every participant in the group and across reloads.
- `status: "connected" | "reconnecting" | "closed" | null`: this participant's connection.
- `restarted: boolean`: `true` when this participant reloaded or reopened the study after
  joining the group, so the group has moved on and counts them as left. Check it right after
  `connect()` and show a message instead of starting over.

### `update(data, options?): Promise<void>`

Shallow-**merges** `data` into your data in the scope: top-level keys in `data` replace the
same keys, other keys are kept, and a key set to `undefined` is removed. A nested object
replaces the whole nested object. `options.scope` is `"trial"` or `"session"`.

```js
await jsPsych.multiplayer.update({ score: 1 });         // { score: 1 }
await jsPsych.multiplayer.update({ round: 2 });         // { score: 1, round: 2 }
await jsPsych.multiplayer.update({ score: undefined }); // { round: 2 }
await jsPsych.multiplayer.update({ role: "sender" }, { scope: "session" });
```

### `replace(data, options?): Promise<void>`

**Replaces** your data in the scope with `data`, dropping every key that `data` leaves out.
Other scopes are not affected.

### `get(participantId, options?)`, `getAll(options?)`, `presence()`, `group()`

`get()` returns one participant's data in the scope, or `undefined` if they haven't written
anything there. `getAll()` returns the shared data in the scope; participants who haven't
written anything in it are left out. `presence()` returns each participant's presence
status, including your own (`away` while reconnecting, `left` once closed). `group()` returns
`{ size, members, sealed }`; `members` is sorted, so everyone in a sealed group sees the same
list. All four are frozen, and presence and the group are the same in every scope.

### `sealGroup(): Promise<void>`, `waitForGroup(options?)`

`sealGroup()` asks the backend to seal the group with the members it has now and resolves
once it confirms. `waitForGroup()` resolves with the group once it is sealed, and takes
`timeout` and `signal` like `wait()`. Both reject with an `unsupported` error when the backend
doesn't form groups.

```js
try {
  const { members } = await jsPsych.multiplayer.waitForGroup({ timeout: 5 * 60000 });
} catch (error) {
  if (error.name === "MultiplayerError" && error.code === "timeout") {
    // The group didn't fill in time
  }
}
```

### `subscribe(callback, options?): Unsubscribe`

Calls `callback(data, presence, group)` immediately with the current state, then after every
change: another participant's write, your own write, a change in presence, or a change in the
group. Returns a function that removes the subscription.

| Option | Description |
| --- | --- |
| `scope` | `"trial"` or `"session"`. See [Scopes](#scopes). |
| `signal` | An `AbortSignal` that removes the subscription. |

A subscription made during a trial with the trial scope is removed when the trial ends; a
session-scope one lasts until the experiment ends (see [Lifetimes](#lifetimes-of-subscriptions-and-waits)).
When the session closes, by `disconnect()` or a lost connection, each callback is called one
last time, with your own presence `left`, and then removed.

### `wait(condition, options?): Promise<GroupSessionData>`

Resolves with the shared data once `condition(data, presence, group)` returns `true`. It
checks the current state first, so an already-true condition resolves at once.

| Option | Description |
| --- | --- |
| `timeout` | The longest time to wait, in ms, or `null` for no limit (the default). See [Timeouts](#timeouts). |
| `participants` | Participants the wait depends on. If one of them leaves first, the wait rejects with a `participant_left` error. |
| `scope` | `"trial"` or `"session"`. See [Scopes](#scopes). |
| `signal` | An `AbortSignal` that cancels the wait. |

The second argument must be an object; the older `wait(condition, 30000)` form rejects with a
`TypeError`. The promise rejects with a `MultiplayerError` whose `code` is `timeout`,
`participant_left`, `cancelled`, or `connection_lost` (see [Errors](#errors)), or with whatever
`condition` throws. Write conditions that stay true once they become true.

```js
try {
  await jsPsych.multiplayer.wait((data) => data[partnerId]?.answer !== undefined, {
    participants: [partnerId],
    timeout: 60000,
  });
} catch (error) {
  if (error.name === "MultiplayerError" && error.code === "participant_left") {
    // End the trial and record that the partner left
  }
}
```

`update()` followed by `wait()` is the **synchronization barrier** most turn-based paradigms
reduce to. [`multiplayer-sync`](plugin-multiplayer-sync) packages that pair as one trial, and
is usually the better choice for experiment code.

### `random(key)`, `randomInt(key, lower, upper)`, `shuffle(key, array)`, `sample(key, array, size)`

Shared counterparts of `Math.random()`, `jsPsych.randomization.randomInt()`,
`jsPsych.randomization.shuffle()`, and `jsPsych.randomization.sampleWithoutReplacement()`.
Every participant who passes the same key (and the same array) gets the same result; see
[Shared randomness](#shared-randomness). `random()` returns a number in [0, 1), `randomInt()`
an integer from `lower` to `upper` inclusive, `shuffle()` a shuffled copy, and `sample()`
`size` items drawn without replacement. `key` must be a non-empty string.

### `disconnect(): Promise<void>`

Closes the current session, or cancels a `connect()` in progress. Subscribers get their
last call, and pending `wait()` calls and unconfirmed writes reject with a `cancelled` error.
Reads keep returning the last state. You can call `connect()` again afterward; reconnecting
from the same page this way is not a reload, so `restarted` stays `false`.

## The adapter interface

You only need this section to write an adapter for a new backend. An adapter has two parts.
The **adapter** holds configuration; each call to its `connect()` opens a new, independent
**connection**:

```ts
interface MultiplayerAdapter {
  connect(options: {
    signal: AbortSignal; // aborted on cancel or connectTimeout: release everything, then reject
    onChange(): void; // call when getAll(), connectedParticipants(), or group() may have changed
    onStatus(status: "connected" | "reconnecting" | "closed"): void;
    onResumed(): void; // others may have seen this client drop out without a "reconnecting"
  }): Promise<MultiplayerConnection>;
}

interface MultiplayerConnection {
  readonly participantId: string;
  readonly sessionId: string; // the same for everyone in the group, and across reloads
  getAll(): Record<string, unknown>; // each participant's pushed payload, unchanged
  connectedParticipants(): string[]; // including this participant
  push(data: Record<string, unknown>): Promise<void>; // rejects on failure; the API retries
  group?(): { size: number | null; members: string[]; sealed: boolean }; // optional
  sealGroup?(): Promise<void>; // optional
  disconnect(): Promise<void>;
}
```

- **Reads are synchronous.** An adapter over an asynchronous backend keeps an in-memory
  mirror and fills it before `connect()` resolves. `onChange()` may be called before then; it
  is ignored.
- **Payloads are opaque.** The API owns the format of each participant's payload (scopes,
  bookkeeping); the adapter stores and returns it unchanged. Echoing your own push back is
  optional.
- **`push()` rejects when it fails.** The API sends one push at a time and retries with
  backoff, so don't build long retry loops that block later writes. Where the backend allows
  it, let a participant write only their own data.
- **Presence** comes from `connectedParticipants()`, which lists open connections, including
  this participant's. For rejoining to work, keep the same `participantId` for every connection
  made from the same page, and report `"reconnecting"` then `"connected"` whenever the channel
  drops. If others may have seen this client drop out while its channel never reported
  `"reconnecting"` (a missed heartbeat, for example), call `onResumed()`.
- **`sessionId`** names the group: the same non-empty string for every participant in it, for
  every connection and page load, and different for each group. Shared randomness is seeded
  with it.
- **Groups.** An adapter whose backend forms groups resolves `connect()` once the backend has
  assigned one, and reports it through `group()`. Once sealed, **every** member's connection
  must report `sealed: true` and the final roster, including members who dropped out; the API
  does not relay the seal between members. Leave `sealGroup()` out entirely when the backend
  can't seal, rather than throwing.
- **Timeouts belong to the API.** `connectTimeout` and `reconnectTimeout` are handled by
  `jsPsych.multiplayer.connect()`, so adapters don't need options of their own for them.

The "Multiplayer Adapter Development" page in jsPsych covers each method in detail.
