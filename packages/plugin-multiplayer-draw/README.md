# @jspsych-multiplayer/plugin-multiplayer-draw

A real-time collaborative drawing canvas for multiplayer jsPsych experiments, built on the multiplayer plugin API. Every participant draws on one shared canvas; strokes from everyone appear live on everyone else's screen. Includes pen/eraser tools, a fixed color palette, brush sizes, and undo/redo buttons that only ever act on this participant's own strokes.

Where [`plugin-multiplayer-chat`](../plugin-multiplayer-chat) pushes once per message (sparse, human-paced), this plugin pushes continuously while a stroke is active — it is the first plugin that stresses the multiplayer API's real-time **`subscribe`** primitive at a genuinely high rate, not just an event-driven one.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. The plugin codes against a local interface mirroring that API (`src/multiplayer-api.ts`) and reaches the real object with one cast — the single seam to re-verify once #3694 lands. Tests run against an in-memory mock, so no live group session is needed to develop it.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.pluginAPI.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter            | Type        | Default               | Description                                                                                                                              |
| -------------------- | ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`             | HTML string | `""`                  | Instructions rendered above the canvas.                                                                                                  |
| `data_key`           | string      | `"draw_strokes"`      | Group-session field this trial stores its stroke array under. Namespacing avoids colliding with other pushed data or another draw trial. |
| `aspect_ratio`       | float       | `4/3`                 | Canvas width:height ratio, fixed and shared across clients (see "Canvas sizing" below).                                                  |
| `colors`             | string[]    | 5 preset swatches     | Color palette buttons. The first is selected by default.                                                                                 |
| `brush_sizes`        | float[]     | `[0.004, 0.01, 0.02]` | Brush width choices, normalized against canvas width. The middle value is selected by default.                                           |
| `min_point_distance` | float       | `0.004`               | Minimum normalized distance between recorded points (decimation) — bounds payload/render growth.                                         |
| `push_interval_ms`   | integer     | `60`                  | How often an in-progress stroke's points are pushed to the group session.                                                                |
| `duration`           | integer     | `null`                | Auto-end the trial after this many milliseconds. `null` (or non-positive) means no time limit.                                           |
| `end_button_label`   | string      | `null`                | If set, show a button with this label that ends the trial when clicked. `null` hides it.                                                 |
| `end_when`           | function    | `null`                | Predicate `(group) => boolean` evaluated on every update; the trial ends when it returns true.                                           |
| `show_roster`        | boolean     | `false`               | Show the list of participants currently present in the group session.                                                                    |
| `roster_label`       | function    | `null`                | `(participantId, group) => string` — how to label each participant in the roster. Defaults to the raw participant id; supply to show names. |
| `store_full_strokes` | boolean     | `true`                | Include full stroke point arrays in trial data. Set `false` to store only counts (see "Payload growth" below).                           |

> **Set at least one end condition** (`duration`, `end_button_label`, or `end_when`). With none, the trial can never end, and the plugin logs a warning.

## Data Generated

| Name            | Type    | Description                                                                                                              |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `strokes`       | object  | The merged, `ts`-ordered stroke list as **this client** saw it at trial end. Omitted if `store_full_strokes` is `false`. |
| `stroke_count`  | integer | Total number of distinct strokes across all participants.                                                                |
| `strokes_drawn` | integer | How many strokes this participant drew (after any undos).                                                                |
| `draw_time`     | integer | Time from trial start until the trial ended, in milliseconds.                                                            |
| `ended_by`      | string  | What ended the trial: `"duration"`, `"button"`, or `"condition"`.                                                        |

## Tools

- **Pen** — draws with the selected color and brush size. Clicking a color swatch also switches the active tool to Pen (matching common drawing-app behavior), since color has no effect while erasing.
- **Eraser** — removes ink using canvas `destination-out` compositing, so it works regardless of background color.
- **Undo** — removes only this participant's own last stroke (or discards the in-progress one, if mid-stroke). Never touches another participant's strokes — safe by construction, since a participant only ever writes their own group-session slot.
- **Redo** — restores the most recently undone stroke (local-only stack; not synced or persisted). Its timestamp is refreshed to the current time so it repaints on top of everything drawn since the undo, preserving the eraser's paint-order correctness. Starting a new stroke clears the redo stack.

## Data model and correctness notes

The multiplayer API's `push` **replaces** a participant's slot (it does not merge — see `plugin-multiplayer-chat`'s README for the same crux). Each participant therefore owns one array — their own strokes — under `data_key`; the rendered canvas is the merge of every participant's array.

**Canvas sizing.** The canvas has a _fixed_ aspect ratio (`aspect_ratio`), letterboxed to fit its container. Stroke points are normalized (0..1) against the canvas's pixel _width_ on both axes — not independently per axis — so a circle drawn on one client's viewport renders as a circle, not an ellipse, on a differently-sized client's viewport.

**Paint order and the eraser.** Because the eraser uses `destination-out` compositing, an eraser stroke only removes ink painted _before_ it — the rendered image depends on paint order. Any full repaint of the canvas (triggered by an undo or a resize) paints every stroke from every participant sorted globally by `(ts, authorId, seq)` — the same author's own clock timestamp used to order strokes started at roughly the same time. This is a best-effort global order (participant clocks aren't synchronized, same caveat as chat's message ordering), not a strict guarantee.

**Incremental rendering.** Between full repaints, the plugin paints only newly-arrived points rather than redrawing the whole canvas on every update — necessary at the push rate this plugin runs at. A `subscribe` callback is not guaranteed to reflect every intermediate stroke state (the local adapter coalesces signals; other adapters may too), so the incremental painter walks forward through _every_ unseen stroke on each callback, not just the newest one.

**Undo detection.** A full repaint is triggered whenever a previously-seen stroke disappears from an author's array — detected by strokeId, not by array length, so an undo immediately followed by a new stroke (same length, different content) is still caught.

> **Payload growth:** each push re-serializes the author's _entire_ stroke history (since `push` replaces the whole slot), so bytes on the wire grow with total ink drawn during the trial, not momentary activity. Points are decimated (`min_point_distance`) to bound this per stroke; for very long or detailed free-draw trials, consider `store_full_strokes: false` to keep trial data small.

> **Dropped pushes self-heal.** Because every push carries the author's complete stroke array, a push that fails or is lost is automatically corrected by the next scheduled push, which resends the full current state. The plugin surfaces a brief "Connection trouble" note on a failed push but does not retry manually.

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

```js
const draw = {
  type: jsPsychMultiplayerDraw,
  end_when: (group) => Object.values(group).every((p) => p.draw_done),
};
```
