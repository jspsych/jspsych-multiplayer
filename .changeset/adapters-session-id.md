---
"@jspsych-multiplayer/adapter-multiplayer-local": minor
"@jspsych-multiplayer/adapter-multiplayer-firebase": minor
"@jspsych-multiplayer/adapter-multiplayer-jatos": minor
---

Report a `sessionId` on each connection, as the jsPsych multiplayer contract now requires. The local and Firebase adapters report their `sessionId` option (the `?mp_session=` value by default); the JATOS adapter reports the JATOS group result ID and rejects `connect()` if the channel opens without one. jsPsych seeds shared randomness (`jsPsych.multiplayer.random()` and related methods) with it, so every participant in a group gets the same values.
