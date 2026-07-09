# @jspsych-multiplayer/plugin-multiplayer-sync

## 0.1.0

### Minor Changes

- [#16](https://github.com/jspsych/jspsych-multiplayer/pull/16) [`66452d6`](https://github.com/jspsych/jspsych-multiplayer/commit/66452d6374fb90858d4d2520852714f6c83b6102) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `plugin-multiplayer-sync`, a synchronization-barrier plugin for the jsPsych multiplayer API.

  It packages the common **push → wait** pattern into a single declarative trial: optionally push this participant's data into the shared group session, show a waiting message, and end the trial once a condition over the group session is met (or an optional `timeout` elapses). This replaces the awkward idioms previously needed for synchronization points — a `call-function` trial with `async`/`done`, or a `NO_KEYS` keyboard-response trial with an `on_start` that awaits `pluginAPI.wait()`. The resolved snapshot is stored in the trial's `group` data so peer reads and role assignment (e.g. via `plugin-multiplayer-role`) happen in a normal `on_finish`. Ported from the reference implementation in jsPsych#3694; built against a local interface mirroring the multiplayer API so it carries no build-time dependency on the unreleased core.
