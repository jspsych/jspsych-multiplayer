---
"@jspsych-multiplayer/plugin-multiplayer-live-scoreboard": minor
---

Add `plugin-multiplayer-live-scoreboard`: a live-updating scoreboard for multiplayer experiments. Unlike the barrier-based end-of-game scoreboard, this trial stays open and re-renders on every group-session update — each client pushes its own score once, subscribes to the shared session, and re-ranks the board in real time as peers report, with a "N reported" (or "N of M reported") caption tracking arrivals. It is a standalone trial screen (not a persistent overlay across other trials) that ends on a `duration` timeout, an `end_button_label` click, or an `end_when` predicate. Reuses the deterministic ranking core and exposes the same static accessors (`getMyRank`/`getMyScore`/`getLeaderboard`) for branching downstream trials.
