# plugin-multiplayer-match

Partition a multiplayer group into **matched sub-groups** — pairs by default, or triads/larger — by
**deterministic consensus**: every client independently computes the _same_ partition from the shared
group-session snapshot, with no coordinator and no extra round-trip. It is the foundational primitive
under every pairwise / small-group paradigm — **trust game, ultimatum, dyadic negotiation,
partner-based coordination** — and composes with the other primitives:

- pair up with **`plugin-multiplayer-match`**, then assign a role _within_ each pair with
  [`plugin-multiplayer-role`](../plugin-multiplayer-role) (drive it off `position`), then play a round
  with [`plugin-multiplayer-choice`](../plugin-multiplayer-choice) namespaced per partner.

Like [`plugin-multiplayer-role`](../plugin-multiplayer-role), it runs as a short **barrier** (write →
wait): it waits until the group is ready, partitions the resolved snapshot, and — because the
partition is a pure function of the snapshot — every client agrees on who is paired with whom.

> **Status.** Requires the jsPsych multiplayer API
> ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)), which is not yet in a jsPsych
> release, plus a network adapter (e.g. JATOS group sessions) and several real participants in the
> same group. On a jsPsych without `jsPsych.multiplayer`, the trial throws an error saying so.

## Loading

### In browser

```html
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-match"></script>
```

### Via NPM

```
npm install @jspsych-multiplayer/plugin-multiplayer-match
```

```js
import MultiplayerMatch from "@jspsych-multiplayer/plugin-multiplayer-match";
// The pure core and the accessors are static members of the plugin class:
//   MultiplayerMatch.buildMatches, .getMyPartners, .getMyGroup, .getMyPosition, .getMatchMap
// To match the trial's "random" grouping, pass the session's shuffle:
//   MultiplayerMatch.buildMatches(snapshot, { ...opts, shuffle: jsPsych.multiplayer.shuffle })
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-match` requires jsPsych v8.0.0 or later, plus a multiplayer
API adapter (e.g. JATOS group sessions).

## Parameters

| Parameter          | Type          | Default                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group_size`       | int           | `2`                            | Members per matched group (2 = dyads, 3 = triads, …). Must be an integer ≥ 2.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `expected_players` | int           | `null`                         | Wait for **exactly** this many participants to reach this trial before partitioning (fail-loud: an overshoot stalls to a timeout). Participants who have left the session don't count and aren't partitioned. `null` trusts an upstream barrier and partitions whoever has arrived as soon as this client has (a warning fires). In a sealed group (`jsPsych.multiplayer.group().sealed`), `null` counts the group's members who haven't left.                                   |
| `strategy`         | string        | `"ordered"`                    | Ordering before chunking: `"ordered"` (by id), `"join_order"` (by `joinedAt` in the session data), or `"random"` (a shuffle seeded by the session — unpredictable-by-id yet identical on every client). Prefer `"random"` for real experiments to avoid pairings that track id order.                                                                                                                                                                                            |
| `seed`             | string        | `null`                         | Picks a different random grouping within the session. Randomness is seeded by the session ID (or the `randomSeed` connect option), so each group of participants gets its own grouping.                                                                                                                                                                                                                                                                                          |
| `round`            | int           | `0`                            | Round index, for `"random"` re-pairing. Increment each re-run to shuffle partners anew.                                                                                                                                                                                                                                                                                                                                                                                          |
| `leftover`         | string        | `"error"`                      | When the count isn't a multiple of `group_size`: `"error"` (throw), `"spectator"` (leave the extras unmatched), or `"smaller_group"` (one final undersized group).                                                                                                                                                                                                                                                                                                               |
| `ready`            | fn            | `null`                         | `(snapshot, presence) => boolean` overriding the readiness gate. `snapshot` holds the participants who have reached this trial and haven't left (see [How the partition works](#how-the-partition-works)); both arguments are frozen, so don't modify them. A predicate that throws counts as "not ready"; if the group never becomes ready, the last error is logged. `null` derives readiness from `expected_players` (and, for `join_order`, that everyone has a `joinedAt`). |
| `write_data`       | object        | `{}`                           | Data this client contributes to the snapshot, e.g. for a custom `ready`. Merged into this participant's data in the trial's own scope, so it never reaches another trial. Must be plain JSON: a `Date` arrives as a string, `undefined` values are dropped, and `BigInt` or circular data makes the write fail.                                                                                                                                                                  |
| `save_group`       | bool          | `false`                        | Include the full group snapshot in the trial data.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `timeout`          | int           | `30000`                        | Milliseconds to wait for readiness before failing loud. `null`, `0`, or a negative value waits forever (discouraged).                                                                                                                                                                                                                                                                                                                                                            |
| `on_timeout`       | fn            | `null`                         | Hook run on timeout. The trial always ends with `matched_self: false, multiplayer_outcome: "timeout"` regardless.                                                                                                                                                                                                                                                                                                                                                                |
| `participants`     | array \| null | `null`                         | Participants the match depends on. If one leaves the session before the group is ready, the trial ends unmatched with `multiplayer_outcome: "participant_left"`. `null` means the rest of a sealed group, or else every other participant who is connected when this participant arrives; `[]` ignores departures.                                                                                                                                                               |
| `message`          | HTML string   | `"<p>Finding your match…</p>"` | Shown while waiting for the group.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Data generated

| Name                  | Type   | Description                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `match_group`         | int    | This participant's group index; `null` if a spectator or unmatched.                                                                                                                                                                                                                                                                  |
| `partners`            | array  | The other members of this participant's group; `null` if unmatched, `[]` if a spectator.                                                                                                                                                                                                                                             |
| `members`             | array  | All members of the group (including self), in consensus order; `null` if unmatched.                                                                                                                                                                                                                                                  |
| `position`            | int    | This participant's 0-based seat within its group; `null` if a spectator or unmatched.                                                                                                                                                                                                                                                |
| `match_map`           | object | The full `participantId -> { group, members, partners, position }` map; `null` if unmatched.                                                                                                                                                                                                                                         |
| `matched_self`        | bool   | Whether this participant was placed in a group — distinguishes a spectator from an unmatched outcome.                                                                                                                                                                                                                                |
| `multiplayer_outcome` | string | How the trial ended: `"completed"`, `"timeout"` (readiness was not reached before `timeout`), `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this participant's connection was lost for good). A cancelled wait (the experiment ended or was aborted) stops the trial quietly, with no record. |
| `left_participant`    | string | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`; `null` otherwise.                                                                                                                                                                                                                            |
| `group`               | object | The full snapshot partitioned over — only when `save_group: true`.                                                                                                                                                                                                                                                                   |

## How the partition works

Each client writes `joinedAt` (first-seen) to the session data and its `write_data` to the trial's
own data, then the trial waits until the group is ready and partitions the resolved snapshot with the
same pure function on every client:

- The snapshot holds every participant who has reached **this** trial (written to its data) and
  hasn't left. Each entry is that participant's session data with their `write_data` merged over it,
  so `joinedAt`, or anything the page wrote with `{ scope: "session" }`, is visible here, but data
  another trial wrote in its own scope is not.
- `joinedAt` is written the first time this participant runs a match (or role) trial and never
  re-stamped, so `join_order` stays the same in every later round. A page can also write it itself,
  e.g. right after `connect()`.
- Participants are ordered (per `strategy`) starting from a **stable id sort**, then chunked into
  groups of `group_size`. Because the ordering is a deterministic function of the snapshot (and, for
  `"random"`, a shuffle seeded by the session ID), every client produces the identical partition — the same consensus
  property `plugin-multiplayer-role` relies on.
- Participants who have `left` are dropped, and the group isn't ready until every remaining participant
  is `connected`. A participant who is only `away`, such as a slot left over from an earlier member,
  can't be matched, and clients don't partition while they disagree about who is still there.
- On a **timeout** the trial fails loud (`matched_self: false, multiplayer_outcome: "timeout",
match_map: null`) rather than hanging. The same happens, with the matching `multiplayer_outcome`,
  if a participant in `participants` leaves (`"participant_left"`, with `left_participant`) or this
  participant's connection is lost (`"connection_lost"`). A non-divisible count with
  `leftover: "error"` is a **config error**, not a timeout — it rejects the trial so you notice,
  rather than silently dropping a participant.

## Reading your match downstream

The trial records the agreed map in its data, and the accessors read the most recent match trial's
data, so later trials can find their partners without re-deriving the partition:

```js
import MultiplayerMatch from "@jspsych-multiplayer/plugin-multiplayer-match";

// Who this participant is paired with:
const partnerId = MultiplayerMatch.getMyPartners()[0];

// Or derive a role-within-pair from the seat, then hand off to plugin-multiplayer-role / -choice:
const iGoFirst = MultiplayerMatch.getMyPosition() === 0;
```

`getMyMatch()`, `getMyPartners()`, `getMyGroup()`, `getMyPosition()`, and `getMatchMap()` reflect the
most recent match trial; after a trial that ended unmatched they return `undefined` (or `[]` for
partners). Called without arguments they read the jsPsych instance that most recently ran a match
trial; on a page with several instances, pass one, e.g. `getMyPartners(jsPsych)`.

## Author / Citation

Mandy Liao
