# @jspsych-multiplayer/plugin-multiplayer-reference-game

## 0.2.0

### Minor Changes

- [#42](https://github.com/jspsych/jspsych-multiplayer/pull/42) [`a836cd6`](https://github.com/jspsych/jspsych-multiplayer/commit/a836cd65d809ef7d0f10cf1190fe3687e8f29758) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Add `plugin-multiplayer-reference-game`, a repeated referential communication game ("tangrams"; Hawkins, Frank & Goodman 2020) for two players on the jsPsych multiplayer API.

  Two players are paired as a fixed director and matcher and see the same objects, each in an independently scrambled layout; only the director sees which objects are targets (and, for more than one, in what order). They communicate over an integrated free-text chat, the matcher assigns objects to the director's ordered target slots (a single click when there is one target), and both then see feedback with the true answer revealed. The published "sequential" (one target, click) and "unconstrained" (all N objects are ordered targets, reproduce the whole board) conditions are the same task with two parameters turned differently — `stimuli` length and `targets` length — so one configurable plugin covers both, plus everything in between. Like `plugin-multiplayer-chat` it is a continuously-open, `subscribe`-driven trial: the matcher's submitted assignment is the shared trigger on which both clients score, show feedback, and end. Object/target counts, scramble mode, chat direction and limits, scoring rule, feedback content, and an optional pre-submit interaction log are all parameters. Composes with `plugin-multiplayer-role` (director/matcher) and `plugin-multiplayer-sync` (lobby). Built against a local interface mirroring the multiplayer API (jsPsych#3694), so it carries no build-time dependency on the unreleased core.

### Patch Changes

- [#53](https://github.com/jspsych/jspsych-multiplayer/pull/53) [`57ea69d`](https://github.com/jspsych/jspsych-multiplayer/commit/57ea69dd54502b1b138b6898b928c808178f74af) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Resolve the multiplayer API via `resolveMultiplayerApi()`, preferring `jsPsych.multiplayer` (jsPsych#3694's current namespace) and falling back to `jsPsych.pluginAPI`, with a directing error when neither is present.

- [#62](https://github.com/jspsych/jspsych-multiplayer/pull/62) [`d1552c0`](https://github.com/jspsych/jspsych-multiplayer/commit/d1552c0ef70fbd8bfcdebd3c9636d96cd66c3eb6) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Register trial timers through `jsPsych.pluginAPI.setTimeout` so they are cancelled when a trial is ended externally (`abortExperiment`, `endCurrentTimeline`, forced `finishTrial`), instead of firing into a finished trial. The plugins previously used bare `setTimeout` and only cleared handles on their own end paths, so external termination — exactly what multiplayer sync timeouts and host-ended sessions do — left timers alive.
