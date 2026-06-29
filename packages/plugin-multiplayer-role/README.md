# plugin-multiplayer-role

Assign each participant in a multiplayer group a **role** (proposer/responder, leader/follower, …) by
**deterministic consensus**: every client independently computes the _same_ role map from the shared
group-session snapshot, with no coordinator and no extra round-trip. The hard part this plugin owns is
that agreement — not the role semantics, which stay in your own game logic.

It builds on the jsPsych multiplayer API (`@jspsych/jspsych` group sessions). Role assignment runs as a
short barrier trial: it waits until the group is ready, computes the map, exposes your role to
downstream trials, and saves the assignment to the data record.

> **Status.** The pure assignment core, the role accessors, and the trial wrapper documented below are
> all implemented and tested. The wrapper is written against a local interface mirroring the jsPsych
> multiplayer API ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)); to actually run a
> trial you still need that API present at runtime (it lands in jsPsych core) plus a network adapter
> (e.g. JATOS group sessions). The parameter and data tables below describe the shipped wrapper.

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
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-role` requires jsPsych v8.0.0 or later, plus a multiplayer API
adapter (e.g. JATOS group sessions).

## Parameters

| Parameter       | Type            | Default                     | Description                                                                                                                                                                       |
| --------------- | --------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`         | array \| object | _required_                  | The roles to hand out. An array is one slot per entry (`["proposer", "responder"]`); an object is counts (`{ leader: 1, follower: 3 }`).                                          |
| `strategy`      | string \| fn    | `"join_order"`              | How participants are ordered into the role slots. One of `"join_order"`, `"random"`, `"rotate"`, or a custom `(snapshot, ctx) => roleMap` function (see below).                   |
| `group_size`    | int             | `null`                      | If set, assignment waits for **exactly** this many participants before computing (fail-loud, not `>=`). `null` assumes an upstream waiting-room barrier already capped the group. |
| `round`         | int             | `0`                         | Round index, for `rotate` and per-round `random`. Increment it each time you re-run the trial.                                                                                    |
| `balanced`      | bool            | `false`                     | For `rotate`: use the balanced (Latin-square) variant — see [Rotation](#rotation-rotate).                                                                                         |
| `seed`          | string          | `null`                      | Shared seed for `random`. Defaults to a hash of the sorted ids + round, so the shuffle re-randomizes each round and is identical on every client.                                 |
| `rank_by`       | fn              | `null`                      | `(entry, id, ctx) => number`. Order participants by a numeric key (highest first), e.g. a task score.                                                                             |
| `role_from`     | fn              | `null`                      | `(entry, id, ctx) => string`. The role **is** a value each participant already carries; must return a declared role. Does not enforce per-role counts.                            |
| `ready`         | fn              | `null`                      | `(snapshot) => boolean`. Override the readiness gate; **required** when `strategy` is a custom function.                                                                          |
| `overflow_role` | string          | `null`                      | Role for participants beyond the declared slots — applies whenever the participant count exceeds the number of declared slots, whether or not `group_size` is set. If unset, overflow throws.                    |
| `push_data`     | object          | `{}`                        | Round-scoped data this client contributes to the snapshot (e.g. the score `rank_by` ranks on). Namespaced under the round so it never clobbers earlier rounds.                    |
| `save_group`    | bool            | `false`                     | Include the full group snapshot in the trial data. Off by default to avoid data bloat.                                                                                            |
| `timeout`       | int             | `30000`                     | Milliseconds to wait for readiness before giving up. `null` waits forever (discouraged).                                                                                          |
| `on_timeout`    | fn              | `null`                      | Hook run on timeout. Default ends the trial with `role: null`, `timed_out: true`.                                                                                                 |
| `message`       | HTML string     | `"<p>Assigning roles…</p>"` | Shown while waiting.                                                                                                                                                              |

## Data generated

| Name            | Type   | Description                                                                                                                                                               |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`          | string | This participant's assigned role (`null` on timeout).                                                                                                                     |
| `role_map`      | object | The full `participantId -> { role }` map every client agreed on.                                                                                                          |
| `assigned_self` | bool   | Whether this participant appears in the agreed map. `false` only when an assignment ran but a **custom strategy** left this participant out (a spectator) — overflow participants are in the map (with `overflow_role`), so they read `true`. Distinguishes that spectator case from a timeout (where `role_map` is also `null`). |
| `timed_out`     | bool   | `true` if readiness was not reached before `timeout`.                                                                                                                     |
| `group`         | object | The full snapshot assigned over — only present when `save_group: true`.                                                                                                   |

## Strategies

The `strategy` parameter takes one of three string presets or a custom function:

| `strategy`   | Ordering                                                 | Requires                         |
| ------------ | -------------------------------------------------------- | -------------------------------- |
| `join_order` | by pushed `joinedAt` (falls back to id order)            | every participant has `joinedAt` |
| `random`     | shared-seeded Fisher–Yates shuffle                       | the id set only                  |
| `rotate`     | base order rotated by round; optional `balanced`         | the id set only                  |
| custom fn    | you compute the whole map (and own the consensus burden) | —                                |

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

## Reading your role downstream

The plugin writes the assignment to a module-level store so later trials can branch on it without
digging through the data record:

The accessors are static members of the plugin class:

```js
import MultiplayerRole from "@jspsych-multiplayer/plugin-multiplayer-role";

// Conditional timeline: only the proposer makes the offer.
const proposerOffer = {
  timeline: [offerTrial],
  conditional_function: () => MultiplayerRole.getMyRole() === "proposer",
};

// Need the *identity* of the player in another role (e.g. to read their pushed decision):
const { responder: [responderId] } = MultiplayerRole.participantsByRole();
const theirDecision = api.get(responderId)?.rounds[round].decision;

// The full agreed map, if you need it:
const map = MultiplayerRole.getRoleMap(); // { p1: { role: "proposer" }, p2: { role: "responder" } }
```

`MultiplayerRole.getMyRole()` / `.getRoleMap()` reflect the most recent assignment, so under `rotate`
or per-round `random` they return the **current** round's role.

## Membership consensus caveat

This plugin guarantees that, given the _same_ snapshot, every client computes the _same_ roles. It does
**not** by itself guarantee everyone sees the same snapshot. That "capped, agreed set of N participants"
contract belongs upstream — a waiting-room / sync barrier that admits exactly the intended group before
the role trial runs. `group_size` turns an overshoot into a loud stall-then-timeout rather than a silent
assignment over a partial group, but it does not create membership agreement on its own.

In practice, **set `group_size` (or supply a custom `ready` that enforces a count)** unless you are
certain every peer has already pushed into _this_ trial's session. Without either, the readiness gate
quantifies only over participants present so far, so it can resolve the instant this client pushes —
assigning over a partial group. Note that an upstream barrier admitting N participants does not by
itself guarantee those N have pushed into this trial's session; the plugin emits a console warning when
`group_size` and `ready` are both omitted.

## Author / Citation

[Hannah Tsukamoto](https://github.com/htsukamoto5)
