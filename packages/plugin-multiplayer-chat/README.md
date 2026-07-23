# @jspsych-multiplayer/plugin-multiplayer-chat

A real-time chat-room plugin for multiplayer jsPsych experiments, built on the multiplayer plugin API. The trial stays open, subscribes to the shared group session, renders the merged transcript of every participant's messages, and lets this participant send messages — ending on a time limit, a button, or a condition over the group session.

It is the first plugin built on the multiplayer API's real-time **`subscribe`** primitive, as opposed to the barrier-based **push → wait** pattern of [`plugin-multiplayer-sync`](../plugin-multiplayer-sync). Use sync when you need to block until a condition holds; use chat when participants need to exchange messages continuously.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. The plugin codes against a local interface mirroring that API (`src/multiplayer-api.ts`) and reaches the real object with one cast — the single seam to re-verify once #3694 lands. Tests run against an in-memory mock, so no live group session is needed to develop it.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter          | Type        | Default             | Description                                                                                                                                                              |
| ------------------ | ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`           | HTML string | `""`                | Instructions rendered above the transcript.                                                                                                                              |
| `placeholder`      | string      | `"Type a message…"` | Placeholder text for the empty message input.                                                                                                                            |
| `data_key`         | string      | `"chat_messages"`   | Group-session field this trial stores its message array under. Namespacing keeps the chat log from colliding with other pushed data (e.g. a role) or another chat trial. |
| `duration`         | integer     | `null`              | Auto-end the trial after this many milliseconds. `null` (or non-positive) means no time limit.                                                                           |
| `end_button_label` | string      | `null`              | If set, show a button with this label that ends the trial when clicked. `null` hides it.                                                                                 |
| `end_when`         | function    | `null`              | Predicate `(group) => boolean` evaluated on every update; the trial ends when it returns true.                                                                           |
| `sender_label`     | function    | `null`              | Maps a senderId to a display name: `(senderId, group) => string`. Defaults to `"You"` for this participant and the raw senderId otherwise.                               |
| `max_length`       | integer     | `null`              | Maximum length, in characters, of a single message. `null` means no limit.                                                                                               |
| `show_roster`      | boolean     | `false`             | Show the list of participants currently present in the group session.                                                                                                    |

> **Set at least one end condition** (`duration`, `end_button_label`, or `end_when`). With none, the trial can never end, and the plugin logs a warning.

## Data Generated

| Name            | Type    | Description                                                                                    |
| --------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `transcript`    | object  | The ordered array of messages as **this client** saw it when the trial ended (see note below). |
| `message_count` | integer | Total number of distinct messages in the transcript.                                           |
| `messages_sent` | integer | How many messages this participant sent.                                                       |
| `chat_time`     | integer | Time from trial start until the trial ended, in milliseconds.                                  |
| `ended_by`      | string  | What ended the trial: `"duration"`, `"button"`, or `"condition"`.                              |

> **`transcript` is this client's view at its own trial end.** Because clients end their own trials independently (a `duration` timer starts slightly later per client, buttons are clicked at different moments), transcripts saved by different participants can differ at the tail. This is the same per-client-timing tradeoff as any independently-ended multiplayer trial.

## How messages are stored

The multiplayer API's `push` **replaces** a participant's slot (it does not merge). A participant therefore owns one slot, so chat history is modeled as an append-only array each participant keeps under `data_key`; the rendered transcript is the merge of every participant's array, ordered by `(timestamp, senderId, seq)` and de-duplicated by message id. When you send, the plugin reads your own slot first and pushes it back with only the chat key changed, so any other data you've pushed (e.g. a role assigned by `plugin-multiplayer-role`) is preserved.

Ordering uses each sender's own clock, which is not synchronized across clients, so strict global order across senders is best-effort. The sort is timestamp-first (`seq` only breaks ties), so even a single sender's messages keep their order only as long as that sender's local clock is monotonic during the trial — a clock that jumps backwards (e.g. an NTP adjustment mid-chat) can reorder them.

> **Payload growth:** each send re-pushes the sender's *entire* message history (plus the rest of their slot), so bytes on the wire grow roughly quadratically with message count, and backends cap group-session size (e.g. JATOS). This is fine for short discussions; keep very long or high-frequency chats in mind.

## Example: a two-minute open chat with a "done" button

```js
const chat = {
  type: jsPsychMultiplayerChat,
  prompt: "<p>Discuss your strategy with the other player.</p>",
  duration: 120000,
  end_button_label: "I'm done",
};
```

## Example: end when everyone is done

Have each client push a `chat_done` flag (e.g. via `plugin-multiplayer-sync`, or by ending on the button and pushing the flag in `on_finish`), and end the chat once all present participants have set it:

```js
const chat = {
  type: jsPsychMultiplayerChat,
  end_when: (group) => Object.values(group).every((p) => p.chat_done),
};
```

## Example: label senders by their assigned role

Compose with `plugin-multiplayer-role` — no hard dependency, just a function:

```js
const chat = {
  type: jsPsychMultiplayerChat,
  duration: 60000,
  sender_label: (id) => jsPsychMultiplayerRole.participantsByRole()[id] ?? id,
};
```
