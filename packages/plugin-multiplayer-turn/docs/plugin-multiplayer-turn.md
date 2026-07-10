# plugin-multiplayer-turn

A sequential turn-taking coordinator: every participant runs one live trial that works out whose turn it is from the shared session (the active player is the first in the turn order who hasn't moved), shows the active player a prompt + commit button and everyone else a "waiting for X" status plus the move history, and ends for everyone once the sequence completes. It is a coordinator, not a decision UI — the move value is supplied via `get_move` — so it composes with `plugin-multiplayer-match` and `plugin-multiplayer-choice`. Built on the multiplayer API's `subscribe` primitive. See the [README](../README.md) for the turn-pointer details.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters.

| Parameter          | Type              | Default    | Description                                                                                                                        |
| ------------------ | ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `get_move`         | function          | `null`     | `(jsPsych) => value` producing this client's move at commit time (reads an earlier decision). Null commits `null`.               |
| `turn_order`       | function \| array | `null`     | Explicit id array, `(sortedIds) => ids`, or null (default: sorted ids). Must be identical on every client.                        |
| `data_key`         | string            | `"turn"`   | Session field moves are stored under. Namespace per game (e.g. per pair).                                                        |
| `prompt`           | HTML string       | `null`     | Shown to the active player above the commit button.                                                                             |
| `submit_label`     | string            | `"Submit"` | The commit button; `null` auto-commits with no button.                                                                          |
| `player_label`     | function          | `null`     | `(participantId) => string` display name.                                                                                        |
| `format_move`      | function          | `null`     | `(move, participantId) => string` for the history.                                                                              |
| `waiting_message`  | function          | `null`     | `(activePlayerId, group) => html` overriding the waiting status.                                                                 |
| `show_history`     | boolean           | `true`     | Show the moves-so-far list.                                                                                                      |
| `expected_players` | integer           | `null`     | Freeze the order only once this many are present. Null freezes as soon as this client is present (warns).                        |
| `timeout`          | integer           | `null`     | Milliseconds before giving up if the sequence stalls. Null waits forever.                                                        |
| `on_timeout`       | function          | `null`     | Hook run on timeout; the trial ends `timed_out: true`.                                                                          |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects:

| Name          | Type    | Value                                                              |
| ------------- | ------- | ----------------------------------------------------------------- |
| `moves`       | array   | The ordered move sequence: `[{ participantId, move, position }]`. |
| `my_move`     | any     | This client's own move; `null` if it never took a turn.           |
| `my_position` | integer | This client's index in the turn order; `null` if a spectator.     |
| `rt`          | integer | This client's response time (ms), turn-start to commit; `null` if it never took a turn. |
| `num_turns`   | integer | Total number of turns.                                            |
| `ended_by`    | string  | `"complete"` or `"timeout"`.                                      |
| `timed_out`   | boolean | `true` if it ended on `timeout`.                                  |

## Install

```js
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-turn"></script>
```

```
npm install @jspsych-multiplayer/plugin-multiplayer-turn
```

```js
import MultiplayerTurn from "@jspsych-multiplayer/plugin-multiplayer-turn";
```

## Examples

### A one-shot ultimatum game (match → decide → take turns)

```javascript
// 1. Pair up (plugin-multiplayer-match). 2. The proposer/responder each make their decision in an
// earlier trial. 3. Take turns to commit them, proposer first:
const takeTurn = {
  type: jsPsychMultiplayerTurn,
  data_key: () => "ultimatum_" + jsPsychMultiplayerMatch.getMyMatch().members.join("_"),
  turn_order: () => jsPsychMultiplayerMatch.getMyMatch().members, // seat 0 first
  prompt: "<p>Lock in your move.</p>",
  get_move: () => jsPsych.data.get().last(1).values()[0].response,
  timeout: 60000,
};
```

### Auto-commit (no button) when the move is already decided

```javascript
const reveal = {
  type: jsPsychMultiplayerTurn,
  turn_order: () => jsPsychMultiplayerMatch.getMyMatch().members,
  submit_label: null, // commit the instant it's your turn — the sequence plays itself out
  get_move: () => jsPsych.data.get().last(1).values()[0].points,
  format_move: (pts) => `${pts} points`,
};
```
