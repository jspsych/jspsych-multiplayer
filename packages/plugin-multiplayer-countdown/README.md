# @jspsych-multiplayer/plugin-multiplayer-countdown

A synchronized group timer for multiplayer jsPsych experiments, built on the multiplayer plugin API. Every participant pushes its own start timestamp on trial load, and each client derives the displayed time from the **minimum** timestamp across all slots — a coordination-free consensus (no elected anchor, no single point of failure) in the same spirit as [`plugin-multiplayer-role`](../plugin-multiplayer-role)'s ordering. Late joiners and page refreshes resume at the group's true remaining time for free.

Like [`plugin-multiplayer-chat`](../plugin-multiplayer-chat), it is built on the multiplayer API's real-time **`subscribe`** primitive: the trial stays open, re-resolves the consensus start whenever a new (lower) timestamp arrives, and re-renders the clock on a ~100 ms interval, ending when its own derived time reaches `duration`.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. The plugin codes against a local interface mirroring that API (`src/multiplayer-api.ts`) and reaches the real object with one cast — the single seam to re-verify once #3694 lands. Tests run against an in-memory mock, so no live group session is needed to develop it.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.pluginAPI.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter    | Type        | Default       | Description                                                                                                                                                                                              |
| ------------ | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duration`   | integer     | _(required)_  | Total length of the timer in milliseconds. Must be positive. Both modes end here. Throws if missing or non-positive.                                                                                     |
| `name`       | string      | _(required)_  | Namespaces the group-session key this countdown stores its start under (`countdown_<name>_startedAt`). Must be identical across clients yet unique per countdown in a timeline. Throws if missing/empty. |
| `mode`       | string      | `"countdown"` | `"countdown"` displays time remaining and ticks toward `0:00`; `"countup"` displays time elapsed and ticks up toward `duration`. Same consensus start either way — only the displayed value differs.     |
| `stimulus`   | HTML string | `null`        | HTML shown above the timer (e.g. `"Time left to draw:"`). `null` shows nothing.                                                                                                                          |
| `prompt`     | HTML string | `null`        | Secondary HTML hint shown below the timer. `null` shows nothing.                                                                                                                                         |
| `format`     | function    | `null`        | Formats the millisecond value into the displayed string: `(ms) => string`. `null` uses the built-in `M:SS` formatter (ceil for countdown, floor for count-up).                                           |
| `save_group` | boolean     | `false`       | Store the full group-session snapshot in the `group` data field at trial end. Off by default (mostly timestamps, low value here).                                                                        |

> **Why `name` is required.** The key must be *identical across clients* (so they resolve the same consensus start) yet *distinct from any other countdown* (or a later countdown silently reuses this one's timestamp and ends instantly). No default can satisfy both. In a loop, pass a function so each iteration gets a fresh name — see the loop example below.

## Data Generated

| Name                 | Type    | Description                                                                                              |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `started_at`         | integer | The resolved canonical (minimum-across-slots) start timestamp the display was derived from.             |
| `own_started_at`     | integer | This client's own pushed start timestamp; its gap vs. `started_at` estimates this client's entry skew.  |
| `displayed_duration` | integer | How long the timer was actually on screen for this client, in ms (≤ `duration` for late joiners).       |
| `mode`               | string  | Which mode ran: `"countdown"` or `"countup"`.                                                            |
| `group`              | object  | Full group-session snapshot at trial end. Only stored when `save_group` is true.                        |

## How the consensus start works

The multiplayer API's `push` **replaces** a participant's slot (it does not merge), so there is no shared slot an "anchor" could own. Instead each participant writes its own `Date.now()` under a namespaced key into its own slot, and the group start is the **minimum** timestamp across all slots. Min is order-independent, so every client converges on the same value with no coordination and no single participant dropping out can break the clock.

Because `push` replaces the whole slot, the plugin reads your own slot first and pushes it back with only the countdown key changed, so other data you've pushed (e.g. a role from `plugin-multiplayer-role`, or `joinedAt`) is preserved. The push is **idempotent on refresh**: if your slot already carries a timestamp for this countdown, it is kept rather than overwritten, so a reload resumes at the group's actual remaining time.

## Limitations (read before you rely on end-synchronization)

This plugin is **not a barrier** — ends are synchronized only within clock skew + network latency. A few honest caveats:

- **Clock skew, and its direction.** Each client renders `remaining = startedAt + duration − Date.now()` against its **own** clock, so no consensus rule can make displays agree better than pairwise clock skew — it only decides *whose* skew becomes the reference. Min is maximally sensitive to the single worst-*behind* clock: if one client's clock is grossly behind, its timestamp becomes the min, *that* client sees a normal countdown, and **everyone else ends early** (their derived time clamps to 0). Behind a ready/sync barrier with normal machines the real-world spread is milliseconds. Failure direction is "ends early," arguably the right direction for "time's up."
- **Convergence is monotone, not smooth.** A lower timestamp arriving mid-trial is a visible downward step in the displayed time — remaining time may tick down slightly as the group finishes converging. Run this trial behind a ready/sync barrier so convergence is already complete when it starts.
- **Assumes slots outlive members.** "Min can only decrease" relies on slots persisting after a member disconnects — true for both current adapters (JATOS group-session data and the local adapter's localStorage). An adapter that pruned slots on leave would make remaining jump *up* when the earliest pusher drops.

The clamp to `[0, duration]` is the v1 mitigation for all of the above: displays stay sane and the failure mode is "ends early" rather than "runs negative / overshoots."

## Composing with a barrier

Because ends are only synchronized within skew + latency, follow the countdown with a hard barrier when you need every client past the line before the next trial:

```js
const timeline = [
  { type: jsPsychMultiplayerCountdown, name: "draw_phase", duration: 60000, stimulus: "Time left to draw:" },
  { type: jsPsychMultiplayerReady }, // wait for everyone before scoring
];
```

## Example: a one-minute drawing timer

```js
const timer = {
  type: jsPsychMultiplayerCountdown,
  name: "draw_phase",
  duration: 60000,
  stimulus: "<strong>Time left to draw:</strong>",
  prompt: "The round ends automatically when the timer reaches zero.",
};
```

## Example: count-up stopwatch

```js
const stopwatch = {
  type: jsPsychMultiplayerCountdown,
  name: "solve_phase",
  mode: "countup",
  duration: 120000,
  stimulus: "Time elapsed:",
};
```

## Example: a fresh name per loop iteration

`name` must be unique per countdown, so in a loop pass a **function** — jsPsych auto-evaluates it (the parameter is declared `STRING`, not `FUNCTION`), giving each iteration its own consensus key:

```js
let round = 0;
const roundTimer = {
  type: jsPsychMultiplayerCountdown,
  name: () => `round_${round}`,
  duration: 30000,
};
const loop = {
  timeline: [roundTimer /* … the round … */],
  on_timeline_finish: () => { round++; },
  loop_function: () => round < 5,
};
```

`jsPsych.timelineVariable("...")` works the same way when the unique name comes from timeline variables.

## Rendering your own display (the exported core)

The flagship use case renders the timer *during another trial* (e.g. a shared drawing canvas). For that, the pure consensus core is exposed as statics on the default export, so demo-side code can render its own synced display from the same logic:

```js
const key = jsPsychMultiplayerCountdown.startedAtKey("draw_phase");
const startedAt = jsPsychMultiplayerCountdown.resolveStartedAt(jsPsych.pluginAPI.getAll(), key);
const remaining = jsPsychMultiplayerCountdown.computeRemaining(startedAt, 60000, Date.now());
myTimerEl.textContent = jsPsychMultiplayerCountdown.formatTime(remaining);
```

Exported statics: `startedAtKey` / `resolveStartedAt` / `computeRemaining` / `computeElapsed` / `formatTime`.

## Accessibility

The visible timer is not a live region (a per-second screen-reader announcement of the whole countdown is noise). Instead a visually-hidden `aria-live` region announces the **final 5 seconds**, once per second — the point at which a screen-reader user needs to know the group deadline is about to auto-end the trial.
