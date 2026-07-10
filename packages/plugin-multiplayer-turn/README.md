# plugin-multiplayer-turn

A **sequential turn-taking coordinator** for multiplayer experiments. Every participant runs this one
trial; it works out **whose turn it is** from the shared session (the active player is the first in the
turn order who hasn't moved yet), shows the active player a prompt + a commit button, and shows
everyone else a live **"waiting for X"** status plus the **moves so far**. When the active player
commits, their move is pushed, the turn advances, and the trial ends for **everyone** once the whole
sequence is complete (or `timeout` elapses). It unlocks sequential-move paradigms — **ultimatum,
bargaining, sequential public-goods, any take-turns game**.

It is a **coordinator, not a decision UI**: the move VALUE is yours to supply via `get_move` (often
reading a decision made in an earlier trial), so it composes with the other primitives:

- pair up with [`plugin-multiplayer-match`](../plugin-multiplayer-match), then set
  `turn_order: () => jsPsychMultiplayerMatch.getMyMatch().members` so each pair takes turns among
  themselves;
- make the actual decision with [`plugin-multiplayer-choice`](../plugin-multiplayer-choice) (or any
  jsPsych trial) and have `get_move` read its result.

Built on the multiplayer API's real-time `subscribe` primitive, like
[`plugin-multiplayer-chat`](../plugin-multiplayer-chat).

> **Status.** The pure core, the trial wrapper, and the tests are all implemented. The wrapper is
> written against a local interface mirroring the jsPsych multiplayer API
> ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)); to actually run a trial you need
> that API present at runtime plus a network adapter (e.g. JATOS group sessions) and several real
> participants in the same group.

## Loading

### In browser

```html
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-turn"></script>
```

### Via NPM

```
npm install @jspsych-multiplayer/plugin-multiplayer-turn
```

```js
import MultiplayerTurn from "@jspsych-multiplayer/plugin-multiplayer-turn";
// The pure core is reachable as static members:
//   MultiplayerTurn.resolveTurnOrder, .activeIndex, .collectMoves
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-turn` requires jsPsych v8.0.0 or later, plus a multiplayer
API adapter (e.g. JATOS group sessions).

## Parameters

| Parameter          | Type        | Default      | Description                                                                                                                                    |
| ------------------ | ----------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_move`         | fn          | `null`       | `(jsPsych) => value` producing this client's move, called when it commits (on the button, or immediately if `submit_label` is null). Read a decision made in an earlier trial here. Null commits a `null` move. |
| `turn_order`       | fn \| array | `null`       | The order of play: an explicit array of participantIds (stable — e.g. `() => match.getMyMatch().members`), a function `(sortedIds) => ids`, or null (default: participantIds sorted). Must resolve to the SAME order on every client. |
| `data_key`         | string      | `"turn"`     | Session field moves are stored under. **Namespace it per game** (e.g. per matched pair) so two concurrent sequences don't count each other's moves. |
| `prompt`           | HTML string | `null`       | Shown to the active player above the commit button.                                                                                           |
| `submit_label`     | string      | `"Submit"`   | The active player's commit button. `null` auto-commits the instant it's their turn (no button).                                               |
| `player_label`     | fn          | `null`       | `(participantId) => string` display name in the status/history. Null shows the raw id.                                                         |
| `format_move`      | fn          | `null`       | `(move, participantId) => string` rendering a move in the history. Null uses `String(move)`.                                                   |
| `waiting_message`  | fn          | `null`       | `(activePlayerId, group) => html` overriding the "waiting for X" status.                                                                       |
| `show_history`     | bool        | `true`       | Show the running list of moves taken so far.                                                                                                   |
| `expected_players` | int         | `null`       | Freeze the turn order only once this many participants are present. `null` freezes as soon as this client is present — safe only behind an upstream barrier, or with an explicit `turn_order` array (a warning fires otherwise). |
| `timeout`          | int         | `null`       | Milliseconds before giving up if the sequence stalls (a player abandoned). `null` waits forever.                                               |
| `on_timeout`       | fn          | `null`       | Hook run if `timeout` elapses before completion. The trial ends `timed_out: true` regardless.                                                  |

## Data generated

| Name          | Type   | Description                                                                    |
| ------------- | ------ | ---------------------------------------------------------------------------- |
| `moves`       | array  | The ordered move sequence: `[{ participantId, move, position }]`.             |
| `my_move`     | any    | This client's own move; `null` if it never took a turn.                      |
| `my_position` | int    | This client's index in the turn order; `null` if it was a spectator.         |
| `rt`          | int    | This client's response time (ms), from when it became its turn to committing; `null` if it never took a turn. |
| `num_turns`   | int    | Total number of turns (the turn order's length).                             |
| `ended_by`    | string | `"complete"` (every turn taken) or `"timeout"`.                              |
| `timed_out`   | bool   | `true` if the trial ended because `timeout` elapsed before completion.        |

## How the turn pointer works

No separate shared counter is needed: the active player is **derived** from the moves already in the
session — the first participant in the turn order that hasn't recorded a move under `data_key`. Each
client independently computes the same answer from the same snapshot (the consensus property the other
multiplayer plugins rely on). When the active player commits, the move lands in the session, the
pointer advances on every client's next `subscribe` frame, and once the pointer passes the last player
the trial ends for everyone with the full `moves` sequence.

The non-active players' UI is gated (no commit button), so moves are taken in order; a stray
out-of-turn push is ignored — the pointer never advances past a player who hasn't actually moved.

## Example: a one-shot ultimatum game

```js
// After pairing with plugin-multiplayer-match and choosing an offer/response in earlier trials,
// take turns: the proposer commits first, then the responder.
const takeTurn = {
  type: jsPsychMultiplayerTurn,
  data_key: () => "ultimatum_" + jsPsychMultiplayerMatch.getMyMatch().members.join("_"), // per pair
  turn_order: () => jsPsychMultiplayerMatch.getMyMatch().members, // proposer = seat 0, responder = seat 1
  prompt: "<p>It's your move. Click to lock it in.</p>",
  get_move: () => jsPsych.data.get().last(1).values()[0].response, // the decision made just before
  format_move: (m, id) => `${m}`,
  timeout: 60000,
};
```

## Author / Citation

Mandy Liao
