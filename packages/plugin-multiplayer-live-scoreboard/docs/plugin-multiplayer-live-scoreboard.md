# plugin-multiplayer-live-scoreboard

Shows every player a live-updating scoreboard: each client pushes its own score once, then the trial stays open and re-ranks the board in real time as the other players report, using the multiplayer API's `subscribe` primitive. A caption tracks how many players have arrived. The standing is exposed to downstream trials via static accessors and saved to the data record when the trial ends.

> **This is a standalone trial screen, NOT a persistent overlay across other trials.** While it is open it owns the display (a lobby, an intermission, a shared "watch the scores climb" screen). The overlay-across-trials form would require jsPsych extension infrastructure this repo does not yet have and is a deferred variant. For a one-shot end-of-game board that waits (a barrier) for everyone before showing a final ranking, use the sibling [`plugin-multiplayer-scoreboard`](../plugin-multiplayer-scoreboard).

See the [README](../README.md) for ranking/tie details, missing-score handling, and reading your standing downstream.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified. Other parameters can be left unspecified if the default value is acceptable.

| Parameter          | Type               | Default Value            | Description                                                                                                                        |
| ------------------ | ------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `score`            | float \| function  | `null`                   | This client's score, auto-computed from its own prior data (a number or a function jsPsych evaluates — not entered by the participant), pushed **once** at trial start. If it doesn't resolve to a finite number, the client isn't ranked but still watches the board. |
| `label`            | string             | `null`                   | Display name this client pushes for its own row (dynamic). Defaults to the participantId.                                         |
| `data_key`         | string             | `"scoreboard"`           | Session field each participant's score entry is stored/read under.                                                                |
| `sort`             | string             | `"desc"`                 | `"desc"` ranks highest score first; `"asc"` ranks lowest first.                                                                   |
| `tie_method`       | string             | `"standard"`             | Tie ranking: `"standard"` (1, 2, 2, 4) or `"dense"` (1, 2, 2, 3).                                                                 |
| `title`            | HTML string        | `"<h2>Live scores</h2>"` | Heading rendered above the board.                                                                                                 |
| `show_rank`        | boolean            | `true`                   | Show the rank column.                                                                                                             |
| `highlight_self`   | boolean            | `true`                   | Visually emphasise this client's own row.                                                                                         |
| `display_label`    | function           | `null`                   | `(id, group) => string` mapping any participantId to the displayed name, overriding pushed labels.                               |
| `score_format`     | function           | `null`                   | `(score) => string` formatting each displayed score (the raw number is still saved).                                             |
| `duration`         | integer            | `null`                   | Auto-end the trial after this many milliseconds. `null` means no time limit — then `end_button_label` and/or `end_when` is required. |
| `end_button_label` | string             | `null`                   | If set, show a button with this label that ends the trial when clicked. `null` hides it.                                          |
| `end_when`         | function           | `null`                   | Predicate `(group) => boolean` evaluated on every update; the trial ends as soon as it returns true.                             |
| `expected_players` | integer            | `null`                   | Total players expected, used **only** for the "N of M reported" caption. It does not gate rendering. `null` → caption shows just "N reported". |

At least one of `duration`, `end_button_label`, or `end_when` must be set, or the board can never close.

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects the following data for each trial.

| Name          | Type    | Value                                                                                 |
| ------------- | ------- | ------------------------------------------------------------------------------------- |
| `leaderboard` | array   | The full ranked board at trial end: `[{ participantId, score, rank, label, isSelf }]`. |
| `my_rank`     | integer | This client's rank (1 = best) at trial end; `null` if it did not report a score.       |
| `my_score`    | float   | This client's score; `null` if it did not report.                                     |
| `num_players` | integer | Number of participants ranked on the board at trial end.                              |
| `ended_by`    | string  | What ended the trial: `"duration"`, `"button"`, or `"condition"`.                     |
| `error`       | string  | A failure message if this client's initial score push failed; `null` otherwise.       |

## Install

Using the CDN-hosted JavaScript file:

```js
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-live-scoreboard"></script>
```

Using the JavaScript file downloaded from a GitHub release dist archive:

```js
<script src="jspsych/plugin-multiplayer-live-scoreboard.js"></script>
```

Using NPM:

```
npm install @jspsych-multiplayer/plugin-multiplayer-live-scoreboard
```

```js
import MultiplayerLiveScoreboard from "@jspsych-multiplayer/plugin-multiplayer-live-scoreboard";
```

## Examples

### A lobby scoreboard that fills in as players finish

```javascript
const liveBoard = {
  type: jsPsychMultiplayerLiveScoreboard,
  score: () => jsPsych.data.get().select("points").sum(), // this client's total, auto-computed
  label: "You",
  expected_players: 4, // caption reads "N of 4 reported" as peers arrive
  end_when: (group) => Object.keys(group).length >= 4, // close once all four have reported
  end_button_label: "Continue", // ...or let a player leave early
};

// Branch on the standing at close:
const winnerScreen = {
  timeline: [celebration],
  conditional_function: () => jsPsychMultiplayerLiveScoreboard.getMyRank() === 1,
};
```

### A timed intermission board (lowest reaction time wins)

```javascript
const rtBoard = {
  type: jsPsychMultiplayerLiveScoreboard,
  score: () => jsPsych.data.get().select("rt").mean(),
  sort: "asc", // fastest (lowest mean RT) ranks first
  score_format: (ms) => `${Math.round(ms)} ms`,
  duration: 15000, // watch the board for 15s, then move on
};
```
