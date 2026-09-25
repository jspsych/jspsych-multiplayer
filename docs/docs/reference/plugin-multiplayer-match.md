---
id: plugin-multiplayer-match
title: multiplayer-match
sidebar_label: multiplayer-match
description: Split the group into pairs, triads, or larger sub-groups that every participant agrees on.
---

# `multiplayer-match`

A match trial splits a larger group into smaller ones: eight participants into four pairs, nine
into three triads. Every participant's browser works out the whole split on its own, from the
same shared data and the same rules, so all of them agree on who is with whom. Later trials find
this participant's partners with `jsPsychMultiplayerMatch.getMyPartners()`.

Use it for dyadic and small-group tasks run in a larger session: trust games, prisoner's
dilemmas, negotiations. Follow it with [`multiplayer-role`](plugin-multiplayer-role) to give roles
within each pair, or use this participant's seat in the group (`position`) as the role.

**What the participant sees:** "Finding your match…" until the group is ready, then the next
trial. The trial does not show who the partner is; show it in the next trial if you want to.

```js
timeline.push({
  type: jsPsychMultiplayerMatch,
  expected_players: 8,
  group_size: 2,
  strategy: "random",
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-match` |
| Browser global | `jsPsychMultiplayerMatch` |
| Trial type | `multiplayer-match` |
| Requires | a connected session (see [Getting started](../getting-started)), and usually a lobby before it ([`multiplayer-sync`](plugin-multiplayer-sync) or [`multiplayer-ready`](plugin-multiplayer-ready)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `group_size` | `number` | `2` | Members per sub-group: 2 for pairs, 3 for triads. Must be a whole number of at least 2. |
| `expected_players` | `number \| null` | `null` | Wait until **exactly** this many participants are present before splitting. Participants who have left don't count and aren't matched. In a [sealed group](../guides/forming-groups), `null` means the group's members who haven't left. Otherwise `null` relies on an earlier lobby to have gathered the group; see [Set `expected_players`](#set-expected_players). |
| `strategy` | `string` | `"ordered"` | How participants are ordered before being split: `"ordered"` (by participant ID), `"join_order"` (by `joinedAt`, earliest first), or `"random"` (a shuffle that is the same on every computer). Use `"random"` in real studies, so that pairings don't follow ID order. |
| `seed` | `string \| null` | `null` | Picks a different random grouping within the session. Randomness is seeded by the session ID (or the `randomSeed` connect option), so each group of participants gets its own grouping. |
| `round` | `number` | `0` | The round number. With `"random"`, a new `round` gives new partners. |
| `leftover` | `string` | `"error"` | What to do when the number of participants isn't a multiple of `group_size`: `"error"` stops the experiment with an error, `"spectator"` leaves the extra participants unmatched, and `"smaller_group"` puts them together in one smaller group. |
| `ready` | `(group, presence) => boolean` | `null` | Your own condition for when the group is ready to split. `group` leaves out participants who have left. Both arguments are frozen. A throw counts as "not ready yet"; if the group never becomes ready, the last error is logged. |
| `push_data` | `object` | `{}` | Extra fields to write to this participant's slot, merged alongside `joinedAt`. Must be plain JSON. |
| `save_group` | `boolean` | `false` | Save the shared data the split was computed from, as `group`. |
| `timeout` | `number \| null` | `30000` | The longest time to wait for the group to be ready, in ms. `null` or a negative number waits indefinitely; `0` gives up at once. |
| `on_timeout` | `function \| null` | `null` | Called with the `jsPsych` instance if `timeout` runs out. The trial ends unmatched either way. |
| `participants` | `string[] \| null` | `null` | The participants the match depends on. If one of them leaves before the group is ready, the trial ends unmatched with `partner_left: true`. `null` means every other participant who is connected when this trial starts. In a [sealed group](../guides/forming-groups), `null` means the rest of the group's members who haven't left, including any who are only `away`. `[]` ignores departures. |
| `message` | HTML string | `"<p>Finding your match…</p>"` | Shown while waiting. |

## Data

| Field | Type | Description |
| --- | --- | --- |
| `match_group` | `number \| null` | The number of this participant's sub-group, from 0. `null` for a spectator or if the trial ended unmatched. |
| `partners` | `string[] \| null` | The IDs of the other members of this participant's sub-group. `[]` for a spectator; `null` if the trial ended unmatched. |
| `members` | `string[] \| null` | All members of the sub-group, including this participant, in the same order on every computer. `null` for a spectator or if the trial ended unmatched. |
| `position` | `number \| null` | This participant's seat in `members`, from 0. `null` for a spectator or if the trial ended unmatched. |
| `match_map` | `object \| null` | The whole split, `{ participantId: { group, members, partners, position } }`. Spectators are not in it. `null` if the trial ended unmatched. |
| `matched_self` | `boolean` | Whether this participant was placed in a sub-group. Tells a spectator (`false`, but `match_map` is set) from a trial that ended unmatched (`match_map` is `null`). |
| `timed_out` | `boolean` | `true` if the group was not ready before `timeout` ran out. |
| `partner_left` | `boolean` | `true` if the trial ended because a participant in `participants` left. |
| `left_participant` | `string \| null` | The ID of the participant who left, when `partner_left` is `true`. |
| `connection_lost` | `boolean` | `true` if the trial ended because this participant's own connection was lost for good. |
| `group` | `object` | The shared data the split was computed from. Only saved when `save_group` is `true`. |

[Handling dropouts](../guides/handling-dropouts) explains `partner_left`, `left_participant`,
`connection_lost`, and how to branch on them. If the experiment ends or is aborted while the
trial is waiting, it stops without calling `on_timeout` and records no data.

## How the group is split

The trial merges `joinedAt` (the time this participant first reached a match trial; an existing
`joinedAt` is kept) and `push_data` into this participant's slot, then waits until the group is
ready:

- participants who have left are dropped,
- every remaining participant is `connected`,
- there are exactly `expected_players` of them, if you set it,
- for `"join_order"`, everyone has a `joinedAt`, and
- your `ready` condition, if you gave one, returns `true` (it replaces the `joinedAt` check).

Participants are then put in order by `strategy`, starting from their IDs sorted the same way on
every computer, and cut into consecutive groups of `group_size`: the first two are group 0, the
next two group 1, and so on. What happens to the last few depends on `leftover`.

## Set `expected_players`

Every participant computes the same split from the same data, but the plugin can't make sure they
all see the same set of participants. Without `expected_players` or a `ready` condition, the
trial may split the group the moment this participant's own data is written, before anyone
else's has arrived. The plugin warns in the console when both are missing.

Put a lobby before the match trial so the group is gathered, and set `expected_players` to the
exact number you expect. If more participants turn up than expected, the trial waits and then
times out instead of splitting a subset.

With an adapter that forms groups (JATOS, or Firebase with `matchmaking`), you can skip both:
wait for the group to be sealed first, with `jsPsych.multiplayer.waitForGroup()`, and leave
`expected_players` as `null`. It then counts the sealed group's members. See
[Forming groups](../guides/forming-groups).

## Reading the match in later trials

The plugin keeps the latest match for later trials, through functions on the browser global:

| Function | Returns |
| --- | --- |
| `jsPsychMultiplayerMatch.getMyMatch()` | This participant's entry, `{ group, members, partners, position }`. |
| `jsPsychMultiplayerMatch.getMyPartners()` | The partners' IDs; `[]` if unmatched. |
| `jsPsychMultiplayerMatch.getMyGroup()` | The sub-group number. |
| `jsPsychMultiplayerMatch.getMyPosition()` | This participant's seat in the sub-group, from 0. |
| `jsPsychMultiplayerMatch.getMatchMap()` | The whole split. |

Apart from `getMyPartners()`, they return `undefined` before a match, for a spectator, and after a
trial that ended unmatched.

## Example

Eight participants in random pairs, each pair playing one round of a prisoner's dilemma with
[`multiplayer-choice`](plugin-multiplayer-choice). Each pair gets its own `data_key`, so pairs
don't count each other's choices:

```js
const match = {
  type: jsPsychMultiplayerMatch,
  expected_players: 8,
  group_size: 2,
  strategy: "random",
  leftover: "spectator",
};

const pairedRound = {
  timeline: [
    {
      type: jsPsychMultiplayerChoice,
      prompt: "<p>Cooperate or defect?</p>",
      choices: ["Cooperate", "Defect"],
      data_key: () => "pd_" + [...jsPsychMultiplayerMatch.getMyMatch().members].sort().join("_"),
      expected_players: () => jsPsychMultiplayerMatch.getMyMatch().members.length,
      participants: () => jsPsychMultiplayerMatch.getMyPartners(),
    },
  ],
  conditional_function: () => jsPsychMultiplayerMatch.getMyMatch() !== undefined,
};

timeline.push(lobby, match, pairedRound);
```
