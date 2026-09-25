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
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — mark yourself as here, wait until at least `MIN_PLAYERS` participants are.         |
| `@jspsych-multiplayer/plugin-multiplayer-chat`   | The room: a continuously-open trial that renders the merged transcript and lets this participant send messages.         |

Three small composition details are worth copying:

1. **Names are written to the session scope and reused by the chat.** During a trial, reads and
   writes default to that trial's own part of the shared data, which the next trial can't see. So
   the name trial's `on_finish` writes the name with
   `jsPsych.multiplayer.update({ name }, { scope: "session" })`, and the chat trial's `sender_label`
   reads it back with `jsPsych.multiplayer.get(senderId, { scope: "session" })` (labelling this
   client's own messages "You", by comparing `senderId` against `jsPsych.multiplayer.participantId`).
2. **The lobby counts connected participants who reached it.** The lobby's `write_data: { here: true }`
   goes to the lobby trial's own data, which is what `wait_for` sees. `wait_for` receives presence as
   its second argument and counts participants who are `connected` and wrote `here`. Counting entries
   alone would be wrong: data stays after its participant leaves. The lobby also sets
   `participants: []`, so someone leaving means waiting longer rather than ending the lobby with
   `multiplayer_outcome: "participant_left"`. Every link-based lobby in these examples follows the
   same pattern; where the backend forms the groups (JATOS, Firebase matchmaking), wait with
   `jsPsych.multiplayer.waitForGroup()` instead, as `ultimatum-game-jatos.html` does.
3. **Connecting can fail, and a reloaded tab can't rejoin.** The `connect()` call has a `.catch` that
   shows a message instead of a blank page, and the page checks `jsPsych.multiplayer.restarted`
   before running the timeline (see "Running it" below). Every example does both.

### Swapping in a real backend

The demo connects `adapter-multiplayer-local` because it needs no infrastructure. To run a real,
cross-device study, change the one adapter line to `adapter-multiplayer-jatos` (and load `jatos.js` /
wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game-jatos.html`). JATOS forms the groups
itself, so the link-based lobby can become `await jsPsych.multiplayer.waitForGroup()` before
`jsPsych.run`, as in that file. Nothing else in the timeline is backend-specific — the chat trial is
identical either way.

### Running it

Unlike the JATOS demos, this example needs **no server infrastructure** — but connecting any adapter
still requires the multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694),
which isn't in a jsPsych release yet.

#### Running it today: the #3694 preview build

jsPsych's PR bot publishes a preview build of every commit on #3694 to the `preview/pr-3694` branch.
This repo uses one preview build in two places, and the two must match:

- **The examples** load it from jsDelivr. Every example's `<script>`/`<link>` tags carry the same
  pinned commit SHA. A pinned URL keeps loading indefinitely, but it stays frozen at whatever that
  commit shipped.
- **The packages' builds and tests** use a copy in `vendor/jspsych`, which the root `jspsych`
  devDependency points at. The JATOS archive scripts bundle this copy too.

When #3694's API changes, update both together:

1. Open [#3694](https://github.com/jspsych/jsPsych/pull/3694), find the bot comment titled
   "📦 Preview build ready," and note the full SHA of the preview commit it links to.
2. Run `npm run vendor-jspsych <sha>` and then `npm install` to refresh `vendor/jspsych`.
3. Replace the old SHA with the new one across `examples/` and `docs/`.

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

   **A refreshed tab can't rejoin.** The local adapter keeps the tab's participant ID across a
   refresh (`persistParticipant` defaults to `true`), but a page that reloads has restarted its
   experiment, so the group counts it as having left (see "Rejoining" in the dropouts guide). The
   page sees `jsPsych.multiplayer.restarted === true` and shows a "you can't rejoin" message
   instead of starting over. The adapter tracks presence itself, so the other tabs see a closed tab
   as `left` without any unload handler in the page.

The examples were updated for the 1.0 API (trial scopes, `multiplayer_outcome`, `restarted`) and
have not yet been re-verified end to end in a browser since.

#### Running it after jsPsych releases the API

Once a jsPsych release includes the multiplayer API, swap the examples' jsPsych `<script>`/`<link>`
tags back to the published `jspsych` package (e.g. `https://unpkg.com/jspsych`), point the root
`jspsych` devDependency back at npm, and delete `vendor/`. Nothing else in the timelines changes.

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
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — mark yourself as here, wait until `EXPECTED_PLAYERS` participants are.            |
| `@jspsych-multiplayer/plugin-multiplayer-choice` | The decision: everyone picks, the group barriers until all have chosen, then the attributed choices + payoffs reveal. |

Two composition details worth copying:

1. **`player_label` turns ids into names on the reveal.** The name trial writes each participant's
   `name` to the session scope; the choice trial's `player_label` reads it back
   (`jsPsych.multiplayer.get(id, { scope: "session" })?.name`) so the reveal reads "Alice: Cooperate"
   rather than a raw id, and labels this client "You".
2. **The `payoff` hook scores the round.** It receives `{ participantId: { index, label } }` for
   everyone plus this client's id, and returns this client's points — here, a lookup into the classic
   PD matrix. With no hook, choice stays a pure decision primitive and you derive payoffs from
   `choices_by_player` in `on_finish` instead.

### Swapping in a real backend

Change the one adapter line from `adapter-multiplayer-local` to `adapter-multiplayer-jatos` (and load
`jatos.js` / wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game-jatos.html`). JATOS forms the
groups itself, so the link-based lobby can become `await jsPsych.multiplayer.waitForGroup()` before
`jsPsych.run`, as in that file. Nothing else in the timeline is backend-specific.

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
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — mark yourself as here, wait until `EXPECTED_PLAYERS` participants are.            |
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
| `@jspsych-multiplayer/plugin-multiplayer-countdown` | The shared timer: every client derives the same remaining time from the earliest start timestamp any client wrote.   |

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
| `@jspsych-multiplayer/plugin-multiplayer-sync`      | The lobby, and the "wait for both contributions" barrier, each one declarative write-then-wait.                      |
| `@jspsych-multiplayer/plugin-multiplayer-countdown` | Used through its **exported statics** (`resolveStartedAt` / `computeRemaining` / `formatTime`), not as a trial.      |

This is the countdown plugin's flagship **"render a synced timer during another trial"** use. The
contribution trial writes its start time to its own part of the shared data, resolves the group's
consensus start (the earliest start timestamp any player wrote) on a 100 ms interval, and paints the
same remaining time into both tabs, so the window closes together within skew + latency. A public-
goods game fits the countdown because its pacing is _duration-bound_ (everyone acts within one
window), unlike the turn-based ultimatum game.

The "wait for both contributions" barrier sets `save_group: true`, so the contributions it waited
for are saved in its jsPsych data; the reveal screen reads them from there
(`jsPsych.data.get().filter({ trial_type: "multiplayer-sync" })`), since the barrier's shared data
belongs to its own trial.

### Running it

Run it the same way as `chat-room.html`: build the packages, serve the repo over http(s), open the
printed URL in one tab, then a second tab with the same `?mp_session=` in the URL. See
`chat-room.html`'s "Running it" section above for the jsDelivr preview build and step-by-step details.

## `draw-room.html`

A real-time **collaborative drawing canvas**: participants wait in a lobby until enough have joined,
then draw together on one shared canvas for a synced, time-boxed round. Unlike `chat-room.html`,
participants are never asked for a display name — strokes aren't attributed by name anywhere in the
UI, so the roster labels players by join order ("Player 1", "Player 2", …) instead. It is the
highest-rate demo of the multiplayer API's `subscribe` primitive (continuous, throttled writes while a
stroke is active, vs. `chat-room.html`'s one write per message), and the flagship demo for the countdown
plugin's **"render a synced timer during another trial"** use — the same core `public-goods-local.html`
uses for its contribution window, drawn on top of a plugin (`plugin-multiplayer-draw`) instead of a
core jsPsych plugin. Like `chat-room.html` it runs on the local adapter, so you can drive it **entirely
from two browser tabs**, no server.

### What it demonstrates

| Package                                             | Role in the demo                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local`    | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.**            |
| `@jspsych-multiplayer/plugin-multiplayer-sync`      | The lobby: mark yourself as here, wait until at least `MIN_PLAYERS` are.                                                   |
| `@jspsych-multiplayer/plugin-multiplayer-draw`      | The shared canvas: pen/eraser, colors, brush sizes, and an undo that only ever removes this participant's own last stroke. |
| `@jspsych-multiplayer/plugin-multiplayer-countdown` | Used through its **exported statics** (`resolveStartedAt` / `computeRemaining` / `formatTime`), not as a trial.            |

The composition detail worth copying: the draw plugin's own `duration` parameter is a per-client
`setTimeout` with no cross-tab agreement on _when_ it started, so two tabs opened moments apart would
see different end times. This demo skips that parameter entirely and instead renders the countdown
plugin's consensus clock into the draw trial's `prompt` on `on_load`: each client writes its start
time to the draw trial's own data, as the countdown plugin itself does, and the clock counts from the
earliest one. The "Player N" labels come from a `joinedAt` time each client writes to the session
scope when it connects, so the draw trial can read it. When the synced
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
| `@jspsych-multiplayer/plugin-multiplayer-sync`       | The lobby: one declarative barrier — mark yourself as here, wait until `EXPECTED_PLAYERS` participants are.            |
| `@jspsych-multiplayer/plugin-multiplayer-scoreboard` | The end board: writes this client's final score, barriers on `group_size` reporters, then reveals the ranking.        |

Two composition details worth copying:

1. **`score` is auto-computed from prior data, never typed in.** Each quiz question tags its trial with
   `points` in `on_finish`; the board's `score: () => jsPsych.data.get().select("points").sum()` sums
   them at trial start.
2. **`group_size` makes it a barrier.** It waits until that many players have reported before
   revealing, so everyone sees a complete ranking at once. It's the fixed `EXPECTED_PLAYERS`, the same
   integer on every client.

Contrast with `live-scoreboard-room.html`, which renders the standings **live** from the same pure
ranking core (via `jsPsych.multiplayer.subscribe`) as peers report, rather than revealing once at the end.

### Swapping in a real backend

Change the one adapter line from `adapter-multiplayer-local` to `adapter-multiplayer-jatos` (and load
`jatos.js` / wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game-jatos.html`). JATOS forms the
groups itself, so the link-based lobby can become `await jsPsych.multiplayer.waitForGroup()` before
`jsPsych.run`, as in that file. Nothing else in the timeline is backend-specific.

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
| `@jspsych-multiplayer/plugin-multiplayer-sync`       | The lobby: one declarative barrier — mark yourself as here, wait until `EXPECTED_PLAYERS` participants are.            |
| `@jspsych-multiplayer/plugin-multiplayer-scoreboard` | Used through its **exported statics** (`buildLeaderboard`), not as a trial — the panel re-ranks every update.          |

Two composition details worth copying:

1. **Each answer writes the running total to the session scope.** Every quiz question's `on_finish`
   calls `jsPsych.multiplayer.update({ score: { score: total, label: name } }, { scope: "session" })`
   — so peers' panels update the moment anyone answers. The scores have to outlive each quiz trial,
   which is what the session scope is for; `update()` merges only the `score` key.
2. **The panel lives outside the jsPsych display element.** jsPsych wipes the display every trial, so
   the standings panel is appended to `document.body` and driven by one
   `subscribe(render, { scope: "session" })` registration — made when the lobby ends, unsubscribed
   when the game ends. A session-scope subscription outlives the trial that made it (a trial-scope
   one would end with that trial). Peer labels are escaped before rendering (they are peer-written
   text).

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
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — mark yourself as here, wait until `EXPECTED_PLAYERS` participants are.            |
| `@jspsych-multiplayer/plugin-multiplayer-match`  | The matchmaker: partitions the group into pairs; exposes this client's partners via `getMyMatch()`.                   |
| `@jspsych-multiplayer/plugin-multiplayer-choice` | The round: each pair plays a Prisoner's Dilemma in its own **per-pair** scope.                                        |

`match` is the odd primitive out: it has **no UI of its own** — it's a short barrier that just
resolves "who is with whom". This demo shows its value by *using* that result, which is exactly how
`match` is meant to compose. Two details worth copying:

1. **The paired round is scoped per pair.** The choice trial's `multiplayer_scope` is derived from the
   pair's members (`"pd_" + members.sort().join("_")`), so two pairs keep separate ballots, its
   `expected_players` is the pair size, so the barrier lifts once *both partners* have chosen — not
   the whole room — and its `participants` is the partner, so a player leaving another pair doesn't
   end this one.
2. **Spectators are handled with a `conditional_function`.** With an odd number of players,
   `leftover: "spectator"` leaves the extra unmatched (`getMyMatch()` is undefined); the game node's
   `conditional_function` skips the round for them.

### Swapping in a real backend

Change the one adapter line from `adapter-multiplayer-local` to `adapter-multiplayer-jatos` (and load
`jatos.js` / wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game-jatos.html`). JATOS forms the
groups itself, so the link-based lobby can become `await jsPsych.multiplayer.waitForGroup()` before
`jsPsych.run`, as in that file. Nothing else in the timeline is backend-specific.

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

| Package                                          | Role in the demo                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-jatos` | The network backend — JATOS group session + channel. JATOS forms groups of two, and the adapter seals each one once it is full. |
| `@jspsych-multiplayer/plugin-multiplayer-role`   | Assigns proposer/responder by **deterministic consensus**.                                                                        |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | Each "wait for the other player" point — the offer, the decision — is a single declarative barrier trial.                       |

**No lobby trial.** JATOS puts each arriving participant in a group with room, and the study's batch
caps groups at two active members (`maxActiveMembers: 2`, set by `build:jatos:ultimatum`). The
adapter seals (fixes) the group once it is full, so the page shows "Waiting for another player…" and
waits with `await jsPsych.multiplayer.waitForGroup({ timeout })` before `jsPsych.run`. A third arrival
starts a new group instead of joining a game in progress, and the plugins' defaults follow the sealed
group: the role trial waits for both members, and each barrier depends on the other member.

The key rewrite: an earlier version assigned roles by hand in the lobby's `on_finish` (sort the
participant ids, take the first two as proposer/responder). That block is now a single
`plugin-multiplayer-role` trial. Every client independently computes the **same** role map — no
coordinator, no extra round-trip. Ordering is by `joinedAt`, a timestamp the role plugin writes
**once**, to the session scope of the shared data, at its own trial's start (this is not the moment a
client first connected), with ties broken deterministically by participant id.

**The offer and decision share one named scope.** During a trial, reads and writes default to that
trial's own part of the shared data, so the responder's "wait for the offer" trial would never see
what the proposer's trial wrote. The three exchange trials (`proposerWaitTrial`, `responderWaitTrial`,
`responderSendDecisionTrial`) therefore all set `multiplayer_scope: "offer_exchange"`: they read and
write one shared part of the data. Each barrier sets `save_group: true`, so its `on_finish` reads the
other player's offer or decision from the trial's `group` data field.

### Dropouts

If the other player **leaves mid-game**, the barrier waiting on them (`proposerWaitTrial`,
`responderWaitTrial`) ends. The adapter reports who is connected; once the partner has been
disconnected for longer than the dropout timeout (10 s by default), they count as `left`, the barrier
ends with `multiplayer_outcome: "participant_left"`, and the timeline shows a brief "the other player
left" screen instead of hanging forever. A lost connection on this client's side ends the barrier with
`multiplayer_outcome: "connection_lost"` and takes the same route. If the role trial ends without
roles (the partner left before it could assign them), the demo routes that client to a brief "could
not form a group" screen rather than letting it fall off the end of the timeline onto a blank page.

A participant who reloads the page keeps their ID but has restarted their experiment, so the group
counts them as left; their page sees `jsPsych.multiplayer.restarted === true` and shows a "you can't
rejoin" screen. A failed `connect()`, or no partner arriving before the `waitForGroup()` timeout,
shows a message too.

Each mid-game barrier also keeps a `timeout` (`PARTNER_TIMEOUT_MS` at the top of the file) as a backstop
for a partner who stays connected but never acts. That backstop decides alone, with no "we both agree
you're gone" handshake. If the responder is still present but takes longer than `PARTNER_TIMEOUT_MS` to
decide, the proposer times out and sees "the other player left" while the responder goes on to complete
the round and sees a normal outcome — the two walk away with contradictory views. The simple guard, if your decisions can run
long, is to keep `PARTNER_TIMEOUT_MS` comfortably generous and/or cap the responder's decision screen with
a `trial_duration` below `PARTNER_TIMEOUT_MS`, so a slow-but-present player is forced to a (timed-out)
choice before they can ever be read as absent. This demo leaves that off by default — it imposes an
auto-advance and a forced decision, which is a behavioral choice better made deliberately than baked in.

### Running it (`ultimatum-game-jatos.html`)

This example is **illustrative** — it cannot run from a single browser tab today. It requires:

1. a jsPsych core that includes the multiplayer API ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)), not yet in a released `jspsych`;
2. the **JATOS** environment, so the `jatos` global and a group study exist; and
3. at least **two** real participants (JATOS groups them in twos).

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
`groupStudy: true` and a batch capped at two active members per group (see above), and zips the
result. If you import the study some other way, set the batch's max active members to 2 yourself:
without a cap, no group ever counts as full, so none is sealed and `waitForGroup()` waits until its
timeout. The archive bundles the repo's jsPsych core, which is the vendored #3694 preview
build (see `chat-room.html`'s "Running it" section), so the study runs against the same API as the
examples.

Two packaging gotchas (they apply to `build:jatos:group-quiz` too):

- On macOS/Linux the script shells out to the `zip` CLI, so it must be on your `PATH` (it is
  preinstalled on macOS and most Linux distributions). On Windows no `zip` binary is needed —
  the script uses PowerShell instead.
- Every build generates **fresh** JATOS study/component UUIDs, so re-importing a rebuilt archive
  creates a **new** study in JATOS rather than updating the one you imported before.

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
vanilla JS calling `jsPsych.multiplayer` without running a timeline, because a presenter screen
reacts continuously rather than advancing through trials.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-jatos` | The network backend — JATOS group session + channel. The players use it from a jsPsych timeline; the host page calls `jsPsych.multiplayer` (`connect`/`update`/`subscribe`) with no timeline. |

Everything both roles share lives in the **session scope** of the shared data. The host runs no
trials, so its writes go there by default; the players pass `{ scope: "session" }` on every protocol
read and write, since during a trial calls default to that trial's own part of the data. For the same
reason each of the player's four "wait for the host to advance" points is one call to a small
`hostBarrier()` helper around `jsPsych.multiplayer.wait(condition, { scope: "session", participants: [hostId] })`,
rather than a `plugin-multiplayer-sync` trial (whose `wait_for` sees only its own trial's data).

The composition detail worth copying is the **monotonic step counter**. The host advances by
overwriting its `phase` field, and JATOS doesn't guarantee a client observes every intermediate
snapshot — so the obvious barrier, `wait_for: g => g[hostId]?.phase === "reveal"`, **deadlocks**: a
lagging player whose snapshot jumps straight from `question` to `leaderboard` is left with a
permanently unsatisfiable condition and hangs forever. Every host write therefore also carries a
`step` that only ever increases, and players wait on `hostStepValue(group) >= phaseStep(…)`. A `>=`
test against a monotonic value can never be missed — once true it stays true. Generalized: **on a
snapshot-based transport, barrier predicates must be monotone.** "State currently equals X" is a
latent deadlock; "state has reached at least X" is not.

`questions.js` holds the answer key, and the protocol keeps correctness a **host** decision — players
write only their `choice`, and the host publishes `correctChoice` at reveal. The demo does load the key
on both roles (one file serves both), so a player can read it in devtools; for anything scored for
real, serve it host-only. Full design notes, including why this demo hand-rolls its leaderboard,
timer, and answer buttons instead of composing the scoreboard/countdown/choice plugins, are in
[`group-quiz/DESIGN.md`](./group-quiz/DESIGN.md).

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

Each player's mid-game barriers name the host in `participants`, so a host who closes the presenter
screen ends the game for every player once the host counts as `left`; group size at real audience scale (~20+ phones on one JATOS group session) is
**untested**; and there is no host election or late-joiner catch-up. See the design doc for details
and the mechanical fix for each.

### Attribution

Adapted from the author's group-quiz demo in jsPsych#3694 (MIT-licensed).

## `ultimatum-game-local.html`

The same game as `ultimatum-game-jatos.html`, wired to `adapter-multiplayer-local` instead of
`adapter-multiplayer-jatos` (and without the `jatos.onLoad` wrapper), so it runs from **two browser
tabs on one machine, no server** — the same local-adapter setup `chat-room.html` uses. The game
itself (sync barriers, the shared `offer_exchange` scope, outcome screens) is the same as
`ultimatum-game-jatos.html`; see that section above for the design notes.

What changes is how the pair forms. The local adapter doesn't form groups — participants share a
link — so a lobby trial waits until two players are here, and the role trial uses open recruitment:
the first two to reach it become proposer and responder, and any later **extra arrival** becomes a
`spectator` routed to a "game is full" screen. Its custom `ready` predicate checks field readiness,
not just a head-count: a custom `ready` _replaces_ the plugin's own gate, so a count-only predicate
could assign the instant a peer appears, before the peer's `joinedAt` has arrived, and the two clients
could disagree about who is the proposer. The predicate therefore requires every participant in the
snapshot to carry `joinedAt`. The snapshot holds only participants who have reached the role trial
(with their session data), so a spectator who arrives mid-game still sees the two players' original
timestamps and computes the same pair. The barriers name the other player in `participants`, so a
spectator leaving never ends the round.

Use this file for iterating on the game logic itself. Use `ultimatum-game-jatos.html` when you want to test
against a real JATOS deployment.

### Running it

Run it the same way as `chat-room.html`: build the packages, serve the repo over http(s), open the
file in one tab, then copy the full URL (including `?mp_session=…`) into a second tab. See
`chat-room.html`'s "Running it" section above for the jsDelivr preview build and step-by-step details.

## `ultimatum-game-firebase.html`

The same game as `ultimatum-game-jatos.html`, wired to `adapter-multiplayer-firebase`, so it runs
across **separate devices, browsers, and machines** with only a free Firebase project — real
cross-device multiplayer, no server to host. It uses a shared `?mp_session=…` link rather than
matchmaking, so its timeline is identical to `ultimatum-game-local.html`'s (lobby, open recruitment
with spectators); only the network backend changes.

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
onValue mirror, cross-client visibility, and exact JSON round-trip). Since that verification the adapter
gained a separate presence node and no longer deletes a participant's slot on disconnect; see its
README for the updated security rules.

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
role trial makes one tab the director and the other the matcher, at random.

## `reference-game-match.html`

The **same plugin** as `reference-game.html`, configured for the **full-board match** ("unconstrained")
condition: every object is an ordered **target**, so the director's board shows numbered slot badges
and the matcher reproduces that order by assigning each shape to a slot, then submitting for a score
out of N. Shows that "sequential" and "unconstrained" are one plugin with `targets` turned from
length-1 to length-N. Run it the same two-tab way.

