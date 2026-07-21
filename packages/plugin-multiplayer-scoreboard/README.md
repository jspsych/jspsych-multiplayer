# plugin-multiplayer-scoreboard

Show every player their **end-of-game scoreboard**: each client contributes its final score, the
trial waits (a barrier) until the group has reported, then every client independently computes the
_same_ ranked leaderboard from the shared group-session snapshot — no coordinator and no extra
round-trip — and renders it locally with its own row highlighted.

It builds on the jsPsych multiplayer API (`@jspsych/jspsych` group sessions). Like
[`plugin-multiplayer-role`](../plugin-multiplayer-role), the ranking is _deterministic consensus_:
given the same snapshot and options, all clients produce a byte-identical board (same order, same
ranks). The hard part this plugin owns is that agreement plus the ranking/tie logic — not your
scoring rules, which stay in your own game and are handed in via the `score` parameter.

> **Status.** The pure ranking core, the standing accessors, and the trial wrapper documented below
> are all implemented and tested. The wrapper is written against a local interface mirroring the
> jsPsych multiplayer API ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)); to actually
> run a trial you still need that API present at runtime plus a network adapter (e.g. JATOS group
> sessions) and several real participants in the same group.

## Loading

### In browser

```html
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-scoreboard"></script>
```

### Via NPM

```
npm install @jspsych-multiplayer/plugin-multiplayer-scoreboard
```

```js
import MultiplayerScoreboard from "@jspsych-multiplayer/plugin-multiplayer-scoreboard";
// The pure core and the standing accessors are static members of the plugin class:
//   MultiplayerScoreboard.buildLeaderboard, .getMyRank, .getMyScore, .getLeaderboard
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-scoreboard` requires jsPsych v8.0.0 or later, plus a
multiplayer API adapter (e.g. JATOS group sessions).

## Parameters

| Parameter         | Type          | Default                                            | Description                                                                                                                                                     |
| ----------------- | ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `score`           | float \| fn   | `null`                                             | This client's final score, **auto-computed from its own prior data** (a number or, typically, a function jsPsych evaluates — not entered by the participant), e.g. `() => jsPsych.data.get().select("points").sum()`. If it doesn't resolve to a finite number the client isn't ranked (a warning fires) but still sees the board. |
| `label`           | string        | `null`                                             | Display name this client pushes for its own row (dynamic). Defaults to the raw participantId. Overridden at render by `display_label` if set.                  |
| `data_key`        | string        | `"scoreboard"`                                     | Session field each participant's score entry is stored/read under. Namespacing avoids colliding with other pushed data and lets two scoreboards keep separate boards. |
| `group_size`      | int           | `null`                                             | Wait until **at least** this many participants have reported before revealing the board (a barrier); set it to the total expected count. `null` reveals immediately from whoever reported — only safe behind an upstream barrier. |
| `timeout`         | int           | `30000`                                            | Milliseconds to wait for `group_size` reporters. On expiry the board still renders (from whoever reported), flagged `timed_out: true`. `null` waits forever (discouraged). |
| `on_timeout`      | fn            | `null`                                             | `(jsPsych) => void` run if `timeout` elapses before `group_size` reporters arrive, just before the partial board is shown. The trial does **not** end here — the board still renders and ends on the button. |
| `sort`            | string        | `"desc"`                                           | `"desc"` ranks highest score first (points); `"asc"` ranks lowest first (e.g. reaction time).                                                                  |
| `tie_method`      | string        | `"standard"`                                       | How ties rank: `"standard"` competition ranking (1, 2, 2, 4) or `"dense"` (1, 2, 2, 3).                                                                        |
| `title`           | HTML string   | `"<h2>Final scores</h2>"`                          | Heading rendered above the board.                                                                                                                             |
| `show_rank`       | bool          | `true`                                             | Show the rank (`#`) column.                                                                                                                                    |
| `highlight_self`  | bool          | `true`                                             | Visually emphasise this client's own row.                                                                                                                     |
| `display_label`   | fn            | `null`                                             | `(id, group) => string` mapping any participantId to the name shown, overriding pushed labels. e.g. drive names from role output.                              |
| `score_format`    | fn            | `null`                                             | `(score) => string` formatting each displayed score. The raw number is still saved in the data.                                                               |
| `button_label`    | string        | `"Continue"`                                       | Label of the button that ends the trial. `null` hides it (then the trial cannot end — a warning fires).                                                        |
| `message`         | HTML string   | `"<p>Waiting for all players to finish…</p>"`      | Shown while waiting for the group.                                                                                                                             |

## Data generated

| Name          | Type   | Description                                                                          |
| ------------- | ------ | ----------------------------------------------------------------------------------- |
| `leaderboard` | array  | The full ranked board: `[{ participantId, score, rank, label, isSelf }]`.           |
| `my_rank`     | int    | This client's rank (1 = best); `null` if it did not report a score.                 |
| `my_score`    | float  | This client's score; `null` if it did not report.                                   |
| `num_players` | int    | Number of participants ranked on the board.                                         |
| `timed_out`   | bool   | `true` **only** if `group_size` reporters were not reached before `timeout` (board may be partial). |
| `error`       | string | A non-timeout failure message (e.g. this client's score push failed); `null` otherwise. |

## How ranking works

Each client pushes `{ score, label? }` under `data_key`. When the barrier lifts, every client runs the
same pure function over the snapshot:

- Participants **without a valid finite score** under `data_key` are **dropped**, not ranked last — an
  absent score means "did not report", not "scored zero".
- Rows are ordered by score (per `sort`), then by **participantId ascending** as a deterministic
  tie-break — so every client renders tied players in the same order regardless of who pushed when.
- Ranks follow the score sequence, so tied scores share a rank. `tie_method` chooses whether the next
  distinct score skips (`"standard"`: 1, 2, 2, 4) or not (`"dense"`: 1, 2, 2, 3).

Because the tie-break is snapshot-independent, the board is identical on every client — the same
consensus property `plugin-multiplayer-role` relies on.

## Reading your standing downstream

The plugin publishes this client's standing to a module-level store so later trials can branch on the
outcome without re-deriving the board. The accessors are static members of the plugin class:

```js
import MultiplayerScoreboard from "@jspsych-multiplayer/plugin-multiplayer-scoreboard";

// Only the winner sees a celebration screen.
const winnerScreen = {
  timeline: [celebrationTrial],
  conditional_function: () => MultiplayerScoreboard.getMyRank() === 1,
};

// Or read the whole board:
const board = MultiplayerScoreboard.getLeaderboard(); // [{ participantId, score, rank, label, isSelf }]
```

## Missing scores and partial boards

- **No valid score**: `score` is meant to be auto-computed from this client's own prior data (a dynamic
  `score` function) — it is never entered by the participant. If it doesn't resolve to a finite number,
  the client still views the board but isn't ranked (`my_rank`/`my_score` are `null`) and a console
  warning fires. This is a safety net for a participant who legitimately has no scored trials, **not** a
  "watch-only" mode.
- **Timeout**: rather than hanging or blanking, the board renders from whoever reported and sets
  `timed_out: true`. An end screen should degrade to a partial ranking.
- **Push/backend failure**: if this client's score push fails, that is **not** a timeout — the board
  still renders (without this client's row), `timed_out` stays `false`, `on_timeout` does not fire, and
  the failure is preserved separately in the `error` data field.

## Membership consensus caveat

As with `plugin-multiplayer-role`, this plugin guarantees that given the _same_ snapshot every client
computes the _same_ board — it does **not** by itself guarantee everyone sees the same snapshot. Set
`group_size` (the exact count) so the reveal is a real barrier; without it the board reveals as soon as
this client reports and may be partial (a console warning fires).

## Author / Citation

Mandy Liao
