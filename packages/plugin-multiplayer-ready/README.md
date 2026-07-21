# @jspsych-multiplayer/plugin-multiplayer-ready

A participant-facing **ready / check-in** barrier for multiplayer jsPsych experiments, built on the multiplayer plugin API. It shows a prompt and a ready button; when the participant clicks it, the plugin pushes `{ ready: true }` into the shared group session, swaps to a waiting message, and ends the trial once every expected group member is ready (or an optional timeout elapses while waiting for the rest of the group).

Use it as the lobby / waiting-room step at the start of a multiplayer timeline, or anywhere the group needs an explicit "everyone confirm you're here before we continue" checkpoint.

## How it differs from `plugin-multiplayer-sync`

`plugin-multiplayer-sync` is a low-level barrier: you supply an arbitrary `wait_for` predicate and optional `push_data`. `plugin-multiplayer-ready` is a higher-level specialization that **owns the check-in UI** and the **"all members ready" condition** for you, and standardizes on a `ready: true` flag so other plugins and examples (chat rooms, ultimatum games, real-time tasks) can reliably gate on group readiness. Reach for `sync` when you need a custom condition; reach for `ready` when you want a drop-in "I'm ready" lobby.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. The plugin codes against a local interface mirroring that API (`src/multiplayer-api.ts`) and reaches the real object with one cast — the single seam to re-verify once #3694 lands. Tests run against an in-memory mock, so no live group session is needed.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.pluginAPI.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter          | Type                    | Default                               | Description                                                                                                                                                              |
| ------------------ | ----------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expected_players` | integer                 | _undefined_ (required)                | Total group size, **including this participant**, that must be ready before the trial ends. May be a function returning a number.                                        |
| `stimulus`         | HTML string \| function | _undefined_ (required)                | The instructions shown above the ready button.                                                                                                                          |
| `prompt`           | HTML string \| function | `null`                                | Optional secondary reminder shown below the button (jsPsych `prompt` convention). `null` shows nothing.                                                                 |
| `button_label`     | string \| function      | `"I'm ready"`                         | Label on the ready button.                                                                                                                                              |
| `waiting_message`  | HTML string \| function | `"<p>Waiting for other players…</p>"` | Shown after this participant clicks ready, while waiting for the rest of the group.                                                                                     |
| `push_data`        | object \| function      | `null`                                | Extra fields merged into the pushed record alongside `ready: true` (e.g. a display name). Because pushes overwrite-per-participant, this record replaces anything this participant pushed earlier — put anything that must survive the check-in here. |
| `timeout`          | integer                 | `null`                                | Max time to wait for the rest of the group **after** clicking ready, in ms. On elapse the trial ends with `timed_out: true` and `on_timeout` is called. `null` waits indefinitely. Does **not** bound how long the participant takes to click. |
| `on_timeout`       | function                | `null`                                | Called if `timeout` elapses before the whole group is ready.                                                                                                           |
| `minimum_wait`     | integer                 | `0`                                   | Minimum time, in ms, to keep the waiting message on screen after clicking ready, so it doesn't flash by when the group is already ready (e.g. the last participant, or solo `expected_players: 1`). Does not extend a naturally longer wait. |

## Data Generated

| Name         | Type           | Description                                                                                                                        |
| ------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `rt`         | integer        | Time from the ready button appearing to this participant clicking it, in ms.                                                      |
| `wait_time`  | integer        | Time spent waiting for the rest of the group, in ms, from the click until the trial ended.                                        |
| `n_ready`    | integer        | Number of group members marked ready in the snapshot when the trial ended.                                                        |
| `group`      | object         | The full group session snapshot when the group was ready (or the timeout fired). Read peers / assign roles from here in `on_finish`. |
| `timed_out`  | boolean        | True if the trial ended because `timeout` elapsed rather than because everyone was ready.                                          |
| `wait_error` | string \| null | The timeout error message when `timeout` elapsed; `null` when everyone was ready. A non-timeout `wait()` failure (an adapter error) is not recorded here — it fails the trial instead. |

## Overwrite-per-participant semantics

`push` uses **overwrite-per-participant**: each participant has a single entry in the group session, and every push replaces it. This plugin pushes `{ ...push_data, ready: true }` as one record, so the check-in **replaces** whatever this participant pushed before. In practice a ready gate is usually the first multiplayer trial, so there is nothing to overwrite — but if you place it after a trial that pushed data you still need, re-supply that data via `push_data` so it is carried through the check-in.

The all-ready condition is robust here because, within this trial, the only push is the ready push — so a member's `ready` flag is never overwritten-away before the barrier resolves.

## Example: a two-player waiting room

```js
const readyGate = {
  type: jsPsychMultiplayerReady,
  expected_players: 2,
  stimulus: "<p>You'll be matched with another player. Click when you're ready.</p>",
  waiting_message: "<p>Waiting for the other player to check in…</p>",
  timeout: 120000, // give up after 2 minutes of waiting for the other player
  on_timeout: () => console.warn("The other player didn't check in."),
  on_finish: (data) => {
    // Role assignment stays experiment-specific — do it here off data.group, or hand the snapshot
    // to @jspsych-multiplayer/plugin-multiplayer-role for deterministic consensus.
    const [firstId, secondId] = Object.keys(data.group).sort();
    myRole = jsPsych.pluginAPI.participantId === firstId ? "proposer" : "responder";
  },
};
```

## Scope

A jsPsych plugin is a trial, so this plugin covers readiness checkpoints that are their own timeline step (lobbies, "press ready to continue" gates). For communication _in the middle_ of another interactive trial, use the raw `jsPsych.pluginAPI` (`push`, `wait`, `get`, `getAll`, `subscribe`) directly, or `plugin-multiplayer-sync` for a custom-condition barrier.
