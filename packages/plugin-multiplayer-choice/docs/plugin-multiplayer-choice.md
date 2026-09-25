# plugin-multiplayer-choice

A simultaneous group decision: every participant picks one of the same options, the trial writes that pick to the trial's shared data and waits (a barrier) until all `expected_players` have chosen, then optionally reveals the outcome. It is the engine under simultaneous-move paradigms — prisoner's dilemma, public-goods contributions, dictator/coordination games — and, in tally mode, under anonymous group polls (majority-rule choices, "vote for the next round"). `reveal_mode: "players"` (default) lists who chose what; `reveal_mode: "tally"` shows only per-option counts and the plurality winner. An optional `payoff` hook scores the round; with no hook the plugin stays a pure decision primitive and you derive payoffs from `choices_by_player` in `on_finish`. See the [README](../README.md) for the barrier/payoff/anonymity details.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified.

| Parameter                  | Type        | Default Value                                       | Description                                                                                                                                 |
| -------------------------- | ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `choices`                  | string[]    | _undefined_                                         | The options this participant can pick from (button contents, HTML allowed). The clicked option's zero-based index is shared with the group. |
| `prompt`                   | HTML string | `null`                                              | Question / instructions above the buttons.                                                                                                  |
| `button_html`              | function    | `null`                                              | `(choice, index) => html` for each button (jsPsych convention). Null uses a plain `jspsych-btn`.                                            |
| `expected_players`         | integer     | `null`                                              | Group size, including this participant, that must choose before the barrier lifts. `null` counts the members of a sealed group who haven't left; without a sealed group it is required. |
| `waiting_message`          | HTML string | `"<p>Waiting for the other players to choose…</p>"` | Shown after choosing, while waiting for the group.                                                                                          |
| `timeout`                  | integer     | `null`                                              | Milliseconds to wait for the group after choosing; on expiry the trial proceeds partial with `multiplayer_outcome: "timeout"`. `null`, `0`, or a negative value waits forever.         |
| `on_timeout`               | function    | `null`                                              | `(waitError) => void` called if `timeout` elapses before everyone has chosen.                                                               |
| `participants`             | array       | `null`                                              | Participants the barrier depends on; if one leaves first, the trial proceeds partial with `multiplayer_outcome: "participant_left"`. `null` means the other group members who haven't left; `[]` ignores departures. |
| `reveal`                   | boolean     | `true`                                              | Reveal the group's decision after the barrier. `false` ends as soon as the group has chosen.                                                |
| `reveal_mode`              | string      | `"players"`                                         | `"players"` lists every player's choice, attributed; `"tally"` shows per-option counts + the plurality winner only (anonymous poll).        |
| `reveal_prompt`            | HTML string | `null`                                              | Heading above the reveal.                                                                                                                   |
| `continue_label`           | string      | `"Continue"`                                        | Button that ends the reveal. Null hides it (then set `reveal_duration`).                                                                    |
| `reveal_duration`          | integer     | `null`                                              | Auto-advance the reveal after this many ms.                                                                                                 |
| `player_label`             | function    | `null`                                              | `(participantId) => string` name shown on the reveal list (`"players"` mode only).                                                          |
| `payoff`                   | function    | `null`                                              | Optional `(choices, me) => number` payoff for this client; saved as `my_payoff` and shown on the reveal (both modes).                       |
| `record_choices_by_player` | boolean     | `true`                                              | Whether to save the participant → choice map as `choices_by_player`. `false` keeps the recorded data anonymous (aggregate only).            |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects:

| Name                | Type    | Value                                                                                                                           |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `choice`            | string  | This participant's chosen option label.                                                                                         |
| `choice_index`      | integer | Zero-based index of the chosen option.                                                                                          |
| `rt`                | integer | Time from the options appearing to the click, in ms.                                                                            |
| `wait_time`         | integer | Time spent waiting for the group after choosing, in ms.                                                                         |
| `choices_by_player` | object  | Every player's choice at the barrier: `{ participantId: { index, label } }`. `null` when `record_choices_by_player` is `false`. |
| `n_players`         | integer | Number of participants whose choice counted when the barrier resolved (or timed out).                                           |
| `tally`             | object  | The aggregate count: one `{ index, label, count }` per option, in `choices` order.                                              |
| `winner`            | object  | The plurality winner `{ index, label, count }`, or `null` on a tie / no picks.                                                  |
| `is_tie`            | boolean | `true` when two or more options shared the top count.                                                                           |
| `tied_options`      | object  | The options sharing the top count when `is_tie` is true; empty otherwise.                                                       |
| `my_payoff`         | float   | This client's payoff from the `payoff` hook; `null` if no hook.                                                                 |
| `multiplayer_outcome` | string | How the barrier ended: `"completed"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`. |
| `left_participant`  | string  | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`; else `null`.                            |

## Install

```js
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-choice"></script>
```

```
npm install @jspsych-multiplayer/plugin-multiplayer-choice
```

```js
import MultiplayerChoice from "@jspsych-multiplayer/plugin-multiplayer-choice";
```

## Examples

### A one-shot prisoner's dilemma

```javascript
const pd = {
  type: jsPsychMultiplayerChoice,
  prompt: "<p>Choose simultaneously with your partner.</p>",
  choices: ["Cooperate", "Defect"],
  expected_players: 2,
  reveal_prompt: "<h3>Both players have chosen</h3>",
  payoff: (choices, me) => {
    const mine = choices[me].index;
    // Find the other player's choice
    let other;
    for (const id in choices) {
      if (id !== me) {
        other = choices[id].index;
      }
    }
    return [
      [3, 0],
      [5, 1],
    ][mine][other];
  },
};
```

### An anonymous group poll (tally mode)

```javascript
const nextGame = {
  type: jsPsychMultiplayerChoice,
  prompt: "<p>Which game should the group play next? Majority wins.</p>",
  choices: ["Trust", "Ultimatum", "Public goods"],
  expected_players: 4,
  reveal_mode: "tally", // reveal counts + winner, never who chose what
  record_choices_by_player: false, // keep the recorded data anonymous too
  reveal_prompt: "<h3>The votes are in</h3>",
  on_finish: (data) => {
    data.next_game = data.winner ? data.winner.label : "Public goods"; // winner is null on a tie
  },
};
```

### A public-goods contribution (score in on_finish)

```javascript
const contribute = {
  type: jsPsychMultiplayerChoice,
  prompt: "<p>How much of your 10 tokens do you contribute?</p>",
  choices: ["0", "2", "5", "10"],
  expected_players: 4,
  on_finish: (data) => {
    // Add up everyone's contribution
    let pot = 0;
    for (const id in data.choices_by_player) {
      pot += Number(data.choices_by_player[id].label);
    }
    data.group_return = (pot * 1.6) / 4; // split the multiplied pot
  },
};
```
