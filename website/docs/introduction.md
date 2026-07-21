---
slug: /
id: introduction
title: Introduction
sidebar_label: Introduction
description: Run synchronous, multi-participant experiments in jsPsych.
---

# jsPsych Multiplayer

jsPsych Multiplayer adds **synchronous, multi-participant** capability to jsPsych. Two or
more participants take part in the same session at the same time, seeing each other's
choices: an ultimatum game, a public-goods game, a live chat, a shared drawing canvas, a
reference game.

It is a set of ordinary jsPsych packages, not a new platform. You keep your stimuli, your
plugins, your deployment, and your data pipeline, and add a few trials to a timeline.

## What it is not

- **Not a game server.** There is no server-side game logic and no privileged "host"
  client. Coordination is computed identically on every client (see below), which is what
  makes a dropout survivable instead of fatal.
- **Not a recruitment system.** Getting several participants to arrive at once is a
  recruitment problem; this library assumes they have arrived and coordinates them from
  there.
- **Not able to enforce hidden information.** Every participant's client can read the whole
  group session. If a design requires that a value be provably unavailable to an opponent,
  you need server-side authority, which this model deliberately does not have.

## The two-layer model

Everything in the ecosystem is one of two things:

| Layer | What it decides | Examples |
| --- | --- | --- |
| **Adapter** | *Where the shared state lives* — the network backend | `adapter-multiplayer-local`, `adapter-multiplayer-jatos`, `adapter-multiplayer-firebase` |
| **Plugin** | *What participants do with that state* — a trial | `plugin-multiplayer-sync`, `plugin-multiplayer-role`, `plugin-multiplayer-chat`, … |

You choose exactly one adapter per experiment, and you register it in one line. Swapping
backends — from two-tabs-on-your-laptop to a real cross-device study — means changing that
one constructor and nothing else. See [Choosing an adapter](/guides/choosing-an-adapter).

## The mental model: one shared object

The whole design rests on a single shared object, the **group session**: a dictionary keyed
by participant ID, where each participant owns exactly one slot.

```jsonc
{
  "participant-a": { "name": "Sam", "ready": true, "offer": 4 },
  "participant-b": { "name": "Alex", "ready": true },
  "participant-c": { "ready": false }
}
```

Three rules govern it:

1. **You can only write your own slot**, and a write **replaces** that slot entirely — it
   does not merge. Nobody can write anyone else's data, so write conflicts are impossible
   by construction. (Replace-not-merge is the single most consequential fact about the API;
   both tutorials return to it.)
2. **Everyone can read every slot**, as a snapshot (`getAll`) or a live subscription
   (`subscribe`).
3. **Shared decisions are computed, not negotiated.** When the group needs to agree on
   something — who is the proposer, who is paired with whom, whose turn it is — every
   client independently runs the *same deterministic function* over the *same group
   session*. Identical inputs plus an identical pure function give identical conclusions on
   every screen, with no coordinator whose disconnection would strand everyone else.

## The `jsPsych.multiplayer` namespace

The API lives on its own module, alongside `jsPsych.data`:

```js
const jsPsych = initJsPsych();

// Register the backend once, before the timeline runs.
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal());

jsPsych.run(timeline);
```

Once connected, `jsPsych.multiplayer` offers:

| Method | What it does |
| --- | --- |
| `connect(adapter)` | Join the group session through the given backend. Call before `jsPsych.run()`. |
| `push(data)` | **Replace** this participant's slot with `data`. |
| `update(data)` | Shallow-**merge** `data` into this participant's slot, then push the result. |
| `get(participantId)` | Read one participant's slot. |
| `getAll()` | Snapshot of the whole group session. |
| `subscribe(cb)` | Live updates; returns an unsubscribe function. Replays current state on registration. |
| `wait(condition, timeout?)` | Promise that resolves once a predicate over the group session holds. |
| `participantId` | This client's stable ID within the session. |
| `disconnect()` | Leave the session. |

Most experiments never call these directly — the plugins do. `push()` followed by `wait()`
is the **synchronization barrier** that nearly every turn-based paradigm reduces to, and
`plugin-multiplayer-sync` is that pair as one declarative trial.

## Two interaction patterns

Every paradigm we have built maps onto one of two shapes:

1. **Barrier (turn-based or simultaneous-move).** Push a value, wait for a condition over
   the group: "everyone is ready", "both players have chosen", "the proposer has offered".
   Ultimatum, dictator, prisoner's dilemma, public goods, group quizzes.
2. **Continuous (real-time).** Subscribe to the group session and re-render on every
   update: chat, shared drawing, live scoreboards, synchronized countdowns.

## The fastest possible win

The local adapter needs no server, no account, and no credentials — it synchronizes tabs in
one browser using `localStorage`. So the shortest path to seeing multiplayer work is:

1. Follow [Your first multiplayer trial](/tutorials/first-multiplayer-trial) (about ten
   minutes), or
2. open one of the [`examples/`](https://github.com/jspsych/jspsych-multiplayer/tree/main/examples)
   files over `http://` and copy its `?mp_session=…` URL into a second tab.

Then read the [Ultimatum game tutorial](/tutorials/ultimatum-game) for a complete,
deployable experiment.

:::warning The local adapter is for development only
It is same-origin, same-browser, same-machine. It is a development and demo tool, **not** a
data-collection backend. For real participants use the JATOS or Firebase adapter.
:::
