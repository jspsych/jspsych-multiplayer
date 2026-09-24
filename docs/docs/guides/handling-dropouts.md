---
id: handling-dropouts
title: Handling dropouts
sidebar_label: Handling dropouts
sidebar_position: 2
description: How the multiplayer plugins detect a participant who leaves, what they record, and how gates stay separate.
---

# Handling dropouts

Participants close tabs, lose their connection, and walk away. A multiplayer experiment
has to notice and move on, rather than leave the others waiting forever. This page covers
how the core API detects a departure, the conventions every plugin in this repository
follows, and how to set up the few trials that need something different.

## How a departure is detected

Each adapter reports which participants currently have an open connection. The core turns
that into a **presence** status for every participant:

| Status      | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `connected` | The participant is connected.                                                            |
| `away`      | The participant's connection dropped. Brief network interruptions look like this.        |
| `left`      | The participant has been away longer than the dropout timeout. This status is permanent. |

The dropout timeout defaults to 10 seconds. Change it when you connect:

```js
await jsPsych.multiplayer.connect(adapter, {
  dropoutTimeout: 15000,
  onParticipantLeft: (id) => console.log(`${id} left`),
});
```

How quickly an adapter notices a drop depends on the backend; see
[Choosing an adapter](/guides/choosing-an-adapter). Two consequences apply everywhere:

- **Slots outlive participants.** A participant's data stays in the shared data after they
  leave. Count participants with `presence`, which every `wait_for`, `ready`, and `end_when`
  callback receives as its second argument, not with `Object.keys(group)`.
- **A departure is not a timeout.** A slow participant who stays connected is never marked
  `left`. Keep timeouts for participants who are present but never act.

## What the plugins do

Every plugin that waits on other participants ends its trial, instead of hanging, when a
participant it depends on leaves or when this participant's own connection is lost. The
trial data then records why:

| Field              | Meaning                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `partner_left`     | `true` if the trial ended because a participant it depended on left.                                |
| `left_participant` | That participant's ID, or `null`.                                                                   |
| `connection_lost`  | `true` if this participant's connection was lost for good.                                          |
| `ended_by`         | In chat, draw, and reference-game: `"participant_left"` or `"connection_lost"` for these two cases. |

What "ends" means depends on the plugin. `sync` and `ready` finish the trial; `match` and
`role` finish unmatched or without a role; `choice` and `scoreboard` reveal whoever reported;
`countdown` keeps counting down locally, because its shared deadline doesn't need anyone else.

### Which participants a trial depends on

- **Barrier plugins** (`ready`, `choice`, `match`, `role`, `scoreboard`) take a
  `participants` parameter. The default, `null`, means every other participant who is
  `connected` when the wait starts. Participants who are only `away` at that moment are left
  out, because a slot left over from an earlier member starts out `away` and becomes `left`
  a few seconds later. Pass a list to depend on specific participants, or `[]` to ignore
  departures.
- **`sync`** takes the same `participants` parameter, but its default is `[]`, which
  ignores departures, because `sync` is often used as a lobby (see below). Pass `null` or a
  list to make a `sync` barrier end when someone leaves.
- **Live plugins** (`chat`, `draw`, `reference-game`) take `end_on_participant_left`,
  default `true`: the trial ends when a participant who was connected when it started
  leaves. Set it to `false` to carry on with whoever remains.

### Lobbies

A lobby waits until enough participants are present. Someone leaving should mean waiting a
little longer, not ending the lobby. `sync` ignores departures by default, so count by
presence in `wait_for`:

```js
const lobby = {
  type: jsPsychMultiplayerSync,
  push_data: { status: "ready" },
  wait_for: (_group, presence) =>
    Object.values(presence).filter((status) => status === "connected").length >= 2,
};
```

To build a lobby from another barrier plugin, pass `participants: []`. A mid-game wait for a
specific partner should name them, as in the
[ultimatum tutorial](/tutorials/ultimatum-game): `participants: () => [partnerId]`.

## Gates and keys

`ready`, `choice`, and `scoreboard` store each participant's contribution under a key in
their slot. If two gates shared a key, the second gate could pass on flags left over from
the first. So by default each gate gets its own key: `ready-1`, `ready-2`, …,
`choice-1`, `choice-2`, …, and `scoreboard-1`, `scoreboard-2`, …

The number counts how many gates of that plugin this participant has reached. Participants
pass gates in the same order, so the Nth gate gets the same key for everyone, however many
other trials each participant saw along the way. Each trial records the key it used as
`data_key` in its data.

Set `data_key` yourself in two cases:

- **A gate that only some participants reach**, for example inside a
  `conditional_function`. The participants who skip it don't count it, so their later keys
  would no longer match.
- **A page reload.** The count restarts at 1 when the page reloads, so a participant who
  reloads mid-experiment would reuse earlier keys. Explicit keys avoid this; better support
  for rejoining after a reload is planned.
