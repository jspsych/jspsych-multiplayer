# @jspsych-multiplayer/adapter-multiplayer-jatos

A multiplayer **adapter** that backs the jsPsych multiplayer API with [JATOS](https://www.jatos.org/) group studies. It implements the `MultiplayerAdapter` contract over JATOS's group session and group channel, so multiplayer plugins (e.g. `@jspsych-multiplayer/plugin-multiplayer-sync`, `@jspsych-multiplayer/plugin-multiplayer-role`) run unchanged on JATOS.

> **Status:** built against the multiplayer adapter contract from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet in a jsPsych release. Tests run against an in-memory mock of the `jatos` global, so no live JATOS server is needed.

## Prerequisites

The experiment must run **inside JATOS as a group study**, with `jatos.js` loaded before your experiment script. The adapter throws on construction if the `jatos` global is absent.

## Usage

```js
import { initJsPsych } from "jspsych";
import JatosAdapter from "@jspsych-multiplayer/adapter-multiplayer-jatos";

const jsPsych = initJsPsych({
  on_finish: () => jatos.endStudy(jsPsych.data.get().json()),
});

await jsPsych.multiplayer.connect(new JatosAdapter());
await jsPsych.run(timeline);
```

Once connected, multiplayer plugins and `jsPsych.multiplayer` (`push`, `update`, `get`, `getAll`, `presence`, `subscribe`, `wait`) work against the JATOS group session.

## Options

Option | Default | Description
-------|---------|------------
`connectTimeoutMs` | `20000` | How long to wait for the group channel to open before `connect()` rejects.
`closeAfterReconnectingMs` | `null` | How long the group channel can stay down before the connection counts as lost for good. `null` or `Infinity` (the default) means never give up, so a participant can rejoin however long they were gone. Set a limit if the study should instead end for a participant who stays offline.

```js
new JatosAdapter({ connectTimeoutMs: 10000, closeAfterReconnectingMs: 5 * 60_000 });
```

## How it works

- **Participant IDs.** Each participant's data is stored under `groupSession[studyResultId]`, and the study result id (as a string) is the participant's ID. The study result id is unique per study run, whereas the same `workerId` can recur when a worker runs the study more than once. It is also what JATOS calls the group member id: jatos.js assigns `jatos.groupMemberId = jatos.studyResultId`, but only after the first group message arrives, so the adapter reads `studyResultId` directly. If `jatos.studyResultId` is not set, the adapter falls back to `jatos.workerId`.
- **Presence.** The participants whose group channel is open (`jatos.groupChannels`) count as connected. The adapter reports every change to the group session and every member joining, leaving, opening, or closing a channel, and jsPsych's multiplayer session turns those into each participant's `connected` / `away` / `left` status.
- **Connection status.** When this participant's group channel drops, jatos.js reopens it by itself. The adapter reports the connection as `reconnecting` while it is down and `connected` once it reopens. By default it waits as long as it takes; if you set `closeAfterReconnectingMs` and the channel stays down longer than that, the adapter reports it as `closed`, which ends the session. While the channel is down, jatos.js clears its copy of the group session, so the adapter keeps serving the last data it read.
- **Rejoining.** Every connection on a page uses the same study result id, and the adapter reports every drop and reopen. So a participant whose channel reopens on the same page rejoins the group, even after other participants have seen them as `left`. A participant who reloads the study page restarted their experiment: other participants keep seeing them as `left`, and `jsPsych.multiplayer.previousInstance` is set on the reloaded page. See [Handling dropouts](https://multiplayer.jspsych.org/guides/handling-dropouts) in the docs.
- **Writes.** The JATOS group session uses optimistic concurrency, so simultaneous writes can hit version conflicts. `push()` makes up to 8 attempts with exponential backoff and jitter, then rejects with the underlying error as `cause`. Each attempt re-sends the same `participantId → data` write, so a retry can never lose or double-apply another participant's update. A write made while the channel is down waits for it to reopen instead of failing.
- **Connecting.** `connect()` resolves when the group channel opens. It rejects if joining fails, if jatos.js refuses to open a channel, or if JATOS reports nothing within `connectTimeoutMs`. jatos.js refuses to open a channel while the previous one's socket is still closing (for example just after a `disconnect()`); the adapter retries that case until the socket has closed, within `connectTimeoutMs`. If the connection attempt is cancelled and the channel opens anyway, the adapter leaves the group.
- **One connection per page.** jatos.js supports one group channel per page, and `jatos.joinGroup()` replaces the page's callbacks even when it refuses to open a second channel. So the adapter rejects a `connect()` while another of its connections is open. A `connect()` made while a closed connection is still leaving the group, or while a cancelled or timed-out join is still in flight, waits for it to finish instead.
- **Disconnecting.** `disconnect()` leaves the JATOS group and stops all reporting. The participant's data stays in the group session; other participants see them as `away`, then `left`. Connecting again on the same page joins again, and JATOS assigns the group on that new join, so the participant is not guaranteed to land in the same group. To ride out a network outage, rely on jatos.js reopening the channel rather than disconnecting.

## Notes

This package provides the network backend only. Synchronization logic (barriers, lobbies) and role assignment live in the multiplayer plugins; this adapter just moves data.

Rejoining the same group after `disconnect()` isn't supported yet: jatos.js may still be closing the previous channel, in which case the new `connect()` rejects.
