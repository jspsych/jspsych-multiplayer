# @jspsych-multiplayer/extension-presence-check

An "Are you still with us?" inactivity check, as a jsPsych extension. While a trial runs, the participant's own mouse movement, clicks, key presses, wheel scrolling and touches count as activity. After `prompt_after` ms without any, a warning appears. Each warning ends in one of three ways:

- **Dismissed:** a counted input (or the warning's button) closes it. The consecutive-miss count goes back to 0 and the idle clock restarts.
- **Missed:** nobody responds within `respond_within` ms. It closes, the consecutive-miss count goes up by 1, and the idle clock restarts.
- **Expired:** when consecutive misses reach `max_consecutive_misses`, the extension calls `on_expire(summary)` once, closes the warning, and stops prompting for the rest of the trial.

Activity between warnings also resets the count, so a participant can be warned any number of times without consequence as long as they react. With the defaults (30 s, 30 s, 2 misses), the check expires after about 120 s with no activity.

The extension never ends a trial or the experiment itself: your `on_expire` callback decides what removal means (ending the experiment, telling the partner, redirecting). It has no dependency on the multiplayer API or any adapter, so it works in any jsPsych 8 experiment.

It generalizes the study-specific `presence-check.js` from [multiplayer-test-experiments#37](https://github.com/jspsych/multiplayer-test-experiments/pull/37), which only reminded participants and only accepted its button.

## Loading

```html
<script src="https://unpkg.com/@jspsych-multiplayer/extension-presence-check"></script>
```

Built from this repo, the browser bundle is `dist/index.browser.min.js` and defines the global `jsPsychExtensionPresenceCheck`. With a bundler:

```js
import jsPsychExtensionPresenceCheck from "@jspsych-multiplayer/extension-presence-check";
```

## Usage

Register the extension once, optionally with experiment-wide defaults, and add it to each trial it should watch. Per-trial `params` override the `initialize` ones; `activity_inputs` and `dismiss_inputs` merge key by key.

```js
const jsPsych = initJsPsych({
  extensions: [
    {
      type: jsPsychExtensionPresenceCheck,
      params: {
        on_expire: () => jsPsych.abortExperiment("You were removed for inactivity."),
      },
    },
  ],
});

const round = {
  type: jsPsychMultiplayerReferenceGame,
  // ...
  extensions: [
    {
      type: jsPsychExtensionPresenceCheck,
      params: { paused: () => inFeedbackPhase() },
    },
  ],
};
```

The extension instance is `jsPsych.extensions["presence-check"]`. Call `reset()` on it to clear the consecutive-miss count; `consecutiveMisses` reads it.

## Parameters

| Parameter                | Type            | Default                                                       | Description                                                                                                                                                                                           |
| ------------------------ | --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt_after`           | integer         | `30000`                                                       | ms with no counted activity before a warning appears. Must be positive.                                                                                                                               |
| `respond_within`         | integer         | `30000`                                                       | ms a warning stays up before it counts as missed. Must be positive.                                                                                                                                   |
| `max_consecutive_misses` | integer \| null | `2`                                                           | Consecutive misses that expire the check. `0` or `null` never expires (a reminder only). Any other value must be a positive integer.                                                                  |
| `count_across_trials`    | boolean         | `true`                                                        | Carry the consecutive-miss count from one trial to the next. When `false`, the trial starts from 0 and leaves the carried count as it was.                                                            |
| `activity_inputs`        | object          | all `true`                                                    | Which inputs reset the idle clock: `{ mouse_move, pointer_down, keyboard, wheel, touch }`.                                                                                                            |
| `dismiss_inputs`         | object          | all `true`                                                    | Which inputs dismiss an open warning, same shape. All `false` means only the button does. The button always works.                                                                                    |
| `paused`                 | function        | `() => false`                                                 | While it returns `true`, no warning shows and an open one closes as `interrupted`. Checked every 250 ms and before each input. If it throws, the error is logged once and the trial counts as paused. |
| `on_expire`              | function        | `() => {}`                                                    | `(summary) => void`, called once per expiry, after the warning has closed. `summary` has the same fields as the trial data, as of the expiry.                                                         |
| `title`                  | HTML string     | `"Are you still with us?"`                                    | Warning title (shown in bold).                                                                                                                                                                        |
| `body`                   | HTML string     | `"Please click the button to let us know you're still here."` | Warning text.                                                                                                                                                                                         |
| `button_label`           | HTML string     | `"I'm still here"`                                            | Button label.                                                                                                                                                                                         |
| `countdown_text`         | HTML string     | `"This message closes in {seconds}s."`                        | Countdown line; `{seconds}` is replaced with the whole seconds left.                                                                                                                                  |

### Inputs

| Input          | Events                                         |
| -------------- | ---------------------------------------------- |
| `mouse_move`   | `mousemove` with movement                      |
| `pointer_down` | `pointerdown` from a mouse or pen              |
| `keyboard`     | `keydown`, `input`                             |
| `wheel`        | `wheel`                                        |
| `touch`        | `touchstart`, `touchmove`, touch `pointerdown` |

Only trusted (user-generated) events count; anything a script dispatches is ignored. There is deliberately no `scroll` listener: a page also scrolls itself (a chat log pinning to new messages), which shows nothing about the participant. For the same reason a `mousemove` without movement is ignored; Chromium sends one when the page scrolls or reflows under a resting cursor. While a warning is open, inputs that do not dismiss it do not count as activity either.

### Counting misses across trials

By default the count persists across trials. If rounds are separated by feedback during which `paused()` returns `true`, a miss in round 5 followed by a miss in round 6 reaches a limit of 2. Being paused, or the trial ending while a warning is open, closes the warning as `interrupted`: that neither counts as a miss nor resets the count. Expiry does not reset the count either (counted activity afterwards still clears it, as at any other time). So if the experiment continues, the count is still at the limit and the next missed warning expires the check again, calling `on_expire` again; call `reset()` if the participant should start over.

## Input pass-through and focus

The input that dismisses a warning still reaches the page: the first keystroke goes into the field the participant was typing in, and a click lands on what was clicked. The extension listens in the capture phase and never calls `preventDefault` or `stopPropagation` on these events. How the warning renders depends on `dismiss_inputs`:

| Mode                                                            | Overlay                                                                                                       | Focus                                                                                                                                                                      | ARIA                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Any of `mouse_move`, `pointer_down`, `wheel`, `touch` (default) | A tinted overlay with `pointer-events: none`; only the button takes clicks. The page underneath stays usable. | Not moved.                                                                                                                                                                 | `role="alert"` on the message, announced on display |
| `keyboard` only                                                 | A blocking backdrop; clicks on it are counted as `backdrop_clicks`.                                           | Not moved, so the dismissing keystroke lands where the participant was typing.                                                                                             | `role="alert"` on the message                       |
| None (button only)                                              | A blocking backdrop; clicks on it are counted.                                                                | Moved to the button and trapped there (Tab and focus changes return to it); keys do not reach the page. Restored afterwards, unless a pause or the trial ending closed it. | `role="alertdialog"`, `aria-modal`                  |

Style the warning with the `jspsych-extension-presence-check` classes (`-card`, `-message`, `-title`, `-body`, `-button`, `-remaining`); the overlay has `is-passthrough` in the first mode.

## Data Generated

| Name                          | Type    | Description                                                                                                                                                                                                                                 |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence_prompts`            | integer | Warnings shown this trial.                                                                                                                                                                                                                  |
| `presence_responded`          | integer | Warnings dismissed by an input or the button.                                                                                                                                                                                               |
| `presence_missed`             | integer | Warnings left unanswered, including the one that expired.                                                                                                                                                                                   |
| `presence_interrupted`        | integer | Warnings closed by `paused()` or by the trial ending.                                                                                                                                                                                       |
| `presence_backdrop_clicks`    | integer | Clicks on the blocking backdrop (keyboard-only and button-only modes).                                                                                                                                                                      |
| `presence_consecutive_misses` | integer | The consecutive-miss count when the trial ended.                                                                                                                                                                                            |
| `presence_expired`            | boolean | Whether the check expired during this trial.                                                                                                                                                                                                |
| `presence_events`             | array   | One entry per warning: `shown_at` (ms from the trial's `on_load`), `outcome` (`responded`, `missed`, `interrupted`, `expired`), `rt` (ms; `null` unless responded), `dismissed_by` (`button`, an input name, or `null`), `backdrop_clicks`. |

## Testing

The timing logic is `createPresenceMonitor` (also a static on the extension class), which has no DOM and takes its clock as `now`, so it can be driven with a fake clock. See `src/monitor.spec.ts`.

## Author / Citation

Hannah Tsukamoto
