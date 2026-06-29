# @jspsych-multiplayer/adapter-multiplayer-jatos

A multiplayer **adapter** that backs the jsPsych multiplayer API with [JATOS](https://www.jatos.org/) group studies. It implements the `MultiplayerAdapter` contract — `connect` / `push` / `getAll` / `get` / `subscribe` / `disconnect` — over JATOS's group session and WebSocket channel, so multiplayer plugins (e.g. `@jspsych-multiplayer/plugin-multiplayer-sync`, `@jspsych-multiplayer/plugin-multiplayer-role`) run unchanged on JATOS.

> **Status:** built against the multiplayer adapter contract from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. The adapter implements a local interface mirroring `MultiplayerAdapter` (`src/multiplayer-adapter.ts`) copied verbatim from that PR — the single seam to re-verify once #3694 lands. Tests run against an in-memory mock of the `jatos` global, so no live JATOS server is needed.

## Prerequisites

The experiment must run **inside JATOS as a group study**, with `jatos.js` loaded before your experiment script. The adapter throws on construction if the `jatos` global is absent.

## Usage

```js
import { initJsPsych } from "jspsych";
import JatosAdapter from "@jspsych-multiplayer/adapter-multiplayer-jatos";

const jsPsych = initJsPsych({
  on_finish: () => jatos.endStudy(jsPsych.data.get().json()),
});

await jsPsych.pluginAPI.connect(new JatosAdapter());
await jsPsych.run(timeline);
```

Once connected, multiplayer plugins and the raw `jsPsych.pluginAPI` (`push`, `wait`, `get`, `getAll`, `subscribe`, `communicate`) work against the JATOS group session.

## How it works

- **Participant namespace.** Each participant's pushed data is stored under `groupSession[workerId]` (the JATOS worker id, stringified as `participantId`), so writes from different participants never collide.
- **Write concurrency.** The JATOS group session uses optimistic concurrency, so simultaneous writes can hit version conflicts. `push()` retries up to 8 times with exponential backoff + jitter, then throws if it still can't commit.
- **Updates.** `jatos`'s `onGroupSession` accepts only one callback, so the adapter registers a single dispatcher and fans out to all `subscribe()` listeners. Subscriptions are **future-only** — they fire on the next update and do not replay the current snapshot on registration. (Whether the core API should replay current state on subscribe is an open contract question for jsPsych core, independent of this adapter.)

## Notes

This package provides the network backend only. Synchronization logic (barriers, lobbies) and role assignment live in the multiplayer plugins; this adapter just moves data.
