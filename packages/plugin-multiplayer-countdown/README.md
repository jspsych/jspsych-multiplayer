# @jspsych-multiplayer/plugin-multiplayer-countdown

A synchronized group timer for multiplayer jsPsych experiments, built on the multiplayer plugin API. Every participant writes its own start timestamp on trial load, and each client derives the displayed time from the **minimum** timestamp across participants — a coordination-free consensus (no elected anchor, no single point of failure) in the same spirit as [`plugin-multiplayer-role`](../plugin-multiplayer-role)'s ordering. A participant who reaches the trial late resumes at the group's true remaining time for free.

Like [`plugin-multiplayer-chat`](../plugin-multiplayer-chat), it is built on the multiplayer API's real-time **`subscribe`** primitive: the trial stays open, re-resolves the consensus start whenever a new (lower) timestamp arrives, and re-renders the clock on a ~100 ms tick, ending when its own derived time reaches `duration`.

> **Status:** requires the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet in a jsPsych release. On a jsPsych without `jsPsych.multiplayer`, the trial throws an error saying so.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter    | Type        | Default       | Description                                                                                                                                                                                          |
| ------------ | ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duration`   | integer     | _(required)_  | Total length of the timer in milliseconds. Must be positive. Both modes end here. Throws if missing or non-positive.                                                                                 |
| `mode`       | string      | `"countdown"` | `"countdown"` displays time remaining and ticks toward `0:00`; `"countup"` displays time elapsed and ticks up toward `duration`. Same consensus start either way — only the displayed value differs. |
| `stimulus`   | HTML string | `null`        | HTML shown above the timer (e.g. `"Time left to draw:"`). `null` shows nothing.                                                                                                                      |
| `prompt`     | HTML string | `null`        | Secondary HTML hint shown below the timer. `null` shows nothing.                                                                                                                                     |
| `format`     | function    | `null`        | Formats the millisecond value into the displayed string: `(ms) => string`. `null` uses the built-in `M:SS` formatter (ceil for countdown, floor for count-up).                                       |
| `save_group` | boolean     | `false`       | Store the trial's snapshot of the group's data in the `group` data field at trial end. Off by default (mostly timestamps, low value here).                                                           |

## Data Generated

| Name                  | Type    | Description                                                                                                                                                                                                 |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `started_at`          | integer | The resolved canonical (minimum-across-participants) start timestamp the display was derived from.                                                                                                          |
| `own_started_at`      | integer | This client's own start timestamp; its gap vs. `started_at` estimates this client's entry skew.                                                                                                             |
| `displayed_duration`  | integer | How long the timer was actually on screen for this client, in ms (≤ `duration` for late joiners).                                                                                                           |
| `mode`                | string  | Which mode ran: `"countdown"` or `"countup"`.                                                                                                                                                               |
| `multiplayer_outcome` | string  | `"completed"`, or `"connection_lost"` if this client's connection was lost for good by the end of the countdown. The countdown still runs to the end locally, from the start time it had already agreed on. |
| `left_participant`    | string  | Always `null`: the countdown doesn't depend on any other participant.                                                                                                                                       |
| `group`               | object  | The trial's snapshot of the group's data at trial end. Only stored when `save_group` is true.                                                                                                               |

## How the consensus start works

Each participant can only write its own data, so there is no shared value an "anchor" could own. Instead each participant writes its own `Date.now()` under the `countdown_started_at` key in the trial's data, and the group start is the **minimum** timestamp across participants. Min is order-independent, so every client converges on the same value with no coordination and no single participant dropping out can break the clock.

The timestamp lives in the trial's own scope of the shared data, so each countdown trial starts a fresh clock, including every repetition of a loop, with nothing to name. The write is **keep-if-present**: if this participant already has a timestamp in the scope, the trial keeps it rather than overwriting it. That lets you run one clock across several trials by giving them the same `multiplayer_scope` (a parameter every trial accepts): the second trial picks up where the first left off, and ends at its own `duration` measured from the shared start.

## Limitations (read before you rely on end-synchronization)

This plugin is **not a barrier** — ends are synchronized only within clock skew + network latency. A few honest caveats:

- **Clock skew, and its direction.** Each client renders `remaining = startedAt + duration − Date.now()` against its **own** clock, so no consensus rule can make displays agree better than pairwise clock skew — it only decides _whose_ skew becomes the reference. Min is maximally sensitive to the single worst-_behind_ clock: if one client's clock is grossly behind, its timestamp becomes the min, _that_ client sees a normal countdown, and **everyone else ends early** (their derived time clamps to 0). Behind a ready/sync barrier with normal machines the real-world spread is milliseconds. Failure direction is "ends early," arguably the right direction for "time's up."
- **Convergence is monotone, not smooth.** A lower timestamp arriving mid-trial is a visible downward step in the displayed time — remaining time may tick down slightly as the group finishes converging. Run this trial behind a ready/sync barrier so convergence is already complete when it starts.
- **Assumes data outlives members.** "Min can only decrease" relies on a participant's data persisting after they disconnect, which the multiplayer adapters guarantee: they report departures through presence rather than by deleting data. An adapter that pruned data on leave would make remaining jump _up_ when the earliest participant drops.

The clamp to `[0, duration]` is the v1 mitigation for all of the above: displays stay sane and the failure mode is "ends early" rather than "runs negative / overshoots."

## Composing with a barrier

Because ends are only synchronized within skew + latency, follow the countdown with a hard barrier when you need every client past the line before the next trial:

```js
const timeline = [
  {
    type: jsPsychMultiplayerCountdown,
    duration: 60000,
    stimulus: "Time left to draw:",
  },
  { type: jsPsychMultiplayerReady }, // wait for everyone before scoring
];
```

## Example: a one-minute drawing timer

```js
const timer = {
  type: jsPsychMultiplayerCountdown,
  duration: 60000,
  stimulus: "<strong>Time left to draw:</strong>",
  prompt: "The round ends automatically when the timer reaches zero.",
};
```

## Example: count-up stopwatch

```js
const stopwatch = {
  type: jsPsychMultiplayerCountdown,
  mode: "countup",
  duration: 120000,
  stimulus: "Time elapsed:",
};
```

## Example: one clock across two trials

Give the trials the same `multiplayer_scope` so they share one start time. Here the group has 60 seconds in total: 20 to read, and whatever is left of the minute to answer.

```js
const readPhase = {
  type: jsPsychMultiplayerCountdown,
  multiplayer_scope: "round_clock",
  duration: 20000,
  stimulus: "Time left to read:",
};
const answerPhase = {
  type: jsPsychMultiplayerCountdown,
  multiplayer_scope: "round_clock",
  duration: 60000, // measured from the start of readPhase
  stimulus: "Time left to answer:",
};
```

In a loop, give each iteration its own scope name (e.g. `` multiplayer_scope: () => `round_${round}` ``) so a new round doesn't pick up the previous round's expired clock.

## Rendering your own display (the exported core)

The flagship use case renders the timer _during another trial_ (e.g. a shared drawing canvas). For that, the pure consensus core is exposed as statics on the default export, so demo-side code can render its own synced display from the same logic. That trial writes its own timestamp (`jsPsych.multiplayer.update({ [key]: Date.now() })`) and reads everyone's with `getAll()`, both in its own scope; `startedAtKey(name)` builds a key that keeps the clock apart from the trial's other data:

```js
const key = jsPsychMultiplayerCountdown.startedAtKey("draw_phase");
const startedAt = jsPsychMultiplayerCountdown.resolveStartedAt(jsPsych.multiplayer.getAll(), key);
const remaining = jsPsychMultiplayerCountdown.computeRemaining(startedAt, 60000, Date.now());
myTimerEl.textContent = jsPsychMultiplayerCountdown.formatTime(remaining);
```

Exported statics: `startedAtKey` / `resolveStartedAt` / `computeRemaining` / `computeElapsed` / `formatTime`.

## Accessibility

The visible timer is not a live region (a per-second screen-reader announcement of the whole countdown is noise). Instead a visually-hidden `aria-live` region announces the **final 5 seconds**, once per second — the point at which a screen-reader user needs to know the group deadline is about to auto-end the trial.
