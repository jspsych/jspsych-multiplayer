# plugin-multiplayer-live-scoreboard

Show every player a **live-updating scoreboard**: each client pushes its own final score once, then
the trial stays open and re-ranks the board in real time as the other players report — participants
watch the standings fill in and climb. A caption tracks how many players have arrived
("N reported", or "N of M reported" when you set `expected_players`).

> **This is a standalone trial screen, NOT a persistent overlay across other trials.** While it is
> open it owns the display (like a lobby, an intermission, or a shared "watch the scores climb"
> screen). A scoreboard that floats over your other trials would need jsPsych _extension_
> infrastructure this repo does not yet have; that overlay form is a deferred variant. Use the
> sibling [`plugin-multiplayer-scoreboard`](../plugin-multiplayer-scoreboard) for a one-shot
> end-of-game board that waits (a barrier) for everyone and then shows a final ranking.

It builds on the jsPsych multiplayer API (`@jspsych/jspsych` group sessions) and is the scoreboard
counterpart of [`plugin-multiplayer-chat`](../plugin-multiplayer-chat): both use the API's real-time
`subscribe` primitive to keep a single trial re-rendering as the shared session changes. The ranking
is _deterministic consensus_ — given the same snapshot and options, every client computes a
byte-identical board — so each participant renders locally with no coordinator and no extra
round-trip.

> **Status.** The pure ranking core, the standing accessors, and the trial wrapper documented below
> are all implemented and tested. The wrapper is written against a local interface mirroring the
> jsPsych multiplayer API ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)); to actually
> run a trial you still need that API present at runtime plus a network adapter (e.g. JATOS group
> sessions) and several real participants in the same group.

## Loading

### In browser

```html
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-live-scoreboard"></script>
```

### Via NPM

```
npm install @jspsych-multiplayer/plugin-multiplayer-live-scoreboard
```

```js
import MultiplayerLiveScoreboard from "@jspsych-multiplayer/plugin-multiplayer-live-scoreboard";
// The pure core and the standing accessors are static members of the plugin class:
//   MultiplayerLiveScoreboard.buildLeaderboard, .getMyRank, .getMyScore, .getLeaderboard
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-live-scoreboard` requires jsPsych v8.0.0 or later, plus a
multiplayer API adapter (e.g. JATOS group sessions).

## Parameters

| Parameter          | Type          | Default              | Description                                                                                                                                                     |
| ------------------ | ------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `score`            | float \| fn   | `null`               | This client's score, **auto-computed from its own prior data** (a number or, typically, a function jsPsych evaluates — not entered by the participant), e.g. `() => jsPsych.data.get().select("points").sum()`. It is pushed **once**, at trial start. If it doesn't resolve to a finite number the client isn't ranked (a warning fires) but still watches the board. |
| `label`            | string        | `null`               | Display name this client pushes for its own row (dynamic). Defaults to the raw participantId. Overridden at render by `display_label` if set.                  |
| `data_key`         | string        | `"scoreboard"`       | Session field each participant's score entry is stored/read under. Namespacing avoids colliding with other pushed data and lets two scoreboards keep separate boards. |
| `sort`             | string        | `"desc"`             | `"desc"` ranks highest score first (points); `"asc"` ranks lowest first (e.g. reaction time).                                                                  |
| `tie_method`       | string        | `"standard"`         | How ties rank: `"standard"` competition ranking (1, 2, 2, 4) or `"dense"` (1, 2, 2, 3).                                                                        |
| `title`            | HTML string   | `"<h2>Live scores</h2>"` | Heading rendered above the board.                                                                                                                          |
| `show_rank`        | bool          | `true`               | Show the rank (`#`) column.                                                                                                                                    |
| `highlight_self`   | bool          | `true`               | Visually emphasise this client's own row.                                                                                                                     |
| `display_label`    | fn            | `null`               | `(id, group) => string` mapping any participantId to the name shown, overriding pushed labels. e.g. drive names from role output.                              |
| `score_format`     | fn            | `null`               | `(score) => string` formatting each displayed score. The raw number is still saved in the data.                                                               |
| `duration`         | int           | `null`               | Auto-end the trial after this many milliseconds. `null` (or non-positive) means no time limit — then you must set `end_button_label` and/or `end_when`.        |
| `end_button_label` | string        | `null`               | If set, show a button with this label that ends the trial when clicked. `null` hides it.                                                                       |
| `end_when`         | fn            | `null`               | Predicate `(group) => boolean` evaluated on every update; the trial ends as soon as it returns true. e.g. `(g) => Object.keys(g).length >= 4`.                 |
| `expected_players` | int           | `null`               | Total players expected to report, used **only** for the "N of M reported" caption. It does **not** gate rendering — there is no barrier. `null` → caption shows just "N reported". |

At least one of `duration`, `end_button_label`, or `end_when` must be set, or the board can never
close (a console warning fires).

## Data generated

| Name          | Type   | Description                                                                          |
| ------------- | ------ | ----------------------------------------------------------------------------------- |
| `leaderboard` | array  | The full ranked board at trial end: `[{ participantId, score, rank, label, isSelf }]`. |
| `my_rank`     | int    | This client's rank (1 = best) at trial end; `null` if it did not report a score.    |
| `my_score`    | float  | This client's score; `null` if it did not report.                                   |
| `num_players` | int    | Number of participants ranked on the board at trial end.                            |
| `ended_by`    | string | What ended the trial: `"duration"`, `"button"`, or `"condition"`.                   |
| `error`       | string | A failure message if this client's initial score push failed; `null` otherwise.     |

## How the live board works

Each client pushes `{ score, label? }` under `data_key` **once**, then subscribes to the shared
session. On every update it re-runs the same pure ranking function over the snapshot:

- Participants **without a valid finite score** under `data_key` are **dropped**, not ranked last — an
  absent score means "hasn't reported yet", not "scored zero". As peers report, their rows appear.
- Rows are ordered by score (per `sort`), then by **participantId ascending** as a deterministic
  tie-break — so every client renders tied players in the same order regardless of who pushed when.
- Ranks follow the score sequence, so tied scores share a rank. `tie_method` chooses whether the next
  distinct score skips (`"standard"`: 1, 2, 2, 4) or not (`"dense"`: 1, 2, 2, 3).

Your own score is **fixed at trial start** — the live-ness is about watching _other_ players' rows
arrive and the ranking shift, not about changing your own number.

## Reading your standing downstream

The plugin publishes this client's standing to a module-level store (on every render and at finish)
so later trials can branch on the outcome without re-deriving the board. The accessors are static
members of the plugin class:

```js
import MultiplayerLiveScoreboard from "@jspsych-multiplayer/plugin-multiplayer-live-scoreboard";

// Only the current leader sees a celebration screen.
const winnerScreen = {
  timeline: [celebrationTrial],
  conditional_function: () => MultiplayerLiveScoreboard.getMyRank() === 1,
};

// Or read the whole board:
const board = MultiplayerLiveScoreboard.getLeaderboard(); // [{ participantId, score, rank, label, isSelf }]
```

## Missing scores and report failures

- **No valid score**: `score` is meant to be auto-computed from this client's own prior data (a dynamic
  `score` function) — it is never entered by the participant. If it doesn't resolve to a finite number,
  the client still watches the board but isn't ranked (`my_rank`/`my_score` are `null`) and a console
  warning fires.
- **Report failure**: if this client's one-time score push fails, the board still renders (without this
  client's row), the failure is shown inline and preserved in the `error` data field, and the trial
  keeps watching so peers' scores continue to update.

## Author / Citation

Mandy Liao
