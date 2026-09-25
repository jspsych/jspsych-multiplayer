---
"@jspsych-multiplayer/adapter-multiplayer-jatos": minor
---

Port to the hardened multiplayer adapter contract.

- **Breaking:** the `connectTimeoutMs` and `closeAfterReconnectingMs` options are removed; the adapter warns and ignores them. Use jsPsych's own options instead: `jsPsych.multiplayer.connect(adapter, { connectTimeout, reconnectTimeout })`. The adapter now honours the AbortSignal jsPsych passes to `connect()`, which also ends a join jatos.js keeps refusing while an old socket closes.
- The adapter now relays a group seal itself. JATOS confirms `setGroupFixed()` only to the member who asked, so that member writes the sorted final roster into the group session under the reserved key `$sealed`. Every member that reads a record it trusts reports `sealed: true` with that roster, and rosters are merged so members who drop out after the seal stay on it. A record is trusted only if its writer and the reader are on it, it includes everyone `jatos.groupMembers` lists at the time, and everyone on it has been seen as a member or has written data.
- `getAll()` returns only participant payloads, unchanged; group session keys starting with `$` are left out.
- `sealGroup()` is left off the connection when jatos.js has no `setGroupFixed()`, so `jsPsych.multiplayer.sealGroup()` reports `unsupported` instead of the adapter throwing.
- `push()` rejects at once while the group channel is down, and after 3 quick attempts (was 8) on repeated version conflicts; jsPsych retries with backoff and resends once the channel reopens. A push no longer waits indefinitely for the channel, which blocked every later write.
- The participant ID (the study result ID) is checked with `validateId` from `@jspsych-multiplayer/utils`, a new dependency.
