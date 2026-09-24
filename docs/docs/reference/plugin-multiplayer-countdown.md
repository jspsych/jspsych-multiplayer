---
id: plugin-multiplayer-countdown
title: multiplayer-countdown
sidebar_label: multiplayer-countdown
description: A timer that shows the same time on every participant's screen and ends when the group's time is up.
---

# `multiplayer-countdown`

A countdown trial shows a clock that runs from the moment the first participant in the group
reached it. Everyone sees the same time remaining, even if they arrived a few seconds apart, and
each participant's trial ends when the group's time runs out. A participant who reloads the page
comes back to the time the group actually has left, not a fresh clock.

Use it for a timed phase that the whole group shares: "you have one minute to think", a break
between rounds, or a deadline shown on its own screen. It can also count up instead of down.

**What the participant sees:** your `stimulus`, a large `M:SS` clock, and your `prompt` below it.
There is nothing to click. The trial ends when the clock reaches `0:00` (or, counting up, the
full `duration`). For screen-reader users, the last five seconds are announced aloud.

```js
timeline.push({
  type: jsPsychMultiplayerCountdown,
  name: "think_phase",
  duration: 60000,
  stimulus: "<p>Time left to think:</p>",
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-countdown` |
| Browser global | `jsPsychMultiplayerCountdown` |
| Trial type | `multiplayer-countdown` |
| Requires | a connected session (see [Getting started](../getting-started)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `duration` | `number` | required | How long the timer runs, in ms. Must be more than 0. |
| `name` | `string` | required | A name for this countdown, the same for every participant and different from every other countdown in the experiment (see [Naming each countdown](#naming-each-countdown)). Can be a function, e.g. `` () => `round_${round}` ``. |
| `mode` | `string` | `"countdown"` | `"countdown"` shows the time remaining; `"countup"` shows the time elapsed, like a stopwatch. Both end at `duration`. |
| `stimulus` | HTML string | `null` | Shown above the clock, e.g. `"Time left:"`. `null` shows nothing. |
| `prompt` | HTML string | `null` | Shown below the clock. `null` shows nothing. |
| `format` | `(ms) => string` | `null` | Turns the time, in ms, into the text shown. `null` shows `M:SS`, rounding up when counting down (so `0:01` stays up for the last partial second) and down when counting up. |
| `save_group` | `boolean` | `false` | Save the group's shared data at the end of the trial in `group`. |

The trial throws an error if `name` is missing or empty, or if `duration` is not a positive
number.

## Data

| Field | Type | Description |
| --- | --- | --- |
| `started_at` | `number` | When the group's countdown started (the earliest start time any participant wrote), in milliseconds since 1970. |
| `own_started_at` | `number` | When this participant reached the trial, by their own clock. The gap from `started_at` is roughly how much later they arrived than the first participant. |
| `displayed_duration` | `number` | How long this participant saw the timer, in ms. Less than `duration` for anyone who arrived after the first participant. |
| `mode` | `string` | `"countdown"` or `"countup"`. |
| `connection_lost` | `boolean` | `true` if this participant's connection was lost for good during the countdown. The timer still runs to the end, from the start time it already had. |
| `group` | `object` | The shared data at the end of the trial, keyed by participant ID. Only saved when `save_group` is `true`. |

## How the group agrees on a start time

When a participant reaches the trial, it writes the current time to their slot. Every
participant's clock is then based on the **earliest** of those times. As later participants'
times arrive, the earliest one does not change, so everyone converges on the same start. If a
participant sees an earlier time arrive after their clock is already running, their clock jumps
down to match.

This makes the countdown a shared deadline, not a waiting point. Participants finish within a
fraction of a second of each other, but not at exactly the same moment, and the countdown does
not wait for anyone who is late or has left. To make everyone start together, put a
[`multiplayer-ready`](plugin-multiplayer-ready) or [`multiplayer-sync`](plugin-multiplayer-sync)
trial before it. To be sure everyone has finished before the next trial, put one after it.

Each participant's clock uses their own computer's time. If one computer's clock is badly wrong
(running behind by several seconds, say), the group's countdown can end early for everyone else.
With normally set clocks, the difference is a few milliseconds.

## Naming each countdown

`name` is how participants' start times are matched up. It must be identical for everyone at the
same countdown, and different for every countdown in the experiment: a start time written under a
name stays in the shared data, so a second countdown with the same name sees that the time is
already up and ends at once (with a warning in the console). The same happens to a participant
who arrives after the group's countdown has ended.

Inside a loop or with timeline variables, give `name` a function or a timeline variable so each
repetition gets its own name.

## Example

A 30-second planning phase before each of five rounds. The round number makes each countdown's
name unique, and a ready trial lines everyone up first:

```js
let round = 0;

const roundTrials = {
  timeline: [
    {
      type: jsPsychMultiplayerReady,
      expected_players: 4,
      stimulus: () => `<p>Round ${round + 1} is about to start.</p>`,
    },
    {
      type: jsPsychMultiplayerCountdown,
      name: () => `plan_round_${round}`,
      duration: 30000,
      stimulus: () => `<p>Round ${round + 1}: plan your move.</p>`,
      prompt: "<p>The round starts when the timer reaches zero.</p>",
    },
    // … the round itself …
  ],
  loop_function: () => ++round < 5,
};
```

The clock's building blocks are also available as functions on `jsPsychMultiplayerCountdown`, so
you can show the group's time during another trial (for example, next to a
[`multiplayer-draw`](plugin-multiplayer-draw) canvas). `startedAtKey(name)` gives the slot field a
countdown uses, `resolveStartedAt(group, key)` finds the group's start time,
`computeRemaining(startedAt, duration, now)` and `computeElapsed(startedAt, duration, now)` do the
arithmetic, and `formatTime(ms)` gives `M:SS`:

```js
const key = jsPsychMultiplayerCountdown.startedAtKey("draw_phase");
const startedAt = jsPsychMultiplayerCountdown.resolveStartedAt(jsPsych.multiplayer.getAll(), key);
const remaining = jsPsychMultiplayerCountdown.computeRemaining(startedAt, 60000, Date.now());
clockElement.textContent = jsPsychMultiplayerCountdown.formatTime(remaining);
```

Something must write the start time first: either a countdown trial with that name, or your own
`jsPsych.multiplayer.update({ [key]: Date.now() })`.
