# Examples

End-to-end demos that compose the multiplayer packages in this repo.

## `chat-room.html`

A real-time **chat room**: participants pick a display name, wait in a lobby until enough people have
joined, then chat in a shared room for a fixed time. It is the demo for the real-time side of the
multiplayer API (`subscribe`), and — because it runs on the local adapter — the one example you can
drive **entirely from two browser tabs**, no server.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local` | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.**   |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — push your name, wait until at least `MIN_PLAYERS` participants are present.         |
| `@jspsych-multiplayer/plugin-multiplayer-chat`   | The room: a continuously-open trial that renders the merged transcript and lets this participant send messages.         |

Two small composition details are worth copying:

1. **Names are published in the lobby and reused by the chat.** The lobby's `push_data` writes
   `{ name, joinedAt }` into the participant's slot. The chat plugin preserves it: when it sends a
   message it reads its own slot and rewrites only the chat key, so `name` stays available. The chat
   trial's `sender_label` then labels each message by name (and this client's own messages as "You",
   by comparing `senderId` against the adapter's `participantId`).
2. **The lobby counts only entries that carry a name.** `wait_for` filters on `entry.name` rather
   than a bare head-count, so a peer still mid-handshake — present in the group session but without a
   published name yet — doesn't tip the room over its threshold before it can be labelled.

### Swapping in a real backend

The demo connects `adapter-multiplayer-local` because it needs no infrastructure. To run a real,
cross-device study, change the one adapter line to `adapter-multiplayer-jatos` (and load `jatos.js` /
wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game.html`). Nothing else in the timeline is
backend-specific — the lobby and chat trials are identical either way.

### Running it

Unlike the JATOS demos, this example needs **no server infrastructure** — but connecting any adapter
still requires the multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694),
which hasn't merged/released yet. Two ways to get that API today:

#### Running it today (pre-#3694): jsDelivr preview build

jsPsych's PR bot publishes a preview build of every commit on #3694, hosted on jsDelivr — no release,
no vendoring #3694's types locally. `chat-room.html` is wired to use it already:

1. Find the current preview link: open [#3694](https://github.com/jspsych/jsPsych/pull/3694), find the
   pinned bot comment titled "📦 Preview build ready," and copy the `jspsych` URL under "All package
   URLs" (plus the matching `jspsych.css` URL). **A SHA-pinned URL like this one keeps loading
   indefinitely — it never 404s.** What it does _not_ track is the still-evolving #3694 API: it stays
   frozen at whatever that commit shipped, so once #3694 moves on, a pin old enough to predate an API
   change can still load fine yet behave wrongly. `chat-room.html`'s `<script>`/`<link>` tags carry the
   SHA that was current when this was last verified; if the demo misbehaves against a newer #3694,
   re-pin to the current preview. Don't commit-and-forget a pinned URL into every example — this one
   recipe, re-run as needed, is the durable fix.

2. Build the multiplayer packages from the repo root (their `dist/` is gitignored, not checked in):

   ```sh
   npm install && npm run build
   ```

   **If a package's `dist/` already exists and you're not sure it's current**, rebuild anyway — a
   stale `dist/` built before a since-merged fix silently reproduces bugs that were already fixed
   upstream (this bit us once: `plugin-multiplayer-chat`'s `dist/` predated its own "make `trial()`
   synchronous" fix by two hours, and the symptom looked like a jsPsych-core race condition rather
   than a stale artifact).

3. Serve the repo over http(s) — **don't** open the file from a `file://` URL, where `localStorage`
   origin behavior varies by browser:

   ```sh
   npx http-server .
   ```

4. Open the printed URL to `examples/chat-room.html` in one tab. On first load the local adapter mints
   a fresh session and writes it into the URL as `?mp_session=…`. **Copy that full URL** (including
   `?mp_session=…`) into a second tab to bring another player into the same room. Opening the bare
   URL again would start a different session.

   The demo constructs the adapter with `persistParticipant: true`, so **refreshing a tab rejoins as
   the same participant** rather than leaving behind a ghost slot that would falsely satisfy the
   lobby's `wait_for`. (Closing a tab clears that tab's `sessionStorage`, and reopening the bare URL
   still starts a fresh session.)

This flow — name entry → lobby → live chat → message delivery across two tabs — was verified
end-to-end with no console errors. That verification predates the lobby `message`-parameter fix in
this change (the custom lobby instructions were previously passed as `prompt`, which the sync plugin
ignores, so they were silently dropped and never displayed), so treat the end-to-end result as
**pending re-verification** after this fix.

#### Running it after #3694 merges

Once #3694 releases, swap `chat-room.html`'s jsPsych `<script>`/`<link>` tags back to the published
`jspsych` package (e.g. `https://unpkg.com/jspsych`) and repeat steps 2–4 above — nothing else in the
timeline changes.

Because the local adapter is same-origin, same-browser, same-machine, this is a development and demo
tool only — not for data collection. For real, multi-participant data use JATOS or another networked
adapter.

## `choice-room.html`

A two-player **Prisoner's Dilemma**: participants pick a display name, wait in a lobby until two
players have joined, then **simultaneously** choose *Cooperate* or *Defect*. The trial barriers until
both have chosen, then reveals **both** choices (choice is attributed, unlike the anonymous vote) and
each player's payoff. Like `chat-room.html` it runs on the local adapter, so it can be driven
**entirely from two browser tabs, no server**.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local` | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.** |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — push your name, wait until `MIN_PLAYERS` participants are present.                |
| `@jspsych-multiplayer/plugin-multiplayer-choice` | The decision: everyone picks, the group barriers until all have chosen, then the attributed choices + payoffs reveal. |

Two composition details worth copying:

1. **`player_label` turns ids into lobby names on the reveal.** The lobby pushes each participant's
   `name`; the choice trial's `player_label` reads it back (`jsPsych.pluginAPI.get(id).name`) so the
   reveal reads "Alice: Cooperate" rather than a raw id, and labels this client "You".
2. **The `payoff` hook scores the round.** It receives `{ participantId: { index, label } }` for
   everyone plus this client's id, and returns this client's points — here, a lookup into the classic
   PD matrix. With no hook, choice stays a pure decision primitive and you derive payoffs from
   `choices_by_player` in `on_finish` instead.

### Swapping in a real backend

Change the one adapter line from `adapter-multiplayer-local` to `adapter-multiplayer-jatos` (and load
`jatos.js` / wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game.html`). Nothing else in the
timeline is backend-specific.

### Running it

Same as [`chat-room.html`](#running-it) — build the packages, serve the repo, and open
`examples/choice-room.html` across two tabs (copy the `?mp_session=…` URL into the second):

```sh
npm install && npm run build
npx http-server .
```

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

### Running it (`ultimatum-game.html`)

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

## `ultimatum-game-local.html`

The same game as `ultimatum-game.html`, wired to `adapter-multiplayer-local` instead of
`adapter-multiplayer-jatos` (and without the `jatos.onLoad` wrapper), so it runs from **two browser
tabs on one machine, no server** — the same local-adapter setup `chat-room.html` uses. Everything
else in the timeline (role assignment, sync barriers, outcome screens) is identical to
`ultimatum-game.html`; see that section above for the full design notes.

Use this file for iterating on the game logic itself. Use `ultimatum-game.html` when you want to test
against a real JATOS deployment.

### Running it

Run it the same way as `chat-room.html`: build the packages, serve the repo over http(s), open the
file in one tab, then copy the full URL (including `?mp_session=…`) into a second tab. See
`chat-room.html`'s "Running it" section above for the jsDelivr preview build and step-by-step details.
