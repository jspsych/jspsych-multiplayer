# @jspsych-multiplayer/plugin-multiplayer-ready

## 0.1.0

### Minor Changes

- [#30](https://github.com/jspsych/jspsych-multiplayer/pull/30) [`d54c569`](https://github.com/jspsych/jspsych-multiplayer/commit/d54c56931817af23fd2b221131c2416240aeb104) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Add `plugin-multiplayer-ready`, a participant-facing ready / check-in barrier for the jsPsych multiplayer API.

  It packages the common lobby / waiting-room pattern into a single declarative trial: show a prompt and a ready button, push `{ ready: true }` (optionally merged with `push_data`) into the shared group session when the participant clicks, display a waiting message, and end the trial once `expected_players` members are ready (or an optional `timeout` elapses while waiting for the rest of the group). Unlike `plugin-multiplayer-sync`, it owns the check-in UI and the "everyone is ready" condition, and standardizes on a `ready: true` flag so other plugins and examples can reliably gate on group readiness. Built against a local interface mirroring the multiplayer API (jsPsych#3694), so it carries no build-time dependency on the unreleased core.

### Patch Changes

- [#45](https://github.com/jspsych/jspsych-multiplayer/pull/45) [`21e0909`](https://github.com/jspsych/jspsych-multiplayer/commit/21e0909725076662c1c0d93453f832ddfd0def03) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Fix `wait_error`/`timed_out` mislabeling a non-timeout `wait()` failure as a timeout. Both plugins previously treated every `wait()` rejection as a timeout (a leftover from before jsPsych#3694 exported a typed `MultiplayerTimeoutError`), so a throwing `wait_for` predicate or an adapter/backend error would silently finish the trial with `timed_out: true` and call `on_timeout`, hiding the real failure in `wait_error`'s message.

  Now only a rejection whose `error.name === "MultiplayerTimeoutError"` is recorded as a timeout; any other rejection propagates and fails the trial, matching how a `push()` failure is already handled.

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.

- [#62](https://github.com/jspsych/jspsych-multiplayer/pull/62) [`d1552c0`](https://github.com/jspsych/jspsych-multiplayer/commit/d1552c0ef70fbd8bfcdebd3c9636d96cd66c3eb6) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Register trial timers through `jsPsych.pluginAPI.setTimeout` so they are cancelled when a trial is ended externally (`abortExperiment`, `endCurrentTimeline`, forced `finishTrial`), instead of firing into a finished trial. The plugins previously used bare `setTimeout` and only cleared handles on their own end paths, so external termination — exactly what multiplayer sync timeouts and host-ended sessions do — left timers alive.
