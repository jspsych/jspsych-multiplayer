# plugin-multiplayer-role

Assign each participant in a multiplayer group a **role** (proposer/responder, leader/follower, …) by
**deterministic consensus**: every client independently computes the _same_ role map from the shared
group-session snapshot, with no coordinator and no extra round-trip. The hard part this plugin owns is
that agreement — not the role semantics, which stay in your own game logic.

It builds on the jsPsych multiplayer API (`@jspsych/jspsych` group sessions). Role assignment runs as a
short barrier trial: it waits until the group is ready, computes the map, and saves the assignment to
the data record, where the role accessors read it for downstream trials.

> **Status.** Requires the jsPsych multiplayer API
> ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)), which is not yet in a jsPsych
> release, plus a network adapter (e.g. JATOS group sessions). On a jsPsych without
> `jsPsych.multiplayer`, the trial throws an error saying so.

## Loading

### In browser

```html
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-role"></script>
```

### Via NPM

```
npm install @jspsych-multiplayer/plugin-multiplayer-role
```

```js
import MultiplayerRole from "@jspsych-multiplayer/plugin-multiplayer-role";
// The pure core and the role accessors are static members of the plugin class:
//   MultiplayerRole.assignRoles, MultiplayerRole.getMyRole, MultiplayerRole.getRoleMap, …
// To match the trial's "random" assignment, pass the session's shuffle:
//   MultiplayerRole.assignRoles(snapshot, { ...opts, shuffle: jsPsych.multiplayer.shuffle })
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-role` requires jsPsych v8.0.0 or later, plus a multiplayer API
adapter (e.g. JATOS group sessions).

## Parameters

| Parameter       | Type            | Default                     | Description                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`         | array \| object | _required_                  | The roles to hand out. An array is one slot per entry (`["proposer", "responder"]`); an object is counts (`{ leader: 1, follower: 3 }`).                                                                                                                                                                                                                                                    |
| `strategy`      | string \| fn    | `"join_order"`              | How participants are ordered into the role slots. One of `"join_order"`, `"random"`, `"rotate"`, or a custom `(snapshot, ctx) => roleMap` function (see below).                                                                                                                                                                                                                             |
| `group_size`    | int             | `null`                      | If set, assignment waits for **exactly** this many participants to reach this trial before computing (fail-loud, not `>=`). Participants who have left the session don't count and aren't assigned. `null` assumes an upstream waiting-room barrier already capped the group. In a sealed group (`jsPsych.multiplayer.group().sealed`), `null` counts the group's members who haven't left. |
| `round`         | int             | `0`                         | Round index, for `rotate` and per-round `random`. Increment it each time you re-run the trial.                                                                                                                                                                                                                                                                                              |
| `balanced`      | bool            | `false`                     | For `rotate`: use the balanced (Latin-square) variant — see [Rotation](#rotation-rotate).                                                                                                                                                                                                                                                                                                   |
| `seed`          | string          | `null`                      | Picks a different random assignment within the session. Randomness is seeded by the session ID (or the `randomSeed` connect option), so each group gets its own assignment and every client computes the same one.                                                                                                                                                                          |
| `rank_by`       | fn              | `null`                      | `(entry, id, ctx) => number`. Order participants by a numeric key (highest first), e.g. a task score.                                                                                                                                                                                                                                                                                       |
| `role_from`     | fn              | `null`                      | `(entry, id, ctx) => string`. The role **is** a value each participant already carries; must return a declared role. Does not enforce per-role counts.                                                                                                                                                                                                                                      |
| `ready`         | fn              | `null`                      | `(snapshot, presence) => boolean`. Override the readiness gate; **required** when `strategy` is a custom function. `snapshot` holds the participants who have reached this trial and haven't left (see [What the strategies see](#what-the-strategies-see)); both arguments are frozen, so don't modify them.                                                                               |
| `overflow_role` | string          | `null`                      | Role for participants beyond the declared slots — applies whenever the participant count exceeds the number of declared slots, whether or not `group_size` is set. If unset, overflow throws.                                                                                                                                                                                               |
| `write_data`    | object          | `{}`                        | Data this client contributes to the snapshot (e.g. the score `rank_by` ranks on). Merged into this participant's data in the trial's own scope, so it never reaches another trial.                                                                                                                                                                                                          |
| `save_group`    | bool            | `false`                     | Include the full group snapshot in the trial data. Off by default to avoid data bloat.                                                                                                                                                                                                                                                                                                      |
| `timeout`       | int             | `30000`                     | Milliseconds to wait for readiness before giving up. `null`, `0`, or a negative value waits forever (discouraged).                                                                                                                                                                                                                                                                          |
| `on_timeout`    | fn              | `null`                      | Hook run on timeout. The trial always ends with `role: null`, `multiplayer_outcome: "timeout"` regardless.                                                                                                                                                                                                                                                                                  |
| `participants`  | array \| null   | `null`                      | Participants the assignment depends on. If one leaves the session before the group is ready, the trial ends with `role: null, multiplayer_outcome: "participant_left"`. `null` means the rest of a sealed group, or else every other participant who is connected when this participant arrives; `[]` ignores departures.                                                                   |
| `message`       | HTML string     | `"<p>Assigning roles…</p>"` | Shown while waiting.                                                                                                                                                                                                                                                                                                                                                                        |

## Data generated

| Name                  | Type   | Description                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`                | string | This participant's assigned role (`null` unless `multiplayer_outcome` is `"completed"`, and for a spectator).                                                                                                                                                                                                                                                                           |
| `role_map`            | object | The full `participantId -> { role }` map every client agreed on (`null` unless `multiplayer_outcome` is `"completed"`).                                                                                                                                                                                                                                                                 |
| `assigned_self`       | bool   | Whether this participant appears in the agreed map. `false` only when an assignment ran but a **custom strategy** left this participant out (a spectator) — overflow participants are in the map (with `overflow_role`), so they read `true`. Distinguishes that spectator case from an unassigned outcome (where `role_map` is `null`).                                                |
| `multiplayer_outcome` | string | How the trial ended: `"completed"`, `"timeout"` (readiness was not reached before `timeout`), `"participant_left"` (a participant in `participants` left the session), or `"connection_lost"` (this participant's connection was lost for good). If the wait is instead **cancelled** because the experiment ended or was aborted, the trial stops quietly and writes no record at all. |
| `left_participant`    | string | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`; `null` otherwise.                                                                                                                                                                                                                                                                               |
| `group`               | object | The full snapshot assigned over — only present when `save_group: true`.                                                                                                                                                                                                                                                                                                                 |

## Strategies

The `strategy` parameter takes one of three string presets or a custom function:

| `strategy`   | Ordering                                                                                  | Requires                         |
| ------------ | ----------------------------------------------------------------------------------------- | -------------------------------- |
| `join_order` | by `joinedAt` in the session data (falls back to id order)                                | every participant has `joinedAt` |
| `random`     | Fisher–Yates shuffle from the session's shared randomness (`jsPsych.multiplayer.shuffle`) | the id set only                  |
| `rotate`     | base order rotated by round; optional `balanced`                                          | the id set only                  |
| custom fn    | you compute the whole map (and own the consensus burden)                                  | —                                |

Two **separate** parameters provide attribute- and value-based ordering — they are _not_ `strategy`
values, and they take precedence over `strategy` when set:

| Parameter   | Ordering                                     | Requires                        |
| ----------- | -------------------------------------------- | ------------------------------- |
| `rank_by`   | by a numeric key, highest first              | a finite key per participant    |
| `role_from` | the role is a value each participant carries | a defined value per participant |

When more than one is supplied, precedence is **custom `strategy` function → `role_from` → `rank_by` →
string `strategy` preset**.

Every preset starts from the **sorted** id list, so the result is invariant to snapshot key order —
that's what makes all clients agree.

### Rotation (`rotate`)

Plain `rotate` cyclically rotates the participant order by `round`, so the participant at base index
`i` receives role slot `(i - round) mod n`. Over `n` rounds each participant holds each role once —
correct counterbalancing of _how often_ you hold each role.

`balanced: true` shifts instead by the round'th term of a balanced (Williams) sequence
`0, n-1, 1, n-2, 2, …`. This keeps the per-round frequency guarantee **and** additionally balances
**first-order carryover**: across the group, each role is immediately preceded by every other role
equally often. That carryover balance is exact when `n` is even; a single Latin square cannot fully
balance odd `n` (the standard Williams caveat), but the frequency guarantee still holds for all `n`.

## What the strategies see

The snapshot that `strategy`, `rank_by`, `role_from`, and `ready` see holds every participant who has
reached **this** trial and hasn't left. Each entry is that participant's session data (see
`{ scope: "session" }` in the multiplayer API) with their `write_data` from this trial merged over
it. So an accessor can read both a value written before the trial, such as a condition the page
wrote at connect time, and a value written in the trial itself, such as a score.

Data another trial wrote in its own scope is **not** visible here. To use such a value (e.g. a score
from an earlier task), write it with `jsPsych.multiplayer.update(data, { scope: "session" })`, or
pass it in through `write_data`.

`join_order` orders by `joinedAt`, which the trial writes to the session data the first time this
participant runs a role (or match) trial and never re-stamps, so the order stays the same in every
later round. A page can also write `joinedAt` itself, e.g. right after `connect()`.

## Reading your role downstream

The trial records `role` and `role_map` in its data, and the accessors read the most recent role
trial's data, so later trials can branch on the role without digging through the data record. They
are static members of the plugin class:

```js
import MultiplayerRole from "@jspsych-multiplayer/plugin-multiplayer-role";

// Conditional timeline: only the proposer makes the offer.
const proposerOffer = {
  timeline: [offerTrial],
  conditional_function: () => MultiplayerRole.getMyRole() === "proposer",
};

// Need the *identity* of the player in another role (e.g. to wait for their decision):
const responderId = MultiplayerRole.participantsByRole().responder[0];

// The full agreed map, if you need it:
const map = MultiplayerRole.getRoleMap(); // { p1: { role: "proposer" }, p2: { role: "responder" } }
```

`getMyRole()`, `getMyAssignment()`, and `getRoleMap()` reflect the most recent role trial, so under
`rotate` or per-round `random` they return the **current** round's role, and after a trial that
ended without roles they return `undefined`. Called without arguments they read the jsPsych instance
that most recently ran a role trial; on a page with several instances, pass one, e.g.
`getMyRole(jsPsych)`. `participantsByRole(map)` inverts any role map, by default `getRoleMap()`.

## Membership consensus caveat

This plugin guarantees that, given the _same_ snapshot, every client computes the _same_ roles. It does
**not** by itself guarantee everyone sees the same snapshot. That "capped, agreed set of N participants"
contract belongs upstream — a waiting-room / sync barrier that admits exactly the intended group before
the role trial runs. `group_size` turns an overshoot into a loud stall-then-timeout rather than a silent
assignment over a partial group, but it does not create membership agreement on its own.

In practice, **set `group_size` (or supply a custom `ready` that enforces a count)** unless you are
certain every peer has already reached _this_ trial. Without either, the readiness gate quantifies
only over participants who have reached it so far, so it can resolve the instant this client arrives —
assigning over a partial group. Note that an upstream barrier admitting N participants does not by
itself guarantee those N have reached this trial; the plugin emits a console warning when
`group_size` and `ready` are both omitted.

Presence narrows the gap. Participants who have `left` are dropped from the group, and the group
isn't ready until every remaining participant is `connected`. So a participant who is only `away`, such
as a slot left over from an earlier member, can't be given a role, and clients don't assign roles while
they disagree about who is still there.

## Accessors that throw

Readiness calls `rank_by`, `role_from`, and `ready` speculatively, before every participant's data has
arrived, so a natural accessor like `(entry) => entry.stats.score` throws until then. A throw counts
as "not ready yet", so accessors don't need to be null-safe. If the group never becomes ready (a
timeout, a departure, or a lost connection), the plugin logs the last error an accessor threw, since
it may explain why — for example, an accessor that tries to modify the frozen snapshot.

## Author / Citation

[Hannah Tsukamoto](https://github.com/htsukamoto5)
