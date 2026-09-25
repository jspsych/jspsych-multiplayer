---
"@jspsych-multiplayer/adapter-multiplayer-firebase": minor
---

Add `matchmaking: { lobby, groupSize }`: everyone opens the same link, and the adapter fills groups of `groupSize` as participants arrive, instead of grouping them by `?mp_session=` link. Each step of joining is a Realtime Database transaction, so two participants who arrive together can't both take the last place. A group is sealed when its last place is taken (or early, with `jsPsych.multiplayer.sealGroup()`), and the adapter reports it through the core's `group()`, so `jsPsych.multiplayer.waitForGroup()` can hold participants in a waiting room. While a group is filling, a participant who leaves gives up their place. The recommended rules gain `mp-sessions-lobby` and `mp-sessions-groups` entries; redeploy them to use matchmaking.
