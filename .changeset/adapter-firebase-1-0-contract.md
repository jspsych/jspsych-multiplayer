---
"@jspsych-multiplayer/adapter-multiplayer-firebase": minor
---

Implement the hardened multiplayer adapter contract. `getAll()` returns each stored payload unchanged, and the connection calls `onResumed()` when the server removed its presence without the connection seeing a drop. With matchmaking, every member now sees the seal and the final roster.

Breaking changes:

- `pathPrefix` is renamed to `namespace`, and `connectTimeoutMs` is removed: pass `connectTimeout` to `jsPsych.multiplayer.connect()` instead. Passing either old option throws.
- The default participant id is now kept per tab in `sessionStorage` (`persistParticipant`, default `true`), so a reload comes back as the same participant, in the same group, and jsPsych reports it as a restart. Pass `persistParticipant: false` for a new participant on every page load.
- `sessionBinding` now defaults to `true` in every identity mode.
- New security rules. Each connection claims its participant id (`<namespace>-owners/<session>/<id> = uid`), and only that uid can write the participant's data and presence, whatever the identity mode. Matchmaking groups are stored as per-seat entries tied to the holder's uid, plus a sealed roster that must match the seats. The lobby can only move off a sealed group. Update your database rules from the README (the quick-start rules now cover every node too). Groups formed by an earlier version aren't read.
- Uses `@jspsych-multiplayer/utils` for session ids, id generation, and id validation. Invalid-id errors now read "must be a non-empty string without any of : / . # $ [ ]".
