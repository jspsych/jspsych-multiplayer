# @jspsych-multiplayer/plugin-multiplayer-ready

A participant-facing **ready / check-in** barrier for multiplayer jsPsych experiments, built on the multiplayer plugin API. It shows a prompt and a ready button; when the participant clicks it, the plugin writes `ready: true` to the trial's shared data, swaps to a waiting message, and ends the trial once every expected group member is ready. It also ends if a timeout elapses, a participant the gate depends on leaves, or the connection is lost.

Use it as the lobby / waiting-room step at the start of a multiplayer timeline, or anywhere the group needs an explicit "everyone confirm you're here before we continue" checkpoint.

## How it differs from `plugin-multiplayer-sync`

`plugin-multiplayer-sync` is a low-level barrier: you supply an arbitrary `wait_for` predicate and optional `write_data`. `plugin-multiplayer-ready` is a higher-level specialization that **owns the check-in UI** and the **"all members ready" condition** for you (see [Gates](#gates)). Reach for `sync` when you need a custom condition; reach for `ready` when you want a drop-in "I'm ready" lobby.

> **Status:** requires the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet in a jsPsych release. On a jsPsych without `jsPsych.multiplayer`, the trial throws an error saying so.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter          | Type                    | Default                               | Description                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expected_players` | integer                 | `null`                                | Total group size, **including this participant**, that must be ready before the trial ends. May be a function returning a number. `null` counts the members of a sealed group (`jsPsych.multiplayer.group().sealed`) who haven't left; without a sealed group it is required.                                                                                                                                          |
| `stimulus`         | HTML string \| function | _undefined_ (required)                | The instructions shown above the ready button.                                                                                                                                                                                                                             |
| `prompt`           | HTML string \| function | `null`                                | Optional secondary reminder shown below the button (jsPsych `prompt` convention). `null` shows nothing.                                                                                                                                                                    |
| `button_label`     | string \| function      | `"I'm ready"`                         | Label on the ready button.                                                                                                                                                                                                                                                 |
| `waiting_message`  | HTML string \| function | `"<p>Waiting for other players…</p>"` | Shown after this participant clicks ready, while waiting for the rest of the group.                                                                                                                                                                                        |
| `write_data`       | object \| function      | `null`                                | Extra fields written to this participant's part of the trial's shared data along with `ready: true` (e.g. a display name). They are merged in with `jsPsych.multiplayer.update()`.                                                                                        |
| `timeout`          | integer                 | `null`                                | Max time to wait for the rest of the group **after** clicking ready, in ms. On elapse the trial ends with `multiplayer_outcome: "timeout"` and `on_timeout` is called. `null`, `0`, or a negative value waits indefinitely. Does **not** bound how long the participant takes to click. |
| `on_timeout`       | function                | `null`                                | Called if `timeout` elapses before the whole group is ready.                                                                                                                                                                                                               |
| `participants`     | array \| null           | `null`                                | Participants the gate depends on. If one leaves the session first, the trial ends with `multiplayer_outcome: "participant_left"`. `null` means the other members of a sealed group who haven't left, or else every other participant connected when this participant clicks ready; `[]` ignores departures.                                     |
| `minimum_wait`     | integer                 | `0`                                   | Minimum time, in ms, to keep the waiting message on screen after clicking ready, so it doesn't flash by when the group is already ready (e.g. the last participant, or solo `expected_players: 1`). Does not extend a naturally longer wait.                               |
| `save_group`       | boolean                 | `false`                               | Save the trial's shared data, as it was when the trial ended, in the `group` data field.                                                                                                                                                                                   |

## Data Generated

| Name               | Type           | Description                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rt`               | integer        | Time from the ready button appearing to this participant clicking it, in ms.                                                                                                                                                                                                                                          |
| `wait_time`        | integer        | Time spent waiting for the rest of the group, in ms, from the click until the trial ended.                                                                                                                                                                                                                            |
| `n_ready`             | integer        | Number of group members ready, and still in the session, when the trial ended.                                                                                                                                  |
| `multiplayer_outcome` | string         | How the trial ended: `"completed"` (everyone was ready), `"timeout"`, `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's connection was lost for good). |
| `left_participant`    | string \| null | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`.                                                                                                                         |
| `group`               | object         | Only with `save_group: true`. The trial's shared data, keyed by participant ID, when the trial ended. The object is frozen; copy it before modifying.                                                           |

An adapter failure fails the trial rather than being recorded as an outcome. If the wait is **cancelled** because the experiment ended or was aborted, the trial stops quietly and writes no record at all.

## Gates

Each trial has its own part of the shared data, so readiness at one gate never carries over to the next. When this participant clicks ready, the plugin merges `write_data` and `ready: true` into their part of this trial's data. The gate counts the participants who have written `ready` in this trial and haven't left the session. Participants running the same timeline share each trial's data because it is named by the trial's position in the timeline (or by the trial's `multiplayer_scope` parameter).

Values written with `write_data` stay in this trial's data. To use one in a later trial, for example a display name, save it in the trial's data in `on_finish`, or write it to the session's shared data, which lasts the whole session: `jsPsych.multiplayer.update({ name }, { scope: "session" })`.

## Example: a two-player waiting room

```js
const readyGate = {
  type: jsPsychMultiplayerReady,
  expected_players: 2,
  stimulus: "<p>You'll be matched with another player. Click when you're ready.</p>",
  waiting_message: "<p>Waiting for the other player to check in…</p>",
  timeout: 120000, // give up after 2 minutes of waiting for the other player
  on_timeout: () => console.warn("The other player didn't check in."),
  save_group: true,
  on_finish: (data) => {
    // Role assignment stays experiment-specific — do it here off data.group, or use
    // @jspsych-multiplayer/plugin-multiplayer-role for deterministic consensus.
    // Sort the IDs so both players agree on who is first
    const ids = Object.keys(data.group).sort();
    myRole = jsPsych.multiplayer.participantId === ids[0] ? "proposer" : "responder";
  },
};
```

## Scope

A jsPsych plugin is a trial, so this plugin covers readiness checkpoints that are their own timeline step (lobbies, "press ready to continue" gates). For communication _in the middle_ of another interactive trial, use `jsPsych.multiplayer` (`update`, `replace`, `get`, `getAll`, `presence`, `subscribe`, `wait`) directly, or `plugin-multiplayer-sync` for a custom-condition barrier.
