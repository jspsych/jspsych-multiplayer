# @jspsych-multiplayer/plugin-multiplayer-reference-game

A repeated **referential communication game** ("tangrams") for two players, built on the multiplayer plugin API. It reproduces the task from Hawkins, Frank & Goodman (2020), _Characterizing the Dynamics of Learning in Repeated Reference Games_ (Cognitive Science 44, e12845).

Two players are paired as a fixed **director** and **matcher**. Both see the same set of objects, each in an **independently scrambled layout** (so you can't point by position); only the director sees which objects are the **targets** (and, when there is more than one, in what order). The players talk over an integrated free-text **chat**, the **matcher assigns objects to the director's ordered target slots**, and both then see **feedback** with the true answer revealed. Run it over many rounds (via `timeline_variables`) and partners build up shared, increasingly efficient ways of referring to hard-to-name shapes.

**One plugin, both classic conditions.** The published "sequential" (one target, a single click) and "unconstrained" (all N objects are ordered targets, reproduce the whole board) conditions are the _same task_ with two parameters turned differently — `stimuli` length (objects on screen) and `targets` length (number of targets). `targets.length === 1` collapses the assign-to-slots mechanic to one click; `targets.length === stimuli.length` is the full-board match; anything between also works.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. It uses `jsPsych.multiplayer` directly and throws a clear error on a jsPsych version without it. Tests run the real multiplayer session over an in-memory backend, so no live group session is needed to develop it.

## Prerequisites

Requires a connected multiplayer adapter, plus a way to assign the two roles. [`plugin-multiplayer-role`](../plugin-multiplayer-role) (director/matcher) and [`plugin-multiplayer-sync`](../plugin-multiplayer-sync) (a lobby barrier) compose naturally with it. Connect the adapter before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

See the runnable two-tab demos in this repo: [`examples/reference-game.html`](../../examples/reference-game.html) (single-target) and [`examples/reference-game-match.html`](../../examples/reference-game-match.html) (full-board match).

## Parameters

Only `stimuli`, `targets`, and `role` are required; everything else has a sensible default.

### Stimuli & display

| Parameter       | Type     | Default         | Description                                                                                                                                                                                 |
| --------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stimuli`       | object[] | _(required)_    | The shared object set. Each `{ id, src?, html?, label? }`: `src` is an image URL, `html` is inline SVG/HTML/emoji, else `label`/`id` renders as text. Length = number of objects on screen. |
| `columns`       | integer  | `6`             | Grid columns. Ignored when `rows` is set (columns are then derived).                                                                                                                        |
| `rows`          | integer  | `null`          | Grid rows; `null` derives the shape from `columns`.                                                                                                                                         |
| `cell_size`     | integer  | `null`          | Object display size in px; `null` lets the grid size itself.                                                                                                                                |
| `scramble_mode` | string   | `"independent"` | `"independent"` (director/matcher differ — the classic design), `"disjoint"` (as independent, but no object may occupy the same slot for both — the original tangrams rule), `"shared"` (identical), or `"matcher_only"`. |
| `seed`          | string   | `null`          | Picks different arrangements within the session. Randomness is seeded by the session ID (or the `randomSeed` connect option), so each group gets its own arrangements.                   |
| `show_labels`   | boolean  | `false`         | Show each object's `label` as a caption.                                                                                                                                                    |

### Targets & scoring

| Parameter | Type             | Default      | Description                                                                                                        |
| --------- | ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `targets` | string[]         | _(required)_ | **Ordered** target object ids. Length 1 = click task; length === `stimuli.length` = full-board match; any k works. |
| `ordered` | boolean          | `null`       | Must the matcher reproduce the target ORDER, or only the set? `null` ⇒ `true` when k>1, `false` when k=1.          |
| `scoring` | function\|string | `"per_slot"` | `"per_slot"` (count correct slots of k), `"all_or_nothing"`, or a custom `(assignment, targets) => number`.        |

### Roles

| Parameter             | Type    | Default                                    | Description                                                                                    |
| --------------------- | ------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `role`                | string  | _(required)_                               | `"director"` or `"matcher"`. Usually `role: () => jsPsychMultiplayerRole.getMyRole()`.         |
| `role_labels`         | object  | `{director:"Director", matcher:"Matcher"}` | Display names for the two roles.                                                               |
| `director_can_select` | boolean | `false`                                    | Let the director click objects too (a local, unscored highlight).                              |
| `reveal_target_to`    | string  | `"director"`                               | Who sees the target highlights before feedback: `"director"`, `"matcher"`, `"both"`, `"none"`. |

### Communication (chat)

| Parameter                         | Type    | Default             | Description                                                                                                                                                                                                                                                        |
| --------------------------------- | ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat_enabled`                    | boolean | `true`              | Show the integrated free-text chat panel.                                                                                                                                                                                                                          |
| `chat_role`                       | string  | `"both"`            | Who may SEND: `"director"`, `"matcher"`, or `"both"` (everyone always reads).                                                                                                                                                                                      |
| `max_messages`                    | integer | `null`              | Cap on messages this participant may send this round. `null` = no cap.                                                                                                                                                                                             |
| `max_length`                      | integer | `null`              | Max characters per message. `null` = no limit.                                                                                                                                                                                                                     |
| `require_message_before_response` | boolean | `false`             | Matcher can't commit a selection until the director has sent a message this round (a referring expression per trial, à la Hawkins et al. 2020 Exp. 2). Gated clicks are ignored (logged as `gated_click`) with a hint; inert (warns) when `chat_enabled` is false. |
| `placeholder`                     | string  | `"Type a message…"` | Placeholder text in the empty input.                                                                                                                                                                                                                               |
| `chat_persists`                   | boolean | `false`             | Carry the transcript across rounds (one shared log) vs. a fresh per-round log.                                                                                                                                                                                     |
| `chat_position`                   | string  | `"below"`           | Chat panel placement: `"below"` or `"beside"` the grid.                                                                                                                                                                                                            |
| `typing_indicator` | boolean | `false`       | Show a "partner is typing…" hint from a timestamp each client keeps in its own slot. Hint only — never gates the trial, and hidden while the partner is away or has left. |
| `typing_key` | string | `"typing_at"` | Slot key for the typing timestamp (`number`) or `null`. Same key on both clients; values stay per-slot. |
| `typing_ttl` | integer | `2500`          | Ms after the partner's last keystroke before the hint hides.                           |
| `typing_throttle` | integer | `800`        | Write at most one typing timestamp per this many ms of continuous typing.              |
| `typing_label` | string | `null`         | Hint text. `null` derives `"<Matcher\|Director> is typing…"` from the partner's role label. |

### Response & interaction

| Parameter           | Type    | Default    | Description                                                                                                 |
| ------------------- | ------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `response_mode`     | string  | `null`     | `"click"` or `"assign_slots"`; `null` derives it from k (click when k=1, slots when k>1).                   |
| `auto_submit`       | boolean | `null`     | Submit as soon as the assignment is complete (no button). `null` ⇒ `true` when k=1, `false` when k>1.       |
| `submit_label`      | string  | `"Submit"` | Label of the Submit button (shown whenever `auto_submit` is off).                                           |
| `allow_change`      | boolean | `true`     | May the matcher revise an assignment before submitting?                                                     |
| `selection_timeout` | integer | `null`     | Matcher response limit in ms. On expiry the current (possibly partial) assignment is submitted `timed_out`. |

### Feedback

| Parameter            | Type    | Default                                                           | Description                                                                         |
| -------------------- | ------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `feedback`           | boolean | `true`                                                            | Show feedback after the matcher submits (false ⇒ end immediately on submission).    |
| `feedback_content`   | object  | `{reveal_target:true, show_score:true, show_partner_choice:true}` | Which feedback elements to show. May instead be keyed by role — `{director: {...}, matcher: {...}}` — so the two players see different things (the original shows the director only the matcher's click, and the matcher only the target). |
| `feedback_to`        | string  | `"both"`                                                          | Who sees feedback: `"director"`, `"matcher"`, or `"both"`.                          |
| `feedback_duration`  | integer | `3000`                                                            | Ms feedback stays up before the trial ends. `null` shows a Continue button instead. |
| `show_running_score` | boolean | `false`                                                           | Show the cumulative score across rounds.                                            |

### Text, data & robustness

| Parameter                  | Type           | Default            | Description                                                                                                                                                                                                                         |
| -------------------------- | -------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                   | function\|HTML | `""`               | Role-aware instructions above the board: an HTML string, or `(role) => html`.                                                                                                                                                       |
| `round`                    | integer        | _(required)_       | Round index; must be **unique** per round (data is keyed by it). The trial fails loudly if this round already holds a submission. Usually `jsPsych.timelineVariable("round")`.                                                      |
| `data_key`                 | string         | `"reference_game"` | Group-session field this trial namespaces its round data under.                                                                                                                                                                     |
| `partner_id`               | string         | `null`             | The partner's participantId. `null` auto-detects the single other participant, ignoring participants who left the study.                                                                                                            |
| `save_orders`              | boolean        | `true`             | Save `my_order` / `partner_order` (the scrambled layouts) in the trial data.                                                                                                                                                        |
| `save_transcript`          | boolean        | `true`             | Save the chat transcript in the trial data.                                                                                                                                                                                         |
| `save_group`               | boolean        | `false`            | Include a copy of the full group snapshot in the trial data.                                                                                                                                                                        |
| `save_interaction_history` | boolean        | `false`            | Record the matcher's ordered PRE-SUBMIT actions (assign/reassign/clear, with timestamps).                                                                                                                                           |
| `round_timeout`            | integer        | `null`             | Whole-round time limit (ms): ends the round with `ended_by: "timeout"` if feedback isn't reached. Bounds a round whose partner stays connected but never responds. The plugin warns if neither this nor `selection_timeout` is set. |
| `end_on_participant_left`  | boolean        | `true`             | End the round, before feedback, when the partner leaves the study (see [Partner leaving](#partner-leaving)).                                                                                                                        |

## Data Generated

| Name                  | Type           | Description                                                                                                                                                                                                         |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`                | string         | This participant's role this round.                                                                                                                                                                                 |
| `round`               | integer        | The round index this trial ran as.                                                                                                                                                                                  |
| `targets`             | string[]       | The ordered target object ids.                                                                                                                                                                                      |
| `assignment`          | object\|string | The matcher's submitted `slot -> objectId` map; for k=1, just the one clicked objectId (a string). `null` if none.                                                                                                  |
| `n_correct`           | integer        | Number of correct slots per the configured scoring. `null` without a submission.                                                                                                                                    |
| `n_targets`           | integer        | Number of targets (k).                                                                                                                                                                                              |
| `accuracy`            | float          | `n_correct / n_targets`. `null` without a submission.                                                                                                                                                               |
| `correct`             | boolean        | True iff every slot was right. `null` without a submission.                                                                                                                                                         |
| `rt`                  | integer        | Matcher only: ms from trial start to submission. `null` for the director.                                                                                                                                           |
| `chat_transcript`     | object[]       | The transcript as this client saw it at trial end — only when `save_transcript`. Each entry is `{ id, senderId, seq, text, ts, round }`.                                                                            |
| `message_count`       | integer        | Distinct messages in this trial's transcript at trial end.                                                                                                                                                          |
| `messages_sent`       | integer        | How many of those this participant sent.                                                                                                                                                                            |
| `my_order`            | string[]       | This client's scrambled display order — only when `save_orders`.                                                                                                                                                    |
| `partner_order`       | string[]       | The partner's display order (computed locally) — only when `save_orders`.                                                                                                                                           |
| `ended_by`            | string         | `"submit"` (the matcher submitted), `"timeout"` (`round_timeout`/`selection_timeout`), `"participant_left"` (the partner left the study), or `"connection_lost"` (this participant's connection was lost for good). |
| `partner_left`        | boolean        | True if the round ended because the partner left the study.                                                                                                                                                         |
| `left_participant`    | string         | The participant whose departure ended the round, or `null`.                                                                                                                                                         |
| `connection_lost`     | boolean        | True if the round ended because this participant's connection was lost for good.                                                                                                                                    |
| `interaction_history` | object[]       | The matcher's pre-submit actions (`{ t, action, slot, object_id }`) — only when `save_interaction_history`.                                                                                                         |

## Partner leaving

The multiplayer API tracks each participant's presence: `connected`, `away` (their connection dropped, possibly briefly), or `left` (away for longer than the dropout timeout set in `jsPsych.multiplayer.connect()`). By default, if the partner reaches `left` before feedback, the round ends with `ended_by: "participant_left"`, `partner_left: true`, their ID in `left_participant`, and no assignment. A submission that arrived before they left is still scored, and once feedback is showing the round finishes normally. Set `end_on_participant_left: false` to rely on `round_timeout` instead.

If this participant's own connection is lost for good, the round ends with `ended_by: "connection_lost"`.

## How it works (correctness notes)

This plugin writes with **`update`**, which merges just the one key it owns into the participant's slot, so `joinedAt` and anything another trial wrote survive untouched — and it **namespaces each round's data under `data_key[round]`** so successive round-trials in one timeline never clobber each other. The multiplayer API shows a participant's own writes in reads immediately, so each chat send reads your messages from your slot, and two quick sends can't lose the first.

Like the chat room, the trial stays open and re-renders on every group-session update. The **matcher's submitted assignment is the shared trigger**: the director's subscription watches for it, and both clients then score (identically, from the same data), reveal the answer, and end within `feedback_duration` of the submission — no extra barrier needed. The matcher's pre-submit action log stays **local** until submit; only the final assignment is ever written.

Layouts are a **deterministic** function of `(session, seed, round, participant ids)`: every shuffle goes through `jsPsych.multiplayer.shuffle`, which is seeded by the session ID (or the `randomSeed` connect option), so each group gets its own layouts. They are stable across re-renders and reloads and each client can also compute its _partner's_ order locally — which is how `partner_order` lands in the data without an extra push. In `"independent"` mode the two layouts are **guaranteed to differ** when there is more than one object (the higher participant id's scramble is deterministically re-salted on the rare collision), so the "can't point by position" property holds even for small object sets.

## Example: sequential (one target, a single click)

```js
const round = {
  type: jsPsychMultiplayerReferenceGame,
  stimuli: SHAPES, // [{ id, html }, …]
  role: () => jsPsychMultiplayerRole.getMyRole(),
  round: jsPsych.timelineVariable("round"),
  targets: jsPsych.timelineVariable("targets"), // e.g. ["star5"] — one target
  prompt: (role) =>
    role === "director"
      ? "<p>Describe the highlighted shape.</p>"
      : "<p>Click the shape your partner describes.</p>",
};
```

## Example: full-board match (all objects are ordered targets, score out of N)

```js
const round = {
  type: jsPsychMultiplayerReferenceGame,
  stimuli: SHAPES,
  columns: 3,
  role: () => jsPsychMultiplayerRole.getMyRole(),
  round: jsPsych.timelineVariable("round"),
  targets: jsPsych.timelineVariable("targets"), // all ids, in an order
  ordered: true,
  submit_label: "Submit board",
  show_running_score: true,
};
```
