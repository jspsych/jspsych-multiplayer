---
id: handling-dropouts
title: Handling dropouts
sidebar_label: Handling dropouts
description: How the multiplayer plugins detect a participant who leaves, what they record, how a participant rejoins, and how gates stay separate.
---

# Handling dropouts

Participants close tabs, lose their connection, and walk away. A multiplayer experiment
has to notice and move on, rather than leave the others waiting forever. This page covers
how the core API detects a departure, the conventions every plugin in this repository
follows, and how to set up the few trials that need something different.

## How a departure is detected

Each adapter reports which participants currently have an open connection. The core turns
that into a **presence** status for every participant:

| Status      | Meaning                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| `connected` | The participant is connected.                                                     |
| `away`      | The participant's connection dropped. Brief network interruptions look like this. |
| `left`      | The participant has been away longer than the dropout timeout.                    |

The dropout timeout defaults to 10 seconds. Change it when you connect:

```js
await jsPsych.multiplayer.connect(adapter, {
  dropoutTimeout: 15000,
  onParticipantLeft: (id) => console.log(`${id} left`),
});
```

How quickly an adapter notices a drop depends on the backend; see
[Choosing a backend](choosing-a-backend). Two consequences apply everywhere:

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
[ultimatum game](ultimatum-game): `participants: () => [partnerId]`.

## Rejoining

A participant who drops out can come back, but only from the same page. The core tells two
cases apart:

- **Same page.** Their connection dropped and recovered: a network outage, a laptop going
  to sleep, a background tab that missed its heartbeats. Their experiment is still where
  they left it, so they become `connected` again, and `onParticipantRejoined` is called if
  they had reached `left`.
- **New page load.** They reloaded, or opened the study again in a new tab, under the same
  ID. Their experiment started over, so it is out of step with the group. They stay `left`
  (or become `left` at once, if they were only `away`), and `onParticipantRestarted` is
  called. On their own page, `jsPsych.multiplayer.previousInstance` is set.

```js
await jsPsych.multiplayer.connect(adapter, {
  onParticipantRejoined: (id) => console.log(`${id} is back`),
  onParticipantRestarted: (id) => console.log(`${id} reloaded and can't rejoin`),
});

if (jsPsych.multiplayer.previousInstance) {
  // This participant reloaded. Show a message instead of starting the game again.
}
```

To tell a reconnect from a reload, each page writes a random page ID and a counter into its
slot under the reserved key `$mp`, and writes them again whenever its connection recovers.
The core removes `$mp` from everything you read, and rejects writes that use it. You will
see it in raw backend data, such as a JATOS group session or the Firebase console.

Rejoining changes only what happens next. A trial that already ended with `partner_left`
stays ended, and its data keeps that record. The recipe below shows how to give a partner
time to come back and then repeat the step.

How each adapter supports rejoining:

| Adapter  | A participant comes back when                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JATOS    | Their group channel reopens. The adapter keeps retrying by default (`closeAfterReconnectingMs: null`), so a participant who is offline for several minutes still rejoins.          |
| Firebase | Firebase reconnects (`.info/connected` turns true again). The adapter rewrites its presence entry and the core announces the return.                                               |
| Local    | The tab sends a heartbeat again. A tab whose heartbeats lapsed, for example because the browser throttled it in the background, reports that as a reconnect, so it counts as back. |

### Recipe: wait for a partner to come back

When a step ends because the partner left, you can wait a few minutes for them to return
and then repeat the step. Wrap the step and a waiting trial in a loop:

```js
const RETURN_WINDOW = 3 * 60 * 1000; // how long to wait for the partner, in ms

// The step that needs the partner, e.g. waiting for their decision
const waitForDecision = {
  type: jsPsychMultiplayerSync,
  participants: () => [partnerId],
  wait_for: (group) => group[partnerId]?.decision !== undefined,
};

// Runs only if the step above ended because the partner left
const waitForReturn = {
  timeline: [
    {
      type: jsPsychMultiplayerSync,
      message: "<p>Your partner lost their connection. Waiting for them to come back…</p>",
      wait_for: (_group, presence) => presence[partnerId] === "connected",
      timeout: RETURN_WINDOW,
      data: { return_wait: true },
    },
  ],
  conditional_function: () => jsPsych.data.get().last(1).values()[0].partner_left === true,
};

const decisionStep = {
  timeline: [waitForDecision, waitForReturn],
  // Repeat the step if the partner left and came back in time
  loop_function: (data) => {
    const [step, returnWait] = data.values();
    return step.partner_left === true && returnWait?.timed_out === false;
  },
};

// After the loop: if the partner never came back, end the session
const partnerGone = {
  timeline: [
    {
      type: jsPsychHtmlButtonResponse,
      stimulus: "<p>Your partner didn't come back, so the game has ended.</p>",
      choices: ["Finish"],
      on_finish: () => jsPsych.abortExperiment(),
    },
  ],
  conditional_function: () => {
    const last = jsPsych.data.get().last(1).values()[0];
    return last.return_wait === true && last.timed_out === true;
  },
};

const timeline = [/* …, */ decisionStep, partnerGone /*, … */];
```

The waiting trial counts a partner as back only when they rejoin from the same page. A
partner who reloaded stays `left`, so the wait runs out and the game ends. This recipe may
become a jsPsych extension later.

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
  reloads mid-experiment would reuse earlier keys. A reloaded participant can't rejoin the
  group anyway (see [Rejoining](#rejoining)), but explicit keys keep their data apart.
  Support for resuming after a reload is planned.
