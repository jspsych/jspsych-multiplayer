---
"@jspsych-multiplayer/plugin-multiplayer-choice": minor
"@jspsych-multiplayer/plugin-multiplayer-match": minor
"@jspsych-multiplayer/plugin-multiplayer-ready": minor
"@jspsych-multiplayer/plugin-multiplayer-role": minor
"@jspsych-multiplayer/plugin-multiplayer-scoreboard": minor
"@jspsych-multiplayer/plugin-multiplayer-sync": minor
---

Use the sealed group when there is one (`jsPsych.multiplayer.group()`, from an adapter that forms groups):

- `expected_players` (ready, choice, match) and `group_size` (role, scoreboard) default to the sealed group's members who haven't left. `expected_players` on ready and choice is no longer required when the group is sealed; without a sealed group it still is, and the error says how to fix it.
- `participants: null` means the rest of the sealed group's members who haven't left, including a member who is only `away` at that moment, instead of only the participants connected when the trial starts. Without a sealed group it is unchanged.
