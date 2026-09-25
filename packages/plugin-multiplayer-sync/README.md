# @jspsych-multiplayer/plugin-multiplayer-sync

A synchronization-barrier plugin for multiplayer jsPsych experiments, built on the multiplayer plugin API. It packages the common **write → wait** pattern into a single declarative trial: optionally write this participant's data to the trial's shared data, show a waiting message, and end the trial once a condition over that data is met (or an optional timeout elapses, or a participant it depends on leaves).

This replaces the awkward idioms previously needed for synchronization points — a `call-function` trial with `async`/`done`, or an `html-keyboard-response` trial with `choices: "NO_KEYS"`, an `on_start` that awaits `jsPsych.multiplayer.wait()`, and a manual `jsPsych.finishTrial()`.

> **Status:** requires the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet in a jsPsych release. On a jsPsych without `jsPsych.multiplayer`, the trial throws an error saying so.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter      | Type                    | Default                               | Description                                                                                                                                                                                                                                                   |
| -------------- | ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait_for`     | function                | _undefined_ (required)                | Predicate `(group, presence) => boolean` over this trial's shared data, evaluated on every update. The trial ends when it returns true. Both arguments are frozen; don't modify them. Same condition you would pass to `jsPsych.multiplayer.wait()`.          |
| `write_data`   | object \| function      | `null`                                | Data written to this participant's part of the trial's shared data when the trial starts. It is merged in with `jsPsych.multiplayer.update()`, never replacing what is there. `null` waits without writing. May be a function returning the object, e.g. `() => ({ offer })`. |
| `message`      | HTML string \| function | `"<p>Waiting for other players…</p>"` | Shown while waiting.                                                                                                                                                                                                                                          |
| `timeout`      | integer                 | `null`                                | Max time to wait, in ms. On elapse the trial ends with `multiplayer_outcome: "timeout"` and `on_timeout` is called. `null`, `0`, or a negative value waits indefinitely.                                                                                     |
| `on_timeout`   | function                | `null`                                | Called if `timeout` elapses before `wait_for` is satisfied.                                                                                                                                                                                                   |
| `participants` | array \| null           | `null`                                | Participants the barrier depends on. If one of them leaves the session first, the trial ends with `multiplayer_outcome: "participant_left"`. `null` means the other members of a sealed group who haven't left, or else every other participant connected when the wait starts. Pass `[]` to ignore departures, e.g. in a lobby that keeps waiting for others to join. |
| `minimum_wait` | integer                 | `0`                                   | Minimum time, in ms, to keep the message on screen so it doesn't flash by — applies whether the trial ends because the condition is met or because the timeout elapses.                                                                                       |
| `save_group`   | boolean                 | `false`                               | Save the trial's shared data, as it was when the trial ended, in the `group` data field.                                                                                                                                                                      |

## Data Generated

| Name                  | Type           | Description                                                                                                                                                                              |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait_time`           | integer        | Time spent waiting, in ms, from trial start until the trial ended.                                                                                                                       |
| `multiplayer_outcome` | string         | How the trial ended: `"completed"` (`wait_for` was met), `"timeout"`, `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's connection was lost for good). |
| `left_participant`    | string \| null | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`.                                                                                                  |
| `group`               | object         | Only with `save_group: true`. The trial's shared data, keyed by participant ID, when the trial ended. Read it in `on_finish`, e.g. to assign roles. The object is frozen; copy it before modifying. |

A throwing `wait_for` fails the trial rather than being recorded as an outcome. If the experiment ends or aborts while the barrier is holding (`jsPsych.abortExperiment()`, or the end of `jsPsych.run()`), jsPsych cancels the pending wait. That is neither a timeout nor a failure: the trial stops quietly, `on_timeout` does not fire, and no data is recorded.

## Each trial has its own shared data

During a trial, `jsPsych.multiplayer` reads and writes that trial's own part of the shared data. So `write_data` lands in this trial's part, `wait_for` sees only what participants wrote during this trial, and a value written in an earlier barrier can never satisfy a later one. Two participants running the same timeline share each trial's data because the part is named by the trial's position in the timeline (or by the trial's `multiplayer_scope` parameter).

To use a value in a later trial, save it in the trial's data (e.g. in `on_finish`), or write it to the session's shared data, which lasts the whole session: `jsPsych.multiplayer.update({ name }, { scope: "session" })`.

The multiplayer API combines writes that a participant makes while an earlier write is still being sent, so other participants may never see a value that was replaced quickly. Prefer conditions that stay true once they are met, such as "every participant has written `ready`", over ones that key on a value that may change again.

## Example: a lobby that waits for two players

```js
const lobby = {
  type: jsPsychMultiplayerSync,
  write_data: { status: "ready" },
  wait_for: (group) => Object.keys(group).length >= 2,
  participants: [], // keep waiting if someone joins and leaves again
  message: "<p>Waiting for another player to join…</p>",
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

A jsPsych plugin is a trial, so this plugin covers synchronization points that are their own timeline step (barriers, lobbies, send-then-wait handoffs). For communication _in the middle_ of another interactive trial, use `jsPsych.multiplayer` (`update`, `replace`, `get`, `getAll`, `presence`, `subscribe`, `wait`) directly.
