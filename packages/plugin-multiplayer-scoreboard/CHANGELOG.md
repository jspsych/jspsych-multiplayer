# @jspsych-multiplayer/plugin-multiplayer-scoreboard

## 0.2.0

### Minor Changes

- [#33](https://github.com/jspsych/jspsych-multiplayer/pull/33) [`33d337e`](https://github.com/jspsych/jspsych-multiplayer/commit/33d337e3ca02ab8374c4f137d2a9bd4cef19566c) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Add `plugin-multiplayer-scoreboard`: an end-of-game scoreboard for multiplayer experiments. Each client contributes its final `score`, the trial waits (a barrier) until the group has reported, then every client independently computes the same ranked leaderboard from the shared group-session snapshot — no coordinator, no extra round-trip — and renders it locally with its own row highlighted. Supports ascending/descending sort, standard/dense tie ranking, an `on_timeout` hook, timeouts that degrade to a partial board, and static accessors (`getMyRank`/`getMyScore`/`getLeaderboard`) for branching downstream trials.

### Patch Changes

- [#33](https://github.com/jspsych/jspsych-multiplayer/pull/33) [`704e2a7`](https://github.com/jspsych/jspsych-multiplayer/commit/704e2a7fe6e28c5fafdae99bc2e6d153a9c333a6) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Drop the now-removed `communicate()` member from the local multiplayer API mirror and test mock (`communicate()` was removed from the jsPsych multiplayer API in jsPsych#3694). The plugin already pushed and waited as two separate calls, so there is no behavior change — this only trims dead interface surface.

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.

- [#62](https://github.com/jspsych/jspsych-multiplayer/pull/62) [`d1552c0`](https://github.com/jspsych/jspsych-multiplayer/commit/d1552c0ef70fbd8bfcdebd3c9636d96cd66c3eb6) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Register trial timers through `jsPsych.pluginAPI.setTimeout` so they are cancelled when a trial is ended externally (`abortExperiment`, `endCurrentTimeline`, forced `finishTrial`), instead of firing into a finished trial. The plugins previously used bare `setTimeout` and only cleared handles on their own end paths, so external termination — exactly what multiplayer sync timeouts and host-ended sessions do — left timers alive.
