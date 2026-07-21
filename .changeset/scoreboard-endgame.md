---
"@jspsych-multiplayer/plugin-multiplayer-scoreboard": minor
---

Add `plugin-multiplayer-scoreboard`: an end-of-game scoreboard for multiplayer experiments. Each client contributes its final `score`, the trial waits (a barrier) until the group has reported, then every client independently computes the same ranked leaderboard from the shared group-session snapshot — no coordinator, no extra round-trip — and renders it locally with its own row highlighted. Supports ascending/descending sort, standard/dense tie ranking, an `on_timeout` hook, timeouts that degrade to a partial board, and static accessors (`getMyRank`/`getMyScore`/`getLeaderboard`) for branching downstream trials.
