# plugin-multiplayer-choice

A simultaneous group decision: every participant picks one of the same options, the trial pushes that pick and waits (a barrier) until all `expected_players` have chosen, then optionally reveals everyone's choices. It is the engine under simultaneous-move paradigms — prisoner's dilemma, public-goods contributions, dictator/coordination games. An optional `payoff` hook scores the round; with no hook the plugin stays a pure decision primitive and you derive payoffs from `choices_by_player` in `on_finish`. See the [README](../README.md) for the barrier/payoff details.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified.

| Parameter          | Type               | Default Value                                       | Description                                                                                                                        |
| ------------------ | ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `choices`          | string[]           | _undefined_                                         | The options this participant can pick from (button contents, HTML allowed). The clicked option's zero-based index is shared with the group. |
| `prompt`           | HTML string        | `null`                                              | Question / instructions above the buttons.                                                                                        |
| `button_html`      | function           | `null`                                              | `(choice, index) => html` for each button (jsPsych convention). Null uses a plain `jspsych-btn`.                                  |
| `data_key`         | string             | `"choice"`                                          | Session field this participant's choice is stored under.                                                                          |
| `expected_players` | integer            | _undefined_                                         | Group size, including this participant, that must choose before the barrier lifts.                                               |
| `waiting_message`  | HTML string        | `"<p>Waiting for the other players to choose…</p>"` | Shown after choosing, while waiting for the group.                                                                               |
| `timeout`          | integer            | `null`                                              | Milliseconds to wait for the group after choosing; on expiry the trial proceeds partial with `timed_out: true`. Null waits forever. |
| `on_timeout`       | function           | `null`                                              | `(waitError) => void` called if `timeout` elapses before everyone has chosen.                                                     |
| `reveal`           | boolean            | `true`                                              | Reveal every player's choice after the barrier. `false` ends as soon as the group has chosen.                                    |
| `reveal_prompt`    | HTML string        | `null`                                              | Heading above the reveal list.                                                                                                    |
| `continue_label`   | string             | `"Continue"`                                        | Button that ends the reveal. Null hides it (then set `reveal_duration`).                                                          |
| `reveal_duration`  | integer            | `null`                                              | Auto-advance the reveal after this many ms.                                                                                       |
| `player_label`     | function           | `null`                                              | `(participantId) => string` name shown on the reveal list.                                                                        |
| `payoff`           | function           | `null`                                              | Optional `(choices, me) => number` payoff for this client; saved as `my_payoff` and shown on the reveal.                          |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects:

| Name                | Type    | Value                                                                                 |
| ------------------- | ------- | ------------------------------------------------------------------------------------- |
| `choice`            | string  | This participant's chosen option label.                                               |
| `choice_index`      | integer | Zero-based index of the chosen option.                                                |
| `rt`                | integer | Time from the options appearing to the click, in ms.                                  |
| `wait_time`         | integer | Time spent waiting for the group after choosing, in ms.                               |
| `choices_by_player` | object  | Every player's choice at the barrier: `{ participantId: { index, label } }`.          |
| `n_players`         | integer | Number of participants who had chosen when the barrier resolved (or timed out).       |
| `my_payoff`         | float   | This client's payoff from the `payoff` hook; `null` if no hook.                        |
| `timed_out`         | boolean | `true` if the trial proceeded because `timeout` elapsed.                               |
| `wait_error`        | string  | The `wait()` rejection message when the barrier ended without the full group; else `null`. |

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
    const other = Object.entries(choices).find(([id]) => id !== me)[1].index;
    return [
      [3, 0],
      [5, 1],
    ][mine][other];
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
    const pot = Object.values(data.choices_by_player).reduce(
      (sum, c) => sum + Number(c.label),
      0
    );
    data.group_return = (pot * 1.6) / 4; // split the multiplied pot
  },
};
```
