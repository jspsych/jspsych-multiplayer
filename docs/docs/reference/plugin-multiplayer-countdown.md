---
id: plugin-multiplayer-countdown
title: multiplayer-countdown
sidebar_label: multiplayer-countdown
description: A timer that shows the same time on every participant's screen and ends when the group's time is up.
---

# `multiplayer-countdown`

A countdown trial shows a clock that runs from the moment the first participant in the group
reached it. Everyone sees the same time remaining, even if they arrived a few seconds apart, and
each participant's trial ends when the group's time runs out. A participant who reaches the trial
late joins the clock at the time the group actually has left.

Use it for a timed phase that the whole group shares: "you have one minute to think", a break
between rounds, or a deadline shown on its own screen. It can also count up instead of down.

**What the participant sees:** your `stimulus`, a large `M:SS` clock, and your `prompt` below it.
There is nothing to click. The trial ends when the clock reaches `0:00` (or, counting up, the
full `duration`). For screen-reader users, the last five seconds are announced aloud.

```js
timeline.push({
  type: jsPsychMultiplayerCountdown,
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
| `mode` | `string` | `"countdown"` | `"countdown"` shows the time remaining; `"countup"` shows the time elapsed, like a stopwatch. Both end at `duration`. |
| `stimulus` | HTML string | `null` | Shown above the clock, e.g. `"Time left:"`. `null` shows nothing. |
| `prompt` | HTML string | `null` | Shown below the clock. `null` shows nothing. |
| `format` | `(ms) => string` | `null` | Turns the time, in ms, into the text shown. `null` shows `M:SS`, rounding up when counting down (so `0:01` stays up for the last partial second) and down when counting up. |
| `save_group` | `boolean` | `false` | Save the trial's shared data, as it was at the end of the trial, in the `group` data field. |

The trial throws an error if `duration` is missing or not a positive number.

## Data

| Field | Type | Description |
| --- | --- | --- |
| `started_at` | `number` | When the group's countdown started (the earliest start time any participant wrote), in milliseconds since 1970. |
| `own_started_at` | `number` | When this participant reached the trial, by their own clock. The gap from `started_at` is roughly how much later they arrived than the first participant. |
| `displayed_duration` | `number` | How long this participant saw the timer, in ms. Less than `duration` for anyone who arrived after the first participant. |
| `mode` | `string` | `"countdown"` or `"countup"`. |
| `multiplayer_outcome` | `string` | `"completed"`, or `"connection_lost"` if this participant's connection was lost for good during the countdown. The timer still runs to the end, from the start time it already had. |
| `left_participant` | `null` | Always `null`: the countdown doesn't depend on any other participant. It is recorded so every multiplayer trial has the same columns. |
| `group` | `object` | The trial's shared data at the end of the trial, keyed by participant ID. Only saved when `save_group` is `true`. |

## How the group agrees on a start time

When a participant reaches the trial, it writes the current time to its part of the trial's
shared data. Every participant's clock is then based on the **earliest** of those times. As later
participants' times arrive, the earliest one does not change, so everyone converges on the same
start. If a participant sees an earlier time arrive after their clock is already running, their
clock jumps down to match.

This makes the countdown a shared deadline, not a waiting point. Participants finish within a
fraction of a second of each other, but not at exactly the same moment, and the countdown does
not wait for anyone who is late or has left. To make everyone start together, put a
[`multiplayer-ready`](plugin-multiplayer-ready) or [`multiplayer-sync`](plugin-multiplayer-sync)
trial before it. To be sure everyone has finished before the next trial, put one after it.

Each participant's clock uses their own computer's time. If one computer's clock is badly wrong
(running behind by several seconds, say), the group's countdown can end early for everyone else.
With normally set clocks, the difference is a few milliseconds.

## Each countdown starts a fresh clock

The start times live in the trial's own part of the shared data (its [trial
scope](../guides/how-it-works)), so every countdown trial starts a new clock, including each
repetition inside a loop. You don't need to name anything.

To run **one clock across several trials**, give them the same `multiplayer_scope` (a parameter
every trial accepts). A participant who already has a start time in that scope keeps it, so the
second trial picks up where the first left off and ends at its own `duration`, measured from the
shared start. Here the group has 60 seconds in total: 20 to read, and whatever is left of the
minute to answer:

```js
const readPhase = {
  type: jsPsychMultiplayerCountdown,
  multiplayer_scope: "round_clock",
  duration: 20000,
  stimulus: "<p>Time left to read:</p>",
};
const answerPhase = {
  type: jsPsychMultiplayerCountdown,
  multiplayer_scope: "round_clock",
  duration: 60000, // measured from the start of readPhase
  stimulus: "<p>Time left to answer:</p>",
};
```

Inside a loop, build the name from something that changes each round, such as a timeline
variable (`` multiplayer_scope: () => `round_${jsPsych.evaluateTimelineVariable("round")}` ``), so a new
round doesn't pick up the previous round's expired clock.

## Example

A 30-second planning phase before each of five rounds, with a ready trial to line everyone up
first:

```js
const roundTrials = {
  timeline: [
    {
      type: jsPsychMultiplayerReady,
      expected_players: 4,
      stimulus: () =>
        `<p>Round ${jsPsych.evaluateTimelineVariable("round")} is about to start.</p>`,
    },
    {
      type: jsPsychMultiplayerCountdown,
      duration: 30000,
      stimulus: () => `<p>Round ${jsPsych.evaluateTimelineVariable("round")}: plan your move.</p>`,
      prompt: "<p>The round starts when the timer reaches zero.</p>",
    },
    // … the round itself …
  ],
  timeline_variables: [{ round: 1 }, { round: 2 }, { round: 3 }, { round: 4 }, { round: 5 }],
};
```

## Showing the clock during another trial

The clock's building blocks are also available as functions on `jsPsychMultiplayerCountdown`, so
you can show the group's time during another trial (for example, next to a
[`multiplayer-draw`](plugin-multiplayer-draw) canvas). `startedAtKey(name)` gives a field name
that keeps the clock apart from the trial's other data, `resolveStartedAt(group, key)` finds the
group's start time, `computeRemaining(startedAt, duration, now)` and
`computeElapsed(startedAt, duration, now)` do the arithmetic, and `formatTime(ms)` gives `M:SS`.

The trial showing the clock writes its own start time and reads everyone's, both in its own
scope:

```js
const key = jsPsychMultiplayerCountdown.startedAtKey("draw_phase");
jsPsych.multiplayer.update({ [key]: Date.now() }); // once, when the trial starts

// Then, on a timer:
const startedAt = jsPsychMultiplayerCountdown.resolveStartedAt(jsPsych.multiplayer.getAll(), key);
const remaining = jsPsychMultiplayerCountdown.computeRemaining(startedAt, 60000, Date.now());
clockElement.textContent = jsPsychMultiplayerCountdown.formatTime(remaining);
```
