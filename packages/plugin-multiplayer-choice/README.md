# plugin-multiplayer-choice

A **simultaneous group decision** for multiplayer experiments. Every participant picks one of the
same options; the trial pushes that pick and waits (a barrier) until the whole group has chosen, then
optionally reveals everyone's choices. It is the engine under simultaneous-move paradigms —
**prisoner's dilemma, public-goods contributions, dictator/coordination games** — packaging the
choose → push → wait → reveal flow as one declarative trial.

It builds on the jsPsych multiplayer API (`@jspsych/jspsych` group sessions). Like
[`plugin-multiplayer-sync`](../plugin-multiplayer-sync) it is a **barrier** trial (push → wait), but
it owns the option UI and the "everyone has chosen" condition, and adds a reveal. Keep the scoring in
your own game: pass a `payoff` hook, or (the default) leave it off and derive payoffs from
`choices_by_player` in `on_finish`.

> **Status.** The pure core, the trial wrapper, and the tests are all implemented. The wrapper is
> written against a local interface mirroring the jsPsych multiplayer API
> ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)); to actually run a trial you need
> that API present at runtime plus a network adapter (e.g. JATOS group sessions) and several real
> participants in the same group.

## Loading

### In browser

```html
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-choice"></script>
```

### Via NPM

```
npm install @jspsych-multiplayer/plugin-multiplayer-choice
```

```js
import MultiplayerChoice from "@jspsych-multiplayer/plugin-multiplayer-choice";
// The pure core is reachable as static members: MultiplayerChoice.collectChoices, .countChosen
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-choice` requires jsPsych v8.0.0 or later, plus a multiplayer
API adapter (e.g. JATOS group sessions).

## Parameters

| Parameter          | Type          | Default                                            | Description                                                                                                                            |
| ------------------ | ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `choices`          | string[]      | _undefined_ (required)                             | The options this participant can pick from — button contents (HTML allowed, experimenter-authored), like `html-button-response`. The clicked option's zero-based **index** is the value shared with the group. |
| `prompt`           | HTML string   | `null`                                             | Question / instructions rendered above the option buttons.                                                                           |
| `button_html`      | fn            | `null`                                             | `(choice, index) => html` producing each button's markup (jsPsych convention). Null uses a plain `jspsych-btn`.                       |
| `data_key`         | string        | `"choice"`                                         | Session field this participant's choice is stored under. Namespacing avoids colliding with other pushed data and separates two choice trials. |
| `expected_players` | int           | _undefined_ (required)                             | Group size, **including this participant**, that must choose before the barrier lifts. Set it to the exact expected count.            |
| `waiting_message`  | HTML string   | `"<p>Waiting for the other players to choose…</p>"`| Shown after this participant chooses, while waiting for the rest of the group.                                                        |
| `timeout`          | int           | `null`                                             | Milliseconds to wait for the group **after** choosing. On expiry the trial proceeds with whoever chose, flagged `timed_out: true`, and `on_timeout` fires. `null` waits indefinitely. Does not bound how long this participant takes to pick. |
| `on_timeout`       | fn            | `null`                                             | `(waitError) => void` called if `timeout` elapses before the group has all chosen.                                                    |
| `reveal`           | bool          | `true`                                             | Reveal every player's choice after the barrier. `false` ends the trial as soon as the group has chosen.                              |
| `reveal_prompt`    | HTML string   | `null`                                             | Heading rendered above the reveal list.                                                                                              |
| `continue_label`   | string        | `"Continue"`                                       | Label of the button that ends the reveal. `null` hides it (then set `reveal_duration`, or the reveal can't advance — a warning fires). |
| `reveal_duration`  | int           | `null`                                             | If set, auto-advance the reveal after this many milliseconds (races the continue button if both are set).                            |
| `player_label`     | fn            | `null`                                             | `(participantId) => string` mapping an id to the name shown on the reveal list. `null` shows the raw participantId.                   |
| `payoff`           | fn            | `null`                                             | Optional `(choices, me) => number` computing this client's payoff from the collected `{ participantId: { index, label } }` map. Saved as `my_payoff` and shown on the reveal. `null` skips payoffs — derive them in `on_finish` instead. |

## Data generated

| Name                | Type   | Description                                                                          |
| ------------------- | ------ | ----------------------------------------------------------------------------------- |
| `choice`            | string | This participant's chosen option label.                                             |
| `choice_index`      | int    | Zero-based index of this participant's chosen option.                               |
| `rt`                | int    | Time from the options appearing to this participant clicking one, in ms.            |
| `wait_time`         | int    | Time spent waiting for the rest of the group after choosing, in ms.                 |
| `choices_by_player` | object | Every player's choice at the barrier: `{ participantId: { index, label } }`.        |
| `n_players`         | int    | Number of participants who had chosen when the barrier resolved (or the timeout fired). |
| `my_payoff`         | float  | This client's payoff from the `payoff` hook; `null` if no hook (or it threw/returned a non-number). |
| `timed_out`         | bool   | `true` if the trial proceeded because `timeout` elapsed rather than because everyone had chosen. |
| `wait_error`        | string | The `wait()` rejection message when the barrier ended without the full group; `null` otherwise. |

## How the barrier works

Each client pushes `{ index, label }` under `data_key` when it chooses. The barrier condition is
"at least `expected_players` participants have a valid choice", checked over the shared snapshot on
every update — the same deterministic-consensus idea the other multiplayer plugins use. A participant
without a valid integer `index` under `data_key` is not counted as having chosen, so a stray push of
other data never trips the barrier early.

On `timeout` the trial does not hang: it proceeds with whoever has chosen so far, sets
`timed_out: true`, and calls `on_timeout` — an experiment should decide (e.g. in `on_finish`) how to
treat a non-responder.

## Computing payoffs

The `payoff` hook receives the collected choices (a `participantId -> { index, label }` map) and this
client's id, and returns this client's payoff for the round:

```js
const pd = {
  type: jsPsychMultiplayerChoice,
  choices: ["Cooperate", "Defect"],
  expected_players: 2,
  payoff: (choices, me) => {
    const mine = choices[me].index; // 0 = cooperate, 1 = defect
    const other = Object.entries(choices).find(([id]) => id !== me)[1].index;
    const T = [
      [3, 0], // I cooperate: (both C) 3, (I'm suckered) 0
      [5, 1], // I defect:    (I exploit) 5, (both D) 1
    ];
    return T[mine][other];
  },
};
```

Leaving `payoff` off keeps the plugin a pure decision primitive — read `choices_by_player` in
`on_finish` and score however you like.

## Reading the group downstream

The full decision map is saved in `choices_by_player`, and the pure core is exposed as static members
for reuse:

```js
import MultiplayerChoice from "@jspsych-multiplayer/plugin-multiplayer-choice";

// e.g. tally a public-goods round from a snapshot:
const choices = MultiplayerChoice.collectChoices(group, "choice"); // { id: { index, label } }
```

## Author / Citation

Mandy Liao
