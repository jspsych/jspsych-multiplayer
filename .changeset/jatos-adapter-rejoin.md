---
"@jspsych-multiplayer/adapter-multiplayer-jatos": minor
---

Support rejoining the group from the same page.

- **Behavior change:** `closeAfterReconnectingMs` now defaults to `null` (never give up) instead of 30 s, so a participant whose group channel reopens after a long outage rejoins instead of having their session closed. Set a limit to restore the old behavior.
- `connect()` right after `disconnect()` no longer fails while the old socket is still closing: the adapter retries jatos.js's "not in readyState CLOSED" refusal until the socket has closed, within `connectTimeoutMs`.
- A `connect()` made while a closed connection is still leaving the group, or while a cancelled join is still in flight, now waits for it instead of rejecting. The page-wide guard is also held until an opened channel has finished leaving, so a quick reconnect no longer hits jatos.js's "can't open group channel while leaving a group".
