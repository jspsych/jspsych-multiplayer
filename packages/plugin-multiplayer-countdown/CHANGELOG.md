# @jspsych-multiplayer/plugin-multiplayer-countdown

## 0.2.0

### Minor Changes

- [#41](https://github.com/jspsych/jspsych-multiplayer/pull/41) [`b4d2faa`](https://github.com/jspsych/jspsych-multiplayer/commit/b4d2faad65380f59a1afae34d7685fb8a9eb6f90) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `plugin-multiplayer-countdown`, a synchronized group timer (countdown or count-up) for the jsPsych multiplayer API.

  Every participant pushes its own start timestamp into its own slot, and each client derives the displayed time from the **minimum** timestamp across all slots — a coordination-free consensus (no elected anchor, no single point of failure) in the same spirit as `plugin-multiplayer-role`'s ordering. Late joiners and refreshes resume at the group's actual remaining time for free, and the pure consensus core (`startedAtKey` / `resolveStartedAt` / `computeRemaining` / `computeElapsed` / `formatTime`) is exposed as statics on the default export so demos can render their own synced display. Requires a jsPsych with the multiplayer API from jsPsych#3694.

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

- [#107](https://github.com/jspsych/jspsych-multiplayer/pull/107) [`be66150`](https://github.com/jspsych/jspsych-multiplayer/commit/be66150ff8d39b75da233302c4cb46dce11ba707) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Port to the hardened multiplayer API. The start timestamp now lives in the trial's own scope of the shared data under `countdown_started_at`, so every countdown starts a fresh clock and the `name` parameter is removed. To run one clock across several trials, give them the same `multiplayer_scope`. The trial records `multiplayer_outcome` (`"completed"` or `"connection_lost"`) and `left_participant` in place of `connection_lost`.

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

- Updated dependencies [[`403bfc4`](https://github.com/jspsych/jspsych-multiplayer/commit/403bfc482be7162b45432b0c7836af43c1eac919)]:
  - @jspsych-multiplayer/utils@0.1.0
