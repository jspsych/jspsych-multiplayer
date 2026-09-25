---
id: handling-dropouts
title: Handling dropouts
sidebar_label: Handling dropouts
description: How the multiplayer plugins detect a participant who leaves, what they record, and when a participant can rejoin.
---

# Handling dropouts

Participants close tabs, lose their connection, and walk away. A multiplayer experiment
has to notice and move on, rather than leave the others waiting forever. This page covers
how the core API detects a departure, the conventions every plugin in this repository
follows, and how to set up the few trials that need something different.

## How a departure is detected

Each adapter reports which participants currently have an open connection. The core turns
that into a **presence** status for every participant:

| Status | Meaning |
| --- | --- |
| `connected` | The participant is connected. |
| `away` | The participant's connection dropped. Brief network interruptions look like this, and the participant can still come back. |
| `left` | The participant was away longer than the dropout timeout, or reloaded the page. `left` is final. |

The dropout timeout defaults to 10 seconds. Change it when you connect, and use
`onParticipantLeft` to react when someone leaves:

```js
await jsPsych.multiplayer.connect(adapter, {
  dropoutTimeout: 15000,
  onParticipantLeft: (id) => console.log(`${id} left`),
});
```

The whole group agrees on who has left. When one participant sees someone leave, they tell
the others, so everyone's trials react to the same departure.

How quickly an adapter notices a drop depends on the backend; see
[Choosing a backend](choosing-a-backend). Two consequences apply everywhere:

- **Data outlives participants.** A participant's data stays in the shared data after they
  leave. Count participants with `presence`, which every `wait_for`, `ready`, and `end_when`
  callback receives as its second argument, not by counting the entries in the shared data.
- **A departure is not a timeout.** A slow participant who stays connected is never marked
  `left`. Keep timeouts for participants who are present but never act.

## What the plugins do

Every plugin that waits on other participants ends its trial, instead of hanging, when a
participant it depends on leaves or when this participant's own connection is lost. The
trial data then records why:

| Field | Meaning |
| --- | --- |
| `multiplayer_outcome` | How the trial ended: `"completed"`, `"timeout"`, `"participant_left"` (a participant it depended on left), `"connection_lost"` (this participant's connection was lost for good), or, in the live plugins, `"cancelled"` (the experiment disconnected during the trial). |
| `left_participant` | The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`; otherwise `null`. |

What "ends" means depends on the plugin. `sync` and `ready` finish the trial; `match` and
`role` finish unmatched or without a role; `choice` and `scoreboard` reveal whoever reported;
`countdown` keeps counting down locally, because its shared deadline doesn't need anyone else.
If the experiment itself ends while a trial is waiting (for example, `abortExperiment()` is
called), the wait is cancelled and the trial stops quietly.

To react in your own code, check the outcome in the next trial or in `on_finish`:

```js
on_finish: (data) => {
  if (data.multiplayer_outcome === "participant_left") {
    jsPsych.abortExperiment("Your partner left the study. Thank you for participating.");
  }
},
```

### Which participants a trial depends on

- **Barrier plugins** (`sync`, `ready`, `choice`, `match`, `role`, `scoreboard`) take a
  `participants` parameter. The default, `null`, means:
  - in a [sealed group](forming-groups), every other member who hasn't left, including
    members who are only `away` (they may come back);
  - otherwise, every other participant who is `connected` when the wait starts.
    Participants who are only `away` at that moment are left out, because data left over from
    an earlier member starts out `away` and becomes `left` a few seconds later.

  Pass a list to depend on specific participants, or `[]` to ignore departures.
- **Live plugins** (`chat`, `draw`, `reference-game`) take `end_on_participant_left`,
  default `true`: in a sealed group, the trial ends when any other member who hasn't left
  leaves; otherwise, when a participant who was connected when it started leaves. Set it to
  `false` to carry on with whoever remains.

### Lobbies

A lobby waits until enough participants are present. Someone leaving should mean waiting a
little longer, not ending the lobby. Pass `participants: []` so departures don't end the
trial, and count by presence in `wait_for`:

```js
const lobby = {
  type: jsPsychMultiplayerSync,
  participants: [], // keep waiting when someone leaves
  wait_for: (data, presence) => {
    // Count the participants who are currently connected
    let connected = 0;
    for (const id in presence) {
      if (presence[id] === "connected") {
        connected++;
      }
    }
    return connected >= 2;
  },
};
```

With a backend that forms groups, such as JATOS, `jsPsych.multiplayer.waitForGroup()` is a
simpler lobby; see [Forming groups](forming-groups). A mid-game wait for a
specific partner should name them, as in the
[ultimatum game](ultimatum-game): `participants: () => [partnerId]`.

## Rejoining

A participant who drops out can come back, but only **from the same page**, and only
**before they count as `left`**:

- **Same page, while `away`.** Their connection dropped and recovered: a network outage, a
  laptop going to sleep, a background tab that missed its heartbeats. If this happens before
  the dropout timeout runs out, they become `connected` again and their experiment carries on
  where it was.
- **Same page, after `left`.** `left` is final. If the group already counted them as left,
  they can't come back: when their connection recovers, their own session closes with a
  `connection_lost` error, and their current trial ends with
  `multiplayer_outcome: "connection_lost"`.
- **New page load.** They reloaded, or opened the study again in a new tab, under the same
  ID. Their experiment started over, so it is out of step with the group. The others count
  them as `left` at once, and on the reloaded page `jsPsych.multiplayer.restarted` is `true`.

Check `restarted` right after connecting, so a participant who reloads sees an explanation
instead of starting the experiment again:

```js
await jsPsych.multiplayer.connect(adapter);

if (jsPsych.multiplayer.restarted) {
  document.body.innerHTML =
    "<p>You reloaded the page, so you can't rejoin your group. Thank you for participating.</p>";
} else {
  await jsPsych.run(timeline);
}
```

How each adapter supports rejoining:

| Adapter | A participant comes back when |
| --- | --- |
| JATOS | Their group channel reopens. jatos.js keeps retrying; pass `reconnectTimeout` to `connect()` if this participant should give up after a while. |
| Firebase | Firebase reconnects (`.info/connected` turns true again). The adapter rewrites its presence entry and the core announces the return. |
| Local | The tab sends a heartbeat again. A tab whose heartbeats lapsed, for example because the browser throttled it in the background, tells the others it is still there. |

### Recipe: give a partner time to come back

Because `left` is final, the way to give a partner more time is a longer dropout timeout.
While the partner is only `away`, every trial that depends on them keeps waiting, so the game
simply pauses. A session-scope subscription can tell the participant what is going on, and
`onParticipantLeft` ends the game if the partner doesn't return in time:

```js
const RETURN_WINDOW = 3 * 60 * 1000; // how long to wait for a partner, in ms

async function runExperiment() {
  await jsPsych.multiplayer.connect(adapter, {
    dropoutTimeout: RETURN_WINDOW,
    onParticipantLeft: () => {
      jsPsych.abortExperiment("<p>Your partner didn't come back, so the game has ended.</p>");
    },
  });
  if (jsPsych.multiplayer.restarted) {
    document.body.innerHTML = "<p>You reloaded the page, so you can't rejoin your group.</p>";
    return;
  }

  // Made before jsPsych.run(), so it uses the session scope and lasts the whole experiment
  const banner = document.createElement("p");
  banner.textContent = "Your partner lost their connection. Waiting for them to come back…";
  banner.style.cssText = "position: fixed; top: 0; width: 100%; text-align: center;";
  banner.hidden = true;
  document.body.appendChild(banner);

  jsPsych.multiplayer.subscribe((data, presence) => {
    const me = jsPsych.multiplayer.participantId;
    const someoneAway = Object.keys(presence).some(
      (id) => id !== me && presence[id] === "away"
    );
    banner.hidden = !someoneAway;
  });

  await jsPsych.run(timeline);
}

runExperiment();
```

The cost of a long dropout timeout is that a partner who really has gone takes that long to be
noticed. A partner who reloads is noticed at once, because the group sees the reload.

The plugins need no changes for this: a barrier waiting on an `away` partner keeps waiting,
and one waiting on a partner who reaches `left` ends with
`multiplayer_outcome: "participant_left"`, just before `onParticipantLeft` ends the game.

## Keeping trials apart

Each trial has its own part of the shared data (its **trial scope**), so a ready flag or a
choice from one trial can never satisfy a wait in a later one. The plugins need no keys or
counters to keep their gates apart. See [How it works](how-it-works#each-trial-has-its-own-shared-data).

If participants' timelines differ in shape, for example a gate that only some participants
reach inside a `conditional_function`, name each shared trial's scope with the
`multiplayer_scope` parameter so the names still match across participants (see
[Scopes](../reference/multiplayer-api#naming-a-scope-with-multiplayer_scope)).
