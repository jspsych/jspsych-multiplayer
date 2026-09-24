# plugin-multiplayer-choice

A **simultaneous group decision** for multiplayer experiments. Every participant picks one of the
same options; the trial pushes that pick and waits (a barrier) until the whole group has chosen, then
optionally reveals the outcome. It is the engine under simultaneous-move paradigms —
**prisoner's dilemma, public-goods contributions, dictator/coordination games** — packaging the
choose → push → wait → reveal flow as one declarative trial.

Two reveal modes cover the attributed and the anonymous cases:

- `reveal_mode: "players"` (the default) lists **who chose what** (`Alice: Cooperate`), and an
  optional `payoff` hook can score the round.
- `reveal_mode: "tally"` shows the **aggregate only** — per-option counts, the plurality winner, and
  ties — an anonymous group poll (majority-rule choices, "vote for the next round", opinion polls).
  Combine it with `record_choices_by_player: false` to keep the recorded data anonymous too.

It builds on the jsPsych multiplayer API (`@jspsych/jspsych` group sessions). Like
[`plugin-multiplayer-sync`](../plugin-multiplayer-sync) it is a **barrier** trial (push → wait), but
it owns the option UI and the "everyone has chosen" condition, and adds a reveal. Keep the scoring in
your own game: pass a `payoff` hook, or (the default) leave it off and derive payoffs from
`choices_by_player` in `on_finish`.

> **Status.** Requires the jsPsych multiplayer API
> ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)), which is not yet in a jsPsych
> release, plus a network adapter (e.g. JATOS group sessions) and several real participants in the
> same group. On a jsPsych without `jsPsych.multiplayer`, the trial throws an error saying so.

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
// The pure core is reachable as static members:
// MultiplayerChoice.collectChoices, .countChosen, .tally, .plurality
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-choice` requires jsPsych v8.0.0 or later, plus a multiplayer
API adapter (e.g. JATOS group sessions).

## Parameters

| Parameter                  | Type          | Default                                             | Description                                                                                                                                                                                                                                                     |
| -------------------------- | ------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `choices`                  | string[]      | _undefined_ (required)                              | The options this participant can pick from — button contents (HTML allowed, experimenter-authored), like `html-button-response`. The clicked option's zero-based **index** is the value shared with the group.                                                  |
| `prompt`                   | HTML string   | `null`                                              | Question / instructions rendered above the option buttons.                                                                                                                                                                                                      |
| `button_html`              | fn            | `null`                                              | `(choice, index) => html` producing each button's markup (jsPsych convention). Null uses a plain `jspsych-btn`.                                                                                                                                                 |
| `data_key`                 | string        | `null`                                              | Session field this participant's choice is stored under. `null` generates `choice-1`, `choice-2`, … so every choice trial has its own key (see **Choice keys**).                                                                                                |
| `expected_players`         | int           | _undefined_ (required)                              | Group size, **including this participant**, that must choose before the barrier lifts. Set it to the exact expected count.                                                                                                                                      |
| `waiting_message`          | HTML string   | `"<p>Waiting for the other players to choose…</p>"` | Shown after this participant chooses, while waiting for the rest of the group.                                                                                                                                                                                  |
| `timeout`                  | int           | `null`                                              | Milliseconds to wait for the group **after** choosing. On expiry the trial proceeds with whoever chose, flagged `timed_out: true`, and `on_timeout` fires. `null` waits indefinitely. Does not bound how long this participant takes to pick.                   |
| `on_timeout`               | fn            | `null`                                              | `(waitError) => void` called if `timeout` elapses before the group has all chosen.                                                                                                                                                                              |
| `participants`             | array \| null | `null`                                              | Participants the barrier depends on. If one leaves the session first, the trial proceeds with whoever chose, flagged `partner_left: true`. `null` means every other participant who is connected when this participant chooses; `[]` ignores departures. |
| `reveal`                   | bool          | `true`                                              | Reveal the group's decision after the barrier. `false` ends the trial as soon as the group has chosen.                                                                                                                                                          |
| `reveal_mode`              | string        | `"players"`                                         | `"players"` lists every player's choice, attributed. `"tally"` shows per-option counts + the plurality winner only — never who chose what.                                                                                                                      |
| `reveal_prompt`            | HTML string   | `null`                                              | Heading rendered above the reveal.                                                                                                                                                                                                                              |
| `continue_label`           | string        | `"Continue"`                                        | Label of the button that ends the reveal. `null` hides it (then set `reveal_duration`, or the reveal can't advance — a warning fires).                                                                                                                          |
| `reveal_duration`          | int           | `null`                                              | If set, auto-advance the reveal after this many milliseconds (races the continue button if both are set).                                                                                                                                                       |
| `player_label`             | fn            | `null`                                              | `(participantId) => string` mapping an id to the name shown on the reveal list. `null` shows the raw participantId. Only used by `reveal_mode: "players"`.                                                                                                      |
| `payoff`                   | fn            | `null`                                              | Optional `(choices, me) => number` computing this client's payoff from the collected `{ participantId: { index, label } }` map. Saved as `my_payoff` and shown on the reveal (both modes). `null` skips payoffs — derive them in `on_finish` instead.           |
| `record_choices_by_player` | bool          | `true`                                              | Whether to save the participant → choice map as `choices_by_player`. Set `false` for an anonymous poll (see **Anonymity**).                                                                                                                                     |

## Data generated

| Name                | Type   | Description                                                                                                                     |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `choice`            | string | This participant's chosen option label.                                                                                         |
| `choice_index`      | int    | Zero-based index of this participant's chosen option.                                                                           |
| `rt`                | int    | Time from the options appearing to this participant clicking one, in ms.                                                        |
| `wait_time`         | int    | Time spent waiting for the rest of the group after choosing, in ms.                                                             |
| `choices_by_player` | object | Every player's choice at the barrier: `{ participantId: { index, label } }`. `null` when `record_choices_by_player` is `false`. |
| `n_players`         | int    | Number of participants whose choice counted when the barrier resolved (or the timeout fired).                                   |
| `tally`             | object | The aggregate count at the barrier: one `{ index, label, count }` per option, in `choices` order.                               |
| `winner`            | object | The plurality winner `{ index, label, count }`, or `null` on a tie or when no one chose.                                        |
| `is_tie`            | bool   | `true` when two or more options shared the top count, so there is no single winner.                                             |
| `tied_options`      | object | The options sharing the top count when `is_tie` is true (`choices` order); empty otherwise.                                     |
| `my_payoff`         | float  | This client's payoff from the `payoff` hook; `null` if no hook (or it threw/returned a non-number).                             |
| `data_key`          | string | The session field the choices were stored under (`data_key`, or the generated `choice-N`).                                      |
| `timed_out`         | bool   | `true` if the trial proceeded because `timeout` elapsed rather than because everyone had chosen.                                |
| `partner_left`      | bool   | `true` if the trial proceeded because a participant in `participants` left the session.                                         |
| `left_participant`  | string | The ID of the participant who left, when `partner_left` is true; `null` otherwise.                                              |
| `connection_lost`   | bool   | `true` if the trial proceeded because this participant's connection was lost for good.                                          |
| `wait_error`        | string | The message of the error that ended the barrier without the full group; `null` otherwise.                                       |

## How the barrier works

Each client writes `{ index, label }` under `data_key` when it chooses, merged into its slot so other
data survives. The barrier condition is "at least `expected_players` participants who haven't left
the session have a valid choice **within the option range**", checked over the shared snapshot on
every update — the same deterministic-consensus idea the other multiplayer plugins use. A participant
without a valid, in-range integer `index` under `data_key` is not counted as having chosen, so a
stray write of other data never trips the barrier early, and the barrier's count always agrees with
the `tally`/`n_players` the trial records. The recorded outcome includes every choice made under
`data_key`, including one from a participant who has since left.

The trial does not hang when the group can't finish. It proceeds with whoever has chosen so far if
`timeout` elapses (`timed_out: true`, and `on_timeout` is called), if a participant in `participants`
leaves (`partner_left: true`), or if this participant's connection is lost (`connection_lost: true`).
An experiment should decide (e.g. in `on_finish`) how to treat those cases.

### Choice keys

Each choice trial stores choices under its own `data_key`, so a choice left over from an earlier
trial can never count toward a later one. By default the key is `choice-1` for the first choice
trial this participant reaches, `choice-2` for the second, and so on. Participants have to pass the
barriers in the same order, so the Nth choice trial gets the same key for everyone, however many
other trials each participant saw. Set an explicit `data_key` for a choice trial that only some
participants reach (for example inside a `conditional_function`); the default count also starts over
if the page reloads. An explicit `data_key` is used as-is and doesn't advance the default count.

## Anonymous polls (tally mode)

`reveal_mode: "tally"` turns the trial into a group poll: the reveal shows one bar per option with
its count, the plurality **winner** (or a **tie**), and a "(you)" marker on this client's own pick —
never a participant → choice mapping. The tally labels options from the trial's own `choices`
(experimenter-authored), not from peer-pushed strings, so no untrusted per-participant text is
rendered. Set `record_choices_by_player: false` to also drop the attributed map from the recorded
data:

```js
const nextGame = {
  type: jsPsychMultiplayerChoice,
  prompt: "<p>Which game should the group play next? Majority wins.</p>",
  choices: ["Trust", "Ultimatum", "Public goods"],
  expected_players: 4,
  reveal_mode: "tally",
  record_choices_by_player: false, // data carries only the aggregate + my own pick
  reveal_prompt: "<h3>The votes are in</h3>",
  on_finish: (data) => {
    // winner is null on a tie — decide however you like (here: keep a default and branch later).
    data.next_game = data.winner ? data.winner.label : "Public goods";
  },
};
```

> **What "anonymous" means here.** Tally mode anonymizes the plugin's **output** — the reveal DOM and
> (with `record_choices_by_player: false`) the recorded data. It does **not** anonymize the shared
> session state: each client's raw pick still sits in its own per-participant slot, so a participant
> who inspects the session snapshot or network traffic (e.g. with devtools) can see peers' picks.
> True unlinkability would require server-side aggregation, which no client-side plugin can provide.
> For cooperative research settings the output-level guarantee is usually what matters; do not rely
> on it against an adversarial participant.

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
`on_finish` and score however you like. The hook always receives the participant-keyed map (it runs
locally and records only the returned number), even when `record_choices_by_player` is `false`.

## Reading the group downstream

The full decision map is saved in `choices_by_player` (unless disabled), the aggregate in
`tally`/`winner`, and the pure core is exposed as static members for reuse:

```js
import MultiplayerChoice from "@jspsych-multiplayer/plugin-multiplayer-choice";

// e.g. tally a public-goods round from a snapshot:
// (data.data_key holds the key the trial used, e.g. "choice-1")
const choices = MultiplayerChoice.collectChoices(group, data.data_key); // { id: { index, label } }
// or re-tally and resolve the winner yourself:
const counts = MultiplayerChoice.tally(group, data.data_key, ["Red", "Green", "Blue"]);
const { winner, isTie } = MultiplayerChoice.plurality(counts);
```

## Author / Citation

Mandy Liao
