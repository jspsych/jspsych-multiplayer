# @jspsych-multiplayer/plugin-multiplayer-ready

A participant-facing **ready / check-in** barrier for multiplayer jsPsych experiments, built on the multiplayer plugin API. It shows a prompt and a ready button; when the participant clicks it, the plugin marks them ready at this gate in the shared group session, swaps to a waiting message, and ends the trial once every expected group member is ready at this gate. It also ends if a timeout elapses, a participant the gate depends on leaves, or the connection is lost.

Use it as the lobby / waiting-room step at the start of a multiplayer timeline, or anywhere the group needs an explicit "everyone confirm you're here before we continue" checkpoint.

## How it differs from `plugin-multiplayer-sync`

`plugin-multiplayer-sync` is a low-level barrier: you supply an arbitrary `wait_for` predicate and optional `push_data`. `plugin-multiplayer-ready` is a higher-level specialization that **owns the check-in UI** and the **"all members ready" condition** for you, with a separate readiness key for every gate (see [Gates and keys](#gates-and-keys)). Reach for `sync` when you need a custom condition; reach for `ready` when you want a drop-in "I'm ready" lobby.

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
| `expected_players` | integer                 | _undefined_ (required)                | Total group size, **including this participant**, that must be ready before the trial ends. May be a function returning a number.                                                                                                                                          |
| `stimulus`         | HTML string \| function | _undefined_ (required)                | The instructions shown above the ready button.                                                                                                                                                                                                                             |
| `prompt`           | HTML string \| function | `null`                                | Optional secondary reminder shown below the button (jsPsych `prompt` convention). `null` shows nothing.                                                                                                                                                                    |
| `button_label`     | string \| function      | `"I'm ready"`                         | Label on the ready button.                                                                                                                                                                                                                                                 |
| `waiting_message`  | HTML string \| function | `"<p>Waiting for other players…</p>"` | Shown after this participant clicks ready, while waiting for the rest of the group.                                                                                                                                                                                        |
| `push_data`        | object \| function      | `null`                                | Extra fields written to this participant's slot along with the ready flags (e.g. a display name). They are merged into the slot, so data from earlier trials is kept.                                                                                                      |
| `data_key`         | string \| null          | `null`                                | The key that marks readiness at this gate. `null` generates `ready-1`, `ready-2`, … in the order this participant reaches ready gates. See [Gates and keys](#gates-and-keys).                                                                                              |
| `timeout`          | integer                 | `null`                                | Max time to wait for the rest of the group **after** clicking ready, in ms. On elapse the trial ends with `timed_out: true` and `on_timeout` is called. `null`, or any non-positive value, waits indefinitely. Does **not** bound how long the participant takes to click. |
| `on_timeout`       | function                | `null`                                | Called if `timeout` elapses before the whole group is ready.                                                                                                                                                                                                               |
| `participants`     | array \| null           | `null`                                | Participants the gate depends on. If one leaves the session first, the trial ends with `partner_left: true`. `null` means every other participant who hasn't already left when this participant clicks ready; `[]` ignores departures.                                     |
| `minimum_wait`     | integer                 | `0`                                   | Minimum time, in ms, to keep the waiting message on screen after clicking ready, so it doesn't flash by when the group is already ready (e.g. the last participant, or solo `expected_players: 1`). Does not extend a naturally longer wait.                               |

## Data Generated

| Name               | Type           | Description                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rt`               | integer        | Time from the ready button appearing to this participant clicking it, in ms.                                                                                                                                                                                                                                          |
| `wait_time`        | integer        | Time spent waiting for the rest of the group, in ms, from the click until the trial ended.                                                                                                                                                                                                                            |
| `n_ready`          | integer        | Number of group members ready at this gate, and still in the session, when the trial ended.                                                                                                                                                                                                                           |
| `data_key`         | string         | The key that marked readiness at this gate (`data_key`, or the generated `ready-N`).                                                                                                                                                                                                                                  |
| `group`            | object         | The full group session snapshot when the trial ended. Read peers / assign roles from here in `on_finish`. The object is frozen; copy it before modifying.                                                                                                                                                             |
| `timed_out`        | boolean        | True if the trial ended because `timeout` elapsed rather than because everyone was ready.                                                                                                                                                                                                                             |
| `partner_left`     | boolean        | True if the trial ended because a participant in `participants` left the session.                                                                                                                                                                                                                                     |
| `left_participant` | string \| null | The ID of the participant who left, when `partner_left` is true.                                                                                                                                                                                                                                                      |
| `connection_lost`  | boolean        | True if the trial ended because this participant's connection was lost for good.                                                                                                                                                                                                                                      |
| `wait_error`       | string \| null | The message of the error that ended the wait early (timeout, departure, or lost connection); `null` when everyone was ready. Other failures (an adapter error) fail the trial instead. If the wait is **cancelled** because the experiment ended or was aborted, the trial stops quietly and writes no record at all. |

## Gates and keys

Each ready gate marks readiness with its own key, so flags from an earlier gate can never make a later gate pass. When this participant clicks ready, the plugin merges `{ ...push_data, ready: true, [key]: true }` into their slot, and the gate counts only participants who have `[key]: true` and haven't left the session. Earlier gates' keys stay in the slot, so a fast participant who moves on to the next gate can't remove a flag that a slower participant is still counting.

By default the key is `ready-1` for the first ready gate this participant reaches, `ready-2` for the second, and so on. Participants have to pass gates in the same order, so the Nth gate gets the same key for everyone, however many other trials each participant saw along the way. Two cases need an explicit `data_key`:

- **A gate that only some participants reach**, for example inside a `conditional_function`. Otherwise the participants who skip it count their later gates differently from the others.
- **A participant who reloads the page.** The count starts over after a reload. (Rejoining after a reload is not yet supported.)

An explicit `data_key` is used as-is and doesn't advance the default count.

The plugin also sets `ready: true`, for experiments that only need to know that a participant has checked in at least once.

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
    myRole = jsPsych.multiplayer.participantId === firstId ? "proposer" : "responder";
  },
};
```

## Scope

A jsPsych plugin is a trial, so this plugin covers readiness checkpoints that are their own timeline step (lobbies, "press ready to continue" gates). For communication _in the middle_ of another interactive trial, use `jsPsych.multiplayer` (`push`, `update`, `get`, `getAll`, `presence`, `subscribe`, `wait`) directly, or `plugin-multiplayer-sync` for a custom-condition barrier.
