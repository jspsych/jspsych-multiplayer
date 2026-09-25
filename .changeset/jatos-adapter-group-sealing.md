---
"@jspsych-multiplayer/adapter-multiplayer-jatos": minor
---

Report the JATOS group through the core's `group()` and `sealGroup()`: the size is the batch's `maxActiveMembers`, the members are `jatos.groupMembers`, and sealing fixes the group with `jatos.setGroupFixed()`. By default the adapter fixes the group once it is full (`sealWhenFull: true`), so a member who leaves mid-study counts as a dropout instead of freeing their place for a newcomer. Experiments can hold participants in a waiting room with `jsPsych.multiplayer.waitForGroup()`.
