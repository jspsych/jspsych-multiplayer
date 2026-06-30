# Examples

End-to-end demos that compose the multiplayer packages in this repo.

## `ultimatum-game.html`

A turn-based **ultimatum game** (Güth, Schmittberger & Schwarze, 1982): two players split a $10 pot.
The **proposer** offers the **responder** some amount; the responder accepts (both keep the split) or
rejects (both get nothing). It is the flagship demo for the multiplayer packages, and shows how an
experiment can carry almost no synchronization or coordination code of its own.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-jatos` | The network backend — JATOS group session + channel. Connected once, before `jsPsych.run`.                           |
| `@jspsych-multiplayer/plugin-multiplayer-role`   | Assigns proposer/responder by **deterministic consensus**, with a `spectator` overflow role for extra arrivals.      |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | Each "wait for the other player" point — the lobby, the offer, the decision — is a single declarative barrier trial. |

The key rewrite: an earlier version assigned roles by hand in the lobby's `on_finish` (sort the
participant ids, take the first two as proposer/responder, route the rest to a "game full" screen).
That block is now a single `plugin-multiplayer-role` trial. Every client independently computes the
**same** role map from the shared group session — no coordinator, no extra round-trip — and because
ordering is by first-seen join time, the proposer/responder pair stays stable even if a spectator
joins later.

### Population model

The lobby admits when **at least two** players are present, and the role trial assigns the first two
as the active pair while any later arrival becomes a `spectator` routed to a "game is full" screen.
This keeps the demo graceful for the extra/abandoned participants that open recruitment inevitably
produces, rather than stalling them. (A stricter "exactly two" capped variant is possible with the
role plugin's `group_size: 2` instead of `overflow_role`; see `plugin-multiplayer-role`'s own example.)

### Running it

This example is **illustrative** — it cannot run from a single browser tab today. It requires:

1. a jsPsych core that includes the multiplayer API ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)), not yet in a released `jspsych`;
2. the **JATOS** environment, so the `jatos` global and a group study exist; and
3. at least **two** real participants in the same JATOS group.

The `<script>` tags load the three packages from their built `dist/` in this repo; once the packages
are published you can load them from a CDN (e.g. `https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-role`).

### Attribution

Adapted from the author's ultimatum-game demo in jsPsych#3694 (MIT-licensed). Güth, W., Schmittberger,
R., & Schwarze, B. (1982). An experimental analysis of ultimatum bargaining. _Journal of Economic
Behavior & Organization_, 3(4), 367–388.
