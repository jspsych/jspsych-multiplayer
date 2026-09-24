---
"@jspsych-multiplayer/adapter-multiplayer-firebase": minor
---

Adopt the redesigned jsPsych multiplayer adapter contract (jsPsych#3694): `connect(options)` returns a new connection each time, change notifications go through `onChange()` / `onStatus()` instead of adapter-side `subscribe()`, and `connect()` honors the cancellation signal. Presence now lives in a separate `<pathPrefix>-presence` node (add it to your security rules; see the README), and `disconnect()` or a dropped connection no longer deletes the participant's data slot. The `removeOnDisconnect` option is removed.
