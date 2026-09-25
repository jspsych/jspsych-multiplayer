---
id: adapter-multiplayer-jatos
title: adapter-multiplayer-jatos
sidebar_label: adapter-multiplayer-jatos
description: Run a multiplayer experiment as a JATOS group study, on your own JATOS server.
---

# `adapter-multiplayer-jatos`

The JATOS adapter runs your experiment as a [JATOS](https://www.jatos.org/) group study. JATOS
puts participants into groups, and the adapter shares data among the members of each group
through JATOS's group session. Use it to collect data on a JATOS server your lab runs or has
access to.

The experiment must run inside JATOS. Creating the adapter anywhere else throws an error. To
build and test without a server, use [`adapter-multiplayer-local`](adapter-multiplayer-local),
then swap in this adapter. See [Choosing a backend](../guides/choosing-a-backend).

```js
jatos.onLoad(async () => {
  const jsPsych = initJsPsych({
    on_finish: () => jatos.endStudy(jsPsych.data.get().json()),
  });
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
  await jsPsych.run(timeline);
});
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/adapter-multiplayer-jatos` |
| Browser global | `jsPsychAdapterMultiplayerJatos` |
| Use it for | Data collection on a JATOS server. |

## Options

Pass these to the constructor, for example
`new jsPsychAdapterMultiplayerJatos({ closeAfterReconnectingMs: 60000 })`. Both are optional.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connectTimeoutMs` | `number` | `20000` | How long, in ms, `connect()` waits for JATOS to open the group connection before it fails. |
| `closeAfterReconnectingMs` | `number \| null` | `null` | How long, in ms, this participant's connection can stay down before it counts as lost for good. `null` (the default) or `Infinity` means keep retrying. |

Each participant's ID is their JATOS study result ID, as a string. Once `connect()` resolves, it
is in `jsPsych.multiplayer.participantId`.

## Setup

### In your experiment's HTML

1. **Load `jatos.js` first.** JATOS provides this file itself; you do not copy it anywhere. Add
   `<script src="jatos.js"></script>` to the page's `<head>`, before the other scripts.
2. **Start inside `jatos.onLoad()`.** Put the whole experiment, including `initJsPsych()` and
   `connect()`, in the function you pass to `jatos.onLoad()`, as in the snippet above.
3. **Save the data with `jatos.endStudy()`.** Call it from `initJsPsych`'s `on_finish` with
   `jsPsych.data.get().json()`. The adapter shares data among the group but does not save your
   trial data.

### In JATOS

1. **Create the study and add the files.** Put your HTML file and every script it loads in the
   study's assets folder, and make the HTML file the study's component. JATOS serves only what is
   in that folder, so download the jsPsych and multiplayer scripts rather than loading them from a
   CDN if your participants' network might block one.
2. **Turn on "Group study"** in the study's properties.
3. **Set the group size** in the batch properties (under Study Links). JATOS puts each arriving
   participant into a group in that batch that still has room, and starts a new group when none
   does:
   - **Max active members** is how many participants a group can hold at once. Set it to your
     group size, for example `2` for a two-player game, to get separate groups of that size.
   - **Max total members** is how many participants can ever join a group, counting those who
     left. Set it to your group size too if nobody should take over a departed player's place.
     Leave it empty if a newcomer may fill the gap.

   With no limits, everyone in the batch joins one group. That is useful when the experiment
   itself decides who plays, for example with the overflow role of
   [`multiplayer-role`](plugin-multiplayer-role).

To test, open the study link in two different browsers, or in a normal window and a private
window, so that each run is a separate participant.

### Trying the ultimatum example

The repository builds its [ultimatum game](../guides/ultimatum-game) example into a file JATOS can
import. From a copy of the repository, run `npm install`, `npm run build`, then
`npm run build:jatos:ultimatum`. Import the resulting `dist/ultimatum-jatos.jzip` with JATOS's
**Import Study** button. It is already marked as a group study, and its batch has no group-size
limits.

## Session ID

The adapter reports the JATOS group result ID as the session ID. Every member of a JATOS group
shares it, so each group gets its own
[shared random values](multiplayer-api#shared-randomness).

## Presence and dropouts

The adapter counts a participant as connected while their JATOS group connection is open.

- **Another participant closes the tab or leaves the study.** JATOS tells the rest of the group
  as soon as the connection closes. That participant becomes `away`, then `left` after the
  dropout timeout (10 seconds by default, set in `connect()`).
- **Another participant loses their network.** They become `away` once the JATOS server notices
  their connection is gone, then `left` after the dropout timeout.
- **This participant loses their network.** jatos.js keeps trying to reconnect, and the
  connection status is `reconnecting`. Data this participant writes in the meantime waits and is
  sent when the connection returns. The adapter keeps waiting for as long as it takes, so a
  participant who comes back after several minutes rejoins: the others see them as `connected`
  again. To give up instead, set `closeAfterReconnectingMs`: once the connection has been down
  that long, it counts as lost, and waiting trials end with `connection_lost: true`. Set it also
  if your JATOS server may close a participant's group channel for good, because jatos.js does
  not reopen a channel the server closed.
- **`jsPsych.multiplayer.disconnect()`** leaves the JATOS group. The others see this participant
  become `away`, then `left`. Calling `connect()` again on the same page joins a group again, but
  JATOS chooses which one, so it may not be the same group.

A participant's data stays in the group session after they leave. See
[Handling dropouts](../guides/handling-dropouts) for what each plugin records.

Only one connection per page is possible. `connect()` fails if another is already open. After
`disconnect()`, a new `connect()` waits for the old connection to finish leaving the group.

## Example

The top of the ultimatum game, which runs as a JATOS group study. The lobby waits for two
connected players, then [`multiplayer-role`](plugin-multiplayer-role) assigns proposer and
responder. The [ultimatum game guide](../guides/ultimatum-game) builds the rest.

```html
<!DOCTYPE html>
<html>
  <head>
    <script src="jatos.js"></script>
    <!-- a jsPsych build with jsPsych.multiplayer; see Getting started -->
    <script src="jspsych.js"></script>
    <script src="plugin-html-keyboard-response.js"></script>
    <script src="adapter-multiplayer-jatos.js"></script>
    <script src="plugin-multiplayer-role.js"></script>
    <script src="plugin-multiplayer-sync.js"></script>
    <link rel="stylesheet" href="jspsych.css" />
  </head>
  <body></body>
  <script>
    jatos.onLoad(async () => {
      const jsPsych = initJsPsych({
        on_finish: () => jatos.endStudy(jsPsych.data.get().json()),
      });

      await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());

      const lobby = {
        type: jsPsychMultiplayerSync,
        participants: [],
        push_data: { status: "ready" },
        wait_for: (group, presence) => {
          // Count the participants who are currently connected
          let connected = 0;
          for (const id in presence) {
            if (presence[id] === "connected") {
              connected++;
            }
          }
          return connected >= 2;
        },
        message: "<p>Waiting for another player to join...</p>",
      };

      const assignRoles = {
        type: jsPsychMultiplayerRole,
        roles: ["proposer", "responder"],
        strategy: "join_order",
        overflow_role: "spectator",
        message: "<p>Assigning roles...</p>",
      };

      const showRole = {
        type: jsPsychHtmlKeyboardResponse,
        stimulus: () => `<p>You are the <strong>${jsPsychMultiplayerRole.getMyRole()}</strong>.</p>`,
        choices: [" "],
      };

      await jsPsych.run([lobby, assignRoles, showRole]);
    });
  </script>
</html>
```
