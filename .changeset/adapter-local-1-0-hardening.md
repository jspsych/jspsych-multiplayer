---
"@jspsych-multiplayer/adapter-multiplayer-local": minor
---

Port to the hardened multiplayer adapter contract.

- **Breaking:** the `keyPrefix` option is renamed `namespace`, matching the other adapters. Passing `keyPrefix` logs a warning and is ignored.
- **Breaking:** `persistParticipant` now defaults to `true`, so a reload keeps the tab's participant ID (in `sessionStorage`) and the group can tell that participant restarted instead of seeing a new stranger. Pass `persistParticipant: false` for a fresh ID on every page load, as before.
- A lapsed heartbeat now calls the contract's `onResumed()` instead of reporting a synthetic `reconnecting` → `connected` blip.
- Session and participant IDs are checked with `validateId` from `@jspsych-multiplayer/utils`: they may not contain any of `: / . # $ [ ]` (previously only `:` was rejected). The namespace may not contain `:`.
- `getAll()` returns each participant's payload exactly as it was pushed.
- The session ID, participant ID, and tab-ID helpers now come from `@jspsych-multiplayer/utils`, a new dependency.
