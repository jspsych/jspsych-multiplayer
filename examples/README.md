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
**same** role map from the shared group session — no coordinator, no extra round-trip. Ordering is
by `joinedAt`, a timestamp the role plugin stamps **once, at its own trial's start** (so
near-simultaneously on the clients leaving the lobby together — this is not the moment a client
first connected), with ties broken deterministically by participant id.

Two details in the demo make that ordering trustworthy, and they are worth copying:

1. **The `ready` predicate checks field readiness, not just a head-count.** Supplying a custom
   `ready` _replaces_ the plugin's strategy-derived gate, so a count-only predicate would let each
   client assign the instant it sees the peer's lobby entry — before the peer's `joinedAt` has
   landed. Both clients would then sort the peer's missing timestamp as 0, each conclude the _other_
   is the proposer, and both would wait for an offer until the barriers time out. The demo's
   predicate therefore requires every present entry to carry `joinedAt` (or to be an unmistakably
   mid-game entry, for a spectator arriving during a round).
2. **Every mid-game push spreads `joinedAt` back in.** The sync plugin pushes `push_data` verbatim
   and the JATOS adapter replaces the participant's whole group-session entry, so a bare
   `{ offer }` push would erase `joinedAt`. The demo captures it in `assignRoles`'s `on_finish` and
   includes it in every later push.

With both in place, a spectator who joins mid-game still sees the two players' original timestamps
and computes the same proposer/responder pair, so the pair stays stable as long as client clocks are
reasonably sane (`joinedAt` comes from each client's own clock, so a late joiner with a badly skewed
clock could in principle sort ahead of the original pair).

### Population model

The lobby admits when **at least two** players are present, and the role trial assigns the first two
as the active pair while any later **extra arrival** becomes a `spectator` routed to a "game is full"
screen — so over-enrollment is handled gracefully rather than left waiting. (A stricter "exactly two"
capped variant is possible with the role plugin's `group_size: 2` instead of `overflow_role`; see
`plugin-multiplayer-role`'s own example.) If role assignment itself times out — a peer vanished
between the lobby and the role trial — the role trial ends with no role, and the demo routes that
client to a brief "could not form a group" screen rather than letting it fall off the end of the
timeline onto a blank page.

The other failure open recruitment produces is an active player **leaving mid-game**. Each barrier that
waits on the other player (`proposerWaitTrial`, `responderWaitTrial`) sets a `timeout`; if it elapses,
`on_timeout` flags the partner as gone and the timeline shows a brief "the other player left" screen
instead of hanging forever. The wait barriers that depend only on a player's _own_ data (the lobby, and
the responder confirming its own decision) intentionally have no timeout — indefinite waiting is correct
there (you genuinely want to wait for a partner to arrive). `PARTNER_TIMEOUT_MS` at the top of the file
sets the value; tune it to your population.

One property to be aware of: each client's barrier times out independently, with no "we both agree you're
gone" handshake, so a _false_ timeout produces **divergent** end-states rather than a clean shared exit.
If the responder is still present but takes longer than `PARTNER_TIMEOUT_MS` to decide, the proposer
times out and sees "the other player left" while the responder goes on to complete the round and sees a
normal outcome — the two walk away with contradictory views. The simple guard, if your decisions can run
long, is to keep `PARTNER_TIMEOUT_MS` comfortably generous and/or cap the responder's decision screen with
a `trial_duration` below `PARTNER_TIMEOUT_MS`, so a slow-but-present player is forced to a (timed-out)
choice before they can ever be read as absent. This demo leaves that off by default — it imposes an
auto-advance and a forced decision, which is a behavioral choice better made deliberately than baked in.

### Running it

This example is **illustrative** — it cannot run from a single browser tab today. It requires:

1. a jsPsych core that includes the multiplayer API ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)), not yet in a released `jspsych`;
2. the **JATOS** environment, so the `jatos` global and a group study exist; and
3. at least **two** real participants in the same JATOS group.

The `<script>` tags load the three packages from their built `dist/` in this repo. `dist/` is not
checked in, so build the packages first from the repo root:

```sh
npm install && npm run build
```

Once the packages are published you can load them from a CDN instead
(e.g. `https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-role`).

### Attribution

Adapted from the author's ultimatum-game demo in jsPsych#3694 (MIT-licensed). Güth, W., Schmittberger,
R., & Schwarze, B. (1982). An experimental analysis of ultimatum bargaining. _Journal of Economic
Behavior & Organization_, 3(4), 367–388.
