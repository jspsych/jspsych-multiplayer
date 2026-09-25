# plugin-multiplayer-role

Assigns each participant in a multiplayer group a role by deterministic consensus: every client independently computes the same role map from the shared group-session snapshot, with no coordinator and no extra round-trip. Runs as a short barrier trial — it waits until the group is ready, computes the map, and saves the assignment to the data record, where static accessors read it for downstream trials. See the [README](../README.md) for strategies, rotation/balancing, what the strategies see, and reading your role downstream.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified. Other parameters can be left unspecified if the default value is acceptable.

| Parameter       | Type               | Default Value               | Description                                                                                                                                                                                                                                                               |
| --------------- | ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`         | array \| object    | _undefined_                 | Roles to hand out: an array (one slot per entry) or an object of counts (`{ leader: 1, follower: 3 }`).                                                                                                                                                                   |
| `strategy`      | string \| function | `"join_order"`              | How participants are ordered into slots: `"join_order"`, `"random"`, `"rotate"`, or a custom `(snapshot, ctx) => roleMap`.                                                                                                                                                |
| `group_size`    | integer            | `null`                      | Wait for **exactly** this many participants to reach this trial before computing (fail-loud). `null` counts the members of a sealed group who haven't left, or else trusts an upstream waiting-room barrier.                                                              |
| `round`         | integer            | `0`                         | Round index, for `rotate` and per-round `random`. Increment each re-run.                                                                                                                                                                                                  |
| `balanced`      | boolean            | `false`                     | For `rotate`: use the balanced (Williams / Latin-square) variant.                                                                                                                                                                                                         |
| `seed`          | string             | `null`                      | Picks a different random assignment within the session. Randomness is seeded by the session ID (or the `randomSeed` connect option), so each group gets its own assignment.                                                                                               |
| `rank_by`       | function           | `null`                      | `(entry, id, ctx) => number`. Order participants by a numeric key, highest first.                                                                                                                                                                                         |
| `role_from`     | function           | `null`                      | `(entry, id, ctx) => string`. The role **is** a value each participant already carries.                                                                                                                                                                                   |
| `ready`         | function           | `null`                      | `(snapshot, presence) => boolean`. Override the readiness gate; **required** when `strategy` is a custom function. `snapshot` holds the participants who have reached this trial and haven't left.                                                                        |
| `overflow_role` | string             | `null`                      | Role for participants beyond the declared slots — applies whenever the participant count exceeds the number of role slots. If unset, overflow throws.                                                                                                                     |
| `write_data`    | object             | `{}`                        | Data this client contributes to the snapshot (e.g. the score `rank_by` ranks on). Merged into this participant's data in the trial's own scope, so it never reaches another trial. Each entry in the snapshot is the participant's session data with this merged over it. |
| `save_group`    | boolean            | `false`                     | Include the full group snapshot in the trial data. Off by default to avoid bloat.                                                                                                                                                                                         |
| `timeout`       | integer            | `30000`                     | Milliseconds to wait for readiness before giving up. `null`, `0`, or a negative value waits forever (discouraged).                                                                                                                                                        |
| `on_timeout`    | function           | `null`                      | Hook run on timeout. The trial always ends with `role: null, multiplayer_outcome: "timeout"` regardless.                                                                                                                                                                  |
| `participants`  | array              | `null`                      | Participants the assignment depends on; if one leaves first, the trial ends with `multiplayer_outcome: "participant_left"`. `null` means the rest of a sealed group, or else the others connected now; `[]` ignores departures.                                           |
| `message`       | HTML string        | `"<p>Assigning roles…</p>"` | Shown while waiting.                                                                                                                                                                                                                                                      |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects the following data for each trial.

| Name                  | Type    | Value                                                                                                                                                                                                                                                               |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`                | string  | This participant's assigned role (`null` unless `multiplayer_outcome` is `"completed"`).                                                                                                                                                                            |
| `role_map`            | object  | The full `participantId -> { role }` map every client agreed on (`null` unless `multiplayer_outcome` is `"completed"`).                                                                                                                                             |
| `assigned_self`       | boolean | Whether this participant appears in the agreed map. `false` only when a custom strategy left them out (a spectator); overflow participants are in the map (with `overflow_role`), so they read `true`. Distinguishes the spectator case from an unassigned outcome. |
| `multiplayer_outcome` | string  | How the trial ended: `"completed"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`. If the wait is instead cancelled because the experiment ended or was aborted, the trial stops quietly and writes no record at all.                                   |
| `left_participant`    | string  | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`; `null` otherwise.                                                                                                                                                           |
| `group`               | object  | The full snapshot assigned over — only present when `save_group: true`.                                                                                                                                                                                             |

## Install

Using the CDN-hosted JavaScript file:

```js
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-role"></script>
```

Using the JavaScript file downloaded from a GitHub release dist archive:

```js
<script src="jspsych/plugin-multiplayer-role.js"></script>
```

Using NPM:

```
npm install @jspsych-multiplayer/plugin-multiplayer-role
```

```js
import MultiplayerRole from "@jspsych-multiplayer/plugin-multiplayer-role";
```

## Examples

### Assign proposer / responder after a waiting-room barrier

```javascript
const assignRole = {
  type: jsPsychMultiplayerRole,
  roles: ["proposer", "responder"], // two participants, one slot each
  strategy: "join_order", // earliest joiner is the proposer
  group_size: 2, // wait for exactly two before computing
};

// Branch a later trial on the assigned role:
const proposerOffer = {
  timeline: [offerTrial],
  conditional_function: () => jsPsychMultiplayerRole.getMyRole() === "proposer",
};
```

### Counterbalanced roles across rounds

```javascript
// Re-run the trial each round, incrementing `round`; `balanced` adds carryover balancing.
const assignThisRound = {
  type: jsPsychMultiplayerRole,
  roles: { leader: 1, follower: 3 },
  strategy: "rotate",
  balanced: true,
  round: jsPsych.timelineVariable("round"),
};
```
