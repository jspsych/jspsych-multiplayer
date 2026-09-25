# @jspsych-multiplayer/plugin-multiplayer-reference-game

## 0.2.0

### Minor Changes

- [#42](https://github.com/jspsych/jspsych-multiplayer/pull/42) [`a836cd6`](https://github.com/jspsych/jspsych-multiplayer/commit/a836cd65d809ef7d0f10cf1190fe3687e8f29758) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Add `plugin-multiplayer-reference-game`, a repeated referential communication game ("tangrams"; Hawkins, Frank & Goodman 2020) for two players on the jsPsych multiplayer API.

  Two players are paired as a fixed director and matcher and see the same objects, each in an independently scrambled layout; only the director sees which objects are targets (and, for more than one, in what order). They communicate over an integrated free-text chat, the matcher assigns objects to the director's ordered target slots (a single click when there is one target), and both then see feedback with the true answer revealed. The published "sequential" (one target, click) and "unconstrained" (all N objects are ordered targets, reproduce the whole board) conditions are the same task with two parameters turned differently — `stimuli` length and `targets` length — so one configurable plugin covers both, plus everything in between. Like `plugin-multiplayer-chat` it is a continuously-open, `subscribe`-driven trial: the matcher's submitted assignment is the shared trigger on which both clients score, show feedback, and end. Object/target counts, scramble mode, chat direction and limits, scoring rule, feedback content, and an optional pre-submit interaction log are all parameters. Composes with `plugin-multiplayer-role` (director/matcher) and `plugin-multiplayer-sync` (lobby). Requires a jsPsych with the multiplayer API from jsPsych#3694.

- [#94](https://github.com/jspsych/jspsych-multiplayer/pull/94) [`bae51f0`](https://github.com/jspsych/jspsych-multiplayer/commit/bae51f01cf64e5f1d383d05cd2b8aa179879d58d) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Move chat, draw, and reference-game to the session-based jsPsych multiplayer API (jsPsych#3694) and handle participants leaving.

  - Use `jsPsych.multiplayer` directly, with a clear error on a jsPsych version without it.
  - New parameter `end_on_participant_left` (default `true`): chat and draw end when a participant who was connected at the start leaves the study; reference-game ends when the partner leaves before feedback. New data fields `partner_left`, `left_participant`, and `connection_lost`; `ended_by` can also be `"participant_left"` or `"connection_lost"`.
  - A lost connection ends the trial instead of leaving it waiting, and send errors no longer claim to be retrying after the connection is gone.
  - `end_when`, `sender_label` (chat), and `roster_label` (draw) also receive the presence snapshot; rosters mark participants who are away or have left. Reference-game partner auto-detection ignores participants who left.
  - Trial data no longer holds the API's frozen snapshots: draw's strokes and reference-game's `save_group` are copies.

- [#107](https://github.com/jspsych/jspsych-multiplayer/pull/107) [`be66150`](https://github.com/jspsych/jspsych-multiplayer/commit/be66150ff8d39b75da233302c4cb46dce11ba707) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Port reference-game to the hardened multiplayer API.

  - Each round's shared data (the submission, the chat, typing timestamps) lives in the round's own trial scope. **Removed `data_key` and `typing_key`.** With `chat_persists`, the chat log is kept in the session scope. The stale-replay guard now catches rounds that share a `multiplayer_scope`.
  - New data field `multiplayer_outcome` (`"completed"`, `"timeout"`, `"participant_left"`, `"connection_lost"`, or `"cancelled"`). **Removed `ended_by`, `partner_left`, and `connection_lost`.**
  - `show_running_score` sums `n_correct` from this participant's earlier reference-game trials in the jsPsych data, plus the current round.
  - Partner auto-detection uses the sealed group's other member, or else the other connected participant.
  - `save_group` saves this round's shared data. Chat messages from a partner who leaves stay in the transcript.
  - Uses `@jspsych-multiplayer/utils`. The send-error note is gone: the core retries failed writes.

- [#80](https://github.com/jspsych/jspsych-multiplayer/pull/80) [`e4c9a0b`](https://github.com/jspsych/jspsych-multiplayer/commit/e4c9a0bba514134ca147e67f21519ee67a867544) Thanks [@Mandyx22](https://github.com/Mandyx22)! - Add two options needed to match the original tangrams experiment (hawkrobe/tangrams) exactly:

  - `scramble_mode: "disjoint"` — like `"independent"`, but guarantees no object occupies the same
    slot for both players. Plain `"independent"` only guarantees the two layouts are not identical, so
    around a third of objects still coincide by chance and positional reference ("the one in the
    corner") sometimes works by luck. The original re-rolls its layouts until every position differs.
  - `feedback_content` may now be keyed by role — `{ director: {...}, matcher: {...} }` — so the two
    players can see different feedback. The original shows the director only the object the matcher
    clicked, and the matcher only the true target. A flat object still applies to both roles.

- [#67](https://github.com/jspsych/jspsych-multiplayer/pull/67) [`d6926f8`](https://github.com/jspsych/jspsych-multiplayer/commit/d6926f8d702636af0e601e7c6eb1b15c2d0d3529) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add a `require_message_before_response` parameter. When true, the matcher cannot commit a selection until the director has sent at least one chat message this round — while gated, matcher grid clicks are ignored and a brief hint is shown. This makes the plugin faithful to Hawkins, Frank & Goodman (2020) Exp. 2, whose client blocked the matcher's click behind `messageSent`, guaranteeing a referring expression on every trial. Defaults to `false` (unchanged behavior); inert with a warning when `chat_enabled` is false (gating with no channel would deadlock the matcher). Applies to both the `click` and `assign_slots` response modes. Only the partner's messages open the gate, so neither the matcher's own message nor a third participant's counts. Blocked clicks are recorded as `gated_click` events in `interaction_history` when `save_interaction_history` is on.

  Chat messages now also carry the `round` they were sent during. This makes the gate exact under `chat_persists: true`, where every round shares one log: an earlier round's message never pre-opens the gate, and the director's message for the current round still counts when it lands before the matcher's trial is constructed (the two clients do not enter a round at the same moment). Saved `chat_transcript` entries gain the same `round` field; transcripts written by earlier versions still merge and render.

- [#105](https://github.com/jspsych/jspsych-multiplayer/pull/105) [`3f2f35c`](https://github.com/jspsych/jspsych-multiplayer/commit/3f2f35c0545c485e27e6e677708e80eb5139b246) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Arrangements now come from the session's shared randomness (`jsPsych.multiplayer.shuffle`), so each group gets its own arrangements, seeded by the session ID or the `randomSeed` connect option. `seed` still picks different arrangements within a session.

- [#92](https://github.com/jspsych/jspsych-multiplayer/pull/92) [`e0fec98`](https://github.com/jspsych/jspsych-multiplayer/commit/e0fec98b4c4324a969f9ddece9f655e5ab7f3179) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add a `typing_indicator` option (off by default) showing a "partner is typing…" hint driven by a
  timestamp each client keeps in its own slot (`typing_key`, throttled by `typing_throttle`, hidden
  `typing_ttl` after the last keystroke, labelled via `typing_label`). Hint only — it never gates
  trial progress, and it hides while the partner is away or has left. The timestamp is written with
  `update()`, which merges only that key, so it can't overwrite chat or round data.

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
