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

Each participant has a **slot**: an object that only they can write and that everyone in the
group can read. Together, the slots are the group's shared data, keyed by participant ID:

```jsonc
{
  "a1b2…": { "name": "Sam", "offer": 4 },
  "c3d4…": { "name": "Alex" },
  "e5f6…": {}
}
```

Three rules govern it.

1. **A participant can only write their own slot.** Two participants can never overwrite each
   other's data.
2. **Everyone can read every slot.** Trials read it when they need it, or re-draw every time it
   changes.
3. **Group decisions are computed, not negotiated.** When the group has to agree on something,
   such as who is the proposer or who is paired with whom, every participant's browser runs
   the same calculation on the same shared data and gets the same answer. No participant's
   browser is in charge, so no single dropout can leave the others stuck.

## Writing: replace or merge

There are two ways to write your slot, and the difference matters:

- **`push(data)` replaces the whole slot.** Anything you do not include is gone, for you and
  for everyone reading it.
- **`update(data)` merges into the slot.** The keys you give replace the same keys, and the
  rest are kept.

[`multiplayer-sync`](../reference/plugin-multiplayer-sync)'s `push_data` uses `push()`, so it
**replaces** the slot. Each `push_data` must carry forward every field another participant
still reads. The [ultimatum game](ultimatum-game#carry-forward-what-others-read) shows what
goes wrong otherwise. Every other plugin merges, and keeps its values under its own keys.

A few more details:

- **Your own writes are visible at once.** Your own trials see a change immediately. Other
  participants see it once it has gone through the backend, usually within a fraction of a
  second.
- **Only the latest value is sent.** If you write twice quickly, others may only ever see the
  second value. For things everyone must see, such as each chat message, add to a list rather
  than overwriting one value.
- **Data is plain JSON.** Dates become strings and `undefined` values are dropped.

## Presence

Alongside the data, every participant has a **presence** status:

| Status | Meaning |
| --- | --- |
| `connected` | The participant is connected. |
| `away` | Their connection dropped. A brief network hiccup looks like this. |
| `left` | They have been away longer than the dropout timeout (10 seconds by default). This is permanent. |

A slot stays in the shared data after its participant leaves, so **count participants by
presence, not by slot**. Every condition function the plugins take, such as `wait_for`,
receives the presence as its second argument for this reason. [Handling
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
