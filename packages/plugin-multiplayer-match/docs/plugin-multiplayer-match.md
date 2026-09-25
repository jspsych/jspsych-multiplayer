# plugin-multiplayer-match

Partition a multiplayer group into matched sub-groups (pairs by default, or triads/larger) by deterministic consensus: every client independently computes the same partition from the shared group-session snapshot, with no coordinator. It runs as a short barrier (like `plugin-multiplayer-role`) and saves the assignment to the data record, where static accessors read it for downstream trials. It is the foundational primitive under pairwise/small-group paradigms (trust game, ultimatum, dyadic negotiation) and composes with `plugin-multiplayer-role` (assign roles within a group via `position`). See the [README](../README.md) for the strategy/leftover details.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified.

| Parameter          | Type        | Default Value                  | Description                                                                                                                                                                                                                                                                                     |
| ------------------ | ----------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group_size`       | integer     | `2`                            | Members per matched group (2 = dyads, 3 = triads). Integer ≥ 2.                                                                                                                                                                                                                                 |
| `expected_players` | integer     | `null`                         | Wait for exactly this many participants to reach this trial before partitioning. `null` counts the members of a sealed group who haven't left, or else trusts an upstream barrier (warns).                                                                                                      |
| `strategy`         | string      | `"ordered"`                    | Ordering before chunking: `"ordered"` (by id), `"join_order"` (by `joinedAt` in the session data), or `"random"` (seeded by the session, per-round).                                                                                                                                            |
| `seed`             | string      | `null`                         | Picks a different random grouping within the session. Randomness is seeded by the session ID (or the `randomSeed` connect option), so each group of participants gets its own grouping.                                                                                                         |
| `round`            | integer     | `0`                            | Round index, for `"random"` re-pairing.                                                                                                                                                                                                                                                         |
| `leftover`         | string      | `"error"`                      | Non-divisible count policy: `"error"`, `"spectator"`, or `"smaller_group"`.                                                                                                                                                                                                                     |
| `ready`            | function    | `null`                         | `(snapshot, presence) => boolean` overriding the readiness gate. `snapshot` holds the participants who have reached this trial and haven't left.                                                                                                                                                |
| `write_data`       | object      | `{}`                           | Data merged into this client's data in the trial's own scope, so it never reaches another trial. Each snapshot entry is the participant's session data with this merged over it. Must be JSON-safe — it is deep-copied with `JSON.stringify`, so `Date`/`undefined`/`Map`/`NaN` do not survive. |
| `save_group`       | boolean     | `false`                        | Include the full snapshot in the trial data.                                                                                                                                                                                                                                                    |
| `timeout`          | integer     | `30000`                        | Milliseconds to wait for readiness before failing loud. `null`, `0`, or a negative value waits forever.                                                                                                                                                                                         |
| `on_timeout`       | function    | `null`                         | Hook run on timeout; the trial always ends `matched_self: false, multiplayer_outcome: "timeout"`.                                                                                                                                                                                               |
| `participants`     | array       | `null`                         | Participants the match depends on; if one leaves first, the trial ends with `multiplayer_outcome: "participant_left"`. `null` means the rest of a sealed group, or else the others connected now; `[]` ignores departures.                                                                      |
| `message`          | HTML string | `"<p>Finding your match…</p>"` | Shown while waiting.                                                                                                                                                                                                                                                                            |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects:

| Name                  | Type    | Value                                                                                                     |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `match_group`         | integer | This participant's group index; `null` if a spectator or unmatched.                                       |
| `partners`            | array   | The other members of the group; `null` if unmatched, `[]` if a spectator.                                 |
| `members`             | array   | All members (including self) in consensus order; `null` if unmatched.                                     |
| `position`            | integer | This participant's 0-based seat within its group; `null` if a spectator or unmatched.                     |
| `match_map`           | object  | The full `participantId -> { group, members, partners, position }` map; `null` if unmatched.              |
| `matched_self`        | boolean | Whether this participant was placed in a group (distinguishes spectator from unmatched).                  |
| `multiplayer_outcome` | string  | How the trial ended: `"completed"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`.            |
| `left_participant`    | string  | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`; `null` otherwise. |
| `group`               | object  | The full snapshot — only when `save_group: true`.                                                         |

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

// A later trial reads its partner from the match trial's data:
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
