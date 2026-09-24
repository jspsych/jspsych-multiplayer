---
id: plugin-multiplayer-draw
title: multiplayer-draw
sidebar_label: multiplayer-draw
description: A shared drawing canvas that every participant in the group draws on at the same time.
---

# `multiplayer-draw`

A draw trial gives the group one canvas to draw on together. Each stroke appears on everyone's
screen while it is being drawn, and each participant's data gets every stroke as a list of
points. Use it for collaborative sketching, drawing-based communication games, or any task where
you want to record how people build a picture together.

Like [`multiplayer-chat`](plugin-multiplayer-chat), the trial stays open until one of the end
conditions you set is met: a time limit (`duration`), a button (`end_button_label`), or a
condition over the group's shared data (`end_when`). Set at least one; with none, the trial
cannot end and the plugin logs a warning.

**What the participant sees:** your `prompt`, a toolbar, and the canvas. The toolbar has a row of
color swatches, a set of brush sizes, and **Pen**, **Eraser**, **Undo**, and **Redo** buttons.
Picking a color switches back to the pen. Undo and Redo only ever affect this participant's own
strokes. If you set `end_button_label`, a button with that label sits below the canvas.

```js
timeline.push({
  type: jsPsychMultiplayerDraw,
  prompt: "<p>Sketch a plan of the room together.</p>",
  duration: 120000,
  end_button_label: "I'm done",
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-draw` |
| Browser global | `jsPsychMultiplayerDraw` |
| Trial type | `multiplayer-draw` |
| Requires | a connected session (see [Getting started](../getting-started)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `prompt` | HTML string | `""` | Shown above the toolbar. |
| `data_key` | `string` | `"draw_strokes"` | The field in this participant's slot where their strokes are kept. Give two draw trials in one experiment different keys if each should start with a blank canvas; trials that share a key share a canvas. |
| `aspect_ratio` | `number` | `4/3` | The canvas's width divided by its height. The canvas is as large as the page allows at this shape, so it has the same shape on every participant's screen. |
| `colors` | `string[]` | 5 colors (see below) | The color swatches, as CSS colors. The first is selected at the start. |
| `brush_sizes` | `number[]` | `[0.004, 0.01, 0.02]` | The brush widths to offer, as a fraction of the canvas width. The middle one is selected at the start. |
| `min_point_distance` | `number` | `0.004` | How far the pointer must move, as a fraction of the canvas width, before another point is recorded. Larger values give fewer points and smaller data. |
| `push_interval_ms` | `number` | `60` | How often, in ms, a stroke in progress is sent to the others while it is being drawn. Lower values look smoother to the others; higher values send less. |
| `duration` | `number \| null` | `null` | End the trial after this many ms. `null`, `0`, or a negative number means no time limit. Each participant's timer starts when they reach the trial. |
| `end_button_label` | `string \| null` | `null` | Show a button with this label that ends the trial for the participant who clicks it. `null` or `""` shows no button. |
| `end_when` | `(group, presence) => boolean` | `null` | A condition checked at the start and after every change to the shared data or presence. The trial ends as soon as it returns `true`. Both arguments are frozen, so don't modify them. |
| `show_roster` | `boolean` | `false` | Show a "Participants:" line listing everyone in the group, with "(away)" after anyone whose connection has dropped and "(left)" after anyone who has left. |
| `roster_label` | `(participantId, group, presence) => string` | `null` | The name shown for each participant in the roster. By default, their participant ID. Only used when `show_roster` is `true`. |
| `store_full_strokes` | `boolean` | `true` | Save every stroke, with its points, in `strokes`. Set `false` to save only the counts. |
| `end_on_participant_left` | `boolean` | `true` | End the trial when a participant who was connected at the start of the trial leaves. Set `false` to keep drawing with whoever remains. |

The default colors are near-black `#1a1a1a`, red `#e03131`, green `#2f9e44`, blue `#1971c2`, and
orange `#f08c00`.

## Data

| Field | Type | Description |
| --- | --- | --- |
| `strokes` | `object[]` | Every stroke on the canvas when this participant's trial ended, in the order they were started (see [Stroke format](#stroke-format)). Not saved when `store_full_strokes` is `false`. |
| `stroke_count` | `number` | How many strokes were on the canvas, from all participants. |
| `strokes_drawn` | `number` | How many of them this participant drew, not counting strokes they undid. |
| `draw_time` | `number` | Milliseconds from the start of the trial to its end. |
| `ended_by` | `string` | What ended the trial: `"duration"`, `"button"`, `"condition"` (`end_when`), `"participant_left"`, or `"connection_lost"`. |
| `partner_left` | `boolean` | `true` if the trial ended because another participant left. |
| `left_participant` | `string \| null` | The ID of the participant who left, when `partner_left` is `true`. |
| `connection_lost` | `boolean` | `true` if the trial ended because this participant's own connection was lost for good. |

[Handling dropouts](../guides/handling-dropouts) explains `partner_left`, `left_participant`,
`connection_lost`, and how to branch on them. As with the chat, the saved strokes are what this
participant's canvas showed when their trial ended, so a stroke finished in the last moment may
be in one participant's data and not another's.

## Stroke format

Each stroke is one continuous press-drag-release:

| Field | Description |
| --- | --- |
| `id` | `"<authorId>#<seq>"`, unique within the trial. |
| `authorId` | The participant ID of whoever drew it. |
| `seq` | Counts that participant's strokes from 0. |
| `points` | The path, as `{ x, y }` points. |
| `tool` | `"pen"` or `"eraser"`. |
| `color` | The CSS color. Meaningless for eraser strokes. |
| `width` | The brush width, as a fraction of the canvas width. |
| `done` | `false` if the stroke was still being drawn when the trial ended. |
| `ts` | When the stroke was started, in milliseconds since 1970, by the author's clock. Strokes are ordered by this. |

Both `x` and `y` are fractions of the canvas **width**, so they are the same on every screen.
`x` runs from 0 (left) to 1 (right); `y` runs from 0 (top) to `1 / aspect_ratio` (bottom), which
is 0.75 with the default 4:3 canvas. To draw the picture again, multiply both by the width you
want.

The eraser removes whatever was drawn before it, whoever drew it. Redo puts a stroke back with a
new `ts`, so it is drawn on top of anything added since it was undone.

## Example

A five-minute shared canvas that closes for everyone once every participant has clicked
**I'm done**. Clicking the button ends the trial only for the participant who clicked it, so
here each participant's click is written to the group first and `end_when` closes the canvas
when everyone has done so:

```js
const draw = {
  type: jsPsychMultiplayerDraw,
  prompt: "<p>Draw a house together. Click <strong>I'm done</strong> when you are finished.</p>",
  duration: 300000,
  aspect_ratio: 16 / 9,
  colors: ["#000000", "#d9480f", "#1971c2", "#2f9e44"],
  show_roster: true,
  end_on_participant_left: false, // keep drawing if someone leaves
  roster_label: (id, group) => {
    // Add a check mark once a participant has clicked "I'm done"
    if (group[id] !== undefined && group[id].draw_done) {
      return `${id} ✓`;
    }
    return id;
  },
  end_when: (group, presence) => {
    // End once every participant has either clicked "I'm done" or left
    for (const id in group) {
      if (!group[id].draw_done && presence[id] !== "left") {
        return false;
      }
    }
    return true;
  },
  on_load: () => {
    const done = document.createElement("button");
    done.textContent = "I'm done";
    done.addEventListener("click", () => {
      done.disabled = true;
      jsPsych.multiplayer.update({ draw_done: true });
    });
    document.querySelector(".jspsych-multiplayer-draw").append(done);
  },
};
```

With `end_on_participant_left: false`, the others keep drawing if someone leaves. A participant
who has left can't click the button, so the condition counts them as done.
