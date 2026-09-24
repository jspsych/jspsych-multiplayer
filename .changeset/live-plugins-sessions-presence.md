---
"@jspsych-multiplayer/plugin-multiplayer-chat": minor
"@jspsych-multiplayer/plugin-multiplayer-draw": minor
"@jspsych-multiplayer/plugin-multiplayer-reference-game": minor
---

Move chat, draw, and reference-game to the session-based jsPsych multiplayer API (jsPsych#3694) and handle participants leaving.

- Use `jsPsych.multiplayer` directly, with a clear error on a jsPsych version without it.
- New parameter `end_on_participant_left` (default `true`): chat and draw end when a participant who was connected at the start leaves the study; reference-game ends when the partner leaves before feedback. New data fields `partner_left`, `left_participant`, and `connection_lost`; `ended_by` can also be `"participant_left"` or `"connection_lost"`.
- A lost connection ends the trial instead of leaving it waiting, and send errors no longer claim to be retrying after the connection is gone.
- `end_when`, `sender_label` (chat), and `roster_label` (draw) also receive the presence snapshot; rosters mark participants who are away or have left. Reference-game partner auto-detection ignores participants who left.
- Trial data no longer holds the API's frozen snapshots: draw's strokes and reference-game's `save_group` are copies.
