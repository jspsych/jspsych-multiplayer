---
id: plugin-multiplayer-chat
title: multiplayer-chat
sidebar_label: multiplayer-chat
description: A live text chat between the participants in a group, saved as a transcript in the trial data.
---

# `multiplayer-chat`

A chat trial lets participants talk to each other in writing. Every message appears on everyone's
screen as soon as it arrives, and each participant's data gets the full transcript. Use it for
free discussion before a decision, for negotiation, or for any task where the conversation is
the data.

The trial stays open until one of the end conditions you set is met: a time limit (`duration`),
a button the participant clicks (`end_button_label`), or a condition over the group's shared data
(`end_when`). Set at least one; with none, the trial cannot end and the plugin logs a warning.

**What the participant sees:** your `prompt`, a scrolling message log, and a text box with a
**Send** button. Their own messages are labelled "You". If you set `end_button_label`, a button
with that label sits below the text box. The log stays scrolled to the newest message unless the
participant has scrolled up to read.

```js
timeline.push({
  type: jsPsychMultiplayerChat,
  prompt: "<p>Discuss your strategy with the other player.</p>",
  duration: 120000,
  end_button_label: "I'm done",
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/plugin-multiplayer-chat` |
| Browser global | `jsPsychMultiplayerChat` |
| Trial type | `multiplayer-chat` |
| Requires | a connected session (see [Getting started](../getting-started)) |

## Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `prompt` | HTML string | `""` | Shown above the message log. |
| `placeholder` | `string` | `"Type a message…"` | Placeholder text in the empty text box. |
| `data_key` | `string` | `"chat_messages"` | The field in this participant's slot where their messages are kept. Give two chat trials in one experiment different keys if each should start with an empty log; trials that share a key share a log. |
| `duration` | `number \| null` | `null` | End the trial after this many ms. `null`, `0`, or a negative number means no time limit. Each participant's timer starts when they reach the trial, so the chat closes at slightly different moments for different participants. |
| `end_button_label` | `string \| null` | `null` | Show a button with this label that ends the trial for the participant who clicks it. `null` shows no button. |
| `end_when` | `(group, presence) => boolean` | `null` | A condition checked at the start and after every change to the shared data or presence. The trial ends as soon as it returns `true`. Both arguments are frozen, so don't modify them. |
| `sender_label` | `(senderId, group, presence) => string` | `null` | The name shown next to each message. By default this participant's messages say "You" and everyone else's show their participant ID. Also used for the roster. |
| `max_length` | `number \| null` | `null` | The longest a message can be, in characters. Longer messages are cut to this length when sent. `null` means no limit. |
| `show_roster` | `boolean` | `false` | Show a "Participants:" line above the log listing everyone in the group, with "(away)" after anyone whose connection has dropped and "(left)" after anyone who has left. |
| `end_on_participant_left` | `boolean` | `true` | End the trial when a participant who was connected at the start of the trial leaves. Set `false` to keep chatting with whoever remains. |

## Data

| Field | Type | Description |
| --- | --- | --- |
| `transcript` | `object[]` | Every message, in order, as this participant's screen showed it when their trial ended. Each message is `{ id, senderId, seq, text, ts }`: `senderId` is the sender's participant ID, `text` is what they typed, `ts` is when they sent it (milliseconds since 1970, by the sender's clock), and `seq` counts that sender's messages from 0. |
| `message_count` | `number` | How many messages are in `transcript`. |
| `messages_sent` | `number` | How many of them this participant sent. |
| `chat_time` | `number` | Milliseconds from the start of the trial to its end. |
| `ended_by` | `string` | What ended the trial: `"duration"`, `"button"`, `"condition"` (`end_when`), `"participant_left"`, or `"connection_lost"`. |
| `partner_left` | `boolean` | `true` if the trial ended because another participant left. |
| `left_participant` | `string \| null` | The ID of the participant who left, when `partner_left` is `true`. |
| `connection_lost` | `boolean` | `true` if the trial ended because this participant's own connection was lost for good. |

[Handling dropouts](../guides/handling-dropouts) explains `partner_left`, `left_participant`,
`connection_lost`, and how to branch on them.

## Transcripts can differ at the end

Each participant's trial ends on its own schedule: timers start when each participant arrives,
and people click the end button at different moments. A message sent in the last second may
reach one participant's transcript and not another's. To analyze the conversation, use the
longest transcript in the group, or merge them by `id`.

Messages are ordered by the time on the sender's computer. Computer clocks are not perfectly in
step, so two messages sent within a fraction of a second of each other by different people can
appear in either order. Everyone sees the same order.

Each participant's messages are stored in their own slot, and every send writes the full list
again. This is fine for a conversation of a few dozen messages. For very long chats, keep in mind
that some backends limit how much data a group can hold.

## When someone leaves

The group tracks whether each participant is `connected`, `away` (their connection dropped,
possibly for a moment), or `left` (gone for longer than the dropout timeout). By default the chat
ends as soon as a participant who was there at the start reaches `left`. A participant who is only
`away` does not end it.

If this participant's own connection is lost for good, the trial ends with
`ended_by: "connection_lost"` and the transcript seen up to that point. If a single message fails
to send, the participant sees a short note and the message goes out with their next one.

## Example

A three-minute chat in which each player's messages carry the name they chose earlier, with a
roster so players can see who is still there:

```js
const nameTrial = {
  type: jsPsychSurveyText,
  questions: [{ prompt: "Choose a display name:", name: "name", required: true }],
  on_finish: (data) => {
    jsPsych.multiplayer.update({ name: data.response.name.trim() });
  },
};

const chat = {
  type: jsPsychMultiplayerChat,
  prompt: "<p>You have three minutes. Agree on a plan together.</p>",
  duration: 180000,
  end_button_label: "Leave chat",
  show_roster: true,
  max_length: 280,
  sender_label: (senderId, group) => {
    if (senderId === jsPsych.multiplayer.participantId) return "You";
    return group[senderId]?.name || "A participant";
  },
};
```

If you assigned roles with [`multiplayer-role`](plugin-multiplayer-role), label senders by role
instead:

```js
sender_label: (senderId) =>
  jsPsychMultiplayerRole.getRoleMap()?.[senderId]?.role ?? senderId,
```
