---
id: adapter-multiplayer-local
title: adapter-multiplayer-local
sidebar_label: adapter-multiplayer-local
description: Run a multiplayer experiment in several tabs of one browser, with no server, while you build and test it.
---

# `adapter-multiplayer-local`

The local adapter connects the tabs of one browser to each other. Open your experiment in two
tabs and they play together, with no server, account, or setup. Use it while you write and pilot
an experiment, and for demos and automated tests.

It cannot connect different browsers or different computers, so it is not for data collection.
When the experiment works, swap in [`adapter-multiplayer-jatos`](adapter-multiplayer-jatos) or
[`adapter-multiplayer-firebase`](adapter-multiplayer-firebase). Nothing else in the timeline
changes. See [Choosing a backend](../guides/choosing-a-backend).

```js
const jsPsych = initJsPsych();

async function runExperiment() {
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal());
  await jsPsych.run(timeline);
}

runExperiment();
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/adapter-multiplayer-local` |
| Browser global | `jsPsychAdapterMultiplayerLocal` |
| Use it for | Development, piloting, demos, and tests in one browser. Not for data collection. |

## Options

Pass these to the constructor, for example
`new jsPsychAdapterMultiplayerLocal({ persistParticipant: true })`. All are optional.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionId` | `string` | the `?mp_session=` URL parameter, or a new random ID | Which session this tab joins. Tabs with the same session ID play together. If the URL has no `mp_session` parameter, the adapter makes a new ID and adds it to the URL. Must not contain `:`. It is also the session ID that seeds [shared randomness](multiplayer-api#shared-randomness). |
| `participantId` | `string` | a new random ID | This tab's participant ID. Must not contain `:`. |
| `persistParticipant` | `boolean` | `false` | Keep the same participant ID when the tab is reloaded. The reload restarted the experiment, so the other tabs keep that participant `left`, and the reloaded page sees `previousInstance`. Without it, a reload joins as a new participant. Ignored if you set `participantId`. |
| `keyPrefix` | `string` | `"mp"` | The prefix of the keys the adapter writes to `localStorage`. Change it only if another page on the same site already uses `mp:` keys. |
| `storage` | `Storage` | `localStorage` | Where the shared data is kept. For automated tests. |
| `signal` | `ChangeSignal` | a `BroadcastChannel` plus the `storage` event | How a tab tells the other tabs that something changed. For automated tests. A signal you pass in is yours to close. |
| `heartbeatIntervalMs` | `number` | `2000` | How often, in ms, a tab records that it is still open. |
| `presenceTimeoutMs` | `number` | `70000` | How long, in ms, after its last heartbeat a tab still counts as connected. Values below `heartbeatIntervalMs` are raised to it. |

Once `connect()` resolves, this tab's ID is in `jsPsych.multiplayer.participantId`.

## Setup

There is nothing to install or configure. Two things matter:

- **Serve the page from a web server.** Tabs can only share data when they come from the same
  web address. A local server is enough, for example `npx http-server`, then open the address it
  prints. Pages opened from a `file://` path behave differently in each browser.
- **Put every tab in the same session.** The first tab you open adds `?mp_session=...` to its
  address. Copy that whole address, including `?mp_session=...`, into each other tab. Opening the
  address without it starts a separate session.

Each session is separate, so start a new one (open the page without `?mp_session=`) for each
test run. Data left in the browser by an earlier run then cannot interfere.

With `persistParticipant: true`, open the extra tabs by pasting the address into a new tab or
window. The browser's **Duplicate Tab** command copies the participant ID along with the tab, so
the two tabs become one participant.

## Presence and dropouts

Each open tab records a heartbeat every 2 seconds (`heartbeatIntervalMs`). The other tabs use it
to tell who is still connected:

- **A tab that closes or reloads** drops out at once. It becomes `away` in the other tabs, then
  `left` after the dropout timeout (10 seconds by default, set in `connect()`).
- **A tab that crashes** sends nothing, so the others notice only when its heartbeat is older
  than `presenceTimeoutMs`: 70 seconds by default, plus the dropout timeout. The timeout is long
  because browsers slow down timers in background tabs, to as little as once a minute, and a
  tab in the background should not be counted as gone.
- **A tab whose heartbeats lapsed** but that is still open, for example one the browser throttled
  in the background, reports this as a reconnect when it catches up. The other tabs then count it
  as `connected` again: it rejoins.
- **Calling `jsPsych.multiplayer.disconnect()`** removes the tab from the session at once, like
  closing it.

There is no network, so a tab never loses its own connection and never shows `reconnecting`.
The dropout fields in trial data work as on any backend; see
[Handling dropouts](../guides/handling-dropouts).

A reload without `persistParticipant` leaves the old participant's data in the session, and that
participant becomes `left`. Count participants by presence, not by the number of entries in the
shared data.

## Example

A two-player experiment that waits in a lobby until two tabs are connected. Serve the page, open
it, and paste its address (with `?mp_session=...`) into a second tab.

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- a jsPsych build with jsPsych.multiplayer; see Getting started -->
    <script src="jspsych.js"></script>
    <script src="https://unpkg.com/@jspsych/plugin-html-keyboard-response"></script>
    <script src="https://unpkg.com/@jspsych-multiplayer/adapter-multiplayer-local"></script>
    <script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-sync"></script>
  </head>
  <body></body>
  <script>
    const jsPsych = initJsPsych({
      on_finish: () => jsPsych.data.get().localSave("json", "data.json"),
    });

    const lobby = {
      type: jsPsychMultiplayerSync,
      participants: [],
      push_data: { status: "ready" },
      wait_for: (group, presence) =>
        Object.values(presence).filter((status) => status === "connected").length >= 2,
      message: "<p>Waiting for another player to join...</p>",
    };

    const start = {
      type: jsPsychHtmlKeyboardResponse,
      stimulus: "<p>Both players are here. Press any key to begin.</p>",
    };

    async function runExperiment() {
      await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal());
      await jsPsych.run([lobby, start]);
    }

    runExperiment();
  </script>
</html>
```

To move this experiment to a real backend, change only the adapter in `connect()`.
