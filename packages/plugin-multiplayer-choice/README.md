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
// The pure core is reachable as static members:
// MultiplayerChoice.collectChoices, .countChosen, .tally, .plurality
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
| `reveal`           | bool          | `true`                                             | Reveal the group's decision after the barrier. `false` ends the trial as soon as the group has chosen.                               |
| `reveal_mode`      | string        | `"players"`                                        | `"players"` lists every player's choice, attributed. `"tally"` shows per-option counts + the plurality winner only — never who chose what. |
| `reveal_prompt`    | HTML string   | `null`                                             | Heading rendered above the reveal.                                                                                                   |
| `continue_label`   | string        | `"Continue"`                                       | Label of the button that ends the reveal. `null` hides it (then set `reveal_duration`, or the reveal can't advance — a warning fires). |
| `reveal_duration`  | int           | `null`                                             | If set, auto-advance the reveal after this many milliseconds (races the continue button if both are set).                            |
| `player_label`     | fn            | `null`                                             | `(participantId) => string` mapping an id to the name shown on the reveal list. `null` shows the raw participantId. Only used by `reveal_mode: "players"`. |
| `payoff`           | fn            | `null`                                             | Optional `(choices, me) => number` computing this client's payoff from the collected `{ participantId: { index, label } }` map. Saved as `my_payoff` and shown on the reveal (both modes). `null` skips payoffs — derive them in `on_finish` instead. |
| `record_choices_by_player` | bool  | `true`                                             | Whether to save the participant → choice map as `choices_by_player`. Set `false` for an anonymous poll (see **Anonymity**).           |

## Data generated

| Name                | Type   | Description                                                                          |
| ------------------- | ------ | ----------------------------------------------------------------------------------- |
| `choice`            | string | This participant's chosen option label.                                             |
| `choice_index`      | int    | Zero-based index of this participant's chosen option.                               |
| `rt`                | int    | Time from the options appearing to this participant clicking one, in ms.            |
| `wait_time`         | int    | Time spent waiting for the rest of the group after choosing, in ms.                 |
| `choices_by_player` | object | Every player's choice at the barrier: `{ participantId: { index, label } }`. `null` when `record_choices_by_player` is `false`. |
| `n_players`         | int    | Number of participants whose choice counted when the barrier resolved (or the timeout fired). |
| `tally`             | object | The aggregate count at the barrier: one `{ index, label, count }` per option, in `choices` order. |
| `winner`            | object | The plurality winner `{ index, label, count }`, or `null` on a tie or when no one chose. |
| `is_tie`            | bool   | `true` when two or more options shared the top count, so there is no single winner. |
| `tied_options`      | object | The options sharing the top count when `is_tie` is true (`choices` order); empty otherwise. |
| `my_payoff`         | float  | This client's payoff from the `payoff` hook; `null` if no hook (or it threw/returned a non-number). |
| `timed_out`         | bool   | `true` if the trial proceeded because `timeout` elapsed rather than because everyone had chosen. |
| `wait_error`        | string | The `wait()` rejection message when the barrier ended without the full group; `null` otherwise. |

## How the barrier works

Each client pushes `{ index, label }` under `data_key` when it chooses. The barrier condition is
"at least `expected_players` participants have a valid choice **within the option range**", checked
over the shared snapshot on every update — the same deterministic-consensus idea the other
multiplayer plugins use. A participant without a valid, in-range integer `index` under `data_key` is
not counted as having chosen, so a stray push of other data — or a stale out-of-range pick left under
a reused `data_key` — never trips the barrier early, and the barrier's count always agrees with the
`tally`/`n_players` the trial records.

On `timeout` the trial does not hang: it proceeds with whoever has chosen so far, sets
`timed_out: true`, and calls `on_timeout` — an experiment should decide (e.g. in `on_finish`) how to
treat a non-responder.

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
const choices = MultiplayerChoice.collectChoices(group, "choice"); // { id: { index, label } }
// or re-tally and resolve the winner yourself:
const counts = MultiplayerChoice.tally(group, "choice", ["Red", "Green", "Blue"]);
const { winner, isTie } = MultiplayerChoice.plurality(counts);
```

## Author / Citation

Mandy Liao
