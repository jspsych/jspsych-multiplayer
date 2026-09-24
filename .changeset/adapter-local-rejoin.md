---
"@jspsych-multiplayer/adapter-multiplayer-local": minor
---

Support rejoining. A tab whose heartbeat lapsed for longer than `presenceTimeoutMs` (a throttled background tab, or a page frozen in the back/forward cache) now reports `reconnecting` and then `connected` when its next heartbeat runs, so the other tabs count it as back (`onParticipantRejoined`) instead of leaving it `left`. A refresh is still a restart: with `persistParticipant: true` the same id returns from a new page load and the other tabs report it through `onParticipantRestarted`.
