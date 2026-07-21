# plugin-multiplayer-match

Partition a multiplayer group into matched sub-groups (pairs by default, or triads/larger) by deterministic consensus: every client independently computes the same partition from the shared group-session snapshot, with no coordinator. It runs as a short barrier (like `plugin-multiplayer-role`), exposes this client's partners to downstream trials via static accessors, and saves the assignment to the data record. It is the foundational primitive under pairwise/small-group paradigms (trust game, ultimatum, dyadic negotiation) and composes with `plugin-multiplayer-role` (assign roles within a group via `position`). See the [README](../README.md) for the strategy/leftover details.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified.

| Parameter          | Type        | Default Value                  | Description                                                                                                                        |
| ------------------ | ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `group_size`       | integer     | `2`                            | Members per matched group (2 = dyads, 3 = triads). Integer ≥ 2.                                                                   |
| `expected_players` | integer     | `null`                         | Wait for exactly this many participants before partitioning. `null` trusts an upstream barrier (warns).                          |
| `strategy`         | string      | `"ordered"`                    | Ordering before chunking: `"ordered"` (by id), `"join_order"` (by `joinedAt`), or `"random"` (seeded, per-round).                |
| `seed`             | string      | `null`                         | Shared seed for `"random"`; defaults to a hash of the sorted ids + `round`.                                                      |
| `round`            | integer     | `0`                            | Round index, for `"random"` re-pairing.                                                                                          |
| `leftover`         | string      | `"error"`                      | Non-divisible count policy: `"error"`, `"spectator"`, or `"smaller_group"`.                                                      |
| `ready`            | function    | `null`                         | `(snapshot) => boolean` overriding the readiness gate.                                                                           |
| `push_data`        | object      | `{}`                           | Extra data merged into this client's session entry (alongside `joinedAt`).                                                       |
| `save_group`       | boolean     | `false`                        | Include the full snapshot in the trial data.                                                                                     |
| `timeout`          | integer     | `30000`                        | Milliseconds to wait for readiness before failing loud. `null` waits forever.                                                    |
| `on_timeout`       | function    | `null`                         | Hook run on timeout; the trial always ends `matched_self: false, timed_out: true`.                                              |
| `message`          | HTML string | `"<p>Finding your match…</p>"` | Shown while waiting.                                                                                                             |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects:

| Name           | Type    | Value                                                                                 |
| -------------- | ------- | ------------------------------------------------------------------------------------- |
| `match_group`  | integer | This participant's group index; `null` if a spectator or on timeout.                  |
| `partners`     | array   | The other members of the group; `null` on timeout, `[]` if a spectator.               |
| `members`      | array   | All members (including self) in consensus order; `null` on timeout.                   |
| `position`     | integer | This participant's 0-based seat within its group; `null` if a spectator/timeout.      |
| `match_map`    | object  | The full `participantId -> { group, members, partners, position }` map; `null` on timeout. |
| `matched_self` | boolean | Whether this participant was placed in a group (distinguishes spectator from timeout). |
| `timed_out`    | boolean | `true` if readiness was not reached before `timeout`.                                  |
| `group`        | object  | The full snapshot — only when `save_group: true`.                                     |

## Install

```js
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-match"></script>
```

```
npm install @jspsych-multiplayer/plugin-multiplayer-match
```

```js
import MultiplayerMatch from "@jspsych-multiplayer/plugin-multiplayer-match";
```

## Examples

### Pair up eight players, then play a dyadic game

```javascript
const match = {
  type: jsPsychMultiplayerMatch,
  expected_players: 8,
  group_size: 2,
  strategy: "random", // unpredictable-by-id, identical on every client
};

// A later trial reads its partner from the store:
const play = {
  type: jsPsychMultiplayerChoice,
  choices: ["Cooperate", "Defect"],
  expected_players: 2,
  // Namespace the round by the pair (both members share the same members array) so two dyads
  // don't collide in the shared session:
  data_key: () => "pd_" + jsPsychMultiplayerMatch.getMyMatch().members.join("_"),
};
```

### Re-pair each round of a repeated game

```javascript
// Increment `round` each block to shuffle partners anew (deterministically, on every client).
const rematch = (round) => ({
  type: jsPsychMultiplayerMatch,
  expected_players: 6,
  strategy: "random",
  round,
});
```

### Assign a role within each pair

```javascript
// position 0 -> proposer, position 1 -> responder, decided by the same consensus partition.
const proposerScreen = {
  timeline: [proposalTrial],
  conditional_function: () => jsPsychMultiplayerMatch.getMyPosition() === 0,
};
```
