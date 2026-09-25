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
| `push_data` | `object \| null` | `null` | Extra fields to write to this participant's slot along with the ready flags, such as a display name. They are merged into the slot, so data from earlier trials is kept. Can be a function that returns the object. |
| `data_key` | `string \| null` | `null` | The key that marks this participant as ready at this gate. `null` generates `ready-1`, `ready-2`, … (see [Gate keys](#gate-keys)). |
| `timeout` | `number \| null` | `null` | The longest time to wait for the others **after** clicking, in ms. When it runs out, the trial ends with `timed_out: true` and `on_timeout` is called. `null`, `0`, or a negative number waits indefinitely. It does not limit how long this participant takes to click. |
| `on_timeout` | `function \| null` | `null` | Called with the timeout error if `timeout` runs out first. The trial ends either way. |
| `participants` | `string[] \| null` | `null` | The participants this gate depends on. If one of them leaves before the group is ready, the trial ends with `partner_left: true`. `null` means every other participant who is connected when this participant clicks. In a [sealed group](../guides/forming-groups), `null` means the rest of the group's members who haven't left, including any who are only `away`. `[]` ignores departures. |
| `minimum_wait` | `number` | `0` | The shortest time, in ms, to keep the waiting message on screen after the click, so it doesn't flash by for the last participant to click. It does not lengthen a wait that is already longer. |

## Data

| Field | Type | Description |
| --- | --- | --- |
| `rt` | `number` | Milliseconds from the button appearing to this participant clicking it. |
| `wait_time` | `number` | Milliseconds from the click to the end of the trial. |
| `n_ready` | `number` | How many group members were ready at this gate, and still in the session, when the trial ended. |
| `data_key` | `string` | The key used for this gate (your `data_key`, or the generated `ready-N`). |
| `group` | `object` | The shared data when the trial ended, keyed by participant ID. Frozen; copy it before changing it. |
| `timed_out` | `boolean` | `true` if the trial ended because `timeout` ran out. |
| `partner_left` | `boolean` | `true` if the trial ended because a participant in `participants` left. |
| `left_participant` | `string \| null` | The ID of the participant who left, when `partner_left` is `true`. |
| `connection_lost` | `boolean` | `true` if the trial ended because this participant's own connection was lost for good. |
| `wait_error` | `string \| null` | The message of whatever ended the wait early (timeout, departure, or lost connection). `null` when everyone was ready. |

[Handling dropouts](../guides/handling-dropouts) explains `partner_left`, `left_participant`,
`connection_lost`, and how to branch on them. If the experiment ends or is aborted while the
trial is waiting, the trial stops without calling `on_timeout` and records no data.

## Gate keys

When a participant clicks, the plugin merges `{ ...push_data, ready: true, [data_key]: true }`
into their slot. The gate counts participants who have `[data_key]: true` and have not left.

Each gate needs its own key, or a flag from an earlier gate would let a later one pass at once. By
default the first ready trial a participant reaches uses `ready-1`, the second `ready-2`, and so
on. Because everyone passes the same gates in the same order, the Nth gate gets the same key for
everyone. Earlier keys are never removed, so a fast participant moving on can't undo a flag a
slow participant is still counting.

Set `data_key` yourself when:

- only some participants reach the gate, for example inside a `conditional_function`. Otherwise
  those participants number their later gates differently from everyone else.
- a participant might reload the page. The count starts over after a reload.

An explicit `data_key` does not advance the default count. The plugin also sets `ready: true`, if
you only need to know that someone has checked in at least once.

## Example

A waiting room for two players that gives up after two minutes:

```js
const waitingRoom = {
  type: jsPsychMultiplayerReady,
  expected_players: 2,
  stimulus: "<p>You'll be playing with one other person. Click when you're ready.</p>",
  prompt: "<p>Please don't close this tab.</p>",
  waiting_message: "<p>Waiting for the other player to check in…</p>",
  push_data: () => ({ name: myName }),
  timeout: 120000,
  minimum_wait: 1000,
  on_finish: (data) => {
    if (data.timed_out || data.partner_left || data.connection_lost) {
      jsPsych.abortExperiment("We couldn't find a partner for you. Thank you for your time.");
    }
  },
};
```
