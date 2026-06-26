# plugin-multiplayer-role

Assigns each participant in a multiplayer group a role by deterministic consensus: every client independently computes the same role map from the shared group-session snapshot, with no coordinator and no extra round-trip. Runs as a short barrier trial — it waits until the group is ready, computes the map, exposes the role to downstream trials via static accessors, and saves the assignment to the data record. See the [README](../README.md) for strategies, rotation/balancing, and reading your role downstream.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified. Other parameters can be left unspecified if the default value is acceptable.

| Parameter       | Type               | Default Value               | Description                                                                                                                |
| --------------- | ------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `roles`         | array \| object    | _undefined_                 | Roles to hand out: an array (one slot per entry) or an object of counts (`{ leader: 1, follower: 3 }`).                    |
| `strategy`      | string \| function | `"join_order"`              | How participants are ordered into slots: `"join_order"`, `"random"`, `"rotate"`, or a custom `(snapshot, ctx) => roleMap`. |
| `group_size`    | integer            | `null`                      | Wait for **exactly** this many participants before computing (fail-loud). `null` trusts an upstream waiting-room barrier.  |
| `round`         | integer            | `0`                         | Round index, for `rotate` and per-round `random`. Increment each re-run.                                                   |
| `balanced`      | boolean            | `false`                     | For `rotate`: use the balanced (Williams / Latin-square) variant.                                                          |
| `seed`          | string             | `null`                      | Shared seed for `random`. Defaults to a hash of the sorted ids + round.                                                    |
| `rank_by`       | function           | `null`                      | `(entry, id, ctx) => number`. Order participants by a numeric key, highest first.                                          |
| `role_from`     | function           | `null`                      | `(entry, id, ctx) => string`. The role **is** a value each participant already carries.                                    |
| `ready`         | function           | `null`                      | `(snapshot) => boolean`. Override the readiness gate; **required** when `strategy` is a custom function.                   |
| `overflow_role` | string             | `null`                      | Role for participants beyond the declared slots. Only meaningful when `group_size` is `null`.                              |
| `push_data`     | object             | `{}`                        | Round-scoped data this client contributes to the snapshot. Namespaced under the round so it never clobbers earlier rounds. |
| `save_group`    | boolean            | `false`                     | Include the full group snapshot in the trial data. Off by default to avoid bloat.                                          |
| `timeout`       | integer            | `30000`                     | Milliseconds to wait for readiness before giving up. `null` waits forever (discouraged).                                   |
| `on_timeout`    | function           | `null`                      | Hook run on timeout. The trial always ends with `role: null, timed_out: true` regardless.                                  |
| `message`       | HTML string        | `"<p>Assigning roles…</p>"` | Shown while waiting.                                                                                                       |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects the following data for each trial.

| Name            | Type    | Value                                                                                                      |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `role`          | string  | This participant's assigned role (`null` on timeout).                                                      |
| `role_map`      | object  | The full `participantId -> { role }` map every client agreed on (`null` on timeout).                       |
| `assigned_self` | boolean | Whether this participant appears in the map — distinguishes a spectator/overflow (`false`) from a timeout. |
| `timed_out`     | boolean | `true` if readiness was not reached before `timeout`.                                                      |
| `group`         | object  | The full snapshot assigned over — only present when `save_group: true`.                                    |

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
  strategy: "join_order",           // earliest joiner is the proposer
  group_size: 2,                    // wait for exactly two before computing
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
