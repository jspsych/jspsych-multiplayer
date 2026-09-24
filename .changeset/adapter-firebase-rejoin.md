---
"@jspsych-multiplayer/adapter-multiplayer-firebase": patch
---

Document and test rejoining: a participant whose connection drops and recovers on the same page rejoins (`onParticipantRejoined`), while a reload under the same participant id is reported as a restart (`onParticipantRestarted`). No behavior change was needed.
