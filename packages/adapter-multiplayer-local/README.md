# @jspsych-multiplayer/adapter-multiplayer-local

A zero-infrastructure multiplayer adapter for jsPsych, backed by the browser's `localStorage` and signalled across tabs. Swap it in for a server-backed adapter to run and demo multiplayer experiments by simply **opening two browser tabs** — no JATOS server, no Firebase project, no account.

It is a sibling of [`adapter-multiplayer-jatos`](../adapter-multiplayer-jatos): both implement the same multiplayer `MultiplayerAdapter` contract, so plugins (`plugin-multiplayer-role`, `plugin-multiplayer-sync`, `plugin-multiplayer-chat`, …) behave identically on either one.

> ### ⚠️ Development / demo / tutorial / CI only — not for data collection
>
> `localStorage` and its cross-tab signalling (`BroadcastChannel` / the `storage` event) are **same-origin, same-browser, same-machine**. This adapter therefore **cannot** cross devices, cross browsers, or cross machines, and must **not** be used to collect real data. Its whole purpose is to make "open two tabs and watch it work" possible while you develop, teach, or run CI. For genuine multi-device testing you need a small local WebSocket relay (a different tool); for real data collection use JATOS or Firebase.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. The adapter implements a local interface mirroring that API's `MultiplayerAdapter` (`src/multiplayer-adapter.ts`) — the single seam to re-verify once #3694 lands. Note that connecting an adapter requires `pluginAPI.connect()`, which only exists in #3694, so experiments cannot *run* until that ships regardless of which adapter you choose.

## Usage

```js
import { initJsPsych } from "jspsych";
import jsPsychAdapterMultiplayerLocal from "@jspsych-multiplayer/adapter-multiplayer-local";

const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal());
await jsPsych.run(timeline);
```

**Serve the page — don't open it from `file://`.** `localStorage`/`BroadcastChannel` are keyed by origin, and `file://` origin behavior varies by browser. Use any static server and open two tabs:

```
npx http-server .
# then open the printed http://localhost:8080/... in two tabs
```

## Running a clean multi-tab session

Each run is namespaced by a **session id** carried in the URL as `?mp_session=…`. When you first load a page with no `mp_session`, the adapter mints a fresh one and writes it into the URL. **To bring another tab into the same run, copy that full URL (including `?mp_session=…`) into the new tab.** Opening the bare URL again would start a *different* session.

This per-run namespacing is deliberate: `localStorage` persists across reloads, so without it a slot left over from a previous run would be counted as a phantom participant ("why does my 2-player lobby open with one tab present?"). A fresh session id per run keeps every run clean.

By default a **page refresh starts a new participant** (the old slot becomes a stale ghost — start a fresh session for a clean run). If you want a refresh to rejoin as the *same* participant, pass `persistParticipant: true`; the tab's id is then kept in `sessionStorage` (per-tab, cleared when the tab closes).

> **Caveat — "Duplicate Tab" clones the participant id.** `persistParticipant` relies on `sessionStorage`, and the browser's *Duplicate Tab* feature (and middle-click-open-in-new-tab in some browsers) **copies `sessionStorage` into the new tab**. The duplicate therefore inherits the *same* participantId and the two tabs write the same slot, clobbering each other — so they look like one participant, not two. To bring a second player into a run, open the shared URL (with its `?mp_session=…`) in a **fresh** tab or window rather than duplicating an existing one.

## Options

```js
new jsPsychAdapterMultiplayerLocal({
  sessionId,           // override the ?mp_session= namespace
  participantId,       // override this tab's id (default: random per tab)
  persistParticipant,  // true → rejoin as the same participant across reloads (sessionStorage)
  keyPrefix,           // storage-key prefix (default "mp")
  storage,             // custom Storage backend (default: localStorage)
  signal,              // custom cross-tab ChangeSignal (default: BroadcastChannel + storage event)
});
```

## How it works

- **One `localStorage` key per participant** (`mp:<sessionId>:<participantId>`), never a shared blob. `localStorage` has no transactions, so a shared blob has a read-modify-write race between tabs. Per-participant keys mean a tab only ever writes its own key, and they reproduce the JATOS adapter's **REPLACE-the-whole-slot** `push` semantics exactly — so a plugin that reads its own slot before pushing (to preserve other keys) works the same on both adapters.
- **`participantId` is a random per-tab id**, not a claimed ordinal like `"player-1"` (which would reintroduce the very read-then-write race the per-key store avoids). No plugin orders by the id's value — ordering comes from data participants push (e.g. `plugin-multiplayer-role` sorts by `joinedAt`) — so random ids give stable, coordination-free assignment.
- **`push` self-notifies on a microtask.** Neither `BroadcastChannel` nor the `storage` event fires in the writing tab, but plugins wait on conditions their own push satisfies, so the adapter delivers the update to its own subscribers too — deferred one microtask so a subscriber that reacts by pushing again can't recurse or observe a half-written store.
- **The cross-tab message carries no payload** — just "something changed, re-read." The `localStorage` store stays the single source of truth.

## Development

```
npm test         # jest (pure store logic + multi-tab adapter behavior via in-memory doubles)
npm run tsc      # type-check
npm run build    # rollup bundle
```

The tests inject in-memory `storage` and `signal` doubles that model several tabs of one browser, so the full connect → push → cross-tab notify → disconnect flow is exercised without a real `localStorage` or `BroadcastChannel`.
