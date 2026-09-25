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
| `ready` | `(group, presence) => boolean` | `null` | Your own condition for when the group is ready to split. `group` holds the participants who have reached this trial and haven't left (see [How the group is split](#how-the-group-is-split)). Both arguments are frozen. A throw counts as "not ready yet"; if the group never becomes ready, the last error is logged. |
| `write_data` | `object` | `{}` | Data this participant contributes to the split, for example for a custom `ready`. It is merged into this participant's part of the trial's shared data, so it never reaches another trial. Must be plain JSON: a `Date` arrives as a string, `undefined` values are dropped, and `BigInt` or circular data makes the write fail. |
| `save_group` | `boolean` | `false` | Save the shared data the split was computed from, as `group`. |
| `timeout` | `number \| null` | `30000` | The longest time to wait for the group to be ready, in ms. `null`, `0`, or a negative number waits indefinitely (not recommended). |
| `on_timeout` | `function \| null` | `null` | Called with the `jsPsych` instance if `timeout` runs out. The trial ends unmatched, with `multiplayer_outcome: "timeout"`, either way. |
| `participants` | `string[] \| null` | `null` | The participants the match depends on. If one of them leaves before the group is ready, the trial ends unmatched with `multiplayer_outcome: "participant_left"`. `null` means the other members of a [sealed group](../guides/forming-groups) who haven't left, or, without a sealed group, every other participant who is connected when this participant arrives. `[]` ignores departures. |
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
| `multiplayer_outcome` | `string` | How the trial ended: `"completed"`, `"timeout"` (the group was not ready before `timeout` ran out), `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's own connection was lost for good). |
| `left_participant` | `string \| null` | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`. |
| `group` | `object` | The snapshot the split was computed from. Only saved when `save_group` is `true`. |

[Handling dropouts](../guides/handling-dropouts) explains `multiplayer_outcome`,
`left_participant`, and how to branch on them. If the experiment ends or is aborted while the
trial is waiting, it stops quietly: `on_timeout` isn't called and no data is recorded.

## How the group is split

The trial writes `joinedAt` to this participant's session data, the time they first reached a match
(or role) trial; it is written once and never changed, so `"join_order"` gives the same order in
every later round. It also writes `write_data` to this participant's part of the trial's shared
data.

The split is computed from a snapshot that holds every participant who has reached **this** trial
and hasn't left. Each entry is that participant's session data with their `write_data` merged over
it, so `joinedAt`, or anything the page wrote with `{ scope: "session" }`, is visible, but data
another trial wrote in its own part of the shared data is not.

The trial waits until the group is ready:

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

They read the data of the most recent match trial. Apart from `getMyPartners()`, they return
`undefined` before a match, for a spectator, and after a trial that ended unmatched. On a page
that runs more than one jsPsych instance, pass the instance, e.g.
`jsPsychMultiplayerMatch.getMyPartners(jsPsych)`.

## Example

Eight participants in random pairs, each pair playing one round of a prisoner's dilemma with
[`multiplayer-choice`](plugin-multiplayer-choice). Everyone runs the same choice trial, so by
default all eight would share one part of the shared data and count each other's choices.
`multiplayer_scope` gives each pair its own part, `expected_players` counts only the pair's
members, and `participants` makes the trial go on if this participant's partner leaves:

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
      // Give each pair its own part of the shared data, so pairs don't count each other's choices
      multiplayer_scope: () => "pd-" + jsPsychMultiplayerMatch.getMyGroup(),
      expected_players: () => jsPsychMultiplayerMatch.getMyMatch().members.length,
      participants: () => jsPsychMultiplayerMatch.getMyPartners(),
    },
  ],
  conditional_function: () => jsPsychMultiplayerMatch.getMyMatch() !== undefined,
};

timeline.push(lobby, match, pairedRound);
```

`multiplayer_scope` is used exactly as written, so if you repeat the round, put the round number
in the name too, e.g. `` () => `pd-${round}-${jsPsychMultiplayerMatch.getMyGroup()}` ``.
