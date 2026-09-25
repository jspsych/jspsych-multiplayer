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
| `label` | `string \| null` | `null` | The name other players see on this participant's row. `null` shows their participant ID. Can be a function. `display_label` overrides it. |
| `group_size` | `number \| null` | `null` | How many scores to wait for before showing the board. Set it to the number of players. Participants who have left don't count toward it. In a [sealed group](../guides/forming-groups), `null` means the group's members who haven't left. Otherwise `null` shows the board at once, from whoever has reported, and logs a warning. |
| `timeout` | `number \| null` | `30000` | The longest time to wait for `group_size` scores, in ms. When it runs out, the board is shown from whoever has reported, with `multiplayer_outcome: "timeout"`. `null`, `0`, or a negative number waits indefinitely (not recommended). |
| `on_timeout` | `function \| null` | `null` | Called with the jsPsych instance if `timeout` runs out, just before the partial board is shown. The trial does not end here; it still ends on the button. |
| `participants` | `string[] \| null` | `null` | The participants the board waits for. If one of them leaves before `group_size` scores are in, the board is shown from whoever has reported, with `multiplayer_outcome: "participant_left"`. `null` means the other members of a [sealed group](../guides/forming-groups) who haven't left, or else every other participant who is connected when this participant reports. `[]` ignores departures. |
| `sort` | `string` | `"desc"` | `"desc"` ranks the highest score first; `"asc"` ranks the lowest first (for times or errors). |
| `tie_method` | `string` | `"standard"` | How tied scores are ranked. `"standard"` skips ranks after a tie (1, 2, 2, 4); `"dense"` doesn't (1, 2, 2, 3). |
| `title` | HTML string | `"<h2>Final scores</h2>"` | Shown above the table. |
| `show_rank` | `boolean` | `true` | Show the rank column. |
| `highlight_self` | `boolean` | `true` | Highlight this participant's own row. |
| `display_label` | `(id, group) => string` | `null` | The name shown on each row, given the participant ID and the session's shared data (see [Names from earlier trials](#names-from-earlier-trials)). Overrides `label`. `group` is frozen, so don't modify it. |
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
| `multiplayer_outcome` | `string \| null` | How waiting for the group ended: `"completed"` (`group_size` scores arrived), `"timeout"`, `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's connection was lost for good). The board may be missing players for anything but `"completed"`. `null` when reporting failed some other way (see `error`). |
| `left_participant` | `string \| null` | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`. |
| `error` | `string \| null` | The message of any other failure, such as this participant's score failing to send. `null` otherwise. The board is still shown. |

[Handling dropouts](../guides/handling-dropouts) explains `multiplayer_outcome` and
`left_participant`, and how to branch on them. Whatever ended the wait, the participant still sees
a board built from the scores that arrived, with a short note above it, and still clicks
**Continue**. Their own row always appears. If the experiment ends or is aborted while the trial
is waiting, the trial stops without showing a board and records no data.

## How players are ranked

Participants with no valid score are left off the board rather than ranked last: no score means
"did not report", not "scored zero". Everyone else is sorted by score. Tied players share a rank
and are listed in order of participant ID, so every participant sees the rows in the same order.

## Several scoreboards

Each scoreboard trial shares scores in its own part of the shared data (its [trial
scope](../guides/how-it-works)), so scores reported to an earlier board never count toward a later
one. You don't need to name anything. Scores come from each participant's own jsPsych data, not
from the shared data.

## Names from earlier trials

To show names that participants chose in an earlier trial, write them to the session scope, which
lasts the whole session, and look them up in `display_label`. Its second argument is the session's
shared data:

```js
// In the trial where participants choose a name:
on_finish: (data) =>
  jsPsych.multiplayer.update({ name: data.response.name }, { scope: "session" }),

// On the scoreboard:
display_label: (id, group) => group[id]?.name ?? id,
```

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
const nameEntry = {
  type: jsPsychSurveyText,
  questions: [{ prompt: "Choose a player name", name: "name" }],
  on_finish: (data) =>
    jsPsych.multiplayer.update({ name: data.response.name }, { scope: "session" }),
};

// … the game's trials, each recording `phase: "game"` and `points` in its data …

const scoreboard = {
  type: jsPsychMultiplayerScoreboard,
  score: () => jsPsych.data.get().filter({ phase: "game" }).select("points").sum(),
  display_label: (id, group) => group[id]?.name ?? id,
  group_size: 4,
  timeout: 60000,
  score_format: (score) => `${score} pts`,
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

timeline.push(nameEntry, /* … */ scoreboard, winnerScreen);
```

For a reaction-time game where lower is better, set `sort: "asc"`.
