# @jspsych-multiplayer/plugin-multiplayer-draw

## 0.2.0

### Minor Changes

- [#34](https://github.com/jspsych/jspsych-multiplayer/pull/34) [`d37bcb3`](https://github.com/jspsych/jspsych-multiplayer/commit/d37bcb3d37fedf2daed5f9c9f2411d51879b6826) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `plugin-multiplayer-draw`, a real-time collaborative drawing canvas for the jsPsych multiplayer API.

  Every participant draws on one shared canvas; strokes from everyone appear live on everyone else's screen. Includes pen/eraser tools, a fixed color palette, brush sizes, and undo/redo buttons that only ever act on the participant's own strokes. Where `plugin-multiplayer-chat` pushes once per message, this plugin pushes continuously while a stroke is active (throttled and point-decimated), making it the first plugin that stresses the multiplayer API's `subscribe` primitive at a genuinely high rate. Full repaints (triggered by undo or a canvas resize) paint strokes in a global timestamp order so the eraser's `destination-out` compositing behaves consistently across clients. Built against a local interface mirroring the multiplayer API (jsPsych#3694), so it carries no build-time dependency on the unreleased core.

### Patch Changes

- [#49](https://github.com/jspsych/jspsych-multiplayer/pull/49) [`2fb283d`](https://github.com/jspsych/jspsych-multiplayer/commit/2fb283d43b7ab325a3d1fc8bc5014b52869a5c23) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Internal: adopt jsPsych#3694's `update()` convenience (shallow-merge into own slot, then push) at the four call sites that were hand-rolling `get() ?? {}` + spread + `push` for a top-level-key overwrite (draw's stroke pushes on flush/undo/redo, chat's message send). No behavior change; each package's local `MultiplayerApiLike` mirror gained an `update` member to match.

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.

- [#62](https://github.com/jspsych/jspsych-multiplayer/pull/62) [`d1552c0`](https://github.com/jspsych/jspsych-multiplayer/commit/d1552c0ef70fbd8bfcdebd3c9636d96cd66c3eb6) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Register trial timers through `jsPsych.pluginAPI.setTimeout` so they are cancelled when a trial is ended externally (`abortExperiment`, `endCurrentTimeline`, forced `finishTrial`), instead of firing into a finished trial. The plugins previously used bare `setTimeout` and only cleared handles on their own end paths, so external termination — exactly what multiplayer sync timeouts and host-ended sessions do — left timers alive.
