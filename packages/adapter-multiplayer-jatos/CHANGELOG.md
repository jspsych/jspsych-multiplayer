# @jspsych-multiplayer/adapter-multiplayer-jatos

## 0.1.0

### Minor Changes

- [#17](https://github.com/jspsych/jspsych-multiplayer/pull/17) [`4d26f2e`](https://github.com/jspsych/jspsych-multiplayer/commit/4d26f2ec9c441f812f214bb30ced318f15749dab) Thanks [@htsukamoto5](https://github.com/htsukamoto5)! - Add `adapter-multiplayer-jatos`, a JATOS group-study backend for the jsPsych multiplayer API.

  It implements the `MultiplayerAdapter` contract (`connect` / `push` / `getAll` / `get` / `subscribe` / `disconnect`) over JATOS's group session and WebSocket channel, so multiplayer plugins (`plugin-multiplayer-sync`, `plugin-multiplayer-role`) run unchanged on JATOS. Each participant's data is namespaced under `groupSession[studyResultId]` (JATOS's group member id, unique per study run and — unlike `workerId` — never repeated across runs of the same worker; falls back to `workerId` if absent); `push()` retries on the group session's optimistic-concurrency version conflicts with exponential backoff + jitter. Ported from the reference implementation in jsPsych#3694; built against a local interface mirroring the adapter contract so it carries no build-time dependency on the unreleased core, and tested against an in-memory mock of the `jatos` global.
