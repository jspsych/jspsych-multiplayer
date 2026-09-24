# @jspsych-multiplayer/plugin-multiplayer-sync

A synchronization-barrier plugin for multiplayer jsPsych experiments, built on the multiplayer plugin API. It packages the common **push → wait** pattern into a single declarative trial: optionally push this participant's data into the shared group session, show a waiting message, and end the trial once a condition over the group session is met (or an optional timeout elapses).

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

| Parameter      | Type                    | Default                               | Description                                                                                                                                                                                                                         |
| -------------- | ----------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait_for`     | function                | _undefined_ (required)                | Predicate `(group, presence) => boolean` evaluated on every update. The trial ends when it returns true. Both arguments are frozen; don't modify them. Same condition you would pass to `jsPsych.multiplayer.wait()`.               |
| `push_data`    | object \| function      | `null`                                | Data pushed into the group session when the trial starts, before waiting. `null` waits without pushing. May be a function returning the object, e.g. `() => ({ offer })`.                                                           |
| `message`      | HTML string \| function | `"<p>Waiting for other players…</p>"` | Shown while waiting.                                                                                                                                                                                                                |
| `timeout`      | integer                 | `null`                                | Max time to wait, in ms. On elapse the trial ends with `timed_out: true` and `on_timeout` is called. `null` — or any non-positive value — waits indefinitely.                                                                       |
| `on_timeout`   | function                | `null`                                | Called if `timeout` elapses before `wait_for` is satisfied.                                                                                                                                                                         |
| `participants` | array \| null           | `[]`                                  | Participants the barrier depends on. If one of them leaves the session first, the trial ends with `partner_left: true`. The default, `[]`, ignores departures, which suits lobbies that keep waiting for others to join; `null` means every other participant who is connected when the wait starts. |
| `minimum_wait` | integer                 | `0`                                   | Minimum time, in ms, to keep the message on screen so it doesn't flash by — applies whether the trial ends because the condition is met or because the timeout elapses.                                                             |

## Data Generated

| Name               | Type           | Description                                                                                                                                                                                                                     |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group`            | object         | The full group session snapshot at the moment the trial ended. Read peers / assign roles from here in `on_finish`. The object is frozen; copy it before modifying.                                                              |
| `wait_time`        | integer        | Time spent waiting, in ms, from trial start until the trial ended.                                                                                                                                                              |
| `timed_out`        | boolean        | True if the trial ended because `timeout` elapsed rather than because `wait_for` was met.                                                                                                                                       |
| `partner_left`     | boolean        | True if the trial ended because a participant in `participants` left the session.                                                                                                                                               |
| `left_participant` | string \| null | The ID of the participant who left, when `partner_left` is true.                                                                                                                                                                |
| `connection_lost`  | boolean        | True if the trial ended because this participant's connection was lost for good.                                                                                                                                                |
| `wait_error`       | string \| null | The message of the error that ended the wait early (timeout, departure, or lost connection); `null` when the condition was satisfied. Other `wait()` failures (a throwing `wait_for`, an adapter error) fail the trial instead. |

If the experiment ends or aborts while the barrier is holding (`jsPsych.abortExperiment()`, or the end of `jsPsych.run()`), jsPsych cancels the pending wait. That is neither a timeout nor a failure: the trial stops quietly, `on_timeout` does not fire, and no data is recorded.

## Writing robust `wait_for` predicates

`push` uses **overwrite-per-participant** semantics: each participant has a single entry in the group session, and every push replaces it. A fast peer that clears a barrier and pushes again in a later trial can therefore overwrite the very entry your `wait_for` predicate is still checking — and the condition you were waiting for may never (re)appear. The multiplayer API also combines writes that a participant makes while an earlier write is still being sent, so other participants may never see a value that was replaced quickly.

Prefer predicates that are **monotone**: once true, they stay true under any later push. For example:

```js
// Fragile: p2's next push may not include `status`, so this can flicker back to false
wait_for: (group) => group["p2"]?.status === "ready",

// Robust: data slots are monotone — a participant's slot stays even after they leave
wait_for: (group) => Object.keys(group).length >= 2,

// Robust: carry a monotone counter/phase forward in every push and compare with >=
wait_for: (group) => Object.values(group).every((p) => p.trial_index >= 5),
```

If a barrier must key on transient fields, include them in every subsequent push (so they are never overwritten away), or advance a `phase`/counter field that only increases.

## Example: a lobby that waits for two players

```js
const lobby = {
  type: jsPsychMultiplayerSync,
  push_data: { status: "ready" },
  wait_for: (group) => Object.keys(group).length >= 2,
  message: "<p>Waiting for another player to join…</p>",
  on_finish: (data) => {
    // Role assignment stays experiment-specific — do it here off data.group, or hand the snapshot
    // to @jspsych-multiplayer/plugin-multiplayer-role for deterministic consensus.
    const [proposerId, responderId] = Object.keys(data.group).sort();
    myRole = jsPsych.multiplayer.participantId === proposerId ? "proposer" : "responder";
  },
};
```

## Scope

A jsPsych plugin is a trial, so this plugin covers synchronization points that are their own timeline step (barriers, lobbies, send-then-wait handoffs). For communication _in the middle_ of another interactive trial, use `jsPsych.multiplayer` (`push`, `update`, `get`, `getAll`, `presence`, `subscribe`, `wait`) directly.
