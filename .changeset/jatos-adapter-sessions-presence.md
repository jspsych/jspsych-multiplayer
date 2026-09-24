---
"@jspsych-multiplayer/adapter-multiplayer-jatos": minor
---

**Breaking:** implement the redesigned multiplayer adapter contract from jsPsych#3694.

- `connect(options)` now returns a new `MultiplayerConnection` for each call, with `getAll()`, `connectedParticipants()`, `push()`, and `disconnect()`. The adapter's own `subscribe()` and `get()` are gone; the adapter reports changes through `options.onChange()`, and jsPsych's multiplayer session handles subscriptions.
- **Presence:** `connectedParticipants()` returns the members with an open group channel (`jatos.groupChannels`), and member join/leave/open/close events are reported, so jsPsych can mark participants who drop out as `away` and then `left`.
- **Connection status:** a dropped group channel is reported as `reconnecting` and a reopened one as `connected`. A channel that stays down longer than the new `closeAfterReconnectingMs` option (default 30000 ms) is reported as `closed`. While the channel is down, reads return the last group session data instead of the empty data jatos.js holds.
- `push()` waits for a dropped channel to reopen instead of failing.
- `connect()` honors the abort signal, rejects promptly when jatos.js refuses to open a channel, and rejects while another connection on the page is open or still joining (jatos.js supports one group channel per page). If a cancelled connect's channel opens anyway, the adapter leaves the group.
