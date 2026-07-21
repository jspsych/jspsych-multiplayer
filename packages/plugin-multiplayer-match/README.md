# plugin-multiplayer-match

Partition a multiplayer group into **matched sub-groups** — pairs by default, or triads/larger — by
**deterministic consensus**: every client independently computes the _same_ partition from the shared
group-session snapshot, with no coordinator and no extra round-trip. It is the foundational primitive
under every pairwise / small-group paradigm — **trust game, ultimatum, dyadic negotiation,
partner-based coordination** — and composes with the other primitives:

- pair up with **`plugin-multiplayer-match`**, then assign a role _within_ each pair with
  [`plugin-multiplayer-role`](../plugin-multiplayer-role) (drive it off `position`), then play a round
  with [`plugin-multiplayer-choice`](../plugin-multiplayer-choice) namespaced per partner.

Like [`plugin-multiplayer-role`](../plugin-multiplayer-role), it runs as a short **barrier** (push →
wait): it waits until the group is ready, partitions the resolved snapshot, and — because the
partition is a pure function of the snapshot — every client agrees on who is paired with whom.

> **Status.** The pure core, the trial wrapper, and the tests are all implemented. The wrapper is
> written against a local interface mirroring the jsPsych multiplayer API
> ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)); to actually run a trial you need
> that API present at runtime plus a network adapter (e.g. JATOS group sessions) and several real
> participants in the same group.

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
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-match` requires jsPsych v8.0.0 or later, plus a multiplayer
API adapter (e.g. JATOS group sessions).

## Parameters

| Parameter          | Type        | Default                        | Description                                                                                                                                     |
| ------------------ | ----------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `group_size`       | int         | `2`                            | Members per matched group (2 = dyads, 3 = triads, …). Must be an integer ≥ 2.                                                                  |
| `expected_players` | int         | `null`                         | Wait for **exactly** this many participants before partitioning (fail-loud: an overshoot stalls to a timeout). `null` trusts an upstream barrier and partitions whoever is present as soon as this client has pushed (a warning fires). |
| `strategy`         | string      | `"ordered"`                    | Ordering before chunking: `"ordered"` (by id), `"join_order"` (by pushed `joinedAt`), or `"random"` (a seeded shuffle — unpredictable-by-id yet identical on every client). Prefer `"random"` for real experiments to avoid pairings that track id order. |
| `seed`             | string      | `null`                         | Shared seed for `"random"`. Defaults to a hash of the sorted ids + `round`.                                                                    |
| `round`            | int         | `0`                            | Round index, for `"random"` re-pairing. Increment each re-run to shuffle partners anew.                                                        |
| `leftover`         | string      | `"error"`                      | When the count isn't a multiple of `group_size`: `"error"` (throw), `"spectator"` (leave the extras unmatched), or `"smaller_group"` (one final undersized group). |
| `ready`            | fn          | `null`                         | `(snapshot) => boolean` overriding the readiness gate. `null` derives it from `expected_players` (and, for `join_order`, that everyone has pushed `joinedAt`). |
| `push_data`        | object      | `{}`                           | Extra data this client contributes into the shared session (merged alongside `joinedAt`).                                                      |
| `save_group`       | bool        | `false`                        | Include the full group snapshot in the trial data.                                                                                            |
| `timeout`          | int         | `30000`                        | Milliseconds to wait for readiness before failing loud. `null` waits forever (discouraged).                                                    |
| `on_timeout`       | fn          | `null`                         | Hook run on timeout. The trial always ends with `matched_self: false, timed_out: true` regardless.                                             |
| `message`          | HTML string | `"<p>Finding your match…</p>"` | Shown while waiting for the group.                                                                                                             |

## Data generated

| Name           | Type    | Description                                                                          |
| -------------- | ------- | ----------------------------------------------------------------------------------- |
| `match_group`  | int     | This participant's group index; `null` if a spectator or on timeout.                |
| `partners`     | array   | The other members of this participant's group; `null` on timeout, `[]` if a spectator. |
| `members`      | array   | All members of the group (including self), in consensus order; `null` on timeout.   |
| `position`     | int     | This participant's 0-based seat within its group; `null` if a spectator or on timeout. |
| `match_map`    | object  | The full `participantId -> { group, members, partners, position }` map; `null` on timeout. |
| `matched_self` | bool    | Whether this participant was placed in a group — distinguishes a spectator from a timeout. |
| `timed_out`    | bool    | `true` if readiness was not reached before `timeout`.                               |
| `group`        | object  | The full snapshot partitioned over — only when `save_group: true`.                  |

## How the partition works

Each client pushes `joinedAt` (first-seen) plus any `push_data`, then the trial waits until the group
is ready and partitions the resolved snapshot with the same pure function on every client:

- Participants are ordered (per `strategy`) starting from a **stable id sort**, then chunked into
  groups of `group_size`. Because the ordering is a deterministic function of the snapshot (and, for
  `"random"`, a shared seed), every client produces the identical partition — the same consensus
  property `plugin-multiplayer-role` relies on.
- On a **timeout** the trial fails loud (`matched_self: false, timed_out: true, match_map: null`)
  rather than hanging. A non-divisible count with `leftover: "error"` is a **config error**, not a
  timeout — it rejects the trial so you notice, rather than silently dropping a participant.

## Reading your match downstream

The plugin publishes this client's assignment to a module-level store so later trials can find their
partners without re-deriving the partition:

```js
import MultiplayerMatch from "@jspsych-multiplayer/plugin-multiplayer-match";

// Namespace a decision per partner so two pairs don't collide in the shared session:
const partnerId = MultiplayerMatch.getMyPartners()[0];

// Or derive a role-within-pair from the seat, then hand off to plugin-multiplayer-role / -choice:
const iGoFirst = MultiplayerMatch.getMyPosition() === 0;
```

## Author / Citation

Mandy Liao
