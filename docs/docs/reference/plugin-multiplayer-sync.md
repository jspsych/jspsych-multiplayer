---
id: plugin-multiplayer-sync
title: multiplayer-sync
sidebar_label: multiplayer-sync
description: Hold every participant on a waiting screen until a condition over the group's shared data is true.
---

# `multiplayer-sync`

A sync trial is a waiting point. It can write some of this participant's data to the group, then
it waits until a condition you write is true of the group's shared data. Use it for lobbies,
for "send my offer, then wait for the reply" handoffs, and for any point where participants must
not move on until something has happened on the other side.

The condition is a function, `wait_for`, that receives the shared data and each participant's
presence status. It is the same condition you would pass to
[`jsPsych.multiplayer.wait()`](multiplayer-api).
If you only need "everyone clicked ready", [`multiplayer-ready`](plugin-multiplayer-ready) does
that without a condition to write.

**What the participant sees:** the `message` ("Waiting for other players…" by default) until the
condition is true, then the next trial. There is nothing to click.

```js
timeline.push({
  type: jsPsychMultiplayerSync,
  wait_for: (group) => Object.keys(group).length >= 2,
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-sync` |
| Browser global | `jsPsychMultiplayerSync` |
| Trial type | `multiplayer-sync` |
| Requires | a connected session (see [Getting started](../getting-started)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `wait_for` | `(group, presence) => boolean` | required | The condition. It is checked at the start and after every change to the shared data or to presence; the trial ends as soon as it returns `true`. Both arguments are frozen, so don't modify them. If it throws, the trial fails with that error. |
| `push_data` | `object \| null` | `null` | Data to write to this participant's slot when the trial starts, before waiting. `null` waits without writing. This **replaces** the whole slot (it uses `push()`), so include every field other participants still need. Can be a function that returns the object, e.g. `() => ({ offer })`. |
| `message` | HTML string | `"<p>Waiting for other players…</p>"` | Shown while waiting. |
| `timeout` | `number \| null` | `null` | The longest time to wait, in ms. When it runs out, the trial ends with `timed_out: true` and `on_timeout` is called. `null`, `0`, or a negative number waits indefinitely. |
| `on_timeout` | `function \| null` | `null` | Called with the timeout error if `timeout` runs out first. The trial ends either way. |
| `participants` | `string[] \| null` | `[]` | The participants this wait depends on. If one of them leaves before the condition is true, the trial ends with `partner_left: true`. The default, `[]`, ignores departures, which suits a lobby that keeps waiting for others to join. `null` means every other participant who is connected when the wait starts. In a [sealed group](../guides/forming-groups), `null` means the rest of the group's members who haven't left, including any who are only `away`. Can be a function, e.g. `() => [partnerId]`. |
| `minimum_wait` | `number` | `0` | The shortest time, in ms, to keep the message on screen, so it doesn't flash by when the condition is already true. It does not lengthen a wait that is already longer. |

## Data

| Field | Type | Description |
| --- | --- | --- |
| `group` | `object` | The shared data when the trial ended, keyed by participant ID. Read other participants' values from here in `on_finish`. The object is frozen; copy it before changing it. |
| `wait_time` | `number` | Milliseconds from the start of the trial to its end. |
| `timed_out` | `boolean` | `true` if the trial ended because `timeout` ran out. |
| `partner_left` | `boolean` | `true` if the trial ended because a participant in `participants` left. |
| `left_participant` | `string \| null` | The ID of the participant who left, when `partner_left` is `true`. |
| `connection_lost` | `boolean` | `true` if the trial ended because this participant's own connection was lost for good. |
| `wait_error` | `string \| null` | The message of whatever ended the wait early (timeout, departure, or lost connection). `null` when the condition was met. |

[Handling dropouts](../guides/handling-dropouts) explains `partner_left`, `left_participant`,
`connection_lost`, and how to branch on them.

If the experiment ends or is aborted while the trial is waiting, the trial stops without
calling `on_timeout` and records no data.

## Writing a condition that stays true

Everyone's slot changes as they move through the experiment. A fast participant who has passed
this point may already have written new data by the time a slow participant checks the
condition, and `push_data` replaces the whole slot. A condition that looks for a field the fast
participant no longer has can then stay false forever.

Write conditions that, once true, stay true:

```js
// Fragile: the other player's next push may not include `status`
wait_for: (group) => group[partnerId]?.status === "ready",

// Better: a slot stays in the shared data even after its owner moves on or leaves
wait_for: (group) => Object.keys(group).length >= 2,

// Better: a counter that only goes up, carried forward in every push
wait_for: (group) => Object.values(group).every((p) => p.round >= 5),
```

To count who is here now, use `presence` rather than slots: slots stay after a participant
leaves.

## Example

A lobby for two players, then a handoff in which the proposer sends an offer and waits for the
responder's decision:

```js
const lobby = {
  type: jsPsychMultiplayerSync,
  participants: [], // keep waiting even if someone joins and leaves
  wait_for: (group, presence) =>
    Object.values(presence).filter((s) => s === "connected").length >= 2,
  message: "<p>Waiting for another player to join…</p>",
};

const sendOfferAndWait = {
  type: jsPsychMultiplayerSync,
  push_data: () => ({ offer: myOffer }),
  wait_for: (group) => group[responderId]?.decision !== undefined,
  participants: () => [responderId], // end early if the responder leaves
  timeout: 120000,
  message: "<p>Waiting for the responder…</p>",
  on_finish: (data) => {
    if (data.partner_left || data.timed_out || data.connection_lost) return;
    responderDecision = data.group[responderId].decision;
  },
};
```

The [ultimatum game tutorial](../guides/ultimatum-game) builds a full experiment from these trials.
