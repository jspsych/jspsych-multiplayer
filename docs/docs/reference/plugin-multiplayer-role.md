---
id: plugin-multiplayer-role
title: multiplayer-role
sidebar_label: multiplayer-role
description: Give each participant in the group a role, such as proposer or responder, that every participant agrees on.
---

# `multiplayer-role`

A role trial hands out roles: proposer and responder, leader and followers, sender and receiver.
Every participant's browser works out the full assignment on its own, from the same shared data
and the same rules, so all of them arrive at the same answer without a server deciding. Later
trials branch on the result with `jsPsychMultiplayerRole.getMyRole()`.

You choose how participants are ordered into roles: by when they joined, at random, rotating
each round, or by a value each participant carries (a score, a condition).

**What the participant sees:** "Assigning roles…" for as long as it takes the group to be ready,
usually well under a second after a lobby. The trial does not show the role; show it in the next
trial if you want participants to see it.

```js
timeline.push({
  type: jsPsychMultiplayerRole,
  roles: ["proposer", "responder"],
  group_size: 2,
});
```

|                |                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package        | `@jspsych-multiplayer/plugin-multiplayer-role`                                                                                                                                                    |
| Browser global | `jsPsychMultiplayerRole`                                                                                                                                                                          |
| Trial type     | `multiplayer-role`                                                                                                                                                                                |
| Requires       | a connected session (see [Getting started](../getting-started)), and usually a lobby before it ([`multiplayer-sync`](plugin-multiplayer-sync) or [`multiplayer-ready`](plugin-multiplayer-ready)) |

## Parameters

| Parameter       | Type                           | Default                     | Description                                                                                                                                                                                                                                               |
| --------------- | ------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`         | `string[] \| object`           | required                    | The roles to hand out. An array has one slot per entry: `["proposer", "responder"]`. An object gives counts: `{ leader: 1, follower: 3 }`.                                                                                                                |
| `strategy`      | `string \| function`           | `"join_order"`              | How participants are ordered into the slots: `"join_order"`, `"random"`, `"rotate"`, or your own function (see [How roles are assigned](#how-roles-are-assigned)).                                                                                        |
| `group_size`    | `number \| null`               | `null`                      | Wait until **exactly** this many participants are present before assigning. Participants who have left don't count. In a [sealed group](../guides/forming-groups), `null` means the group's members who haven't left. Otherwise `null` relies on an earlier lobby to have gathered the group; see [Set `group_size`](#set-group_size). |
| `round`         | `number`                       | `0`                         | The round number, used by `"rotate"` and to reshuffle `"random"`. Increase it each time you run the trial again.                                                                                                                                          |
| `balanced`      | `boolean`                      | `false`                     | For `"rotate"`: use a balanced (Williams) rotation, so each role follows every other role equally often across the group. Exact for an even number of participants.                                                                                       |
| `seed`          | `string \| null`               | `null`                      | Picks a different random assignment within the session. Randomness is seeded by the session ID (or the `randomSeed` connect option), so each group gets its own assignment. The shuffle is the same for everyone and changes each `round`.                |
| `rank_by`       | `(entry, id, ctx) => number`   | `null`                      | Order participants by a number, highest first, e.g. a score. `entry` is the participant's data (see [What the rules see](#what-the-rules-see)). Takes precedence over a string `strategy`.                                                                                                          |
| `role_from`     | `(entry, id, ctx) => string`   | `null`                      | Read each participant's role directly from their data. Must return one of the declared roles. Does not enforce the counts in `roles`. Takes precedence over `rank_by`.                                                                                    |
| `ready`         | `(group, presence) => boolean` | `null`                      | Your own condition for when the group is ready to assign. **Required** with a custom `strategy` function. `group` holds the participants who have reached this trial and haven't left (see [What the rules see](#what-the-rules-see)). Both arguments are frozen. |
| `overflow_role` | `string \| null`               | `null`                      | The role for participants beyond the declared slots, e.g. `"spectator"`. Without it, more participants than slots is an error.                                                                                                                            |
| `write_data`    | `object`                       | `{}`                        | Data this participant contributes to the assignment, such as the score `rank_by` reads. It is merged into this participant's part of the trial's shared data, so it never reaches another trial.                                                          |
| `save_group`    | `boolean`                      | `false`                     | Save the shared data the assignment was computed from, as `group`.                                                                                                                                                                                        |
| `timeout`       | `number \| null`               | `30000`                     | The longest time to wait for the group to be ready, in ms. `null`, `0`, or a negative number waits indefinitely (not recommended).                                                                                                                        |
| `on_timeout`    | `function \| null`             | `null`                      | Called with the `jsPsych` instance if `timeout` runs out. The trial ends with `role: null` and `multiplayer_outcome: "timeout"` either way.                                                                                                                |
| `participants`  | `string[] \| null`             | `null`                      | The participants the assignment depends on. If one of them leaves before the group is ready, the trial ends with `role: null` and `multiplayer_outcome: "participant_left"`. `null` means the other members of a [sealed group](../guides/forming-groups) who haven't left, or, without a sealed group, every other participant who is connected when this participant arrives. `[]` ignores departures. |
| `message`       | HTML string                    | `"<p>Assigning roles…</p>"` | Shown while waiting.                                                                                                                                                                                                                                      |

`ctx`, passed to `rank_by`, `role_from`, and a custom `strategy`, is
`{ ids, round, seed }`: the sorted participant IDs, the `round`, and the `seed` you set (or `""`).

## Data

| Field              | Type             | Description                                                                                                                                                                                    |
| ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`             | `string \| null` | This participant's role. `null` if the trial ended without an assignment.                                                                                                                      |
| `role_map`         | `object \| null` | The full assignment, `{ participantId: { role } }`, identical for every participant. `null` if the trial ended without an assignment.                                                          |
| `assigned_self`    | `boolean`        | Whether this participant is in `role_map`. `false` after a timeout or dropout, or when a custom strategy left this participant out. Overflow participants are in the map, so they read `true`. |
| `multiplayer_outcome` | `string`      | How the trial ended: `"completed"`, `"timeout"` (the group was not ready before `timeout` ran out), `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's own connection was lost for good). |
| `left_participant` | `string \| null` | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`.                                                                                                       |
| `group`            | `object`         | The snapshot the assignment was computed from. Only saved when `save_group` is `true`.                                                                                                         |

[Handling dropouts](../guides/handling-dropouts) explains `multiplayer_outcome`,
`left_participant`, and how to branch on them. If the experiment ends or is aborted while the
trial is waiting, it stops quietly: `on_timeout` isn't called and no data is recorded.

## How roles are assigned

The trial writes `joinedAt` to this participant's session data, the time they first reached a role
(or match) trial; it is written once and never changed, so `"join_order"` gives the same order in
every later round. It also writes `write_data` to this participant's part of the trial's shared
data. It then waits until the group is ready and computes the assignment:

1. Participants who have left are dropped. The group is not ready until every remaining
   participant is `connected` and, if you set `group_size`, there are exactly that many.
2. Participants are put in order, starting from their IDs sorted the same way on every computer.
3. The first participant in the order gets the first slot in `roles`, the second the second, and
   so on. Extra participants get `overflow_role`.

Which ordering applies, highest priority first:

| Setting                  | Order                                                                                                                                                                                           | Also waits until                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `strategy` is a function | You return the whole `{ participantId: { role } }` map.                                                                                                                                         | your `ready` returns `true`             |
| `role_from`              | No order; each participant's role is read from their data.                                                                                                                                      | it returns a value for everyone         |
| `rank_by`                | By the number, highest first; ties by ID.                                                                                                                                                       | it returns a finite number for everyone |
| `"join_order"`           | By `joinedAt`, earliest first.                                                                                                                                                                  | everyone has a `joinedAt`               |
| `"random"`               | A shuffle from the session's shared randomness, the same on every computer. It differs between groups, changes with `round` and `seed`, and can be pinned with the `randomSeed` connect option. | —                                       |
| `"rotate"`               | ID order, shifted by `round`. Over *n* rounds, each participant holds each role once.                                                                                                           | —                                       |

`joinedAt` comes from each participant's own clock, so `"join_order"` reflects who arrived first
only as well as their clocks agree.

`rank_by`, `role_from`, and `ready` are called before everyone's data has arrived, so a function
like `(entry) => entry.stats.score` will throw at first. A throw counts as "not ready yet"; you don't
need to guard against missing data. If the group never becomes ready, the last error is logged to
the console.

A configuration mistake, such as more participants than slots with no `overflow_role`, or
`role_from` returning a role you didn't declare, stops the experiment with an error instead of
recording a result.

## What the rules see

The snapshot that `strategy`, `rank_by`, `role_from`, and `ready` see holds every participant who
has reached **this** trial and hasn't left. Each entry is that participant's session data with
their `write_data` from this trial merged over it. So a rule can read both a value written before
the trial, such as a condition the page wrote right after connecting, and a value written in the
trial itself, such as a score.

Data that another trial wrote in its own part of the shared data is **not** visible here. To use
such a value, for example a score from an earlier task, write it to the session data with
`jsPsych.multiplayer.update({ score }, { scope: "session" })`, or pass it in through `write_data`:

```js
{
  type: jsPsychMultiplayerRole,
  roles: ["leader", "follower", "follower"],
  group_size: 3,
  write_data: () => ({ score: myScore }),
  rank_by: (entry) => entry.score,
}
```

## Set `group_size`

Every participant computes the same roles from the same data, but the plugin can't make sure they
all see the same set of participants. Without `group_size` or a `ready` condition, the trial may
assign roles the moment this participant's own data is written, before anyone else's has arrived.
The plugin warns in the console when both are missing.

Put a lobby before the role trial so the group is gathered, and set `group_size` to the exact
number you expect.

With an adapter that forms groups (JATOS, or Firebase with `matchmaking`), you can skip both:
wait for the group to be sealed first, with `jsPsych.multiplayer.waitForGroup()`, and leave
`group_size` as `null`. It then counts the sealed group's members. See
[Forming groups](../guides/forming-groups).

## Reading roles in later trials

The plugin keeps the latest assignment for later trials, through functions on the browser global:

| Function                                      | Returns                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `jsPsychMultiplayerRole.getMyRole()`          | This participant's role, e.g. `"proposer"`.                                      |
| `jsPsychMultiplayerRole.getMyAssignment()`    | This participant's entry in the map, `{ role }`.                                 |
| `jsPsychMultiplayerRole.getRoleMap()`         | The full map.                                                                    |
| `jsPsychMultiplayerRole.participantsByRole()` | Participant IDs grouped by role, e.g. `{ proposer: ["p1"], responder: ["p2"] }`. |

They read the data of the most recent role trial. All of them return `undefined` (or `{}`) before
an assignment, and after a trial that ended without one. When you run the trial again for a new
round, they return the new round's roles. On a page that runs more than one jsPsych instance, pass
the instance, e.g. `jsPsychMultiplayerRole.getMyRole(jsPsych)`.

## Example

Two players, roles by arrival, and the rest of the timeline split by role:

```js
const assignRoles = {
  type: jsPsychMultiplayerRole,
  roles: ["proposer", "responder"],
  strategy: "join_order",
  group_size: 2,
  on_finish: (data) => {
    if (data.multiplayer_outcome !== "completed") return; // timed out or a partner left
    const byRole = jsPsychMultiplayerRole.participantsByRole();
    proposerId = byRole.proposer[0];
    responderId = byRole.responder[0];
  },
};

const proposerTurn = {
  timeline: [makeOffer, sendOfferAndWait],
  conditional_function: () => jsPsychMultiplayerRole.getMyRole() === "proposer",
};

const responderTurn = {
  timeline: [waitForOffer, respondToOffer],
  conditional_function: () => jsPsychMultiplayerRole.getMyRole() === "responder",
};

timeline.push(lobby, assignRoles, proposerTurn, responderTurn);
```

Swapping roles every round, for four rounds:

```js
for (let round = 0; round < 4; round++) {
  timeline.push({
    type: jsPsychMultiplayerRole,
    roles: ["proposer", "responder"],
    strategy: "rotate",
    round: round,
    group_size: 2,
  });
  timeline.push(proposerTurn, responderTurn);
}
```
