---
id: extension-presence-check
title: presence-check
sidebar_label: presence-check
description: An "Are you still with us?" warning for idle participants, with removal left to the experiment.
---

# `presence-check`

A jsPsych extension that notices when a participant has stopped interacting. After a stretch with
no mouse movement, clicks, typing, wheel scrolling or touches, a warning asks "Are you still with
us?". Any of those inputs, or the warning's button, dismisses it. A warning nobody answers in time
counts as a miss, and when misses in a row reach a limit the extension calls your `on_expire`
callback, which decides what removal means.

Use it in multiplayer studies where one idle participant holds up their partner, or anywhere you
want to catch someone who walked away. It does not use the multiplayer API, so it needs no
connected session.

```js
const jsPsych = initJsPsych({
  extensions: [
    {
      type: jsPsychExtensionPresenceCheck,
      params: { on_expire: () => jsPsych.abortExperiment("You were removed for inactivity.") },
    },
  ],
});

timeline.push({
  type: jsPsychMultiplayerReferenceGame,
  // ...
  extensions: [{ type: jsPsychExtensionPresenceCheck, params: { paused: () => inFeedback() } }],
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/extension-presence-check` |
| Browser global | `jsPsychExtensionPresenceCheck` |
| Extension name | `presence-check` (the instance is `jsPsych.extensions["presence-check"]`) |
| Requires | jsPsych 8; no multiplayer session |

## How a warning ends

| Outcome | When | Consecutive misses |
| --- | --- | --- |
| Dismissed | A counted input from `dismiss_inputs`, or the button, closes it. | Back to 0; the idle clock restarts. |
| Missed | Nobody responds within `respond_within`. | Up by 1; the idle clock restarts, so the next warning can come `prompt_after` later. |
| Expired | A miss brings the count to `max_consecutive_misses`. | `on_expire(summary)` is called once and no more warnings show this trial. |
| Interrupted | `paused()` returns `true`, or the trial ends, while it is open. | Unchanged. |

Activity between warnings also resets the count. With the defaults (30 s, 30 s, 2 misses) the check
expires after about 120 s of no activity.

The count carries over to the next trial by default, so a miss in one round and a miss in the next
reach a limit of 2 even with a paused feedback screen between them. Expiry does not reset it
(counted activity afterwards does, as at any other time); call
`jsPsych.extensions["presence-check"].reset()` if the experiment carries on and the participant
should start over.

## Parameters

Set experiment-wide defaults in `initJsPsych({ extensions: [{ type, params }] })` and override them
per trial in `extensions: [{ type, params }]`. `activity_inputs` and `dismiss_inputs` merge key by
key.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `prompt_after` | `number` | `30000` | ms with no counted activity before a warning shows. Must be more than 0. |
| `respond_within` | `number` | `30000` | ms a warning stays up before it counts as missed. Must be more than 0. |
| `max_consecutive_misses` | `number \| null` | `2` | Misses in a row that expire the check. `0` or `null` never expires. |
| `count_across_trials` | `boolean` | `true` | Carry the miss count into the next trial. `false` starts the trial from 0. |
| `activity_inputs` | `object` | all `true` | Which inputs restart the idle clock: `{ mouse_move, pointer_down, keyboard, wheel, touch }`. |
| `dismiss_inputs` | `object` | all `true` | Which inputs dismiss an open warning, same shape. All `false` leaves only the button. |
| `paused` | `() => boolean` | `() => false` | While `true`, no warning shows and an open one is interrupted. |
| `on_expire` | `(summary) => void` | `() => {}` | Called once per expiry, after the warning closes, with the same fields as the trial data. |
| `title` | HTML string | `"Are you still with us?"` | Warning title. |
| `body` | HTML string | `"Please click the button to let us know you're still here."` | Warning text. |
| `button_label` | HTML string | `"I'm still here"` | Button label. |
| `countdown_text` | HTML string | `"This message closes in {seconds}s."` | `{seconds}` is replaced with the seconds left. |

Inputs map to events as follows: `mouse_move` is `mousemove`; `pointer_down` is a mouse or pen
`pointerdown`; `keyboard` is `keydown` and `input`; `wheel` is `wheel`; `touch` is `touchstart`,
`touchmove` and a touch `pointerdown`. Only trusted events count, and there is no `scroll`
listener, because pages scroll themselves (for example a chat log following new messages).

## Input pass-through and focus

The input that dismisses a warning is not swallowed: a keystroke still goes into the field the
participant was typing in, and a click lands on what was clicked.

- **Pointer dismissal on** (any of `mouse_move`, `pointer_down`, `wheel`, `touch`; the default):
  the overlay has `pointer-events: none`, so the page underneath keeps working and only the button
  takes clicks. Focus is not moved. The warning is a `role="alert"` region.
- **Keyboard only:** the backdrop blocks clicks (and counts them), but focus stays where it was so
  typing lands in the participant's field.
- **Button only** (all `false`): the original modal. The button takes focus, Tab and focus changes
  return to it, backdrop clicks are counted, and focus goes back afterwards unless a pause or the
  end of the trial closed the warning. The card is a `role="alertdialog"` with `aria-modal`.

## Data

| Name | Type | Description |
| --- | --- | --- |
| `presence_prompts` | `number` | Warnings shown this trial. |
| `presence_responded` | `number` | Warnings dismissed. |
| `presence_missed` | `number` | Warnings not answered in time, including the one that expired. |
| `presence_interrupted` | `number` | Warnings closed by `paused()` or the trial ending. |
| `presence_backdrop_clicks` | `number` | Clicks on the blocking backdrop (keyboard-only and button-only modes). |
| `presence_consecutive_misses` | `number` | The miss count when the trial ended. |
| `presence_expired` | `boolean` | Whether the check expired this trial. |
| `presence_events` | `array` | Per warning: `shown_at` (ms from trial start), `outcome` (`responded`, `missed`, `interrupted`, `expired`), `rt` (ms, or `null`), `dismissed_by` (`button`, an input name, or `null`), `backdrop_clicks`. |
