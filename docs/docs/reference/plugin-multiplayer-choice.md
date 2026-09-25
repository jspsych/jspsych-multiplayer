---
id: plugin-multiplayer-choice
title: multiplayer-choice
sidebar_label: multiplayer-choice
description: Have every participant choose at the same time, wait for the whole group, then show what everyone chose.
---

# `multiplayer-choice`

A choice trial is a simultaneous decision. Every participant picks one of the same options
without seeing anyone else's pick; once the whole group has chosen, the trial shows the outcome.
Use it for simultaneous-move games (prisoner's dilemma, coordination, public goods with a few
contribution levels) and for group votes.

The outcome screen either lists who chose what, or shows only the count for each option and the
winner, as an anonymous poll. An optional `payoff` function scores the round for each
participant.

**What the participant sees:** your `prompt` and one button per option. After a click, the
buttons dim and "Waiting for the other players to choose…" appears until the group has chosen.
Then the outcome screen, with a Continue button.

```js
timeline.push({
  type: jsPsychMultiplayerChoice,
  choices: ["Cooperate", "Defect"],
  expected_players: 2,
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-choice` |
| Browser global | `jsPsychMultiplayerChoice` |
| Trial type | `multiplayer-choice` |
| Requires | a connected session (see [Getting started](../getting-started)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `choices` | `string[]` | required | The options, one button each. HTML is allowed. The option's index (from 0) is what is shared with the group. |
| `prompt` | HTML string | `null` | Shown above the buttons. |
| `button_html` | `(choice, index) => string` | `null` | Returns the HTML for each option, as in `html-button-response`. `null` uses a plain `jspsych-btn` button. |
| `expected_players` | `number \| null` | `null` | How many participants, including this one, must choose before the outcome is shown. Can be a function that returns the number. `null` means everyone in a [sealed group](../guides/forming-groups) who hasn't left; if the group isn't sealed when the trial starts, you must set it. |
| `waiting_message` | HTML string | `"<p>Waiting for the other players to choose…</p>"` | Shown after this participant chooses, while the rest of the group finishes. |
| `timeout` | `number \| null` | `null` | The longest time to wait for the others **after** choosing, in ms. When it runs out, the trial goes on with whoever has chosen, with `multiplayer_outcome: "timeout"`, and `on_timeout` is called. `null`, `0`, or a negative number waits indefinitely. It does not limit how long this participant takes to choose. |
| `on_timeout` | `function \| null` | `null` | Called with the timeout error if `timeout` runs out first. |
| `participants` | `string[] \| null` | `null` | The participants this choice depends on. If one of them leaves before the group has chosen, the trial goes on with whoever has chosen, with `multiplayer_outcome: "participant_left"`. `null` means the other members of a [sealed group](../guides/forming-groups) who haven't left, or, without a sealed group, every other participant who is connected when this participant chooses. `[]` ignores departures. |
| `reveal` | `boolean` | `true` | Show the outcome screen. `false` ends the trial as soon as the group has chosen. |
| `reveal_mode` | `"players" \| "tally"` | `"players"` | `"players"` lists each participant's choice by name. `"tally"` shows only the count for each option and the winner (or a tie), never who chose what. |
| `reveal_prompt` | HTML string | `null` | A heading above the outcome. |
| `continue_label` | `string \| null` | `"Continue"` | The label of the button that ends the outcome screen. `null` hides the button; then set `reveal_duration`, or the screen can't end. |
| `reveal_duration` | `number \| null` | `null` | End the outcome screen automatically after this many ms. With a button as well, whichever comes first ends it. |
| `player_label` | `(participantId) => string` | `null` | The name to show for each participant in `"players"` mode. `null` shows participant IDs. |
| `payoff` | `(choices, me) => number` | `null` | Computes this participant's payoff. `choices` is `{ participantId: { index, label } }` and `me` is this participant's ID. The result is saved as `my_payoff` and shown on the outcome screen. |
| `record_choices_by_player` | `boolean` | `true` | Save everyone's choice as `choices_by_player`. Set `false` for an anonymous poll; see [Anonymous polls](#anonymous-polls). |

## Data

| Field | Type | Description |
| --- | --- | --- |
| `choice` | `string` | The label of this participant's choice. |
| `choice_index` | `number` | The index of this participant's choice, from 0. |
| `rt` | `number` | Milliseconds from the buttons appearing to this participant's click. |
| `wait_time` | `number` | Milliseconds from the click until the group had chosen (or the wait ended early). Does not include the outcome screen. |
| `choices_by_player` | `object \| null` | Everyone's choice, `{ participantId: { index, label } }`. `null` when `record_choices_by_player` is `false`. |
| `n_players` | `number` | How many choices were counted. |
| `tally` | `object[]` | One `{ index, label, count }` per option, in `choices` order. |
| `winner` | `object \| null` | The option with the most picks, `{ index, label, count }`. `null` on a tie or if no one chose. |
| `is_tie` | `boolean` | `true` if two or more options shared the most picks. |
| `tied_options` | `object[]` | The options that tied, in `choices` order. Empty if there was no tie. |
| `my_payoff` | `number \| null` | The value `payoff` returned. `null` without a `payoff` function, or if it threw or didn't return a finite number. |
| `multiplayer_outcome` | `string` | How the wait ended: `"completed"` (everyone chose), `"timeout"`, `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's own connection was lost for good). On any outcome but `"completed"`, the trial goes on with whoever chose so far. |
| `left_participant` | `string \| null` | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`. |

When the wait ends early, the trial still shows and records the outcome among those who did
choose. Check `multiplayer_outcome` in `on_finish`; [Handling dropouts](../guides/handling-dropouts)
has patterns for that. The counts include a choice from a participant who chose and then left. If
the experiment ends or is aborted while the trial is waiting, it stops quietly: `on_timeout` isn't
called and no data is recorded.

## Each trial has its own shared data

When a participant chooses, the plugin merges `{ choice: { index, label } }` into their part of
the trial's shared data. The trial counts participants who have a valid choice there and have not
left the session.

Each trial has its own part of the shared data, so a choice made in an earlier trial can never
count toward a later one. Participants running the same timeline share each trial's data, because
it is named by the trial's position in the timeline (see [How it works](../guides/how-it-works)).
To use a round's result later, read it from the trial's jsPsych data (`choices_by_player`,
`winner`, …).

Set the trial's `multiplayer_scope` parameter when several sub-groups choose separately in one
session. Give each sub-group its own name and set `expected_players` to the sub-group's size;
[`multiplayer-match`](plugin-multiplayer-match#example) shows this for pairs. The name is used
exactly as written, so a trial that repeats needs a name that changes with each repetition.

## Anonymous polls

With `reveal_mode: "tally"`, the outcome screen shows a bar for each option with its count, the
winner or the tie, and "(you)" next to this participant's own pick. Add
`record_choices_by_player: false` to leave the per-participant choices out of the data as well;
the data then holds the tally, the winner, and this participant's own choice.

This hides choices on screen and in your data, not in the session. Each participant's pick is
still in their part of the trial's shared data, and a participant who inspects the page's network traffic can see it.

## Example

A one-shot prisoner's dilemma with payoffs, followed by an anonymous vote:

```js
const PAYOFFS = [
  [3, 0], // I cooperate: they cooperate, they defect
  [5, 1], // I defect:    they cooperate, they defect
];

const dilemma = {
  type: jsPsychMultiplayerChoice,
  prompt: "<p>You and your partner choose at the same time.</p>",
  choices: ["Cooperate", "Defect"],
  expected_players: 2,
  timeout: 60000,
  reveal_prompt: "<h3>Both players have chosen</h3>",
  player_label: (id) => (id === jsPsych.multiplayer.participantId ? "You" : "Your partner"),
  payoff: (choices, me) => {
    // Find the other player's ID
    let other;
    for (const id in choices) {
      if (id !== me) {
        other = id;
        break;
      }
    }
    return PAYOFFS[choices[me].index][choices[other].index];
  },
};

const vote = {
  type: jsPsychMultiplayerChoice,
  prompt: "<p>Which game should the group play next?</p>",
  choices: ["Trust", "Ultimatum", "Public goods"],
  expected_players: 4,
  reveal_mode: "tally",
  record_choices_by_player: false,
  reveal_prompt: "<h3>The votes are in</h3>",
  on_finish: (data) => {
    nextGame = data.winner ? data.winner.label : "Public goods"; // winner is null on a tie
  },
};
```

If the partner times out, `choices[other]` is missing, `payoff` throws, and `my_payoff` is
recorded as `null`.
