---
id: how-it-works
title: How it works
sidebar_label: How it works
description: The shared data every multiplayer trial reads and writes, the rules that govern it, and how participants agree without a server deciding for them.
---

# How it works

Every multiplayer trial reads and writes one shared object. Once you know its rules, you can
predict what any plugin will do, and write conditions of your own.

## The shared data

Each participant has their own data: an object that only they can write and that everyone in
the group can read. Together, these form the group's shared data, keyed by participant ID:

```jsonc
{
  "a1b2…": { "name": "Sam", "offer": 4 },
  "c3d4…": { "name": "Alex" },
  "e5f6…": {}
}
```

Three rules govern it.

1. **A participant can only write their own data.** Two participants can never overwrite each
   other's data.
2. **Everyone can read everyone's data.** Trials read it when they need it, or re-draw every
   time it changes.
3. **Group decisions are computed, not negotiated.** When the group has to agree on something,
   such as who is the proposer or who is paired with whom, every participant's browser runs
   the same calculation on the same shared data and gets the same answer. No participant's
   browser is in charge, so no single dropout can leave the others stuck.

## Each trial has its own shared data

The shared data is split into **scopes**. Each trial gets a fresh, empty scope of its own,
and while the trial runs, everything it reads and writes goes there. When the trial ends, the
next trial starts with a clean slate. This is why a choice made in round 1 can never be
mistaken for a choice in round 2, even though both are stored as `choice`.

Participants running the same timeline share each trial's scope automatically: the scope is
named after the trial's position in the timeline, so the fifth trial is the same scope for
everyone. If participants' timelines differ in shape, or you want two trials to share data on
purpose, name the scope yourself with the `multiplayer_scope` parameter (see
[Scopes](../reference/multiplayer-api#scopes)).

Data that should last the **whole session**, such as a nickname or a role, goes in the
**session scope** instead:

```js
await jsPsych.multiplayer.update({ nickname: "Sam" }, { scope: "session" });

// Any later trial can read it:
jsPsych.multiplayer.get(partnerId, { scope: "session" })?.nickname;
```

Code that runs outside a trial, such as code before `jsPsych.run()` or the experiment's
`on_finish`, uses the session scope by default. The plugins also record their results in
jsPsych's regular data, so a later trial can look up what happened in an earlier one there.

## Writing: merge or replace

There are two ways to write your data:

- **`update(data)` merges.** The keys you give replace the same keys, and the rest are kept.
  This is what you want almost every time, and what every plugin does, including
  [`multiplayer-sync`](../reference/plugin-multiplayer-sync)'s `write_data`.
- **`replace(data)` replaces** your data in the scope. Anything you do not include is gone.

Both write to the current trial's scope unless you pass `{ scope: "session" }`.

A few more details:

- **Your own writes are visible at once.** Your own trials see a change immediately. Other
  participants see it once it has gone through the backend, usually within a fraction of a
  second.
- **Only the latest value is sent.** If you write twice quickly, others may only ever see the
  second value. For things everyone must see, such as each chat message, add to a list rather
  than overwriting one value. For the same reason, wait for conditions that stay true once they
  are true ("step 3 or later"), not for a value that may be skipped over.
- **Data is plain JSON.** Dates become strings and `undefined` values are dropped.
- **Keep it small.** Every write sends all your shared data, so share only what the others need
  to see. Each backend has a size limit; see
  [How much data you can share](../reference/multiplayer-api#how-much-data-you-can-share).

## Presence

Alongside the data, every participant has a **presence** status:

| Status | Meaning |
| --- | --- |
| `connected` | The participant is connected. |
| `away` | Their connection dropped. A brief network hiccup looks like this. |
| `left` | They were away longer than the dropout timeout (10 seconds by default), or reloaded the page. |

A participant whose connection comes back on the same page, after a network outage for
example, becomes `connected` again, as long as they return before the dropout timeout. Once a
participant is `left`, they stay `left`, and the whole group agrees on it. A participant who
reloads has restarted the experiment, so the others count them as `left`.
[Rejoining](handling-dropouts#rejoining) explains the details.

A participant's data stays in the shared data after they leave, so **count participants by
presence, not by who has data**. Every condition function the plugins take, such as
`wait_for`, receives the presence as its second argument for this reason. [Handling
dropouts](handling-dropouts) covers what the plugins do when someone leaves.

## Two kinds of trial

Every paradigm built so far uses one of two patterns:

1. **Wait for the group.** A participant shares a value, then waits until a condition over
   the whole group is true: everyone is ready, both players have chosen, the proposer has
   made an offer. Ultimatum games, prisoner's dilemmas, public-goods games and group quizzes
   are sequences of these. [`multiplayer-sync`](../reference/plugin-multiplayer-sync) is the
   general version; `ready`, `role`, `match`, `choice` and `scoreboard` are specialised ones.
2. **Live.** The trial re-draws every time the shared data changes, and participants act
   whenever they like: chat, a shared canvas, a reference game, a live scoreboard.

## What it does not do

- **It does not recruit participants.** Getting several people to arrive at the same time is
  up to your recruitment platform. The plugins take over once they have arrived, with a lobby
  that waits for enough of them.
- **It cannot hide information from participants.** Every participant's browser can read the
  whole shared data, so a technically skilled participant could read their partner's private
  value. If your design needs a value to be truly hidden, it needs a server that holds it.
- **It does not run game logic on a server.** Everything is computed in the participants'
  browsers, the same way on each one.

## Using the API directly

Most experiments only call `jsPsych.multiplayer.connect()` and leave the rest to the plugins.
For anything the plugins do not cover, the same methods are available on `jsPsych.multiplayer`;
see the [API reference](../reference/multiplayer-api).
