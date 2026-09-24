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

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-role` |
| Browser global | `jsPsychMultiplayerRole` |
| Trial type | `multiplayer-role` |
| Requires | a connected session (see [Getting started](../getting-started)), and usually a lobby before it ([`multiplayer-sync`](plugin-multiplayer-sync) or [`multiplayer-ready`](plugin-multiplayer-ready)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `roles` | `string[] \| object` | required | The roles to hand out. An array has one slot per entry: `["proposer", "responder"]`. An object gives counts: `{ leader: 1, follower: 3 }`. |
| `strategy` | `string \| function` | `"join_order"` | How participants are ordered into the slots: `"join_order"`, `"random"`, `"rotate"`, or your own function (see [How roles are assigned](#how-roles-are-assigned)). |
| `group_size` | `number \| null` | `null` | Wait until **exactly** this many participants are present before assigning. Participants who have left don't count. `null` relies on an earlier lobby to have gathered the group; see [Set `group_size`](#set-group_size). |
| `round` | `number` | `0` | The round number, used by `"rotate"` and to reshuffle `"random"`. Increase it each time you run the trial again. |
| `balanced` | `boolean` | `false` | For `"rotate"`: use a balanced (Williams) rotation, so each role follows every other role equally often across the group. Exact for an even number of participants. |
| `seed` | `string \| null` | `null` | Seed for `"random"`. `null` derives one from the participant IDs and `round`, so the shuffle is the same for everyone and changes each round. |
| `rank_by` | `(entry, id, ctx) => number` | `null` | Order participants by a number, highest first, e.g. a score. `entry` is the participant's whole slot. Takes precedence over a string `strategy`. |
| `role_from` | `(entry, id, ctx) => string` | `null` | Read each participant's role directly from their data. Must return one of the declared roles. Does not enforce the counts in `roles`. Takes precedence over `rank_by`. |
| `ready` | `(group, presence) => boolean` | `null` | Your own condition for when the group is ready to assign. **Required** with a custom `strategy` function. `group` leaves out participants who have left. Both arguments are frozen. |
| `overflow_role` | `string \| null` | `null` | The role for participants beyond the declared slots, e.g. `"spectator"`. Without it, more participants than slots is an error. |
| `push_data` | `object` | `{}` | Data this participant contributes for this round, such as the score `rank_by` reads. It is stored in the slot under `rounds[round]`. |
| `save_group` | `boolean` | `false` | Save the shared data the assignment was computed from, as `group`. |
| `timeout` | `number \| null` | `30000` | The longest time to wait for the group to be ready, in ms. `null` or a negative number waits indefinitely; `0` gives up at once. |
| `on_timeout` | `function \| null` | `null` | Called with the `jsPsych` instance if `timeout` runs out. The trial ends with `role: null` either way. |
| `participants` | `string[] \| null` | `null` | The participants the assignment depends on. If one of them leaves before the group is ready, the trial ends with `role: null, partner_left: true`. `null` means every other participant who is connected when this trial starts. `[]` ignores departures. |
| `message` | HTML string | `"<p>Assigning roles…</p>"` | Shown while waiting. |

`ctx`, passed to `rank_by`, `role_from`, and a custom `strategy`, is
`{ ids, round, seed }`: the sorted participant IDs, the `round`, and the `seed` you set (or `""`).

## Data

| Field | Type | Description |
| --- | --- | --- |
| `role` | `string \| null` | This participant's role. `null` if the trial ended without an assignment. |
| `role_map` | `object \| null` | The full assignment, `{ participantId: { role } }`, identical for every participant. `null` if the trial ended without an assignment. |
| `assigned_self` | `boolean` | Whether this participant is in `role_map`. `false` after a timeout or dropout, or when a custom strategy left this participant out. Overflow participants are in the map, so they read `true`. |
| `timed_out` | `boolean` | `true` if the group was not ready before `timeout` ran out. |
| `partner_left` | `boolean` | `true` if the trial ended because a participant in `participants` left. |
| `left_participant` | `string \| null` | The ID of the participant who left, when `partner_left` is `true`. |
| `connection_lost` | `boolean` | `true` if the trial ended because this participant's own connection was lost for good. |
| `group` | `object` | The shared data the assignment was computed from. Only saved when `save_group` is `true`. |

[Handling dropouts](../guides/handling-dropouts) explains `partner_left`, `left_participant`,
`connection_lost`, and how to branch on them. If the experiment ends or is aborted while the
trial is waiting, it stops without calling `on_timeout` and records no data.

## How roles are assigned

The trial writes two fields into this participant's slot, merged with what is already there:
`joinedAt`, the time this participant first reached a role trial (an existing `joinedAt` is kept),
and `rounds[round]`, the `push_data`. A later `push()`, including a `multiplayer-sync` trial's
`push_data`, replaces the whole slot, so carry `joinedAt` forward if you run role trials again. It then waits until the group is ready and computes the assignment:

1. Participants who have left are dropped. The group is not ready until every remaining
   participant is `connected` and, if you set `group_size`, there are exactly that many.
2. Participants are put in order, starting from their IDs sorted the same way on every computer.
3. The first participant in the order gets the first slot in `roles`, the second the second, and
   so on. Extra participants get `overflow_role`.

Which ordering applies, highest priority first:

| Setting | Order | Also waits until |
| --- | --- | --- |
| `strategy` is a function | You return the whole `{ participantId: { role } }` map. | your `ready` returns `true` |
| `role_from` | No order; each participant's role is read from their data. | it returns a value for everyone |
| `rank_by` | By the number, highest first; ties by ID. | it returns a finite number for everyone |
| `"join_order"` | By `joinedAt`, earliest first. | everyone has a `joinedAt` |
| `"random"` | A shuffle seeded from `seed`, the same on every computer. | — |
| `"rotate"` | ID order, shifted by `round`. Over *n* rounds, each participant holds each role once. | — |

`joinedAt` comes from each participant's own clock, so `"join_order"` reflects who arrived first
only as well as their clocks agree.

`rank_by`, `role_from`, and `ready` are called before everyone's data has arrived, so a function
like `(entry) => entry.rounds[0].score` will throw at first. A throw counts as "not ready yet"; you don't
need to guard against missing data. If the group never becomes ready, the last error is logged to
the console.

A configuration mistake, such as more participants than slots with no `overflow_role`, or
`role_from` returning a role you didn't declare, stops the experiment with an error instead of
recording a result.

## Set `group_size`

Every participant computes the same roles from the same data, but the plugin can't make sure they
all see the same set of participants. Without `group_size` or a `ready` condition, the trial may
assign roles the moment this participant's own data is written, before anyone else's has arrived.
The plugin warns in the console when both are missing.

Put a lobby before the role trial so the group is gathered, and set `group_size` to the exact
number you expect.

## Reading roles in later trials

The plugin keeps the latest assignment for later trials, through functions on the browser global:

| Function | Returns |
| --- | --- |
| `jsPsychMultiplayerRole.getMyRole()` | This participant's role, e.g. `"proposer"`. |
| `jsPsychMultiplayerRole.getMyAssignment()` | This participant's entry in the map, `{ role }`. |
| `jsPsychMultiplayerRole.getRoleMap()` | The full map. |
| `jsPsychMultiplayerRole.participantsByRole()` | Participant IDs grouped by role, e.g. `{ proposer: ["p1"], responder: ["p2"] }`. |

All of them return `undefined` (or `{}`) before an assignment, and after a trial that ended
without one. When you run the trial again for a new round, they return the new round's roles.

## Example

Two players, roles by arrival, and the rest of the timeline split by role:

```js
const assignRoles = {
  type: jsPsychMultiplayerRole,
  roles: ["proposer", "responder"],
  strategy: "join_order",
  group_size: 2,
  on_finish: (data) => {
    if (data.role === null) return; // timed out or a partner left
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
