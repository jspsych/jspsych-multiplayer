# plugin-multiplayer-scoreboard

Show every player their **end-of-game scoreboard**: each client contributes its final score, the
trial waits (a barrier) until the group has reported, then every client independently computes the
_same_ ranked leaderboard from the trial's shared data — no coordinator and no extra
round-trip — and renders it locally with its own row highlighted.

It builds on the jsPsych multiplayer API (`jsPsych.multiplayer`). Like
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
| `label`          | string        | `null`                                        | Display name this client writes for its own row (dynamic). Defaults to the raw participantId. Overridden at render by `display_label` if set.                                                                                                                                                                                      |
| `group_size`     | int           | `null`                                        | Wait until **at least** this many participants have reported before revealing the board (a barrier); set it to the total expected count. Participants who have left the session don't count. `null` reveals immediately from whoever reported — only safe behind an upstream barrier. In a sealed group (`jsPsych.multiplayer.group().sealed`), `null` counts the group's members who haven't left.                                              |
| `timeout`        | int           | `30000`                                       | Milliseconds to wait for `group_size` reporters. On expiry the board still renders (from whoever reported), with `multiplayer_outcome: "timeout"`. `null`, `0`, or a negative value waits forever (discouraged).                                                                                                                                                         |
| `on_timeout`     | fn            | `null`                                        | `(jsPsych) => void` run if `timeout` elapses before `group_size` reporters arrive, just before the partial board is shown. The trial does **not** end here — the board still renders and ends on the button.                                                                                                                       |
| `participants`   | array \| null | `null`                                        | Participants the board depends on. If one leaves the session before `group_size` reporters arrive, the board is shown from whoever reported, with `multiplayer_outcome: "participant_left"`. `null` means the other members of a sealed group who haven't left, or else every other participant connected when this participant reports; `[]` ignores departures.                                    |
| `sort`           | string        | `"desc"`                                      | `"desc"` ranks highest score first (points); `"asc"` ranks lowest first (e.g. reaction time).                                                                                                                                                                                                                                      |
| `tie_method`     | string        | `"standard"`                                  | How ties rank: `"standard"` competition ranking (1, 2, 2, 4) or `"dense"` (1, 2, 2, 3).                                                                                                                                                                                                                                            |
| `title`          | HTML string   | `"<h2>Final scores</h2>"`                     | Heading rendered above the board.                                                                                                                                                                                                                                                                                                  |
| `show_rank`      | bool          | `true`                                        | Show the rank (`#`) column.                                                                                                                                                                                                                                                                                                        |
| `highlight_self` | bool          | `true`                                        | Visually emphasise this client's own row.                                                                                                                                                                                                                                                                                          |
| `display_label`  | fn            | `null`                                        | `(id, group) => string` mapping any participantId to the name shown, overriding written labels. `group` is the session's shared data (see **Names from earlier trials**), keyed by participantId; it is frozen, so don't modify it. e.g. drive names from role output.                                                                                                                                                              |
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
| `multiplayer_outcome` | string | How waiting for the group ended: `"completed"` (`group_size` reporters arrived), `"timeout"`, `"participant_left"` (a participant in `participants` left), or `"connection_lost"`. The board may be partial on any but `"completed"`. `null` when reporting failed some other way (see `error`). |
| `left_participant` | string | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`; `null` otherwise.                  |
| `error`            | string | The message of any other failure while reporting to the group (e.g. an adapter error); `null` otherwise. The board is still shown. |

## How ranking works

Each client writes `{ score, label? }` under the key `scoreboard` in its part of the trial's shared
data, with `jsPsych.multiplayer.update()`. When the barrier lifts, every client runs the same pure
function over the trial's shared data:

- Participants **without a valid finite score** are **dropped**, not ranked last — an
  absent score means "did not report", not "scored zero".
- Rows are ordered by score (per `sort`), then by **participantId ascending** as a deterministic
  tie-break — so every client renders tied players in the same order regardless of who wrote when.
- Ranks follow the score sequence, so tied scores share a rank. `tie_method` chooses whether the next
  distinct score skips (`"standard"`: 1, 2, 2, 4) or not (`"dense"`: 1, 2, 2, 3).

Because the tie-break is snapshot-independent, the board is identical on every client — the same
consensus property `plugin-multiplayer-role` relies on.

### Where scores come from

Each client's `score` comes from its **own jsPsych data** (e.g. `() => jsPsych.data.get().select("points").sum()`),
which every trial has already recorded locally; it is not read from the shared data. The board
shares scores with the group only during the scoreboard trial, in that trial's own part of the
shared data. Each trial has its own part, so scores reported to an earlier board can never count
toward a later one. Participants running the same timeline share each trial's data because it is
named by the trial's position in the timeline (or by the trial's `multiplayer_scope` parameter).

### Names from earlier trials

The board shows each row's written `label`, or the participantId. To show names that participants
chose in an earlier trial, write them to the session's shared data, which lasts the whole session,
and look them up in `display_label`, which receives that data as its second argument:

```js
// In the trial where participants choose a name:
on_finish: (data) => jsPsych.multiplayer.update({ name: data.response.name }, { scope: "session" }),

// On the scoreboard:
display_label: (id, group) => group[id]?.name ?? id,
```

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
- **Timeout**: rather than hanging or blanking, the board renders from whoever reported, with
  `multiplayer_outcome: "timeout"`. An end screen should degrade to a partial ranking.
- **A participant leaving, or a lost connection**: the board likewise renders from whoever reported,
  with `multiplayer_outcome` `"participant_left"` or `"connection_lost"` and a note above the board.
  This client's own row still appears, because its own view shows its latest writes even when other
  participants haven't received them.
- **Adapter failure**: any other failure while reporting is **not** a timeout — the board still
  renders, `multiplayer_outcome` is `null`, `on_timeout` does not fire, and the failure is preserved
  in the `error` data field.
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
