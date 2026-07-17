---
"@jspsych-multiplayer/plugin-multiplayer-sync": patch
---

Finish gracefully when `getAll()` throws on the timeout path. On a genuine timeout the adapter may already be torn down (`getAll()` then throws `"connect() must be called…"`), which would otherwise escape and reject the trial instead of finishing it as `timed_out: true`. The snapshot read now falls back to an empty group session, matching the `safeGetAll` guard `plugin-multiplayer-ready` already had.
