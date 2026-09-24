---
"@jspsych-multiplayer/adapter-multiplayer-local": minor
---

Implement jsPsych's redesigned multiplayer adapter contract (jsPsych#3694): `connect()` now returns a new, independent connection each time, and the adapter reports changes through the `onChange()` callback instead of its own `subscribe()` / `get()`.

Add presence: each tab writes a heartbeat, removes it on `pagehide` or disconnect, and drops out after `presenceTimeoutMs` (default 70 s) if it stops. New options `heartbeatIntervalMs` and `presenceTimeoutMs`. `disconnect()` no longer deletes the participant's data slot. An injected `signal` is no longer closed by the adapter, and `ChangeSignal.onChange()` now returns a function that removes the handler.
