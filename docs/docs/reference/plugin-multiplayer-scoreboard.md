---
id: plugin-multiplayer-scoreboard
title: multiplayer-scoreboard
sidebar_label: multiplayer-scoreboard
description: Collect each participant's final score and show everyone the same ranked leaderboard.
---

# `multiplayer-scoreboard`

A scoreboard trial ends a game by showing every player how they ranked. Each participant sends
their own score, the trial waits until the whole group has reported, and then every participant
sees the same ranked table with their own row highlighted.

You compute the score, not the participant: `score` is usually a function that adds up points
from earlier trials in this participant's data. The plugin handles the waiting, the ranking, and
ties, and saves this participant's rank so later trials can branch on it.

**What the participant sees:** the `message` ("Waiting for all players to finish…" by default)
until the group has reported, then your `title`, a table with rank, player, and score columns,
and a **Continue** button. The trial ends when they click it.

```js
timeline.push({
  type: jsPsychMultiplayerScoreboard,
  score: () => jsPsych.data.get().select("points").sum(),
  group_size: 4,
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-scoreboard` |
| Browser global | `jsPsychMultiplayerScoreboard` |
| Trial type | `multiplayer-scoreboard` |
| Requires | a connected session (see [Getting started](../getting-started)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `score` | `number` | `null` | This participant's final score. Usually a function, evaluated when the trial starts, e.g. `() => jsPsych.data.get().select("points").sum()`. If it isn't a finite number, this participant still sees the board but isn't on it, and a warning is logged. |
| `label` | `string \| null` | `null` | The name other players see on this participant's row. `null` shows their participant ID. Can be a function. |
| `data_key` | `string \| null` | `null` | The field in each slot where the score is stored. `null` uses `scoreboard-1` for the first scoreboard, `scoreboard-2` for the second, and so on (see [Several scoreboards](#several-scoreboards)). |
| `group_size` | `number \| null` | `null` | How many scores to wait for before showing the board. Set it to the number of players. Scores from participants who have left don't count toward it (they still appear on the board). `null` shows the board at once, from whoever has reported, and logs a warning. |
| `timeout` | `number \| null` | `30000` | The longest time to wait for `group_size` scores, in ms. When it runs out, the board is shown from whoever has reported, with `timed_out: true`. `null` waits indefinitely. |
| `on_timeout` | `function \| null` | `null` | Called with the jsPsych instance if `timeout` runs out, just before the partial board is shown. The trial does not end here; it still ends on the button. |
| `participants` | `string[] \| null` | `null` | The participants the board waits for. If one of them leaves before `group_size` scores are in, the board is shown from whoever has reported, with `partner_left: true`. `null` means every other participant who is connected when this participant reports. `[]` ignores departures. |
| `sort` | `string` | `"desc"` | `"desc"` ranks the highest score first; `"asc"` ranks the lowest first (for times or errors). |
| `tie_method` | `string` | `"standard"` | How tied scores are ranked. `"standard"` skips ranks after a tie (1, 2, 2, 4); `"dense"` doesn't (1, 2, 2, 3). |
| `title` | HTML string | `"<h2>Final scores</h2>"` | Shown above the table. |
| `show_rank` | `boolean` | `true` | Show the rank column. |
| `highlight_self` | `boolean` | `true` | Show this participant's own row in bold on a yellow background. |
| `display_label` | `(id, group) => string` | `null` | The name shown on each row, given the participant ID and the shared data. Overrides `label`. `group` is frozen, so don't modify it. |
| `score_format` | `(score) => string` | `null` | How each score is shown, e.g. `(s) => s.toFixed(0) + " pts"`. The data keeps the raw number. |
| `button_label` | `string \| null` | `"Continue"` | The label of the button that ends the trial. `null` shows no button, so the trial never ends (a warning is logged). |
| `message` | HTML string | `"<p>Waiting for all players to finish…</p>"` | Shown while waiting for the group. |

## Data

| Field | Type | Description |
| --- | --- | --- |
| `leaderboard` | `object[]` | The ranked board, best first. Each row is `{ participantId, score, rank, label, isSelf }`. |
| `my_rank` | `number \| null` | This participant's rank (1 is best). `null` if they didn't report a valid score. |
| `my_score` | `number \| null` | This participant's score. `null` if they didn't report a valid score. |
| `num_players` | `number` | How many participants are on the board. |
| `data_key` | `string` | The field the scores were stored under: your `data_key`, or the generated `scoreboard-N`. |
| `timed_out` | `boolean` | `true` if `timeout` ran out before `group_size` scores arrived. The board may be missing players. |
| `partner_left` | `boolean` | `true` if the board was shown early because a participant in `participants` left. |
| `left_participant` | `string \| null` | The ID of the participant who left, when `partner_left` is `true`. |
| `connection_lost` | `boolean` | `true` if the board was shown early because this participant's own connection was lost for good. |
| `error` | `string \| null` | The message of any other failure, such as this participant's score failing to send. `null` otherwise. |

[Handling dropouts](../guides/handling-dropouts) explains `partner_left`, `left_participant`,
`connection_lost`, and how to branch on them. Whatever ended the wait, the participant still sees
a board built from the scores that arrived, with a short note above it, and still clicks
**Continue**. If the experiment ends or is aborted while the trial is waiting, the trial stops
without showing a board and records no data.

## How players are ranked

Participants with no valid score are left off the board rather than ranked last: no score means
"did not report", not "scored zero". Everyone else is sorted by score. Tied players share a rank
and are listed in order of participant ID, so every participant sees the rows in the same order.

## Several scoreboards

Each scoreboard needs its own `data_key`, so that scores from an earlier board don't count toward
a later one. With the default `null`, the first scoreboard a participant reaches uses
`scoreboard-1`, the second `scoreboard-2`, and so on. This matches across participants as long
as everyone reaches the same scoreboards in the same order.

Give a scoreboard an explicit `data_key` if only some participants reach it (for example, inside a
`conditional_function`). The count also starts over if a participant reloads the page.

## Using the result in later trials

After the board is shown, these functions return this participant's result. They return
`undefined` until a scoreboard has been shown.

| Function | Returns |
| --- | --- |
| `jsPsychMultiplayerScoreboard.getMyRank()` | This participant's rank. |
| `jsPsychMultiplayerScoreboard.getMyScore()` | This participant's score. |
| `jsPsychMultiplayerScoreboard.getLeaderboard()` | The full board, as in the `leaderboard` data field. |

## Example

A four-player game in which each player's name, entered earlier, appears on their row, followed
by a screen only the winner sees:

```js
let myName = "";

const scoreboard = {
  type: jsPsychMultiplayerScoreboard,
  score: () => jsPsych.data.get().filter({ phase: "game" }).select("points").sum(),
  label: () => myName,
  group_size: 4,
  timeout: 60000,
  score_format: (s) => `${s} pts`,
  title: "<h2>Final standings</h2>",
};

const winnerScreen = {
  timeline: [
    {
      type: jsPsychHtmlButtonResponse,
      stimulus: "<p>You won! Your bonus will be added to your payment.</p>",
      choices: ["Finish"],
    },
  ],
  conditional_function: () => jsPsychMultiplayerScoreboard.getMyRank() === 1,
};

timeline.push(scoreboard, winnerScreen);
```

For a reaction-time game where lower is better, set `sort: "asc"`.
