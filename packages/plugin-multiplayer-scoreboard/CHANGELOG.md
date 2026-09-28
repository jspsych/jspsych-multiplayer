# @jspsych-multiplayer/plugin-multiplayer-scoreboard

## 0.2.0

### Minor Changes

- [#94](https://github.com/jspsych/jspsych-multiplayer/pull/94) [`91ff22c`](https://github.com/jspsych/jspsych-multiplayer/commit/91ff22cd3d18d50298b64368fb21bfb9bd20539a) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Move to jsPsych#3694's session-based multiplayer API, and handle participants who leave.

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
    Counts, lobbies, and partitions ignore participants who have left. match and role also wait until
    every participant they count is connected, so clients agree on the group and a slot left over from
    an earlier member is never matched or given a role.
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

- [#106](https://github.com/jspsych/jspsych-multiplayer/pull/106) [`8b89cac`](https://github.com/jspsych/jspsych-multiplayer/commit/8b89cac0a90493467ea2752e4f5c107bceb2e24e) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Use the sealed group when there is one (`jsPsych.multiplayer.group()`, from an adapter that forms groups):

  - `expected_players` (ready, choice, match) and `group_size` (role, scoreboard) default to the sealed group's members who haven't left. `expected_players` on ready and choice is no longer required when the group is sealed; without a sealed group it still is, and the error says how to fix it.
  - `participants: null` means the rest of the sealed group's members who haven't left, including a member who is only `away` at that moment, instead of only the participants connected when the trial starts. Without a sealed group it is unchanged.

- [#33](https://github.com/jspsych/jspsych-multiplayer/pull/33) [`33d337e`](https://github.com/jspsych/jspsych-multiplayer/commit/33d337e3ca02ab8374c4f137d2a9bd4cef19566c) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Add `plugin-multiplayer-scoreboard`: an end-of-game scoreboard for multiplayer experiments. Each client contributes its final `score`, the trial waits (a barrier) until the group has reported, then every client independently computes the same ranked leaderboard from the shared group-session snapshot — no coordinator, no extra round-trip — and renders it locally with its own row highlighted. Supports ascending/descending sort, standard/dense tie ranking, an `on_timeout` hook, timeouts that degrade to a partial board, and static accessors (`getMyRank`/`getMyScore`/`getLeaderboard`) for branching downstream trials.

- [#107](https://github.com/jspsych/jspsych-multiplayer/pull/107) [`be66150`](https://github.com/jspsych/jspsych-multiplayer/commit/be66150ff8d39b75da233302c4cb46dce11ba707) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Port to the hardened multiplayer API (trial scopes, `MultiplayerError` codes).

  **Breaking:**

  - Each trial has its own part of the shared data, so boards no longer need their own keys: the `data_key` parameter and data field are removed, and scores are written under `scoreboard` in the trial's data.
  - `timed_out`, `partner_left`, and `connection_lost` are replaced by `multiplayer_outcome` (`"completed"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`; `null` when reporting failed some other way, which `error` describes); `left_participant` and `error` stay.
  - `display_label`'s second argument is now the session's shared data (what participants wrote with `{ scope: "session" }`, e.g. names chosen in earlier trials) instead of the whole group snapshot.

  A timeout of `0` or less now means no limit, like the other plugins. The board no longer waits for the backend to confirm this client's score before its timeout starts.

### Patch Changes

- [#90](https://github.com/jspsych/jspsych-multiplayer/pull/90) [`e698fc5`](https://github.com/jspsych/jspsych-multiplayer/commit/e698fc56c84aa507bd73bc0ddfb376840e475e6f) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Stop cleanly when the experiment ends or is aborted.

  A pending `wait()` now rejects with a `MultiplayerCancelledError` when the experiment ends or is
  aborted, instead of hanging. The plugins that wait on the group (choice, match, ready, role,
  scoreboard, sync) stop quietly on that error rather than treating it as a timeout or a backend
  failure. `plugin-multiplayer-scoreboard` previously logged an error and drew a final board over the
  cleared display, leaving a Continue button that called `finishTrial` after the run had ended.

  Fixes found alongside that work: `plugin-multiplayer-countdown` and `plugin-multiplayer-draw`
  registered their repeating timers with a raw `setInterval`, which survived `abortExperiment()` — the
  countdown could call `finishTrial` after the run ended and draw kept writing to the session forever;
  both now tick through jsPsych's own timer registry. `plugin-multiplayer-chat` and
  `plugin-multiplayer-reference-game` could drop a message when a participant sent two in quick
  succession; they no longer do. `adapter-multiplayer-firebase` marked itself connected before arming
  its disconnect cleanup, so a failure there left a connected-looking adapter with a leaked listener
  and a retry that silently did nothing; a failed `connect()` now releases everything it opened.

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Read the multiplayer API from `jsPsych.multiplayer` (jsPsych#3694's namespace), and throw an error that says so when it is absent. Builds that exposed these methods on `jsPsych.pluginAPI` predate the current API and are not supported.

- [#62](https://github.com/jspsych/jspsych-multiplayer/pull/62) [`d1552c0`](https://github.com/jspsych/jspsych-multiplayer/commit/d1552c0ef70fbd8bfcdebd3c9636d96cd66c3eb6) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Register trial timers through `jsPsych.pluginAPI.setTimeout` so they are cancelled when a trial is ended externally (`abortExperiment`, `endCurrentTimeline`, forced `finishTrial`), instead of firing into a finished trial. The plugins previously used bare `setTimeout` and only cleared handles on their own end paths, so external termination — exactly what multiplayer sync timeouts and host-ended sessions do — left timers alive.

- Updated dependencies [[`403bfc4`](https://github.com/jspsych/jspsych-multiplayer/commit/403bfc482be7162b45432b0c7836af43c1eac919)]:
  - @jspsych-multiplayer/utils@0.1.0
