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

The condition is a function, `wait_for`, that receives the trial's shared data and each
participant's presence status. It is the same condition you would pass to
[`jsPsych.multiplayer.wait()`](multiplayer-api).
If you only need "everyone clicked ready", [`multiplayer-ready`](plugin-multiplayer-ready) does
that without a condition to write.

**What the participant sees:** the `message` ("Waiting for other players…" by default) until the
condition is true, then the next trial. There is nothing to click.

```js
timeline.push({
  type: jsPsychMultiplayerSync,
  write_data: { status: "ready" },
  // Wait until two participants have written in this trial
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
| `wait_for` | `(group, presence) => boolean` | required | The condition. It receives the data participants wrote during this trial and everyone's presence status. It is checked at the start and after every change; the trial ends as soon as it returns `true`. Both arguments are frozen, so don't modify them. If it throws, the trial fails with that error. |
| `write_data` | `object \| null` | `null` | Data to write to this participant's part of the trial's shared data when the trial starts. It is merged in with `jsPsych.multiplayer.update()`, so it never replaces what is already there. `null` waits without writing. Can be a function that returns the object, e.g. `() => ({ offer })`. |
| `message` | HTML string | `"<p>Waiting for other players…</p>"` | Shown while waiting. |
| `timeout` | `number \| null` | `null` | The longest time to wait, in ms. When it runs out, the trial ends with `multiplayer_outcome: "timeout"` and `on_timeout` is called. `null`, `0`, or a negative number waits indefinitely. |
| `on_timeout` | `function \| null` | `null` | Called with the timeout error if `timeout` runs out first. The trial ends either way. |
| `participants` | `string[] \| null` | `null` | The participants this wait depends on. If one of them leaves before the condition is true, the trial ends with `multiplayer_outcome: "participant_left"`. `null` means the other members of a [sealed group](../guides/forming-groups) who haven't left, or, without a sealed group, every other participant who is connected when the wait starts. Pass `[]` to ignore departures, for example in a lobby that keeps waiting for others to join. Can be a function, e.g. `() => [partnerId]`. |
| `minimum_wait` | `number` | `0` | The shortest time, in ms, to keep the message on screen, so it doesn't flash by when the condition is already true. It applies whether the trial ends because the condition is met or because the timeout runs out. It does not lengthen a wait that is already longer. |
| `save_group` | `boolean` | `false` | Save the trial's shared data, as it was when the trial ended, in the `group` data field. |

## Data

| Field | Type | Description |
| --- | --- | --- |
| `wait_time` | `number` | Milliseconds from the start of the trial to its end. |
| `multiplayer_outcome` | `string` | How the trial ended: `"completed"` (`wait_for` was met), `"timeout"`, `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's own connection was lost for good). |
| `left_participant` | `string \| null` | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`. |
| `group` | `object` | Only with `save_group: true`. The trial's shared data when the trial ended, keyed by participant ID. Read other participants' values from here in `on_finish`. The object is frozen; copy it before changing it. |

[Handling dropouts](../guides/handling-dropouts) explains `multiplayer_outcome`,
`left_participant`, and how to branch on them.

If `wait_for` throws, the trial fails rather than recording an outcome. If the experiment ends or
is aborted while the trial is waiting, the trial stops quietly: `on_timeout` isn't called and no
data is recorded.

## Each trial has its own shared data

During a trial, `jsPsych.multiplayer` reads and writes that trial's own part of the shared data.
So `write_data` lands in this trial's part, `wait_for` sees only what participants wrote during
this trial, and a value written at an earlier sync trial can never satisfy a later one.
Participants running the same timeline share each trial's data, because the part is named by the
trial's position in the timeline (or by the trial's `multiplayer_scope` parameter; see
[How it works](../guides/how-it-works)).

To use a value in a later trial, save it in the trial's data (for example with `save_group: true`
or in `on_finish`), or write it to the session's shared data, which lasts the whole session:

```js
await jsPsych.multiplayer.update({ name: myName }, { scope: "session" });
```

## Writing a condition that stays true

When a participant writes twice in quick succession, the others may only ever see the second
value. Write conditions that stay true once they are met, such as "every participant has written
`ready`", rather than ones that look for a value that may change again:

```js
// Fragile: the partner may change `status` again before this participant sees "ready"
wait_for: (group) => group[partnerId]?.status === "ready",

// Better: once a participant has written in this trial, their data stays
wait_for: (group) => Object.keys(group).length >= 2,

// Better: a counter that only goes up
wait_for: (group) => {
  for (const id in group) {
    if (group[id].step === undefined || group[id].step < 3) {
      return false;
    }
  }
  return true;
},
```

To count who is here now, use `presence` rather than the shared data: a participant's data stays
after they leave.

## Example

A lobby for two players, then a handoff in which the proposer sends an offer and waits for the
responder's decision:

```js
const lobby = {
  type: jsPsychMultiplayerSync,
  participants: [], // keep waiting even if someone joins and leaves
  wait_for: (group, presence) => {
    // Count the participants who are currently connected
    let connected = 0;
    for (const id in presence) {
      if (presence[id] === "connected") {
        connected++;
      }
    }
    return connected >= 2;
  },
  message: "<p>Waiting for another player to join…</p>",
};

const sendOfferAndWait = {
  type: jsPsychMultiplayerSync,
  write_data: () => ({ offer: myOffer }),
  // The responder writes their decision in a trial with the same multiplayer_scope
  multiplayer_scope: "offer",
  wait_for: (group) => group[responderId]?.decision !== undefined,
  participants: () => [responderId], // end early if the responder leaves
  timeout: 120000,
  message: "<p>Waiting for the responder…</p>",
  save_group: true,
  on_finish: (data) => {
    if (data.multiplayer_outcome !== "completed") return;
    responderDecision = data.group[responderId].decision;
  },
};
```

The two players run different trials here (one sends, the other responds), so both trials set
the same `multiplayer_scope` to share one part of the shared data. The
[ultimatum game tutorial](../guides/ultimatum-game) builds a full experiment from these trials.
