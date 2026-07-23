# Tutorial: Building a Two-Player Ultimatum Game with jsPsych Multiplayer

This tutorial walks through building a complete two-player **ultimatum game** — the canonical
turn-based economic game (Güth, Schmittberger & Schwarze, 1982) — using the multiplayer packages in
this repository. Two players split a $10 pot: the **proposer** offers the **responder** some amount;
the responder accepts (both keep the split) or rejects (both get nothing).

The finished experiment is [`examples/ultimatum-game-local.html`](../examples/ultimatum-game-local.html)
(added in [PR #31](https://github.com/jspsych/jspsych-multiplayer/pull/31)). You can run it yourself
from **two browser tabs on one machine, with no server** — and by the end you'll know how to swap one
line to deploy the identical experiment on JATOS for real, cross-device data collection.

The headline of this tutorial is what's *missing* from the finished experiment: it contains almost no
synchronization or coordination code. Every "wait for the other player" moment is one declarative
trial; role assignment is one declarative trial; the network backend is one constructor call. The
experiment code is about the game, not about networking.

## Contents

1. [Why multiplayer experiments are hard](#1-why-multiplayer-experiments-are-hard)
2. [The building blocks and the shared-state model](#2-the-building-blocks-and-the-shared-state-model)
3. [Run it first](#3-run-it-first)
4. [Walkthrough: setup and connecting the adapter](#4-walkthrough-setup-and-connecting-the-adapter)
5. [The lobby: a synchronization barrier](#5-the-lobby-a-synchronization-barrier)
6. [Role assignment by deterministic consensus](#6-role-assignment-by-deterministic-consensus)
7. [The `joinedAt` rule: pushes replace, so carry it forward](#7-the-joinedat-rule-pushes-replace-so-carry-it-forward)
8. [The proposer's turn](#8-the-proposers-turn)
9. [The responder's turn](#9-the-responders-turn)
10. [The outcome — and what happens when a player leaves](#10-the-outcome--and-what-happens-when-a-player-leaves)
11. [Spectators and other edge paths](#11-spectators-and-other-edge-paths)
12. [The data you get](#12-the-data-you-get)
13. [Deploying for real data collection](#13-deploying-for-real-data-collection)
14. [Where to go next](#14-where-to-go-next)

## 1. Why multiplayer experiments are hard

A single-participant jsPsych experiment is a linear timeline: every trial's inputs are available the
moment it starts. A multiplayer experiment breaks that assumption in three ways:

- **Waiting.** The responder cannot decide until the proposer's offer exists. Somewhere, a client has
  to idle until a condition about *another* client's data becomes true.
- **Agreement.** Both clients must agree who the proposer is — without a server-side coordinator,
  and even though each client only ever sees its own local copy of the shared state.
- **Absence.** Real participants close tabs. A design that waits forever for a partner who left is a
  design that strands the partner who stayed.

Hand-rolling these — polling loops, sorting participant IDs in an `on_finish` callback, ad-hoc
timeout flags — is exactly the code that makes multiplayer experiments brittle and hard to review.
The packages used here turn each concern into a declarative trial parameter instead.

## 2. The building blocks and the shared-state model

The experiment composes three packages on top of the jsPsych multiplayer API
([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)):

| Package                                          | What it contributes                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local` | The network backend: `localStorage` + cross-tab signalling. Zero infrastructure. **Dev/demo only.**     |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | A **barrier** trial: push data, then wait until a condition over the whole group holds.                 |
| `@jspsych-multiplayer/plugin-multiplayer-role`   | **Deterministic role assignment**: every client independently computes the same role map, no coordinator. |

Before reading any code, internalize the state model, because every design decision below follows
from it:

> **The group session is a map from participant ID to that participant's data slot, and a `push`
> REPLACES the pushing participant's entire slot — it does not merge.**

So if your slot is `{ status: "ready", joinedAt: 1783619087856 }` and you push `{ offer: 9 }`, your
slot is now `{ offer: 9 }`. The `joinedAt` is gone — for you *and* for every other client reading
the group. This replace-not-merge semantic is the single most consequential fact about the API, and
Section 7 is devoted to the rule it forces on this experiment.

Every client sees the same group session (delivered by the adapter), and the plugins only ever
*read* the whole group while *writing* only their own slot. That asymmetry — shared reads, own-slot
writes — is what makes coordinator-free consensus possible.

## 3. Run it first

The tutorial is easier to follow if you've watched the game run. The short version (the full recipe,
including how to get a pre-release build of the multiplayer API, lives in
[`examples/README.md`](../examples/README.md) under "Running it"):

```sh
npm install && npm run build   # build the packages (dist/ is gitignored, not checked in)
npx http-server .              # serve over http — file:// URLs break localStorage sharing
```

Open the printed URL to `examples/ultimatum-game-local.html` in one tab. The local adapter mints a
session and writes it into the URL as `?mp_session=…` — **copy that full URL into a second tab** to
join the same game (the bare URL would start a new session). One tab becomes the proposer, the other
the responder; play the round through and use the end screen's button to download the session's data
as JSON.

## 4. Walkthrough: setup and connecting the adapter

The experiment begins by constructing the backend and handing it to jsPsych:

```js
const jsPsych = initJsPsych();

const localAdapter = new jsPsychAdapterMultiplayerLocal({ persistParticipant: true });

// ...timeline definitions...

jsPsych.multiplayer.connect(localAdapter).then(() => {
  jsPsych.run([lobby, assignRoles, gameFull, noGroupScreen, gameTimeline, doneScreen]);
});
```

Two things to note:

- **`connect` before `run`.** Every multiplayer trial talks to the group session through the
  connected adapter, so the connection must exist before the timeline starts.
- **`persistParticipant: true`** stores this tab's participant ID in `sessionStorage`, so a mid-game
  refresh rejoins as the *same* participant instead of abandoning a ghost slot (which would, for
  example, falsely satisfy the lobby's "two players present" condition).

This is the only backend-specific code in the whole file. Everything from here on would run
unchanged on JATOS (Section 13).

## 5. The lobby: a synchronization barrier

The first trial holds each arriving player until a partner exists:

```js
const lobby = {
  type: jsPsychMultiplayerSync,
  push_data: { status: "ready" },
  wait_for: (group) => Object.keys(group).length >= 2,
  message: `<p>Waiting for another player to join…</p>`,
};
```

This is the sync plugin's whole contract in one trial: **push your data, then wait until a predicate
over the group holds.** `push_data` writes `{ status: "ready" }` into this participant's slot;
`wait_for` receives the full group map every time it changes and returns `true` once at least two
participants are present. The plugin shows `message` while waiting and finishes the trial the moment
the predicate passes.

Note there is deliberately **no timeout** here: waiting indefinitely for a partner to arrive is the
correct behavior for a recruitment lobby. Timeouts belong on mid-game waits, where an absent partner
means the round cannot finish (Section 10).

## 6. Role assignment by deterministic consensus

With two players present, someone must become the proposer. The trap is that there is no server to
decide: each client runs the same code against its own view of the group. The role plugin's answer
is to make the computation **deterministic over shared inputs** — if every client sorts the same
data with the same rule, every client derives the same answer, and no coordination round-trip is
needed.

```js
const assignRoles = {
  type: jsPsychMultiplayerRole,
  roles: ["proposer", "responder"],
  strategy: "join_order",
  overflow_role: "spectator",
  ready: (group) =>
    Object.keys(group).length >= 2 &&
    Object.values(group).every(
      (entry) =>
        entry.joinedAt != null || entry.offer !== undefined || entry.decision !== undefined
    ),
  save_group: true,
  message: "<p>Assigning roles…</p>",
  on_finish: (data) => {
    myRole = jsPsychMultiplayerRole.getMyRole();
    const byRole = jsPsychMultiplayerRole.participantsByRole();
    proposerId = byRole.proposer?.[0];
    responderId = byRole.responder?.[0];
    myJoinedAt = data.group?.[jsPsych.multiplayer.participantId]?.joinedAt;
  },
};
```

Piece by piece:

- **`strategy: "join_order"`** sorts participants by `joinedAt`, a timestamp the role plugin stamps
  into each participant's slot **once, when its own trial starts** — i.e. near-simultaneously on the
  clients leaving the lobby together. Ties break deterministically by participant ID. The first two
  in that order fill `roles`; anyone beyond them gets `overflow_role: "spectator"`.
- **The `ready` predicate gates *when* a group snapshot is safe to assign over** — and supplying a
  custom one *replaces* the plugin's built-in gate, so it must check two things, not one.
  *Membership*: at least two participants. *Field readiness*: every present entry actually carries
  the data `join_order` sorts on. A count-only predicate has a real race: each client would assign
  the instant it sees the peer's lobby entry — possibly before the peer's `joinedAt` lands — sort
  the missing timestamp as 0, conclude the *other* client is the proposer, and both would sit
  waiting for an offer that never comes. (The `entry.offer !== undefined || entry.decision !==
  undefined` fallback is a deliberate liveness choice for one buggy-edit case — when the carry rule
  below is followed, it never fires. The end of Section 7 covers exactly what it does and doesn't
  protect.)
- **`on_finish` captures what the rest of the timeline needs**: this client's role (via the
  `getMyRole()` static), the two player IDs by role (via `participantsByRole()`), and — because
  `save_group: true` saved the snapshot the roles were computed over — this client's own `joinedAt`.
  That last capture looks like bookkeeping. It is actually load-bearing, and it gets its own
  section.

## 7. The `joinedAt` rule: pushes replace, so carry it forward

This is the least obvious line in the experiment, and the one most likely to be dropped by someone
adapting the code — so here is the rule stated on its own:

> **Every push after role assignment must include `joinedAt`, because a push replaces the
> participant's entire slot, and the role ordering that keeps the game stable is derived from
> `joinedAt`.**

Concretely, both mid-game pushes in the experiment spread it back in:

```js
// Proposer sends the offer:
push_data: () => ({ offer: proposerOffer, joinedAt: myJoinedAt }),

// Responder sends the decision:
push_data: () => ({ decision: responderDecision, joinedAt: myJoinedAt }),
```

Walk through what happens *without* it. The proposer pushes a bare `{ offer: 9 }`. Because pushes
replace rather than merge (Section 2), the proposer's slot — which the role trial had left as
`{ status: "ready", joinedAt: 1783619087856, rounds: { "0": {} } }` (the `rounds` key is the role
plugin's own per-round bookkeeping) — is now just `{ offer: 9 }`. The timestamp that determined who
the proposer *is* has been erased from the shared state.

Between the two original players, nothing visibly breaks at first — they already captured their
roles in local variables. The failure arrives with the next client that has to *compute* roles from
the group session: a spectator joining mid-game. Deterministic consensus only works if every client
sorts **the same inputs**; a late joiner who sees one player's `joinedAt` missing sorts that player
as timestamp 0, derives a *different* proposer/responder pair than the pair actually playing, and
the "every client computes the same role map" guarantee is silently broken. The same erasure would
also invalidate any role recomputation after a refresh. It's a classic distributed-state bug: the
mistake happens at push time, the symptom appears later, on a different client, in a different
trial.

Hence the pattern, in three steps, all visible in Section 6's and Section 8–9's code:

1. **Capture:** `save_group: true` on the role trial, then in `on_finish` read your own slot's
   `joinedAt` into a variable (`myJoinedAt`).
2. **Carry:** include `joinedAt: myJoinedAt` in every subsequent `push_data`.
3. **Guard — for initial assignment only:** the role trial's `ready` predicate refuses to assign
   over a lobby entry whose `joinedAt` hasn't landed yet, closing the race described in Section 6.
   It does *not* catch a forgotten carry: the predicate's fallback clause deliberately admits
   mid-game entries (`offer` or `decision` present), so a bare `{ offer: 9 }` slot passes the gate
   and a late joiner assigns over it anyway — sorting the missing timestamp as 0, exactly the
   silent divergence above. For everything after initial assignment, the carry rule (step 2) is
   the **only** protection.

Why does the example's gate tolerate that, rather than being strict so a forgotten carry at least
fails loudly? Because the divergence it admits is *inert in this design*, and strictness would
punish the wrong person. A missing timestamp sorts **first**, never last — so a late joiner can
never sort ahead of a timestamp-less player into a player slot; it always still lands in the
overflow role, still routes to the "game full" screen, and never acts on who it *thinks* the pair
is. A strict gate would instead leave that innocent spectator hanging until the role trial's 30 s
timeout and exit them through "could not form a group" — trading a graceful participant experience
for a loud dev-time signal about a bug the carry rule already owns. If you adapt this design so
that late joiners *do* act on the computed role map, revisit that trade: strictness may then be
worth it.

The general form of the rule outlives this example: **whatever fields of your slot other clients
depend on, every push must carry them forward** — and *only* them: the correct pushes above still
happily erase `status` and the role plugin's `rounds` key, because nothing downstream reads those.
The rule is not "preserve everything"; it's "preserve what other clients depend on." The chat-room
example obeys the same law with a different field — participants publish `name` in the lobby, and the chat plugin re-reads its own
slot and rewrites only the chat keys so `name` survives. If you build your own multiplayer flow on
this API, "what does this push erase?" is the review question to ask at every `push_data`.

## 8. The proposer's turn

The proposer's flow is two trials inside a conditional timeline:

```js
const proposerOfferTrial = {
  type: jsPsychHtmlButtonResponse,
  stimulus: `...You are the Proposer... Choose how much to offer...`,
  choices: Array.from({ length: POT + 1 }, (_, index) => `$${index}`),
  on_finish: (data) => {
    proposerOffer = data.response; // button index equals dollar amount
  },
};

const proposerWaitTrial = {
  type: jsPsychMultiplayerSync,
  push_data: () => ({ offer: proposerOffer, joinedAt: myJoinedAt }),
  wait_for: (group) => group[responderId]?.decision !== undefined,
  timeout: PARTNER_TIMEOUT_MS,
  on_timeout: () => {
    partnerLeft = true;
  },
  message: () => `<p>You offered the Responder <strong>$${proposerOffer}</strong>…</p>`,
  on_finish: (data) => {
    if (data.timed_out) return;
    responderDecision = data.group[responderId].decision;
  },
};

const proposerTimeline = {
  timeline: [proposerOfferTrial, proposerWaitTrial],
  conditional_function: () => myRole === "proposer",
};
```

The first trial is ordinary single-player jsPsych — a button response. All the multiplayer work is
in the second: one sync barrier that **sends the offer and waits for the decision** in a single
declarative step. Its `wait_for` targets the responder's slot specifically (`group[responderId]`),
using the ID captured from `participantsByRole()` in Section 6. Note `push_data` is a function here,
not an object — the offer doesn't exist until runtime, so it's evaluated when the trial starts.

The `timeout` / `on_timeout` pair is the abandonment guard; Section 10 covers it.

## 9. The responder's turn

The responder mirrors the proposer, with the wait on the *other* side of the input:

```js
const responderWaitTrial = {
  type: jsPsychMultiplayerSync,
  wait_for: (group) => group[proposerId]?.offer !== undefined,
  timeout: PARTNER_TIMEOUT_MS,
  on_timeout: () => {
    partnerLeft = true;
  },
  message: "<p>Waiting for the Proposer's offer…</p>",
  on_finish: (data) => {
    if (data.timed_out) return;
    proposerOffer = data.group[proposerId].offer;
  },
};
```

This barrier pushes nothing (`push_data` omitted) — the responder has nothing to say yet — it only
waits for the proposer's `offer` to appear, then reads it out of the group snapshot in `on_finish`.
Then an ordinary button trial collects accept/reject, and a final barrier publishes it:

```js
const responderSendDecisionTrial = {
  type: jsPsychMultiplayerSync,
  push_data: () => ({ decision: responderDecision, joinedAt: myJoinedAt }),
  wait_for: (group) => group[responderId]?.decision !== undefined,
  message: "<p>Sending your decision…</p>",
};
```

Its `wait_for` checks the responder's **own** slot — this barrier just confirms the decision landed
in the shared state before moving on. Like the lobby, it carries no timeout: a wait on your own data
either succeeds promptly or something is wrong at a level a timeout wouldn't fix.

Both roles' timelines hang off `conditional_function`s checking `myRole`, so the same file serves
both players — which client runs which branch is decided entirely by the role trial's consensus.

## 10. The outcome — and what happens when a player leaves

The happy path ends in a shared outcome screen: both clients now hold `proposerOffer` and
`responderDecision` locally, so each renders its own perspective on the result (what you offered vs.
what you were offered, and what you earned).

The unhappy path is the one that distinguishes a demo from a deployable design. In open recruitment,
a partner can close their tab mid-round. Every barrier that waits on the **other** player's data —
`proposerWaitTrial` and `responderWaitTrial` — therefore sets:

```js
timeout: PARTNER_TIMEOUT_MS,   // 60 s — one tunable constant at the top of the file
on_timeout: () => { partnerLeft = true; },
```

If the timeout elapses, the barrier finishes with `timed_out: true` in its data (which is why both
`on_finish` handlers bail out early on that flag: the group snapshot won't contain what they came
for), and downstream conditionals route around the outcome:

```js
const partnerLeftScreen = { timeline: [/* "The other player left…" */],
                            conditional_function: () => partnerLeft };
const outcome = { timeline: [outcomeTrial],
                  conditional_function: () => !partnerLeft };
```

So the stranded player gets a clean "the other player left the game" exit instead of an infinite
spinner. One honest caveat: each client times out **independently** — there is no "we both agree
you're gone" handshake. If a present-but-slow responder ponders past `PARTNER_TIMEOUT_MS`, the
proposer concludes they left while the responder completes the round normally, and the two walk away
with contradictory end-states. The pragmatic guard is to keep the timeout generous relative to your
slowest plausible participant (and/or cap decision screens with a `trial_duration` below it). This
experiment keeps 60 s and no forced decision — imposing an auto-advance is a behavioral-design
choice that shouldn't be baked into an example.

## 11. Spectators and other edge paths

Open recruitment produces one more character: the third player. The lobby admits at *least* two, so
someone can arrive after the pair formed. Rather than a hard cap (rejecting them after a confusing
wait), the role trial's `overflow_role: "spectator"` assigns them a role that the timeline routes to
a graceful exit:

```js
const gameFull = { timeline: [/* "Sorry, this game is already full…" */],
                   conditional_function: () => myRole === "spectator" };
```

— and thanks to the `joinedAt` rule (Section 7), that late spectator computed the *same*
proposer/responder pair as the players themselves, so its arrival can never destabilize the game.

Two final guards complete the paths off the happy road: if role assignment itself times out (a peer
vanished between lobby and role trial), `myRole` stays undefined and a "could not form a group"
screen shows; and every path — played, spectated, or stranded — funnels into a closing screen so no
participant is ever left on a blank page. On the local version that closing screen offers an opt-in
**Download data (JSON)** button, since with no backend collecting data, a click-triggered
`jsPsych.data.get().localSave(...)` is how you inspect a session.

## 12. The data you get

Each multiplayer trial records structured data alongside the usual jsPsych fields. From a real run
of this experiment (proposer's tab, abridged):

```json
{ "trial_type": "multiplayer-sync", "wait_time": 1, "timed_out": false, "wait_error": null,
  "group": { "031cc…": { "status": "ready" }, "dbad5…": { "status": "ready" } } }

{ "trial_type": "multiplayer-role", "role": "proposer", "assigned_self": true, "timed_out": false,
  "role_map": { "031cc…": { "role": "proposer" }, "dbad5…": { "role": "responder" } },
  "group": { "031cc…": { "status": "ready", "joinedAt": 1783619087856 },
             "dbad5…": { "status": "ready", "joinedAt": 1783619087857 } } }

{ "trial_type": "multiplayer-sync", "wait_time": 2359, "timed_out": false,
  "group": { "031cc…": { "offer": 9,           "joinedAt": 1783619087856 },
             "dbad5…": { "decision": "accept", "joinedAt": 1783619087857 } } }
```

Everything you'd analyze is here: the barrier's `wait_time` (how long this client actually waited),
`timed_out` / `wait_error` for data-quality filtering, the full `role_map` (so you can verify both
clients agreed), and — because the barriers snapshot the group they resolved over — the offer and
decision themselves, with `joinedAt` visibly riding along in every mid-game slot, exactly as
Section 7 prescribed. Note the role trial's group snapshot resolves per-client questions like "which
participant was this tab?" (`assigned_self`, plus the role map keyed by participant ID) without any
extra bookkeeping in the experiment code.

## 13. Deploying for real data collection

The local adapter is same-origin, same-browser, same-machine — a development and demo tool, **not**
a data-collection backend. Deploying the experiment for real participants means swapping the
backend, and this is where the architecture pays off. Compare the local version against
[`examples/ultimatum-game-jatos.html`](../examples/ultimatum-game-jatos.html), the JATOS variant: the *entire*
diff in experiment logic is the connection code.

```js
// Local (two tabs, no server):
const localAdapter = new jsPsychAdapterMultiplayerLocal({ persistParticipant: true });
jsPsych.multiplayer.connect(localAdapter).then(() => {
  jsPsych.run([...]);
});

// JATOS (real, cross-device study):
jatos.onLoad(async () => {
  const jsPsych = initJsPsych({ on_finish: () => jatos.endStudy() });
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
  jsPsych.run([...]);
});
```

(Plus the `<script src="jatos.js">` tag JATOS injects, and loading the JATOS adapter bundle instead
of the local one.) The coordination that makes this a _multiplayer_ experiment — the lobby, the role
consensus, the barriers, the timeout handling — is identical across both files, because none of it is
backend-specific. (The two example files do differ in a few backend-adjacent details beyond the
connection code — e.g. the local variant adds a "download data" button and reaches its closing screen
by a slightly different route — but the multiplayer logic itself is unchanged.) That's the
development loop this package set is designed for: **iterate on game logic in two tabs on your
laptop; change one object to run the study.**

The same swap works in the other direction for any adapter implementing the `MultiplayerAdapter`
interface, so a future backend (e.g. a WebSocket server, or Firebase) slots in without touching
experiment code.

## 14. Where to go next

- **Adapt the game.** Multi-round ultimatum, different pot sizes, a strategy-method variant — the
  round logic is plain jsPsych; only remember Section 7's rule when you add pushes.
- **More players.** The role plugin's `roles` array and `overflow_role` generalize beyond pairs;
  `participantsByRole()` hands back ID lists per role.
- **Real-time interaction.** The barriers here are turn-based (`wait_for` a condition once). For
  continuously live interaction, see the `subscribe`-based
  [`plugin-multiplayer-chat`](../packages/plugin-multiplayer-chat) and its
  [`chat-room.html`](../examples/chat-room.html) example, which runs on the same local adapter.
- **Package docs.** Each package's README covers its full parameter surface:
  [`plugin-multiplayer-sync`](../packages/plugin-multiplayer-sync),
  [`plugin-multiplayer-role`](../packages/plugin-multiplayer-role),
  [`adapter-multiplayer-local`](../packages/adapter-multiplayer-local),
  [`adapter-multiplayer-jatos`](../packages/adapter-multiplayer-jatos).

### References

Güth, W., Schmittberger, R., & Schwarze, B. (1982). An experimental analysis of ultimatum
bargaining. _Journal of Economic Behavior & Organization_, 3(4), 367–388.

The ultimatum-game demo is adapted from the author's demo in
[jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694) (MIT-licensed).
