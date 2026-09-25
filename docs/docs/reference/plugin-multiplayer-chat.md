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
| `duration` | `number \| null` | `null` | End the trial after this many ms. `null`, `0`, or a negative number means no time limit. Each participant's timer starts when they reach the trial, so the chat closes at slightly different moments for different participants. |
| `end_button_label` | `string \| null` | `null` | Show a button with this label that ends the trial for the participant who clicks it. `null` shows no button. |
| `end_when` | `(group, presence) => boolean` | `null` | A condition checked at the start and after every change to the trial's shared data or presence. The trial ends as soon as it returns `true`. |
| `sender_label` | `(senderId, group, presence) => string` | `null` | The name shown next to each message. By default this participant's messages say "You" and everyone else's show their participant ID. Also used for the roster. |
| `max_length` | `number \| null` | `null` | The longest a message can be, in characters. Longer messages are cut to this length when sent. `null` means no limit. |
| `show_roster` | `boolean` | `false` | Show a "Participants:" line above the log listing everyone in the group, with "(away)" after anyone whose connection has dropped and "(left)" after anyone who has left. |
| `end_on_participant_left` | `boolean` | `true` | End the trial when another participant it depends on leaves (see [When someone leaves](#when-someone-leaves)). Set `false` to keep chatting with whoever remains. |

`group` is the **trial's** shared data (see [Continuing a chat across
trials](#continuing-a-chat-across-trials)) and `presence` is everyone's connection status. Both are
frozen, so read them but don't modify them. To show names or roles written in an earlier trial,
read them from the session scope with `jsPsych.multiplayer.get(id, { scope: "session" })`.

## Data

| Field | Type | Description |
| --- | --- | --- |
| `transcript` | `object[]` | Every message, in order, as this participant's screen showed it when their trial ended. Each message is `{ id, senderId, seq, text, ts }`: `senderId` is the sender's participant ID, `text` is what they typed, `ts` is when they sent it (milliseconds since 1970, by the sender's clock), and `seq` counts that sender's messages from 0. |
| `message_count` | `number` | How many messages are in `transcript`. |
| `messages_sent` | `number` | How many of them this participant sent. |
| `chat_time` | `number` | Milliseconds from the start of the trial to its end. |
| `multiplayer_outcome` | `string` | How the trial ended: `"completed"` (by `duration`, the end button, or `end_when`), `"participant_left"`, `"connection_lost"`, or `"cancelled"` (the experiment called `jsPsych.multiplayer.disconnect()` during the trial). |
| `left_participant` | `string \| null` | The ID of the participant whose departure ended the trial, when `multiplayer_outcome` is `"participant_left"`. |
| `ended_by` | `string \| null` | Which end condition completed the trial: `"duration"`, `"button"`, or `"condition"` (`end_when`). `null` when `multiplayer_outcome` isn't `"completed"`. |

[Handling dropouts](../guides/handling-dropouts) explains `multiplayer_outcome` and
`left_participant`, and how to branch on them.

## Transcripts can differ at the end

Each participant's trial ends on its own schedule: timers start when each participant arrives,
and people click the end button at different moments. A message sent in the last second may
reach one participant's transcript and not another's. To analyze the conversation, use the
longest transcript in the group, or merge them by `id`.

Messages are ordered by the time on the sender's computer. Computer clocks are not perfectly in
step, so two messages sent within a fraction of a second of each other by different people can
appear in either order. Everyone sees the same order.

Each participant's messages are stored as a list in their own part of the trial's shared data,
and every send writes the full list again. This is fine for a conversation of a few dozen
messages. For very long chats, keep in mind that each backend limits how much data a participant
or group can hold (see [Choosing a backend](../guides/choosing-a-backend)).

## When someone leaves

The group tracks whether each participant is `connected`, `away` (their connection dropped,
possibly for a moment), or `left` (gone for longer than the dropout timeout). By default the chat
ends as soon as a participant it depends on reaches `left`, with
`multiplayer_outcome: "participant_left"` and their ID in `left_participant`. In a [sealed
group](../guides/forming-groups), it depends on every other member who hasn't left; otherwise, on
the participants who were connected when the trial started. A participant who is only `away` does
not end it. Messages a departed participant sent stay in the transcript.

If this participant's own connection is lost for good, the trial ends with
`multiplayer_outcome: "connection_lost"` and the transcript seen up to that point. A message that
fails to send is retried automatically.

## Continuing a chat across trials

Messages are kept in the trial's own part of the shared data (its [trial
scope](../guides/how-it-works)), so every chat trial starts with an empty log, even when the same
trial runs again in a loop. To continue one conversation across several trials (for example chat,
then a decision, then more chat), give those trials the same `multiplayer_scope`:

```js
const discussion = {
  type: jsPsychMultiplayerChat,
  multiplayer_scope: "discussion",
  duration: 60000,
};

// The second chat shows the first one's messages
timeline.push(discussion, decision, discussion);
```

Everything else in those trials that uses the trial scope shares it too, so give each
conversation you want kept apart its own name.

## Example

A three-minute chat in which each player's messages carry the name they chose earlier, with a
roster so players can see who is still there. The name is written to the session scope, so the
chat trial can read it:

```js
const nameTrial = {
  type: jsPsychSurveyText,
  questions: [{ prompt: "Choose a display name:", name: "name", required: true }],
  on_finish: (data) => {
    jsPsych.multiplayer.update({ name: data.response.name.trim() }, { scope: "session" });
  },
};

const chat = {
  type: jsPsychMultiplayerChat,
  prompt: "<p>You have three minutes. Agree on a plan together.</p>",
  duration: 180000,
  end_button_label: "Leave chat",
  show_roster: true,
  max_length: 280,
  sender_label: (senderId) => {
    if (senderId === jsPsych.multiplayer.participantId) return "You";
    // undefined until the participant has entered a name
    const name = jsPsych.multiplayer.get(senderId, { scope: "session" })?.name;
    return name || "A participant";
  },
};
```

To end the chat once everyone is done, have each participant write a `chat_done` flag when they
click the end button (a trial's `on_finish` still writes to that trial's data), and end once every
participant has set it or left:

```js
const chat = {
  type: jsPsychMultiplayerChat,
  end_button_label: "I'm done",
  on_finish: () => jsPsych.multiplayer.update({ chat_done: true }),
  end_when: (group, presence) => {
    for (const id in group) {
      if (!group[id].chat_done && presence[id] !== "left") {
        return false; // this participant is still going
      }
    }
    return true;
  },
};
```

If you assigned roles with [`multiplayer-role`](plugin-multiplayer-role), label senders by role
instead:

```js
sender_label: (senderId) => {
  // The role map is undefined until the role trial has run
  const roleMap = jsPsychMultiplayerRole.getRoleMap();
  if (roleMap !== undefined && roleMap[senderId] !== undefined) {
    return roleMap[senderId].role;
  }
  return senderId;
},
```
