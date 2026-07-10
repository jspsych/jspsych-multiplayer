# plugin-multiplayer-vote

An anonymous group vote: every participant votes for one of the same options, the trial pushes that vote and waits (a barrier) until all `expected_players` have voted, then optionally reveals the aggregate tally and the plurality winner. It is the engine under group-decision and consensus paradigms — majority-rule choices, "vote for the next round", opinion polls. Unlike [`plugin-multiplayer-choice`](../../plugin-multiplayer-choice), the vote is anonymous: the data and reveal carry counts per option and the winner, never a participant → vote mapping. See the [README](../README.md) for the barrier/anonymity details.

## Parameters

In addition to the [parameters available in all plugins](https://www.jspsych.org/latest/overview/plugins#parameters-available-in-all-plugins), this plugin accepts the following parameters. Parameters with a default value of undefined must be specified.

| Parameter          | Type        | Default Value                                     | Description                                                                                                                       |
| ------------------ | ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `choices`          | string[]    | _undefined_                                       | The options to vote among (button contents, HTML allowed). The clicked option's zero-based index is shared with the group.        |
| `prompt`           | HTML string | `null`                                            | Question / instructions above the buttons.                                                                                        |
| `button_html`      | function    | `null`                                            | `(choice, index) => html` for each button (jsPsych convention). Null uses a plain `jspsych-btn`.                                  |
| `data_key`         | string      | `"vote"`                                          | Session field this participant's vote is stored under.                                                                            |
| `expected_players` | integer     | _undefined_                                       | Group size, including this participant, that must vote before the barrier lifts.                                                  |
| `waiting_message`  | HTML string | `"<p>Waiting for the other players to vote…</p>"` | Shown after voting, while waiting for the group.                                                                                  |
| `timeout`          | integer     | `null`                                            | Milliseconds to wait for the group after voting; on expiry the trial proceeds partial with `timed_out: true`. Null waits forever. |
| `on_timeout`       | function    | `null`                                            | `(waitError) => void` called if `timeout` elapses before everyone has voted.                                                      |
| `reveal`           | boolean     | `true`                                            | Reveal the tally + winner after the barrier. `false` ends as soon as the group has voted.                                         |
| `reveal_prompt`    | HTML string | `null`                                            | Heading above the tally.                                                                                                          |
| `continue_label`   | string      | `"Continue"`                                      | Button that ends the reveal. Null hides it (then set `reveal_duration`).                                                          |
| `reveal_duration`  | integer     | `null`                                            | Auto-advance the reveal after this many ms.                                                                                       |

## Data Generated

In addition to the [default data collected by all plugins](https://www.jspsych.org/latest/overview/plugins#data-collected-by-all-plugins), this plugin collects:

| Name           | Type    | Value                                                                                             |
| -------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `vote`         | string  | This participant's chosen option label.                                                           |
| `vote_index`   | integer | Zero-based index of the chosen option.                                                            |
| `rt`           | integer | Time from the options appearing to the click, in ms.                                              |
| `wait_time`    | integer | Time spent waiting for the group after voting, in ms.                                             |
| `tally`        | object  | The anonymous tally at the barrier: one `{ index, label, count }` per option, in `choices` order. |
| `winner`       | object  | The plurality winner `{ index, label, count }`, or `null` on a tie or when no votes were cast.    |
| `is_tie`       | boolean | `true` when two or more options shared the top count.                                             |
| `tied_options` | object  | The options sharing the top count when `is_tie` is true; empty otherwise.                         |
| `n_votes`      | integer | Total number of valid votes when the barrier resolved (or timed out).                             |
| `timed_out`    | boolean | `true` if the trial proceeded because `timeout` elapsed.                                          |
| `wait_error`   | string  | The `wait()` rejection message when the barrier ended without the full group; else `null`.        |

## Install

```js
<script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-vote"></script>
```

```
npm install @jspsych-multiplayer/plugin-multiplayer-vote
```

```js
import MultiplayerVote from "@jspsych-multiplayer/plugin-multiplayer-vote";
```

## Examples

### Vote on the next round

```javascript
const nextRound = {
  type: jsPsychMultiplayerVote,
  prompt: "<p>Which game should the group play next?</p>",
  choices: ["Trust", "Ultimatum", "Public goods"],
  expected_players: 4,
  reveal_prompt: "<h3>The votes are in</h3>",
  on_finish: (data) => {
    // winner is null on a tie OR if nobody voted. On a tie, break it by picking randomly among the
    // tied leaders (data.tied_options); guard the no-votes case, where tied_options is empty.
    const leaders = data.winner ? [data.winner] : data.tied_options;
    data.next_game = leaders.length
      ? jsPsych.randomization.sampleWithoutReplacement(leaders, 1)[0].label
      : null; // nobody voted
  },
};
```

### A quick opinion poll (no reveal, tally in on_finish)

```javascript
const poll = {
  type: jsPsychMultiplayerVote,
  prompt: "<p>Was your partner fair?</p>",
  choices: ["Yes", "No"],
  expected_players: 2,
  reveal: false,
  on_finish: (data) => {
    console.log("Group tally:", data.tally); // [{ index, label, count }, …]
  },
};
```
