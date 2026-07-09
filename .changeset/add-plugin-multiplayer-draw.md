---
"@jspsych-multiplayer/plugin-multiplayer-draw": minor
---

Add `plugin-multiplayer-draw`, a real-time collaborative drawing canvas for the jsPsych multiplayer API.

Every participant draws on one shared canvas; strokes from everyone appear live on everyone else's screen. Includes pen/eraser tools, a fixed color palette, brush sizes, and an undo button that only ever removes the participant's own last stroke. Where `plugin-multiplayer-chat` pushes once per message, this plugin pushes continuously while a stroke is active (throttled and point-decimated), making it the first plugin that stresses the multiplayer API's `subscribe` primitive at a genuinely high rate. Full repaints (triggered by undo or a canvas resize) paint strokes in a global timestamp order so the eraser's `destination-out` compositing behaves consistently across clients. Built against a local interface mirroring the multiplayer API (jsPsych#3694), so it carries no build-time dependency on the unreleased core.
