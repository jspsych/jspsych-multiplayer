# @jspsych-multiplayer/plugin-multiplayer-chat

## 0.1.1

### Patch Changes

- [#49](https://github.com/jspsych/jspsych-multiplayer/pull/49) [`2fb283d`](https://github.com/jspsych/jspsych-multiplayer/commit/2fb283d43b7ab325a3d1fc8bc5014b52869a5c23) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Internal: adopt jsPsych#3694's `update()` convenience (shallow-merge into own slot, then push) at the four call sites that were hand-rolling `get() ?? {}` + spread + `push` for a top-level-key overwrite (draw's stroke pushes on flush/undo/redo, chat's message send). No behavior change; each package's local `MultiplayerApiLike` mirror gained an `update` member to match.

- [#29](https://github.com/jspsych/jspsych-multiplayer/pull/29) [`2650fa9`](https://github.com/jspsych/jspsych-multiplayer/commit/2650fa9da7a39cd74fb7ac9fb9c982ef99e1f082) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Fix unreadable chat transcript: the plugin shipped no CSS, so sender and message text rendered as bare unstyled `<span>`s with nothing between them (e.g. "AliceHello"). Inject minimal scoped styles (boxed log, one message per line, bold sender label with a colon separator, own-message highlight) so the transcript is legible out of the box.

  Also clarifies the chat-room example's name prompt ("Choose a display name — this is what other participants will see you as in the chat") since testers read the original wording as naming the chat room itself.

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.

- [#62](https://github.com/jspsych/jspsych-multiplayer/pull/62) [`d1552c0`](https://github.com/jspsych/jspsych-multiplayer/commit/d1552c0ef70fbd8bfcdebd3c9636d96cd66c3eb6) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Register trial timers through `jsPsych.pluginAPI.setTimeout` so they are cancelled when a trial is ended externally (`abortExperiment`, `endCurrentTimeline`, forced `finishTrial`), instead of firing into a finished trial. The plugins previously used bare `setTimeout` and only cleared handles on their own end paths, so external termination — exactly what multiplayer sync timeouts and host-ended sessions do — left timers alive.

## 0.1.0

### Minor Changes

- [#21](https://github.com/jspsych/jspsych-multiplayer/pull/21) [`5e28485`](https://github.com/jspsych/jspsych-multiplayer/commit/5e284850abe647eefcf989eb47c930def733e37b) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `plugin-multiplayer-chat`, a real-time chat-room trial for the jsPsych multiplayer API.

  It is the first plugin built on the API's real-time `subscribe` primitive rather than the `push → wait` barrier used by `plugin-multiplayer-sync`: the trial stays open, subscribes to the shared group session, renders the merged transcript of every participant's messages, and lets this participant send messages. It ends on any configured condition — a `duration` timeout, an `end_button_label` click, or an `end_when` predicate over the group session — and stores the transcript this client saw in the trial data. Message text is rendered as text (never HTML), and because the API's `push` replaces a participant's slot, sending reads the client's own slot first so other pushed data (e.g. a role) is preserved. Built against a local interface mirroring the multiplayer API so it carries no build-time dependency on the unreleased core (jsPsych#3694); a pure `chat-core` module (message merge/sort/dedup) is unit-tested in isolation, and the trial is exercised against an in-memory mock that fires subscribers on every push.
