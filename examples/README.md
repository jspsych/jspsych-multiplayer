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
wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game-jatos.html`). Nothing else in the timeline is
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
both have chosen, then reveals **both** choices (attributed — the plugin's default
`reveal_mode: "players"`; contrast with the anonymous tally in `poll-room.html`) and each player's
payoff. Like `chat-room.html` it runs on the local adapter, so it can be driven **entirely from two
browser tabs, no server**.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local` | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.** |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — push your name, wait until `MIN_PLAYERS` participants are present.                |
| `@jspsych-multiplayer/plugin-multiplayer-choice` | The decision: everyone picks, the group barriers until all have chosen, then the attributed choices + payoffs reveal. |

Two composition details worth copying:

1. **`player_label` turns ids into lobby names on the reveal.** The lobby pushes each participant's
   `name`; the choice trial's `player_label` reads it back (`jsPsych.multiplayer.get(id).name`) so the
   reveal reads "Alice: Cooperate" rather than a raw id, and labels this client "You".
2. **The `payoff` hook scores the round.** It receives `{ participantId: { index, label } }` for
   everyone plus this client's id, and returns this client's points — here, a lookup into the classic
   PD matrix. With no hook, choice stays a pure decision primitive and you derive payoffs from
   `choices_by_player` in `on_finish` instead.

### Swapping in a real backend

Change the one adapter line from `adapter-multiplayer-local` to `adapter-multiplayer-jatos` (and load
`jatos.js` / wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game-jatos.html`). Nothing else in the
timeline is backend-specific.

### Running it

Same as [`chat-room.html`](#running-it) — build the packages, serve the repo, and open
`examples/choice-room.html` across two tabs (copy the `?mp_session=…` URL into the second):

```sh
npm install && npm run build
npx http-server .
```

## `poll-room.html`

An **anonymous group poll** built from the same choice plugin as `choice-room.html`, switched to
`reveal_mode: "tally"`: participants pick a display name, wait in a lobby, then vote for a movie
genre. The trial barriers until everyone has voted, then reveals only the **per-option counts and the
plurality winner** (or a tie) — never who voted for what — and `record_choices_by_player: false`
keeps the participant → pick map out of the recorded data too. Note this is **output-level**
anonymity: peers' raw picks still exist in the shared session state (see the plugin README's
Anonymity section). Runs on the local adapter across two browser tabs, no server.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local` | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.** |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — push your name, wait until `EXPECTED_PLAYERS` participants are present.           |
| `@jspsych-multiplayer/plugin-multiplayer-choice` | The ballot in tally mode: everyone picks, the group barriers, then the anonymous tally + winner reveal.                |

### Running it

Same as [`choice-room.html`](#running-it-1) — build the packages, serve the repo, and open
`examples/poll-room.html` across two tabs (copy the `?mp_session=…` URL into the second).

## `countdown-timer.html`

A **synchronized group timer**: participants wait in a lobby until enough have joined, then see the
same countdown ending at (approximately) the same moment for everyone, followed by a hard barrier
before the results screen. Like `chat-room.html` it runs on the local adapter, so you can drive it
**entirely from two browser tabs**, no server.

### What it demonstrates

| Package                                             | Role in the demo                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local`    | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.** |
| `@jspsych-multiplayer/plugin-multiplayer-sync`      | Two declarative barriers: the lobby before the timer, and a "wait for everyone to finish" barrier after it.           |
| `@jspsych-multiplayer/plugin-multiplayer-countdown` | The shared timer: every client derives the same remaining time from the minimum start timestamp across all slots.     |

The composition detail worth copying is the **barrier sandwich**:

1. **A barrier before** the countdown makes every client resolve the consensus start at nearly the
   same instant, so the timer is already converged when it appears (no visible downward step as later
   timestamps arrive).
2. **A barrier after** it holds everyone at the line before the results screen, because the countdown
   is _not itself a barrier_ — clients end within clock skew + latency, not exactly together. The
   wrap-up screen reads back `own_started_at − started_at` to show this client's entry skew.

### Running it

Run it the same way as `chat-room.html`: build the packages, serve the repo over http(s), open the
printed URL in one tab, then a second tab with the same `?mp_session=` in the URL. See
`chat-room.html`'s "Running it" section above for the jsDelivr preview build and step-by-step details.

## `public-goods-local.html`

A **timed public-goods game**: two players each hold an endowment and, in a single time-boxed round,
_simultaneously_ decide how much to contribute to a common pool that is multiplied and split equally.
It is the econ-game companion to `countdown-timer.html`, and the showcase for a **synchronized
contribution deadline** — the contribution buttons are a plain `html-button-response`, with a shared
countdown drawn on top of them.

### What it demonstrates

| Package                                             | Role in the demo                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local`    | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.**            |
| `@jspsych-multiplayer/plugin-multiplayer-sync`      | The lobby, and the "wait for both contributions" barrier, each one declarative push-then-wait.                                   |
| `@jspsych-multiplayer/plugin-multiplayer-countdown` | Used through its **exported statics** (`startedAtKey` / `resolveStartedAt` / `computeRemaining` / `formatTime`), not as a trial. |

This is the countdown plugin's flagship **"render a synced timer during another trial"** use. The contribution trial resolves the group's
consensus start (the minimum start timestamp across all slots) on a 100 ms interval and paints the
same remaining time into both tabs, so the window closes together within skew + latency. A public-
goods game fits the countdown because its pacing is _duration-bound_ (everyone acts within one
window), unlike the turn-based ultimatum game.

### Running it

Run it the same way as `chat-room.html`: build the packages, serve the repo over http(s), open the
printed URL in one tab, then a second tab with the same `?mp_session=` in the URL. See
`chat-room.html`'s "Running it" section above for the jsDelivr preview build and step-by-step details.

## `draw-room.html`

A real-time **collaborative drawing canvas**: participants wait in a lobby until enough have joined,
then draw together on one shared canvas for a synced, time-boxed round. Unlike `chat-room.html`,
participants are never asked for a display name — strokes aren't attributed by name anywhere in the
UI, so the roster labels players by join order ("Player 1", "Player 2", …) instead. It is the
highest-rate demo of the multiplayer API's `subscribe` primitive (continuous, throttled pushes while a
stroke is active, vs. `chat-room.html`'s one push per message), and the flagship demo for the countdown
plugin's **"render a synced timer during another trial"** use — the same core `public-goods-local.html`
uses for its contribution window, drawn on top of a plugin (`plugin-multiplayer-draw`) instead of a
core jsPsych plugin. Like `chat-room.html` it runs on the local adapter, so you can drive it **entirely
from two browser tabs**, no server.

### What it demonstrates

| Package                                             | Role in the demo                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local`    | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.**            |
| `@jspsych-multiplayer/plugin-multiplayer-sync`      | The lobby: push a join timestamp, wait until at least `MIN_PLAYERS` are present.                                                 |
| `@jspsych-multiplayer/plugin-multiplayer-draw`      | The shared canvas: pen/eraser, colors, brush sizes, and an undo that only ever removes this participant's own last stroke.       |
| `@jspsych-multiplayer/plugin-multiplayer-countdown` | Used through its **exported statics** (`startedAtKey` / `resolveStartedAt` / `computeRemaining` / `formatTime`), not as a trial. |

The composition detail worth copying: the draw plugin's own `duration` parameter is a per-client
`setTimeout` with no cross-tab agreement on _when_ it started, so two tabs opened moments apart would
see different end times. This demo skips that parameter entirely and instead renders the countdown
plugin's consensus clock into the draw trial's `prompt` on `on_load`, using the same "read own slot →
spread → push, keep-if-present" pattern the countdown plugin itself uses internally. When the synced
clock reaches zero, the client auto-clicks its own "I'm done" button rather than ending the trial
directly — the room closes for everyone through the same `end_when` "wait for everyone's `draw_done`
flag" mechanism a manual click uses, so a clock-driven end and a manual end are indistinguishable to
the rest of the group.

### Running it

Run it the same way as `chat-room.html`: build the packages, serve the repo over http(s), open the
printed URL in one tab, then a second tab with the same `?mp_session=` in the URL. See
`chat-room.html`'s "Running it" section above for the jsDelivr preview build and step-by-step details.

## `scoreboard-room.html`

An **end-of-game scoreboard**: participants pick a display name, wait in a lobby, each answers a short
quiz for points, then hit a board that **waits (a barrier) until everyone has reported** and reveals
the final ranking all at once — so no one sees a partial board. Like `chat-room.html` it runs on the
local adapter, so it can be driven **entirely from two browser tabs, no server**.

### What it demonstrates

| Package                                              | Role in the demo                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local`     | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.** |
| `@jspsych-multiplayer/plugin-multiplayer-sync`       | The lobby: one declarative barrier — push your name, wait until `MIN_PLAYERS` participants are present.                |
| `@jspsych-multiplayer/plugin-multiplayer-scoreboard` | The end board: pushes this client's final score, barriers on `group_size` reporters, then reveals the ranking.        |

Two composition details worth copying:

1. **`score` is auto-computed from prior data, never typed in.** Each quiz question tags its trial with
   `points` in `on_finish`; the board's `score: () => jsPsych.data.get().select("points").sum()` sums
   them at trial start.
2. **`group_size` makes it a barrier.** It waits until that many players have reported before
   revealing, so everyone sees a complete ranking at once. The demo reads it dynamically from the
   players who made it through the lobby.

Contrast with `live-scoreboard-room.html`, which renders the standings **live** from the same pure
ranking core (via `jsPsych.multiplayer.subscribe`) as peers report, rather than revealing once at the end.

### Swapping in a real backend

Change the one adapter line from `adapter-multiplayer-local` to `adapter-multiplayer-jatos` (and load
`jatos.js` / wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game-jatos.html`). Nothing else in the
timeline is backend-specific.

### Running it

Same as [`chat-room.html`](#running-it) — build the packages, serve the repo, and open
`examples/scoreboard-room.html` across two tabs (copy the `?mp_session=…` URL into the second):

```sh
npm install && npm run build
npx http-server .
```

## `live-scoreboard-room.html`

The **live** counterpart to `scoreboard-room.html`: the same name → lobby → quiz game, but a
standings panel stays on screen through the whole quiz and **fills in and re-ranks in real time** as
each player's running score arrives — no barrier, no one-shot reveal. There is no separate plugin for
this: the panel is rendered directly from `plugin-multiplayer-scoreboard`'s exported pure core
(`buildLeaderboard`) inside a `jsPsych.multiplayer.subscribe` callback, the same
"use the statics during another trial" pattern as `public-goods-local.html`'s countdown overlay.

### What it demonstrates

| Package                                              | Role in the demo                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local`     | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.** |
| `@jspsych-multiplayer/plugin-multiplayer-sync`       | The lobby: one declarative barrier — push your name, wait until `EXPECTED_PLAYERS` participants are present.           |
| `@jspsych-multiplayer/plugin-multiplayer-scoreboard` | Used through its **exported statics** (`buildLeaderboard`), not as a trial — the panel re-ranks every update.          |

Two composition details worth copying:

1. **Each answer pushes the running total.** Every quiz question's `on_finish` reads this client's own
   slot, spreads it, and pushes `score: { score: total, label: name }` — so peers' panels update the
   moment anyone answers, and the lobby-pushed `name` survives (`push` replaces the whole slot).
2. **The panel lives outside the jsPsych display element.** jsPsych wipes the display every trial, so
   the standings panel is appended to `document.body` and driven by one `subscribe` registration —
   registered after `connect()`, unsubscribed when the game ends. Peer labels are escaped before
   rendering (they are peer-pushed text).

### Running it

Same as [`scoreboard-room.html`](#running-it) — build the packages, serve the repo, and open
`examples/live-scoreboard-room.html` across two tabs (copy the `?mp_session=…` URL into the second).

## `match-room.html`

A **"pair up, then play"** demo: participants pick a display name, wait in a lobby, then get
partitioned into **pairs** by deterministic consensus, are shown who they're matched with, and play
one round of Prisoner's Dilemma with their partner. Like `chat-room.html` it runs on the local
adapter, so it can be driven **entirely from browser tabs, no server**.

> **Designed for a fixed number of players.** `EXPECTED_PLAYERS` (top of the file) defaults to **4** —
> so **open exactly 4 tabs** and you get **2 pairs**, each playing its own round. The first screen
> states this up front. The count is a fixed integer, not a live head-count: `expected_players` must be
> the *same exact value on every client* for the plugin to reach consensus, so all tabs partition the
> identical set of players. A live "count whoever's here now" value lets tabs that reach the matching
> step at different moments disagree on the group and compute divergent pairings.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local` | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.** |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — push your name, wait until `EXPECTED_PLAYERS` participants are present.           |
| `@jspsych-multiplayer/plugin-multiplayer-match`  | The matchmaker: partitions the group into pairs; exposes this client's partners via `getMyMatch()`.                   |
| `@jspsych-multiplayer/plugin-multiplayer-choice` | The round: each pair plays a Prisoner's Dilemma, keyed **per pair**.                                                   |

`match` is the odd primitive out: it has **no UI of its own** — it's a short barrier that just
resolves "who is with whom". This demo shows its value by *using* that result, which is exactly how
`match` is meant to compose. Two details worth copying:

1. **The paired round is namespaced per pair.** `choice`'s `data_key` is derived from the pair's
   members (`"pd_" + members.sort().join("_")`) so two pairs keep separate ballots, and its
   `expected_players` is the pair size, so the barrier lifts once *both partners* have chosen — not
   the whole room.
2. **Spectators are handled with a `conditional_function`.** With an odd number of players,
   `leftover: "spectator"` leaves the extra unmatched (`getMyMatch()` is undefined); the game node's
   `conditional_function` skips the round for them.

### Swapping in a real backend

Change the one adapter line from `adapter-multiplayer-local` to `adapter-multiplayer-jatos` (and load
`jatos.js` / wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game-jatos.html`). Nothing else in the
timeline is backend-specific.

### Running it

Same as [`chat-room.html`](#running-it) — build the packages, serve the repo, and open
`examples/match-room.html` across **4 tabs** (copy the `?mp_session=…` URL into each new one):

```sh
npm install && npm run build
npx http-server .
```

## `ultimatum-game-jatos.html`

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

### Running it (`ultimatum-game-jatos.html`)

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

To get it into JATOS, package it as an importable study archive:

```sh
npm run build:jatos:ultimatum      # → dist/ultimatum-jatos.jzip
```

This flattens the assets (resolving the CDN `<script src>` above to their installed node_modules
copies, since a JATOS study has to be self-contained), writes the `.jas` metadata with
`groupStudy: true`, and zips the result. The batch is left **uncapped** on purpose: this demo's
population model admits extra arrivals as `spectator`s (see above), which a two-member cap would
make unreachable. Note the archive carries the same #3694 caveat as the example — the bundled
jsPsych core is a published release, so the study imports cleanly but fails at `connect()` until
#3694 ships.

### Attribution

Adapted from the author's ultimatum-game demo in jsPsych#3694 (MIT-licensed). Güth, W., Schmittberger,
R., & Schwarze, B. (1982). An experimental analysis of ultimatum bargaining. _Journal of Economic
Behavior & Organization_, 3(4), 367–388.

## `group-quiz/`

A live, Kahoot-style **group quiz**. Everyone opens **one** URL; one person clicks **Host** (the
presenter screen — the big screen the room watches), everyone else clicks **Player** (their phone).
The host drives the game forward question by question while players answer against a clock, score by
speed, and see their rank between questions.

It is the repo's demo of the **asymmetric** pattern — one authoritative driver plus many followers —
and the counterpart to `ultimatum-game-jatos.html`, where every client runs the same timeline and
coordination is by deterministic consensus. The host half is **not a jsPsych timeline at all**: it's
vanilla JS driving the adapter directly, because a presenter screen reacts continuously rather than
advancing through trials.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-jatos` | The network backend — JATOS group session + channel. Used **two ways**: through the multiplayer API by players, and **directly** (`connect`/`push`/`subscribe`/`getAll`) by the host page. |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | Every one of the player's four "wait for the host to advance" points is a single declarative barrier trial.                |

The composition detail worth copying is the **monotonic step counter**. The host advances by
overwriting its `phase` field, and JATOS doesn't guarantee a client observes every intermediate
snapshot — so the obvious barrier, `wait_for: g => g[hostId]?.phase === "reveal"`, **deadlocks**: a
lagging player whose snapshot jumps straight from `question` to `leaderboard` is left with a
permanently unsatisfiable condition and hangs forever. Every host push therefore also carries a
`step` that only ever increases, and players wait on `hostStepValue(group) >= phaseStep(…)`. A `>=`
test against a monotonic value can never be missed — once true it stays true. Generalized: **on a
snapshot-based transport, barrier predicates must be monotone.** "State currently equals X" is a
latent deadlock; "state has reached at least X" is not.

`questions.js` holds the answer key, and the protocol keeps correctness a **host** decision — players
push only their `choice`, and the host publishes `correctChoice` at reveal. The demo does load the key
on both roles (one file serves both), so a player can read it in devtools; for anything scored for
real, serve it host-only. Full design notes, including why this demo hand-rolls its leaderboard,
timer, and answer buttons instead of composing the scoreboard/countdown/choice plugins, are in
[`docs/group-quiz-design.md`](../docs/group-quiz-design.md).

### Running it

Like `ultimatum-game-jatos.html`, this example is **illustrative** — it cannot run from a single
browser tab today. It requires:

1. a jsPsych core that includes the multiplayer API ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)), not yet in a released `jspsych`;
2. the **JATOS** environment, so the `jatos` global and a group study exist; and
3. at least **two** real participants in one JATOS group — one Host plus one or more Players.

Build the multiplayer packages first (`dist/` is gitignored), then package the study for upload:

```sh
npm install && npm run build
npm run build:jatos:group-quiz     # → dist/group-quiz-jatos.jzip
```

Import the `.jzip` into JATOS and share the single study link with the room.

### Known limitations

The player's mid-game barriers have **no timeout**, so a host who closes the presenter screen leaves
every player hanging; group size at real audience scale (~20+ phones on one JATOS group session) is
**untested**; and there is no host election or late-joiner catch-up. See the design doc for details
and the mechanical fix for each.

## `ultimatum-game-local.html`

The same game as `ultimatum-game-jatos.html`, wired to `adapter-multiplayer-local` instead of
`adapter-multiplayer-jatos` (and without the `jatos.onLoad` wrapper), so it runs from **two browser
tabs on one machine, no server** — the same local-adapter setup `chat-room.html` uses. Everything
else in the timeline (role assignment, sync barriers, outcome screens) is identical to
`ultimatum-game-jatos.html`; see that section above for the full design notes.

Use this file for iterating on the game logic itself. Use `ultimatum-game-jatos.html` when you want to test
against a real JATOS deployment.

### Running it

Run it the same way as `chat-room.html`: build the packages, serve the repo over http(s), open the
file in one tab, then copy the full URL (including `?mp_session=…`) into a second tab. See
`chat-room.html`'s "Running it" section above for the jsDelivr preview build and step-by-step details.

## `ultimatum-game-firebase.html`

The same game as `ultimatum-game-jatos.html`, wired to `adapter-multiplayer-firebase`, so it runs
across **separate devices, browsers, and machines** with only a free Firebase project — real
cross-device multiplayer, no server to host. Everything in the timeline is identical to the other two
variants; only the network backend changes.

Unlike the other examples, the Firebase adapter is loaded as an **ES module** (its browser build
externalizes the Firebase SDK), so the page uses an `<script type="importmap">` that resolves the
adapter's `firebase/*` imports to Firebase's modular CDN. The two multiplayer plugins and jsPsych core
are still ordinary IIFE `<script>` tags.

### Running it

Two ways, both documented in the file's header comment:

- **A real Firebase project** (real data collection): create a project, enable Anonymous auth, create a
  Realtime Database, paste the recommended session-locked rules and your web-app config (see
  [`adapter-multiplayer-firebase`'s README](../packages/adapter-multiplayer-firebase/README.md)), then
  serve the repo and open the page on two devices/tabs sharing the `?mp_session=…` URL.
- **The local Firebase Emulator** (no account, no credentials): `firebase emulators:start` (database +
  auth), then open the page with `?emulator` in the query string — it points the adapter at the
  emulator so a two-tab run works entirely offline.

The adapter itself is verified end-to-end against the RTDB + Auth emulators (anonymous sign-in, the
onValue mirror, cross-client visibility, exact JSON round-trip, and slot cleanup on disconnect).

## `reference-game.html`

A repeated **referential communication game** ("tangrams"; Hawkins, Frank & Goodman, 2020) built on
`plugin-multiplayer-reference-game`. Two players are paired as a fixed **director** and **matcher**;
both see the same twelve abstract shapes, each in an independently scrambled layout, and only the
director sees which shape is the round's **target**. They talk over the built-in chat, the matcher
**clicks** the target, and both see feedback — repeated over several rounds so the same targets recur.

### What it demonstrates

Composing four packages into one experiment with almost no bespoke networking:
`adapter-multiplayer-local` (two-tab backend), `plugin-multiplayer-sync` (lobby),
`plugin-multiplayer-role` (director/matcher), and `plugin-multiplayer-reference-game` (the game
trial, one per round via `timeline_variables`). The shapes are inline SVG, so there are no external
assets. This is the **sequential** condition (one target ⇒ a single click).

### Running it

Same as `chat-room.html`: build the packages, serve the repo over http(s), open the file in one tab,
then copy the full URL (including `?mp_session=…`) into a second tab so a second player joins. The
first tab becomes the director, the second the matcher.

## `reference-game-match.html`

The **same plugin** as `reference-game.html`, configured for the **full-board match** ("unconstrained")
condition: every object is an ordered **target**, so the director's board shows numbered slot badges
and the matcher reproduces that order by assigning each shape to a slot, then submitting for a score
out of N. Shows that "sequential" and "unconstrained" are one plugin with `targets` turned from
length-1 to length-N. Run it the same two-tab way.
