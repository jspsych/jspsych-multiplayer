---
"@jspsych-multiplayer/adapter-multiplayer-local": minor
---

Add `adapter-multiplayer-local`, a zero-infrastructure multiplayer adapter backed by `localStorage` and signalled cross-tab.

Swap it in for the JATOS adapter (`pluginAPI.connect(new LocalAdapter())`) to run multiplayer experiments by opening two browser tabs — no server, no account. It is a development/demo/tutorial/CI tool only: `localStorage` and its cross-tab signalling are same-origin, same-browser, same-machine, so it cannot cross devices, browsers, or machines and must not be used to collect real data.

It implements the same local `MultiplayerAdapter` mirror the JATOS adapter uses (no build-time dependency on the unreleased jsPsych#3694). The store is one key per participant (`mp:<session>:<participantId>`), reproducing JATOS's REPLACE-the-whole-slot semantics so plugins behave identically across adapters; a fresh session id per run (carried in the `?mp_session=` URL) namespaces keys to avoid stale "ghost" participants; and `push` self-notifies on a microtask so a tab's own waits resolve without reentrancy.
