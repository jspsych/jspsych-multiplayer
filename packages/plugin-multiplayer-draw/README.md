# @jspsych-multiplayer/plugin-multiplayer-draw

A real-time collaborative drawing canvas for multiplayer jsPsych experiments, built on the multiplayer plugin API. Every participant draws on one shared canvas; strokes from everyone appear live on everyone else's screen. Includes pen/eraser tools, a fixed color palette, brush sizes, and undo/redo buttons that only ever act on this participant's own strokes.

Where [`plugin-multiplayer-chat`](../plugin-multiplayer-chat) writes once per message (sparse, human-paced), this plugin writes continuously while a stroke is active — it is the first plugin that stresses the multiplayer API's real-time **`subscribe`** primitive at a genuinely high rate, not just an event-driven one.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. It uses `jsPsych.multiplayer` and throws a clear error on a jsPsych version without it. Tests run the real multiplayer session over an in-memory backend, so no live group session is needed to develop it.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter                 | Type        | Default               | Description                                                                                                                             |
| ------------------------- | ----------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                  | HTML string | `""`                  | Instructions rendered above the canvas.                                                                                                 |
| `aspect_ratio`            | float       | `4/3`                 | Canvas width:height ratio, fixed and shared across clients (see "Canvas sizing" below).                                                 |
| `colors`                  | string[]    | 5 preset swatches     | Color palette buttons. The first is selected by default.                                                                                |
| `brush_sizes`             | float[]     | `[0.004, 0.01, 0.02]` | Brush width choices, normalized against canvas width. The middle value is selected by default.                                          |
| `min_point_distance`      | float       | `0.004`               | Minimum normalized distance between recorded points (decimation) — bounds payload/render growth.                                        |
| `push_interval_ms`        | integer     | `60`                  | How often an in-progress stroke's points are written to the group session. Each write serializes this participant's whole stroke array. |
| `duration`                | integer     | `null`                | Auto-end the trial after this many milliseconds. `null` (or non-positive) means no time limit.                                          |
| `end_button_label`        | string      | `null`                | If set, show a button with this label that ends the trial when clicked. `null` hides it.                                                |
| `end_when`                | function    | `null`                | Predicate `(group, presence) => boolean` evaluated on every update; the trial ends when it returns true.                                |
| `show_roster`             | boolean     | `false`               | Show the participants in the group session, marking those whose connection dropped "(away)" and those who left the study "(left)".      |
| `roster_label`            | function    | `null`                | `(participantId, group, presence) => string` — how to label each participant in the roster. Defaults to the raw participant id.         |
| `store_full_strokes`      | boolean     | `true`                | Include full stroke point arrays in trial data. Set `false` to store only counts (see "Payload growth" below).                          |
| `end_on_participant_left` | boolean     | `true`                | End the trial when another participant leaves the study (see [Participants leaving](#participants-leaving)).                            |

`group` and `presence` are the multiplayer API's frozen snapshots: read them, but don't modify them. `group` holds **this trial's** data (see [Drawing across trials](#drawing-across-trials)); to show names written in an earlier trial, read them from the session scope, e.g. `roster_label: (id) => jsPsych.multiplayer.get(id, { scope: "session" })?.name ?? id`.

> **Set at least one end condition** (`duration`, `end_button_label`, or `end_when`). With none, the trial can never end, and the plugin logs a warning.

## Data Generated

| Name                  | Type    | Description                                                                                                                                                 |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strokes`             | object  | The merged, `ts`-ordered stroke list as **this client** saw it at trial end. Omitted if `store_full_strokes` is `false`.                                    |
| `stroke_count`        | integer | Total number of distinct strokes across all participants.                                                                                                   |
| `strokes_drawn`       | integer | How many strokes this participant drew (after any undos).                                                                                                   |
| `draw_time`           | integer | Time from trial start until the trial ended, in milliseconds.                                                                                               |
| `multiplayer_outcome` | string  | How the trial ended: `"completed"` (by `duration`, the end button, or `end_when`), `"participant_left"`, `"connection_lost"`, or `"cancelled"` (see below). |
| `left_participant`    | string  | The participant whose departure ended the trial, or `null`.                                                                                                 |
| `ended_by`            | string  | Which end condition completed the trial: `"duration"`, `"button"`, or `"condition"` (`end_when`). `null` when `multiplayer_outcome` isn't `"completed"`.    |

## Participants leaving

The multiplayer API tracks each participant's presence: `connected`, `away` (their connection dropped, possibly briefly), or `left` (away for longer than the dropout timeout set in `jsPsych.multiplayer.connect()`). By default, the trial ends as soon as another participant it depends on reaches `left`, with `multiplayer_outcome: "participant_left"` and their ID in `left_participant`. In a sealed group (see `jsPsych.multiplayer.group()`) it depends on every other member who hasn't left; otherwise, on the participants who were connected when the trial started. A participant who is only `away` doesn't end the trial, and a departed participant's strokes stay on the canvas and in the data. Set `end_on_participant_left: false` to keep drawing with whoever remains.

If this participant's own connection is lost for good, the trial ends with `multiplayer_outcome: "connection_lost"`, keeping the strokes drawn up to that point. If the experiment calls `jsPsych.multiplayer.disconnect()` during the trial, it ends with `"cancelled"`.

## Tools

- **Pen** — draws with the selected color and brush size. Clicking a color swatch also switches the active tool to Pen (matching common drawing-app behavior), since color has no effect while erasing.
- **Eraser** — removes ink using canvas `destination-out` compositing, so it works regardless of background color.
- **Undo** — removes only this participant's own last stroke (or discards the in-progress one, if mid-stroke). Never touches another participant's strokes — safe by construction, since a participant only ever writes their own data.
- **Redo** — restores the most recently undone stroke (local-only stack; not synced or persisted). Its timestamp is refreshed to the current time so it repaints on top of everything drawn since the undo, preserving the eraser's paint-order correctness. Starting a new stroke clears the redo stack.

## Data model and correctness notes

The plugin writes with `update()`, which shallow-merges just the `draw_strokes` key into this participant's data for the trial and leaves everything else alone. Each participant therefore owns one array — their own strokes — under `draw_strokes`; the rendered canvas is the merge of every participant's array.

**Canvas sizing.** The canvas has a _fixed_ aspect ratio (`aspect_ratio`), letterboxed to fit its container. Stroke points are normalized (0..1) against the canvas's pixel _width_ on both axes — not independently per axis — so a circle drawn on one client's viewport renders as a circle, not an ellipse, on a differently-sized client's viewport.

**Paint order and the eraser.** Because the eraser uses `destination-out` compositing, an eraser stroke only removes ink painted _before_ it — the rendered image depends on paint order. Any full repaint of the canvas (triggered by an undo or a resize) paints every stroke from every participant sorted globally by `(ts, authorId, seq)` — the same author's own clock timestamp used to order strokes started at roughly the same time. This is a best-effort global order (participant clocks aren't synchronized, same caveat as chat's message ordering), not a strict guarantee.

**Incremental rendering.** Between full repaints, the plugin paints only newly-arrived points rather than redrawing the whole canvas on every update — necessary at the push rate this plugin runs at. A `subscribe` callback is not guaranteed to reflect every intermediate stroke state (the multiplayer API combines writes made while one is being sent, and adapters may batch updates too), so the incremental painter walks forward through _every_ unseen stroke on each callback, not just the newest one.

**Undo detection.** A full repaint is triggered whenever a previously-seen stroke disappears from an author's array — detected by strokeId, not by array length, so an undo immediately followed by a new stroke (same length, different content) is still caught.

> **Payload growth:** each write re-serializes the author's _entire_ stroke history (the whole array is written under `draw_strokes`), so bytes on the wire grow with total ink drawn during the trial, not momentary activity. Points are decimated (`min_point_distance`) to bound this per stroke; for very long or detailed free-draw trials, consider `store_full_strokes: false` to keep trial data small.

> **Writes cannot pile up.** The multiplayer API sends one write to the backend at a time and combines the writes made meanwhile into the next one, so a `push_interval_ms` faster than the backend confirms writes doesn't build a queue. `push_interval_ms` still bounds how often the plugin serializes the stroke array and notifies subscribers.

> **Failed writes self-heal.** The multiplayer API retries a failed write, and every write carries the author's complete stroke array, so the next one resends the full current state. If the connection is lost for good, the trial ends instead (see [Participants leaving](#participants-leaving)).

> **Trial data is safe to modify.** The stroke list in trial data is a copy, not the multiplayer API's frozen snapshot.

## Drawing across trials

Strokes are kept in the trial's own part of the shared data, so every draw trial starts with a blank canvas, even when the same trial object runs again in a loop. To keep drawing on one canvas across several trials, give those trials the same `multiplayer_scope`:

```js
const sketch = {
  type: jsPsychMultiplayerDraw,
  multiplayer_scope: "shared-sketch",
  duration: 60000,
};
const timeline = [sketch, discussion, sketch]; // the second sketch continues the first
```

Everything else in those trials that uses the default scope shares it too, so give a different name to each canvas you want kept apart.

## Example: a two-minute collaborative sketch with a "done" button

```js
const draw = {
  type: jsPsychMultiplayerDraw,
  prompt: "<p>Sketch out your plan together.</p>",
  duration: 120000,
  end_button_label: "I'm done",
};
```

## Example: end when everyone is done

Have each client write a `draw_done` flag when they click the end button (a trial's `on_finish` still writes to that trial's data). A participant who left the study can't set it, so count them as done:

```js
const draw = {
  type: jsPsychMultiplayerDraw,
  end_button_label: "I'm done",
  on_finish: () => jsPsych.multiplayer.update({ draw_done: true }),
  end_when: (group, presence) => {
    // End once every participant has either set draw_done or left
    for (const id in group) {
      if (!group[id].draw_done && presence[id] !== "left") {
        return false; // this participant is still going
      }
    }
    return true;
  },
};
```
