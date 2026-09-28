# @jspsych-multiplayer/plugin-multiplayer-draw

## 0.2.0

### Minor Changes

- [#34](https://github.com/jspsych/jspsych-multiplayer/pull/34) [`d37bcb3`](https://github.com/jspsych/jspsych-multiplayer/commit/d37bcb3d37fedf2daed5f9c9f2411d51879b6826) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `plugin-multiplayer-draw`, a real-time collaborative drawing canvas for the jsPsych multiplayer API.

  Every participant draws on one shared canvas; strokes from everyone appear live on everyone else's screen. Includes pen/eraser tools, a fixed color palette, brush sizes, and undo/redo buttons that only ever act on the participant's own strokes. Where `plugin-multiplayer-chat` pushes once per message, this plugin pushes continuously while a stroke is active (throttled and point-decimated), making it the first plugin that stresses the multiplayer API's `subscribe` primitive at a genuinely high rate. Full repaints (triggered by undo or a canvas resize) paint strokes in a global timestamp order so the eraser's `destination-out` compositing behaves consistently across clients. Requires a jsPsych with the multiplayer API from jsPsych#3694.

- [#107](https://github.com/jspsych/jspsych-multiplayer/pull/107) [`be66150`](https://github.com/jspsych/jspsych-multiplayer/commit/be66150ff8d39b75da233302c4cb46dce11ba707) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Port draw to the hardened multiplayer API.

  - Strokes live in the trial's own scope, so each draw trial starts with a blank canvas. **Removed `data_key`**; give several draw trials the same `multiplayer_scope` to keep drawing on one canvas.
  - New data field `multiplayer_outcome` (`"completed"`, `"participant_left"`, `"connection_lost"`, or `"cancelled"` when the experiment disconnects mid-trial). **Removed `partner_left` and `connection_lost`.** `ended_by` now only says which end condition completed the trial (`"duration"`, `"button"`, or `"condition"`) and is `null` otherwise.
  - With a sealed group, the trial ends when any other member who hasn't left leaves, including one who was only away when it started.
  - Strokes from a participant who leaves stay on the canvas and in the data.
  - Uses `@jspsych-multiplayer/utils`. The "connection trouble" note is gone: the core retries failed writes.

- [#94](https://github.com/jspsych/jspsych-multiplayer/pull/94) [`bae51f0`](https://github.com/jspsych/jspsych-multiplayer/commit/bae51f01cf64e5f1d383d05cd2b8aa179879d58d) Thanks [@jodeleeuw](https://github.com/jodeleeuw)! - Move chat, draw, and reference-game to the session-based jsPsych multiplayer API (jsPsych#3694) and handle participants leaving.

  - Use `jsPsych.multiplayer` directly, with a clear error on a jsPsych version without it.
  - New parameter `end_on_participant_left` (default `true`): chat and draw end when a participant who was connected at the start leaves the study; reference-game ends when the partner leaves before feedback. New data fields `partner_left`, `left_participant`, and `connection_lost`; `ended_by` can also be `"participant_left"` or `"connection_lost"`.
  - A lost connection ends the trial instead of leaving it waiting, and send errors no longer claim to be retrying after the connection is gone.
  - `end_when`, `sender_label` (chat), and `roster_label` (draw) also receive the presence snapshot; rosters mark participants who are away or have left. Reference-game partner auto-detection ignores participants who left.
  - Trial data no longer holds the API's frozen snapshots: draw's strokes and reference-game's `save_group` are copies.

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
