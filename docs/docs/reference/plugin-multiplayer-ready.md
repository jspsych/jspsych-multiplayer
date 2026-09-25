---
id: plugin-multiplayer-ready
title: multiplayer-ready
sidebar_label: multiplayer-ready
description: Show a ready button and wait until the whole group has clicked it.
---

# `multiplayer-ready`

A ready trial is a check-in. Each participant reads a screen and clicks a button when they are
ready; nobody moves on until the expected number of group members have clicked. Use it as the
first step of a multiplayer timeline, or before any part of the task that should start for
everyone at once.

It is a [`multiplayer-sync`](plugin-multiplayer-sync) trial with the button and the "everyone is
ready" condition built in. Use `multiplayer-sync` when you need a different condition.

**What the participant sees:** your `stimulus`, an "I'm ready" button, and an optional `prompt`
below it. After the click, the button is replaced by "Waiting for other players…" until the rest
of the group has clicked.

```js
timeline.push({
  type: jsPsychMultiplayerReady,
  expected_players: 2,
  stimulus: "<p>Click when you're ready to start.</p>",
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-ready` |
| Browser global | `jsPsychMultiplayerReady` |
| Trial type | `multiplayer-ready` |
| Requires | a connected session (see [Getting started](../getting-started)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `expected_players` | `number \| null` | `null` | How many group members, including this participant, must be ready before the trial ends. Can be a function that returns the number. `null` means everyone in a [sealed group](../guides/forming-groups) who hasn't left; if the group isn't sealed when the trial starts, you must set it. |
| `stimulus` | HTML string | required | The content shown above the button. |
| `prompt` | HTML string | `null` | A reminder shown below the button. `null` shows nothing. |
| `button_label` | `string` | `"I'm ready"` | The button's label. |
| `waiting_message` | HTML string | `"<p>Waiting for other players…</p>"` | Shown after this participant clicks, while the rest of the group finishes. |
| `write_data` | `object \| null` | `null` | Extra fields to write to this participant's part of the trial's shared data along with `ready: true`, such as a display name. They are merged in with `jsPsych.multiplayer.update()`. Can be a function that returns the object. |
| `timeout` | `number \| null` | `null` | The longest time to wait for the others **after** clicking, in ms. When it runs out, the trial ends with `multiplayer_outcome: "timeout"` and `on_timeout` is called. `null`, `0`, or a negative number waits indefinitely. It does not limit how long this participant takes to click. |
| `on_timeout` | `function \| null` | `null` | Called with the timeout error if `timeout` runs out first. The trial ends either way. |
| `participants` | `string[] \| null` | `null` | The participants this gate depends on. If one of them leaves before the group is ready, the trial ends with `multiplayer_outcome: "participant_left"`. `null` means the other members of a [sealed group](../guides/forming-groups) who haven't left, or, without a sealed group, every other participant who is connected when this participant clicks. `[]` ignores departures. |
| `minimum_wait` | `number` | `0` | The shortest time, in ms, to keep the waiting message on screen after the click, so it doesn't flash by for the last participant to click (or with `expected_players: 1`). It does not lengthen a wait that is already longer. |
| `save_group` | `boolean` | `false` | Save the trial's shared data, as it was when the trial ended, in the `group` data field. |

## Data

| Field | Type | Description |
| --- | --- | --- |
| `rt` | `number` | Milliseconds from the button appearing to this participant clicking it. |
| `wait_time` | `number` | Milliseconds from the click to the end of the trial. |
| `n_ready` | `number` | How many group members were ready in this trial, and still in the session, when the trial ended. |
| `multiplayer_outcome` | `string` | How the trial ended: `"completed"` (everyone was ready), `"timeout"`, `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's own connection was lost for good). |
| `left_participant` | `string \| null` | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`. |
| `group` | `object` | Only with `save_group: true`. The trial's shared data when the trial ended, keyed by participant ID. Frozen; copy it before changing it. |

[Handling dropouts](../guides/handling-dropouts) explains `multiplayer_outcome`,
`left_participant`, and how to branch on them. If the backend fails, the trial fails rather than
recording an outcome. If the experiment ends or is aborted while the trial is waiting, the trial
stops quietly: `on_timeout` isn't called and no data is recorded.

## Each gate has its own shared data

Each trial has its own part of the shared data, so readiness at one gate never carries over to
the next. When this participant clicks, the plugin merges `write_data` and `ready: true` into
their part of this trial's data. The gate counts the participants who have written `ready` in this
trial and haven't left the session. Participants running the same timeline share each trial's data
because it is named by the trial's position in the timeline (or by the trial's `multiplayer_scope`
parameter; see [How it works](../guides/how-it-works)).

Values written with `write_data` stay in this trial's data. To use one in a later trial, such as a
display name, save it in the trial's data in `on_finish`, or write it to the session's shared
data, which lasts the whole session:

```js
await jsPsych.multiplayer.update({ name: myName }, { scope: "session" });
```

## Example

A waiting room for two players that gives up after two minutes:

```js
const waitingRoom = {
  type: jsPsychMultiplayerReady,
  expected_players: 2,
  stimulus: "<p>You'll be playing with one other person. Click when you're ready.</p>",
  prompt: "<p>Please don't close this tab.</p>",
  waiting_message: "<p>Waiting for the other player to check in…</p>",
  timeout: 120000,
  minimum_wait: 1000,
  on_finish: (data) => {
    if (data.multiplayer_outcome !== "completed") {
      jsPsych.abortExperiment("We couldn't find a partner for you. Thank you for your time.");
    }
  },
};
```
