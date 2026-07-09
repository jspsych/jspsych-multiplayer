# plugin-multiplayer-scoreboard

Shows every player their end-of-game scoreboard: each client contributes its final score, the trial waits (a barrier) until the group has reported, then every client independently computes the same ranked leaderboard from the shared group-session snapshot — no coordinator, no extra round-trip — and renders it locally with its own row highlighted. The standing is exposed to downstream trials via static accessors and saved to the data record. See the [README](../README.md) for ranking/tie details, missing-score handling, and reading your standing downstream.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified. Other parameters can be left unspecified if the default value is acceptable.

| Parameter         | Type               | Default Value                                 | Description                                                                                                                        |
| ----------------- | ------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `score`           | float \| function  | `null`                                        | This client's final score, auto-computed from its own prior data (a number or a function jsPsych evaluates — not entered by the participant). If it doesn't resolve to a finite number, the client isn't ranked but still views the board. |
| `label`           | string             | `null`                                        | Display name this client pushes for its own row (dynamic). Defaults to the participantId.                                         |
| `data_key`        | string             | `"scoreboard"`                                | Session field each participant's score entry is stored/read under.                                                                |
| `group_size`      | integer            | `null`                                        | Wait until **at least** this many participants have reported before revealing the board. `null` reveals immediately (trusts an upstream barrier). |
| `timeout`         | integer            | `30000`                                       | Milliseconds to wait for `group_size` reporters. On expiry the board still renders, flagged `timed_out: true`. `null` waits forever. |
| `on_timeout`      | function           | `null`                                        | `(jsPsych) => void` run if `timeout` elapses before `group_size` reporters arrive, before the partial board is shown. The trial does not end here. |
| `sort`            | string             | `"desc"`                                      | `"desc"` ranks highest score first; `"asc"` ranks lowest first.                                                                   |
| `tie_method`      | string             | `"standard"`                                  | Tie ranking: `"standard"` (1, 2, 2, 4) or `"dense"` (1, 2, 2, 3).                                                                 |
| `title`           | HTML string        | `"<h2>Final scores</h2>"`                     | Heading rendered above the board.                                                                                                 |
| `show_rank`       | boolean            | `true`                                        | Show the rank column.                                                                                                             |
| `highlight_self`  | boolean            | `true`                                        | Visually emphasise this client's own row.                                                                                         |
| `display_label`   | function           | `null`                                        | `(id, group) => string` mapping any participantId to the displayed name, overriding pushed labels.                               |
| `score_format`    | function           | `null`                                        | `(score) => string` formatting each displayed score (the raw number is still saved).                                             |
| `button_label`    | string             | `"Continue"`                                  | Label of the button that ends the trial. `null` hides it (then the trial cannot end).                                            |
| `message`         | HTML string        | `"<p>Waiting for all players to finish…</p>"` | Shown while waiting for the group.                                                                                                |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects the following data for each trial.

| Name          | Type    | Value                                                                                 |
| ------------- | ------- | ------------------------------------------------------------------------------------- |
| `leaderboard` | array   | The full ranked board: `[{ participantId, score, rank, label, isSelf }]`.             |
| `my_rank`     | integer | This client's rank (1 = best); `null` if it did not report a score.                   |
| `my_score`    | float   | This client's score; `null` if it did not report.                                     |
| `num_players` | integer | Number of participants ranked on the board.                                           |
| `timed_out`   | boolean | `true` **only** if `group_size` reporters were not reached before `timeout` (board may be partial). |
| `error`       | string  | A non-timeout failure message (e.g. this client's score push failed); `null` otherwise. |

## Install

Using the CDN-hosted JavaScript file:

```js
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-scoreboard"></script>
```

Using the JavaScript file downloaded from a GitHub release dist archive:

```js
<script src="jspsych/plugin-multiplayer-scoreboard.js"></script>
```

Using NPM:

```
npm install @jspsych-multiplayer/plugin-multiplayer-scoreboard
```

```js
import MultiplayerScoreboard from "@jspsych-multiplayer/plugin-multiplayer-scoreboard";
```

## Examples

### Show final standings at the end of a game

```javascript
const scoreboard = {
  type: jsPsychMultiplayerScoreboard,
  score: () => jsPsych.data.get().select("points").sum(), // this client's total
  label: "You",
  group_size: 4, // wait for all four players to report
  sort: "desc", // highest score wins
};

// Branch on the outcome:
const winnerScreen = {
  timeline: [celebration],
  conditional_function: () => jsPsychMultiplayerScoreboard.getMyRank() === 1,
};
```

### A reaction-time leaderboard (lowest wins)

```javascript
const rtBoard = {
  type: jsPsychMultiplayerScoreboard,
  score: () => jsPsych.data.get().select("rt").mean(),
  group_size: 2,
  sort: "asc", // fastest (lowest mean RT) ranks first
  score_format: (ms) => `${Math.round(ms)} ms`,
};
```
