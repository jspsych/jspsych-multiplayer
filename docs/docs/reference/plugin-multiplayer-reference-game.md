---
id: plugin-multiplayer-reference-game
title: multiplayer-reference-game
sidebar_label: multiplayer-reference-game
description: One round of a two-player reference game, in which a director describes target objects and a matcher picks them out.
---

# `multiplayer-reference-game`

A reference game trial is one round of the repeated reference game ("tangrams") of Hawkins,
Frank & Goodman (2020). Two players, a **director** and a **matcher**, see the same set of
objects, each in a different arrangement, so they can't refer to objects by position. Only the
director sees which objects are the targets. The players talk in a chat panel, the matcher picks
out the targets, and both see how they did. Run it over many rounds and you can measure how
partners come to agree on short names for hard-to-describe objects.

The number of targets sets the task. With one target, the matcher clicks one object (the
"sequential" condition of the original study). With every object a target, the matcher puts the
whole board in the director's order (the "unconstrained" condition). Any number in between also
works.

**What the participant sees:** your `prompt`, "You are the Director." or "You are the Matcher.",
a grid of objects, a line of instructions, and the chat panel. The director's targets are
outlined, and numbered when there is more than one. With more than one target, the matcher sees
a row of numbered slots: they click a slot, then the object for it, and click **Submit** when
every slot is filled. With one target, a click is the answer. After the matcher answers, both
players see the targets, the matcher's choices marked right or wrong, and the score, for three
seconds.

```js
timeline.push({
  type: jsPsychMultiplayerReferenceGame,
  stimuli: SHAPES, // [{ id: "a", src: "img/a.png" }, …]
  targets: ["c"],
  role: () => jsPsychMultiplayerRole.getMyRole(),
  round: 0,
  round_timeout: 60000,
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-reference-game` |
| Browser global | `jsPsychMultiplayerReferenceGame` |
| Trial type | `multiplayer-reference-game` |
| Requires | a connected session (see [Getting started](../getting-started)) and a role for each player, usually from [`multiplayer-role`](plugin-multiplayer-role) |

## Parameters

`stimuli`, `targets`, `role`, and `round` are required. The trial throws an error if one is
missing, if two stimuli share an `id`, or if a target isn't one of the stimuli.

In the tables below, _k_ is the number of targets.

### Objects and layout

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `stimuli` | `object[]` | required | The objects, as `{ id, src?, html?, label? }`. Each `id` must be unique. `src` is an image URL; `html` is inline HTML, such as an SVG; otherwise `label` (or the `id`) is shown as text. Every object is on screen. |
| `columns` | `number` | `6` | How many columns the grid has. Ignored when `rows` is set. |
| `rows` | `number \| null` | `null` | How many rows the grid has. The number of columns is then worked out from it. `null` uses `columns`. |
| `cell_size` | `number \| null` | `null` | The width of each grid column, in pixels. `null` lets each be between 3 and 6 em wide. |
| `scramble_mode` | `string` | `"independent"` | How the two players' arrangements relate: `"independent"` (different random arrangements), `"disjoint"` (different, and no object is in the same place for both, as in the original study; needs at least 2 objects), `"shared"` (the same arrangement for both), or `"matcher_only"` (the director sees `stimuli` in the order given; the matcher's is shuffled). |
| `seed` | `string \| null` | `null` | Picks different arrangements within the session. Randomness is seeded by the session ID (or the `randomSeed` connect option), so each group gets its own arrangements. |
| `show_labels` | `boolean` | `false` | Show each object's `label` (or `id`) under it. |

### Targets and scoring

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `targets` | `string[]` | required | The `id`s of the target objects, in order. |
| `ordered` | `boolean \| null` | `null` | Whether the matcher must put the targets in the right slots (`true`) or only pick the right objects (`false`). `null` means `true` when _k_ > 1. |
| `scoring` | `string \| function` | `"per_slot"` | How `n_correct` is counted: `"per_slot"` (one per correct slot), `"all_or_nothing"` (_k_ if every slot is right, else 0), or your own `(assignment, targets) => number`, whose result is rounded and kept between 0 and _k_. |

### Roles

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `role` | `string` | required | This participant's role: `"director"` or `"matcher"`. Usually `() => jsPsychMultiplayerRole.getMyRole()`. |
| `role_labels` | `object` | `{ director: "Director", matcher: "Matcher" }` | The names used for the two roles on screen. |
| `director_can_select` | `boolean` | `false` | Let the director click objects to highlight them for themselves. The highlight is not sent or scored. |
| `reveal_target_to` | `string` | `"director"` | Who sees the targets outlined before the answer: `"director"`, `"matcher"`, `"both"`, or `"none"`. |

### Chat

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `chat_enabled` | `boolean` | `true` | Show the chat panel. |
| `chat_role` | `string` | `"both"` | Who can send messages: `"director"`, `"matcher"`, or `"both"`. Both can always read. |
| `max_messages` | `number \| null` | `null` | The most messages this participant can send in the round. `null` means no limit. |
| `max_length` | `number \| null` | `null` | The longest a message can be, in characters. Longer messages are cut when sent. `null` means no limit. |
| `require_message_before_response` | `boolean` | `false` | Ignore the matcher's clicks until the director has sent a message this round, as in the original study's Experiment 2. Ignored clicks are shown a hint and recorded as `gated_click` in `interaction_history`. Has no effect when `chat_enabled` is `false`. |
| `placeholder` | `string` | `"Type a message…"` | Placeholder text in the empty text box. |
| `chat_persists` | `boolean` | `false` | Keep one conversation across rounds. `false` starts each round with an empty chat. |
| `chat_position` | `string` | `"below"` | Where the chat panel goes: `"below"` or `"beside"` the grid. |
| `typing_indicator` | `boolean` | `false` | Show "Matcher is typing…" (or "Director is typing…") while the partner types. |
| `typing_key` | `string` | `"typing_at"` | The slot field used for the typing indicator. Only change it if your experiment already uses `typing_at` for something else. |
| `typing_ttl` | `number` | `2500` | How long the typing hint stays up after the partner's last keystroke, in ms. |
| `typing_throttle` | `number` | `800` | While typing, send at most one update per this many ms. |
| `typing_label` | `string \| null` | `null` | The typing hint's text. `null` uses the partner's role label, e.g. "Matcher is typing…". |

### Answering

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `response_mode` | `string \| null` | `null` | `"click"` (one click is the answer) or `"assign_slots"` (numbered slots). `null` means `"click"` when _k_ = 1 and `"assign_slots"` otherwise. |
| `auto_submit` | `boolean \| null` | `null` | Send the answer as soon as every slot is filled, without a Submit button. `null` means `true` when _k_ = 1. |
| `submit_label` | `string` | `"Submit"` | The label of the Submit button. |
| `allow_change` | `boolean` | `true` | Let the matcher change a choice before submitting. |
| `selection_timeout` | `number \| null` | `null` | The matcher's time limit, in ms. When it runs out, whatever they have chosen so far is submitted and scored. It keeps running while the matcher waits for a message under `require_message_before_response`. |

### Feedback

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `feedback` | `boolean` | `true` | Show feedback after the matcher answers. `false` ends the trial as soon as the answer arrives. |
| `feedback_content` | `object` | `{ reveal_target: true, show_score: true, show_partner_choice: true }` | What feedback shows: the targets, the score, and the matcher's choices. To show the two players different things, key it by role: `{ director: {…}, matcher: {…} }`. Missing entries are `true`. |
| `feedback_to` | `string` | `"both"` | Who sees feedback: `"director"`, `"matcher"`, or `"both"`. |
| `feedback_duration` | `number \| null` | `3000` | How long feedback stays up, in ms. `null` shows a **Continue** button instead. |
| `show_running_score` | `boolean` | `false` | Add the pair's total `n_correct` so far to the score line. |

### Rounds, timing, and data

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `prompt` | HTML string or `(role) => string` | `""` | Shown above the board. A function receives this participant's role, so the two players can get different instructions. |
| `round` | `number` | required | The round number. Must be different for every round in the experiment (see [Rounds](#rounds)). Usually `jsPsych.timelineVariable("round")`. |
| `data_key` | `string` | `"reference_game"` | The slot field where round results are stored. The chat uses fields that start with the same name. |
| `partner_id` | `string \| null` | `null` | The partner's participant ID. `null` finds the one other participant who hasn't left, and throws an error if there is more than one. Set it when the session can hold more than two people. |
| `round_timeout` | `number \| null` | `null` | The longest the round can last before feedback, in ms. When it runs out, the round ends with `ended_by: "timeout"` and no answer. If neither this nor `selection_timeout` is set, a warning is logged: a partner who stays connected but never acts would leave the trial waiting forever. |
| `end_on_participant_left` | `boolean` | `true` | End the round, with no answer, if the partner leaves before feedback. |
| `save_orders` | `boolean` | `true` | Save both players' arrangements in `my_order` and `partner_order`. |
| `save_transcript` | `boolean` | `true` | Save the chat in `chat_transcript`. |
| `save_interaction_history` | `boolean` | `false` | Save every choice the matcher made before submitting in `interaction_history`. |
| `save_group` | `boolean` | `false` | Save the group's shared data at the end of the trial in `group`. |

## Data

Both players get a row for each round. Fields about the answer are `null` if the round ended
without one.

| Field | Type | Description |
| --- | --- | --- |
| `role` | `string` | `"director"` or `"matcher"`. |
| `round` | `number` | The round number. |
| `targets` | `string[]` | The target `id`s, in order. |
| `assignment` | `string \| object \| null` | The matcher's answer. With one target, the `id` they clicked. With more, an object from slot number (starting at 1) to `id`, e.g. `{ "1": "c", "2": "a" }`. |
| `n_correct` | `number \| null` | The score, counted as `scoring` says. |
| `n_targets` | `number` | _k_, the number of targets. |
| `accuracy` | `number \| null` | `n_correct / n_targets`. |
| `correct` | `boolean \| null` | `true` if every slot was right, whatever `scoring` says. |
| `rt` | `number \| null` | For the matcher, ms from the start of the trial to the answer. `null` for the director. |
| `chat_transcript` | `object[]` | The round's chat, as `{ id, senderId, seq, text, ts, round }` messages. Only when `save_transcript` is `true`. |
| `message_count` | `number` | How many messages are in the chat. |
| `messages_sent` | `number` | How many of them this participant sent. |
| `my_order` | `string[]` | The `id`s in the order this participant saw them, row by row. Only when `save_orders` is `true`. |
| `partner_order` | `string[] \| null` | The same for the partner. `null` if the partner was never found. Only when `save_orders` is `true`. |
| `interaction_history` | `object[]` | The matcher's choices before submitting, as `{ t, action, slot, object_id }`. `t` is ms from the start of the trial; `action` is `"assign"`, `"reassign"`, `"clear"`, or `"gated_click"`. Only for the matcher, and only when `save_interaction_history` is `true`. |
| `ended_by` | `string` | `"submit"`, `"timeout"`, `"participant_left"`, or `"connection_lost"`. |
| `partner_left` | `boolean` | `true` if the round ended because the partner left. |
| `left_participant` | `string \| null` | The partner's ID, when `partner_left` is `true`. |
| `connection_lost` | `boolean` | `true` if the round ended because this participant's own connection was lost for good. |
| `group` | `object` | The shared data at the end of the trial. Only when `save_group` is `true`. |

`ended_by: "timeout"` has two cases. If `selection_timeout` ran out, the matcher's partial answer
was scored and feedback was shown, so `assignment` and `n_correct` are filled in. If
`round_timeout` ran out, there is no answer.

[Handling dropouts](../guides/handling-dropouts) explains `partner_left`, `left_participant`,
`connection_lost`, and how to branch on them.

## Rounds

Put one trial per round in a timeline with `timeline_variables`, and give each round its own
`round` number. Round results are stored under that number, so a repeated number would find the
earlier round's answer. The trial throws an error if the matcher's slot already holds an answer
for that round.

Arrangements are shuffled again every round. They depend only on the session ID (or the
`randomSeed` connect option), `seed`, the round number, and the two participant IDs, so a player
who reloads the page sees the same arrangement, each group gets its own arrangements, and each
player's data can record the partner's arrangement too.

With the default feedback settings, both players' trials end together: when the matcher answers, the director's screen shows the
feedback at the same moment, and both end `feedback_duration` later.

## When the partner leaves or goes quiet

If the partner leaves before feedback, the round ends for this participant with
`ended_by: "participant_left"` and no answer. An answer that arrived before they left is still
scored. Once feedback is showing, a departure changes nothing.

A partner who stays connected but stops responding does not end the round. Set `round_timeout`
so the round can't wait forever, and skip the remaining rounds once a partner is gone, as in the
example below.

## Example

A six-round game with one target per round. A [`multiplayer-role`](plugin-multiplayer-role) trial
assigns the roles, and the remaining rounds are skipped if the partner leaves:

```js
let partnerId;
let partnerGone = false;

const roleTrial = {
  type: jsPsychMultiplayerRole,
  roles: ["director", "matcher"],
  group_size: 2,
  on_finish: () => {
    const byRole = jsPsychMultiplayerRole.participantsByRole();
    const me = jsPsychMultiplayerRole.getMyRole();
    partnerId = me === "director" ? byRole.matcher?.[0] : byRole.director?.[0];
  },
};

const gameRound = {
  type: jsPsychMultiplayerReferenceGame,
  stimuli: SHAPES, // [{ id: "poly3", html: "<svg>…</svg>" }, …]
  targets: jsPsych.timelineVariable("targets"),
  round: jsPsych.timelineVariable("round"),
  role: () => jsPsychMultiplayerRole.getMyRole(),
  partner_id: () => partnerId,
  scramble_mode: "disjoint",
  require_message_before_response: true,
  show_running_score: true,
  round_timeout: 90000,
  prompt: (role) =>
    role === "director"
      ? "<p>Describe the outlined shape so your partner can find it.</p>"
      : "<p>Click the shape your partner describes.</p>",
  on_finish: (data) => {
    if (data.partner_left || data.connection_lost) partnerGone = true;
  },
};

const game = {
  timeline: [{ timeline: [gameRound], conditional_function: () => !partnerGone }],
  timeline_variables: [
    { round: 0, targets: ["star5"] },
    { round: 1, targets: ["poly3"] },
    { round: 2, targets: ["star5"] },
    { round: 3, targets: ["poly7"] },
    { round: 4, targets: ["star8"] },
    { round: 5, targets: ["poly3"] },
  ],
};

timeline.push(roleTrial, game);
```

For the full-board version, give every round all the object `id`s as `targets`, in a different
order each round. The matcher then fills one slot per object and clicks **Submit**, and the score
is out of the number of objects.
