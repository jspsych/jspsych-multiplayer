---
"@jspsych-multiplayer/plugin-multiplayer-sync": minor
"@jspsych-multiplayer/plugin-multiplayer-ready": minor
"@jspsych-multiplayer/plugin-multiplayer-choice": minor
"@jspsych-multiplayer/plugin-multiplayer-match": minor
"@jspsych-multiplayer/plugin-multiplayer-role": minor
"@jspsych-multiplayer/plugin-multiplayer-scoreboard": minor
"@jspsych-multiplayer/plugin-multiplayer-countdown": minor
---

Move to jsPsych#3694's session-based multiplayer API, and handle participants who leave.

**Breaking:** these plugins need a jsPsych with the redesigned multiplayer API (sessions, presence,
`wait(condition, { timeout, participants })`). On a jsPsych without `jsPsych.multiplayer` they throw
an error saying so.

- **Timeouts work again.** The old positional `wait(condition, timeout)` form silently meant "no
  timeout" under the redesigned core; every configured `timeout` (sync, ready, choice, match, role,
  scoreboard) is honored again.
- **Departures.** The barrier plugins (sync, ready, choice, match, role, scoreboard) take a
  `participants` parameter: the participants the barrier depends on. It defaults to every other
  participant who is connected when the wait starts (`null`), except in sync, where it defaults to
  `[]` (ignore departures) because sync is often used as a lobby. If one leaves, the trial ends the
  way a timeout would, and records `partner_left: true` and `left_participant`.
  Counts, lobbies, and partitions ignore participants who have left.
- **Lost connections** end the wait with `connection_lost: true` instead of failing the trial.
  Countdown keeps running locally and records `connection_lost`.
- **One key per gate.** ready, choice, and scoreboard now tie each trial's writes to that trial:
  `data_key` defaults to `ready-N` / `choice-N` / `scoreboard-N`, counting that plugin's trials in the
  order this participant reaches them, so flags or choices from an earlier trial can't count toward a
  later one. An explicit `data_key` is used as-is. The key used is recorded as `data_key`. A trial that
  only some participants reach needs an explicit key, and the count restarts on a page reload.
- **ready** merges `push_data` and the gate flag into the slot with `update()` instead of replacing
  the slot with `push()`, so earlier gates' flags and other data survive. It still sets `ready: true`.
- **Frozen snapshots.** User callbacks (`wait_for`, `ready`, `rank_by`, `role_from`, `display_label`,
  …) receive frozen data. Predicates receive `(snapshot, presence)`. In match and role, a throwing
  predicate or accessor still means "not ready", and the last error is logged if the group never
  becomes ready.
- **scoreboard** drops its own timeout race and backstop wait in favor of the core's timeout, and
  shows a note on boards revealed after a departure or a lost connection.
