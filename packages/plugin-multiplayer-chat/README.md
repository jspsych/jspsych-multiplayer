# @jspsych-multiplayer/plugin-multiplayer-chat

A real-time chat-room plugin for multiplayer jsPsych experiments, built on the multiplayer plugin API. The trial stays open, subscribes to the shared group session, renders the merged transcript of every participant's messages, and lets this participant send messages — ending on a time limit, a button, or a condition over the group session.

It is the first plugin built on the multiplayer API's real-time **`subscribe`** primitive, as opposed to the barrier-based **update → wait** pattern of [`plugin-multiplayer-sync`](../plugin-multiplayer-sync). Use sync when you need to block until a condition holds; use chat when participants need to exchange messages continuously.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. It uses `jsPsych.multiplayer` and throws a clear error on a jsPsych version without it. Tests run the real multiplayer session over an in-memory backend, so no live group session is needed to develop it.

## Prerequisites

Requires a connected multiplayer adapter (e.g. `@jspsych-multiplayer/adapter-multiplayer-jatos`). Connect it before `jsPsych.run()`:

```js
const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
await jsPsych.run(timeline);
```

## Parameters

| Parameter                 | Type        | Default             | Description                                                                                                                                          |
| ------------------------- | ----------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                  | HTML string | `""`                | Instructions rendered above the transcript.                                                                                                          |
| `placeholder`             | string      | `"Type a message…"` | Placeholder text for the empty message input.                                                                                                        |
| `duration`                | integer     | `null`              | Auto-end the trial after this many milliseconds. `null` (or non-positive) means no time limit.                                                       |
| `end_button_label`        | string      | `null`              | If set, show a button with this label that ends the trial when clicked. `null` hides it.                                                             |
| `end_when`                | function    | `null`              | Predicate `(group, presence) => boolean` evaluated on every update; the trial ends when it returns true.                                             |
| `sender_label`            | function    | `null`              | Maps a senderId to a display name: `(senderId, group, presence) => string`. Defaults to `"You"` for this participant and the raw senderId otherwise. |
| `max_length`              | integer     | `null`              | Maximum length, in characters, of a single message. `null` means no limit.                                                                           |
| `show_roster`             | boolean     | `false`             | Show the participants in the group session, marking those whose connection dropped "(away)" and those who left the study "(left)".                   |
| `end_on_participant_left` | boolean     | `true`              | End the trial when another participant leaves the study (see [Participants leaving](#participants-leaving)).                                         |

`group` and `presence` are the multiplayer API's frozen snapshots: read them, but don't modify them. `group` holds **this trial's** data (see [Continuing a chat across trials](#continuing-a-chat-across-trials)); to show names or roles written in an earlier trial, read them from the session scope with `jsPsych.multiplayer.get(id, { scope: "session" })`.

> **Set at least one end condition** (`duration`, `end_button_label`, or `end_when`). With none, the trial can never end, and the plugin logs a warning.

## Data Generated

| Name                  | Type    | Description                                                                                                                                                 |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript`          | object  | The ordered array of messages as **this client** saw it when the trial ended (see note below).                                                              |
| `message_count`       | integer | Total number of distinct messages in the transcript.                                                                                                        |
| `messages_sent`       | integer | How many messages this participant sent.                                                                                                                    |
| `chat_time`           | integer | Time from trial start until the trial ended, in milliseconds.                                                                                               |
| `multiplayer_outcome` | string  | How the trial ended: `"completed"` (by `duration`, the end button, or `end_when`), `"participant_left"`, `"connection_lost"`, or `"cancelled"` (see below). |
| `left_participant`    | string  | The participant whose departure ended the trial, or `null`.                                                                                                 |
| `ended_by`            | string  | Which end condition completed the trial: `"duration"`, `"button"`, or `"condition"` (`end_when`). `null` when `multiplayer_outcome` isn't `"completed"`.    |

> **`transcript` is this client's view at its own trial end.** Because clients end their own trials independently (a `duration` timer starts slightly later per client, buttons are clicked at different moments), transcripts saved by different participants can differ at the tail. This is the same per-client-timing tradeoff as any independently-ended multiplayer trial.

## Participants leaving

The multiplayer API tracks each participant's presence: `connected`, `away` (their connection dropped, possibly briefly), or `left` (away for longer than the dropout timeout set in `jsPsych.multiplayer.connect()`). By default, the trial ends as soon as another participant it depends on reaches `left`, with `multiplayer_outcome: "participant_left"` and their ID in `left_participant`. In a sealed group (see `jsPsych.multiplayer.group()`) it depends on every other member who hasn't left; otherwise, on the participants who were connected when the trial started. A participant who is only `away` doesn't end the trial. Messages a departed participant sent stay in the transcript.

Set `end_on_participant_left: false` to keep chatting with whoever remains; with `show_roster`, departed participants are then marked "(left)".

If this participant's own connection is lost for good, the trial ends with `multiplayer_outcome: "connection_lost"` and the transcript seen up to that point. If the experiment calls `jsPsych.multiplayer.disconnect()` during the trial, it ends with `"cancelled"`.

## Continuing a chat across trials

Messages are kept in the trial's own part of the shared data, so every chat trial starts with an empty transcript, even when the same trial object runs again in a loop. To continue one conversation across several trials (e.g. chat, then a decision, then more chat), give those trials the same `multiplayer_scope`:

```js
const discussion = {
  type: jsPsychMultiplayerChat,
  multiplayer_scope: "discussion",
  duration: 60000,
};
const timeline = [discussion, decision, discussion]; // the second chat shows the first one's messages
```

Everything else in those trials that uses the default scope shares it too, so give a different name to each conversation you want kept apart.

## How messages are stored

Each participant writes only their own data, so chat history is modeled as an append-only array each participant keeps under the `chat_messages` key of the trial's data; the rendered transcript is the merge of every participant's array, ordered by `(timestamp, senderId, seq)` and de-duplicated by message id. Each send reads your own array, appends the message, and writes it back with `update()`, which merges only the chat key into your data, so anything else you've written in the trial is preserved. The multiplayer API shows your own writes in reads immediately, so two quick sends can't lose the first, and it retries a write that fails.

Because each message is kept in the array rather than in a "latest message" field, no message is lost when the API combines several quick sends into one write to the backend.

Ordering uses each sender's own clock, which is not synchronized across clients, so strict global order across senders is best-effort. The sort is timestamp-first (`seq` only breaks ties), so even a single sender's messages keep their order only as long as that sender's local clock is monotonic during the trial — a clock that jumps backwards (e.g. an NTP adjustment mid-chat) can reorder them.

> **Payload growth:** each send re-sends the sender's _entire_ message history (plus the rest of their data), so bytes on the wire grow roughly quadratically with message count, and backends cap group-session size (e.g. JATOS). This is fine for short discussions; keep very long or high-frequency chats in mind.

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

Have each client write a `chat_done` flag when they click the end button (a trial's `on_finish` still writes to that trial's data), and end the chat once every participant has either set it or left:

```js
const chat = {
  type: jsPsychMultiplayerChat,
  end_button_label: "I'm done",
  on_finish: () => jsPsych.multiplayer.update({ chat_done: true }),
  end_when: (group, presence) => {
    // End once every participant has either set chat_done or left
    for (const id in group) {
      if (!group[id].chat_done && presence[id] !== "left") {
        return false; // this participant is still going
      }
    }
    return true;
  },
};
```

## Example: label senders by their assigned role

Compose with `plugin-multiplayer-role` — no hard dependency, just a function:

```js
const chat = {
  type: jsPsychMultiplayerChat,
  duration: 60000,
  sender_label: (senderId) => {
    // Show the sender's role, or their ID if roles haven't been assigned yet
    const roleMap = jsPsychMultiplayerRole.getRoleMap();
    if (roleMap !== undefined && roleMap[senderId] !== undefined) {
      return roleMap[senderId].role;
    }
    return senderId;
  },
};
```
