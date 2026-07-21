---
"@jspsych-multiplayer/plugin-multiplayer-match": minor
---

Add `plugin-multiplayer-match`: partition a multiplayer group into matched sub-groups (pairs by default, or triads/larger) by deterministic consensus — every client independently computes the same partition from the shared group-session snapshot, with no coordinator. It is the foundational primitive under pairwise/small-group paradigms (trust game, ultimatum, dyadic negotiation) and composes with `plugin-multiplayer-role` (assign roles *within* a group via `position`). Runs as a short barrier (like `plugin-multiplayer-role`), supports `ordered`/`join_order`/`random` (seeded, per-round) pairing strategies and `error`/`spectator`/`smaller_group` leftover policies for non-divisible counts, fails loud on timeout, and exposes the pure core (`buildMatches`) plus partner accessors (`getMyPartners`/`getMyGroup`/`getMyPosition`/`getMatchMap`) as statics for downstream trials.
