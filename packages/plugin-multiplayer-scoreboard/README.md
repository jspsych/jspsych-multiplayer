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

> **Status.** Requires the jsPsych multiplayer API
> ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)), which is not yet in a jsPsych
> release, plus a network adapter (e.g. JATOS group sessions) and several real participants in the
> same group. On a jsPsych without `jsPsych.multiplayer`, the trial throws an error saying so.

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

| Parameter        | Type          | Default                                       | Description                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `score`          | float \| fn   | `null`                                        | This client's final score, **auto-computed from its own prior data** (a number or, typically, a function jsPsych evaluates — not entered by the participant), e.g. `() => jsPsych.data.get().select("points").sum()`. If it doesn't resolve to a finite number the client isn't ranked (a warning fires) but still sees the board. |
| `label`          | string        | `null`                                        | Display name this client pushes for its own row (dynamic). Defaults to the raw participantId. Overridden at render by `display_label` if set.                                                                                                                                                                                      |
| `data_key`       | string        | `null`                                        | Session field each participant's score entry is stored/read under. `null` generates `scoreboard-1`, `scoreboard-2`, … so every board has its own key (see **Board keys**).                                                                                                                                                         |
| `group_size`     | int           | `null`                                        | Wait until **at least** this many participants have reported before revealing the board (a barrier); set it to the total expected count. Participants who have left the session don't count. `null` reveals immediately from whoever reported — only safe behind an upstream barrier. In a sealed group (`jsPsych.multiplayer.group().sealed`), `null` counts the group's members who haven't left.                                              |
| `timeout`        | int           | `30000`                                       | Milliseconds to wait for `group_size` reporters. On expiry the board still renders (from whoever reported), flagged `timed_out: true`. `null` waits forever (discouraged).                                                                                                                                                         |
| `on_timeout`     | fn            | `null`                                        | `(jsPsych) => void` run if `timeout` elapses before `group_size` reporters arrive, just before the partial board is shown. The trial does **not** end here — the board still renders and ends on the button.                                                                                                                       |
| `participants`   | array \| null | `null`                                        | Participants the board depends on. If one leaves the session before `group_size` reporters arrive, the board is shown from whoever reported, flagged `partner_left: true`. `null` means every other participant who is connected when this participant reports; `[]` ignores departures.                                    |
| `sort`           | string        | `"desc"`                                      | `"desc"` ranks highest score first (points); `"asc"` ranks lowest first (e.g. reaction time).                                                                                                                                                                                                                                      |
| `tie_method`     | string        | `"standard"`                                  | How ties rank: `"standard"` competition ranking (1, 2, 2, 4) or `"dense"` (1, 2, 2, 3).                                                                                                                                                                                                                                            |
| `title`          | HTML string   | `"<h2>Final scores</h2>"`                     | Heading rendered above the board.                                                                                                                                                                                                                                                                                                  |
| `show_rank`      | bool          | `true`                                        | Show the rank (`#`) column.                                                                                                                                                                                                                                                                                                        |
| `highlight_self` | bool          | `true`                                        | Visually emphasise this client's own row.                                                                                                                                                                                                                                                                                          |
| `display_label`  | fn            | `null`                                        | `(id, group) => string` mapping any participantId to the name shown, overriding pushed labels. e.g. drive names from role output. `group` is frozen; don't modify it.                                                                                                                                                              |
| `score_format`   | fn            | `null`                                        | `(score) => string` formatting each displayed score. The raw number is still saved in the data.                                                                                                                                                                                                                                    |
| `button_label`   | string        | `"Continue"`                                  | Label of the button that ends the trial. `null` hides it (then the trial cannot end — a warning fires).                                                                                                                                                                                                                            |
| `message`        | HTML string   | `"<p>Waiting for all players to finish…</p>"` | Shown while waiting for the group.                                                                                                                                                                                                                                                                                                 |

## Data generated

| Name               | Type   | Description                                                                                         |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| `leaderboard`      | array  | The full ranked board: `[{ participantId, score, rank, label, isSelf }]`.                           |
| `my_rank`          | int    | This client's rank (1 = best); `null` if it did not report a score.                                 |
| `my_score`         | float  | This client's score; `null` if it did not report.                                                   |
| `num_players`      | int    | Number of participants ranked on the board.                                                         |
| `data_key`         | string | The session field the scores were stored under (`data_key`, or the generated `scoreboard-N`).       |
| `timed_out`        | bool   | `true` **only** if `group_size` reporters were not reached before `timeout` (board may be partial). |
| `partner_left`     | bool   | `true` if the board was shown early because a participant in `participants` left the session.       |
| `left_participant` | string | The ID of the participant who left, when `partner_left` is true; `null` otherwise.                  |
| `connection_lost`  | bool   | `true` if the board was shown early because this participant's connection was lost for good.        |
| `error`            | string | Any other failure message (e.g. this client's score write was rejected); `null` otherwise.          |

## How ranking works

Each client writes `{ score, label? }` under `data_key`, with `jsPsych.multiplayer.update()` — a
shallow merge into its own slot, so anything earlier trials pushed there (a role, a chat log)
survives. When the barrier lifts, every client runs the same pure function over the snapshot:

- Participants **without a valid finite score** under `data_key` are **dropped**, not ranked last — an
  absent score means "did not report", not "scored zero".
- Rows are ordered by score (per `sort`), then by **participantId ascending** as a deterministic
  tie-break — so every client renders tied players in the same order regardless of who pushed when.
- Ranks follow the score sequence, so tied scores share a rank. `tie_method` chooses whether the next
  distinct score skips (`"standard"`: 1, 2, 2, 4) or not (`"dense"`: 1, 2, 2, 3).

Because the tie-break is snapshot-independent, the board is identical on every client — the same
consensus property `plugin-multiplayer-role` relies on.

### Board keys

Each scoreboard stores scores under its own `data_key`, so scores left over from an earlier board can
never count toward a later one. By default the key is `scoreboard-1` for the first board this
participant reaches, `scoreboard-2` for the second, and so on. Participants have to pass the boards in
the same order, so the Nth board gets the same key for everyone, however many other trials each
participant saw. Set an explicit `data_key` for a board that only some participants reach (for example
inside a `conditional_function`); the default count also starts over if the page reloads. An explicit
`data_key` is used as-is and doesn't advance the default count.

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
- **A participant leaving, or a lost connection**: the board likewise renders from whoever reported,
  with `partner_left: true` or `connection_lost: true` and a note above the board.
- **Write/backend failure**: if this client's score write is rejected, that is **not** a timeout — the
  board still renders, `timed_out` stays `false`, `on_timeout` does not fire, and the failure is
  preserved separately in the `error` data field. This client's own row still appears, because its
  own view shows its latest writes even when other participants haven't received them.
- **The experiment ending or aborting**: `jsPsych.abortExperiment()` (and the end of `jsPsych.run()`)
  cancels a pending wait. The trial then stops quietly — no board is drawn over the cleared display,
  nothing is logged, and no data is recorded.

## Membership consensus caveat

As with `plugin-multiplayer-role`, this plugin guarantees that given the _same_ snapshot every client
computes the _same_ board — it does **not** by itself guarantee everyone sees the same snapshot. Set
`group_size` (the exact count) so the reveal is a real barrier; without it the board reveals as soon as
this client reports and may be partial (a console warning fires).

## Author / Citation

Mandy Liao
