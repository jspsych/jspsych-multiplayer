# plugin-multiplayer-vote

An **anonymous group vote** for multiplayer experiments. Every participant votes for one of the same
options; the trial pushes that vote and waits (a barrier) until the whole group has voted, then
optionally reveals the aggregate **tally** and the **plurality winner**. It is the engine under group
decisions and consensus paradigms — **majority-rule choices, "vote for the next round", opinion
polls** — packaging the vote → push → wait → reveal-tally flow as one declarative trial.

It builds on the jsPsych multiplayer API (`@jspsych/jspsych` group sessions). Like
[`plugin-multiplayer-choice`](../plugin-multiplayer-choice) it is a **barrier** trial (push → wait)
that owns the option UI and the "everyone has voted" condition. The difference is the emphasis: vote
reports the **aggregate**, not each individual's pick. It is **anonymous** — the data and reveal carry
counts per option and the winner, never a participant → vote mapping. Reach for `choice` when you need
to know who chose what (and to score per-player payoffs); reach for `vote` when you only need the
group's collective decision.

> **Status.** The pure core, the trial wrapper, and the tests are all implemented. The wrapper is
> written against a local interface mirroring the jsPsych multiplayer API
> ([jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694)); to actually run a trial you need
> that API present at runtime plus a network adapter (e.g. JATOS group sessions) and several real
> participants in the same group.

## Loading

### In browser

```html
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-vote"></script>
```

### Via NPM

```
npm install @jspsych-multiplayer/plugin-multiplayer-vote
```

```js
import MultiplayerVote from "@jspsych-multiplayer/plugin-multiplayer-vote";
// The pure core is reachable as static members: MultiplayerVote.tally, .plurality, .countVoted
```

## Compatibility

`@jspsych-multiplayer/plugin-multiplayer-vote` requires jsPsych v8.0.0 or later, plus a multiplayer
API adapter (e.g. JATOS group sessions).

## Parameters

| Parameter          | Type        | Default                                           | Description                                                                                                                                                                                   |
| ------------------ | ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `choices`          | string[]    | _undefined_ (required)                            | The options to vote among — button contents (HTML allowed, experimenter-authored), like `html-button-response`. The clicked option's zero-based **index** is the value shared with the group. |
| `prompt`           | HTML string | `null`                                            | Question / instructions rendered above the option buttons.                                                                                                                                    |
| `button_html`      | fn          | `null`                                            | `(choice, index) => html` producing each button's markup (jsPsych convention). Null uses a plain `jspsych-btn`.                                                                               |
| `data_key`         | string      | `"vote"`                                          | Session field this participant's vote is stored under. Namespacing avoids colliding with other pushed data and separates two vote trials.                                                     |
| `expected_players` | int         | _undefined_ (required)                            | Group size, **including this participant**, that must vote before the barrier lifts. Set it to the exact expected count.                                                                      |
| `waiting_message`  | HTML string | `"<p>Waiting for the other players to vote…</p>"` | Shown after this participant votes, while waiting for the rest of the group.                                                                                                                  |
| `timeout`          | int         | `null`                                            | Milliseconds to wait for the group **after** voting. On expiry the trial proceeds with whoever voted, flagged `timed_out: true`, and `on_timeout` fires. `null` waits indefinitely.           |
| `on_timeout`       | fn          | `null`                                            | `(waitError) => void` called if `timeout` elapses before the whole group has voted.                                                                                                           |
| `reveal`           | bool        | `true`                                            | Reveal the tally + winner after the barrier. `false` ends the trial as soon as the group has voted.                                                                                           |
| `reveal_prompt`    | HTML string | `null`                                            | Heading rendered above the tally.                                                                                                                                                             |
| `continue_label`   | string      | `"Continue"`                                      | Label of the button that ends the reveal. `null` hides it (then set `reveal_duration`, or the reveal can't advance — a warning fires).                                                        |
| `reveal_duration`  | int         | `null`                                            | If set, auto-advance the reveal after this many milliseconds (races the continue button if both are set).                                                                                     |

## Data generated

| Name           | Type   | Description                                                                                       |
| -------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `vote`         | string | This participant's chosen option label.                                                           |
| `vote_index`   | int    | Zero-based index of this participant's chosen option.                                             |
| `rt`           | int    | Time from the options appearing to this participant clicking one, in ms.                          |
| `wait_time`    | int    | Time spent waiting for the rest of the group after voting, in ms.                                 |
| `tally`        | object | The anonymous tally at the barrier: one `{ index, label, count }` per option, in `choices` order. |
| `winner`       | object | The plurality winner `{ index, label, count }`, or `null` on a tie or when no votes were cast.    |
| `is_tie`       | bool   | `true` when two or more options shared the top count, so there is no single winner.               |
| `tied_options` | object | The options sharing the top count when `is_tie` is true (`choices` order); empty otherwise.       |
| `n_votes`      | int    | Total number of valid votes counted when the barrier resolved (or the timeout fired).             |
| `timed_out`    | bool   | `true` if the trial proceeded because `timeout` elapsed rather than because everyone had voted.   |
| `wait_error`   | string | The `wait()` rejection message when the barrier ended without the full group; `null` otherwise.   |

## How the barrier and winner work

Each client pushes `{ index, label }` under `data_key` when it votes. The barrier condition is "at
least `expected_players` participants have a valid vote", checked over the shared snapshot on every
update — the same deterministic-consensus idea the other multiplayer plugins use. A participant
without a valid integer `index` under `data_key` is not counted as having voted, so a stray push of
other data never trips the barrier early.

The **tally** counts votes per option using the trial's own `choices` for labels (never the
per-voter pushed label), which keeps the aggregate free of untrusted per-participant strings — part of
what makes the vote anonymous. The **winner** is the option with the most votes (plurality). If two or
more options share the top count it is a **tie** (`winner: null`, `is_tie: true`, `tied_options` lists
them); if nobody voted there is no winner and it is not a tie.

On `timeout` the trial does not hang: it proceeds with whoever has voted so far, sets
`timed_out: true`, calls `on_timeout`, and tallies the partial result.

## Anonymity

The vote is anonymous with respect to _other_ participants: nothing in the recorded data or the reveal
maps any **peer** back to how they voted — the barrier snapshot is collapsed to per-option counts
(`tally`/`winner`/`tied_options`) before it is exposed, and no participant→vote mapping is ever kept.
Each client still records and sees its **own** choice (`vote`/`vote_index`, and a "(you)" highlight on
its own option in the reveal); it just never learns how anyone else voted. If you need every player's
individual decision (or per-player payoffs), use
[`plugin-multiplayer-choice`](../plugin-multiplayer-choice) instead.

## Reading the group downstream

The tally and winner are saved on the trial data, and the pure core is exposed as static members for
reuse:

```js
import MultiplayerVote from "@jspsych-multiplayer/plugin-multiplayer-vote";

// e.g. re-tally a snapshot and resolve the winner yourself:
const counts = MultiplayerVote.tally(group, "vote", ["Red", "Green", "Blue"]);
const { winner, isTie } = MultiplayerVote.plurality(counts);
```

## Author / Citation

Mandy Liao
