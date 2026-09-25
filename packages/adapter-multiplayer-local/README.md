# @jspsych-multiplayer/adapter-multiplayer-local

A zero-infrastructure multiplayer adapter for jsPsych, backed by the browser's `localStorage` and signalled across tabs. Swap it in for a server-backed adapter to run and demo multiplayer experiments by simply **opening two browser tabs** — no JATOS server, no Firebase project, no account.

It is a sibling of [`adapter-multiplayer-jatos`](../adapter-multiplayer-jatos): both implement jsPsych's `MultiplayerAdapter` contract, so plugins (`plugin-multiplayer-role`, `plugin-multiplayer-sync`, `plugin-multiplayer-chat`, …) behave identically on either one.

> ### ⚠️ Development / demo / tutorial / CI only — not for data collection
>
> `localStorage` and its cross-tab signalling (`BroadcastChannel` / the `storage` event) are **same-origin, same-browser, same-machine**. This adapter therefore **cannot** cross devices, cross browsers, or cross machines, and must **not** be used to collect real data. Its whole purpose is to make "open two tabs and watch it work" possible while you develop, teach, or run CI. For genuine multi-device testing you need a small local WebSocket relay (a different tool); for real data collection use JATOS or Firebase.

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet in a jsPsych release. Until it is, load the PR's preview build of jsPsych (see the package example).

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

By default a **page refresh keeps the same participant id**: the tab's id is kept in `sessionStorage` (per-tab, cleared when the tab closes). A refresh still restarts the experiment, so the other tabs count that participant as `left` rather than seeing a new stranger, and the refreshed page finds `jsPsych.multiplayer.restarted === true` (see [Rejoining](#rejoining)). Pass `persistParticipant: false` to give every page load a fresh id instead.

> **Caveat — "Duplicate Tab" clones the participant id.** The kept id lives in `sessionStorage`, and the browser's *Duplicate Tab* feature (and middle-click-open-in-new-tab in some browsers) **copies `sessionStorage` into the new tab**. The duplicate therefore inherits the *same* participantId and the two tabs write the same slot, clobbering each other — so they look like one participant, not two. To bring a second player into a run, open the shared URL (with its `?mp_session=…`) in a **fresh** tab or window rather than duplicating an existing one.

## Options

```js
new jsPsychAdapterMultiplayerLocal({
  sessionId,           // override the ?mp_session= namespace (also seeds shared randomness)
  participantId,       // override this tab's id (default: random per tab, kept across reloads)
  persistParticipant,  // false → a fresh id on every page load (default true: kept in sessionStorage)
  namespace,           // storage-key prefix, to keep studies on one origin apart (default "mp")
  storage,             // custom Storage backend (default: localStorage)
  signal,              // custom cross-tab ChangeSignal (default: BroadcastChannel + storage event)
  heartbeatIntervalMs, // how often a tab refreshes its presence (default 2000)
  presenceTimeoutMs,   // how long a silent tab still counts as connected (default 70000)
});
```

Session and participant ids must not contain any of `: / . # $ [ ]`, and the namespace must not contain `:`; the constructor throws otherwise.

> **Upgrading from 0.1:** `keyPrefix` is now `namespace`, and `persistParticipant` now defaults to `true`. Pass `persistParticipant: false` to keep the old behavior of a new participant on every refresh.

A `signal` you pass in belongs to you: connections add and remove their own handlers but never close it. Without one, each connection creates its own signal and closes it on disconnect.

## Presence

jsPsych tracks whether each participant is still connected (`jsPsych.multiplayer.presence()`), and this adapter tells it which tabs are open:

- **Each connected tab writes a heartbeat** to its own presence key (`mp-presence:<sessionId>:<participantId>`) every `heartbeatIntervalMs`.
- **A tab that closes normally drops out at once.** It removes its presence key on `pagehide` and when you call `jsPsych.multiplayer.disconnect()`. A tab restored from the back/forward cache reappears.
- **A tab that crashes drops out after `presenceTimeoutMs`**, when its last heartbeat goes stale. The default of 70 seconds is long because browsers throttle timers in background tabs: Chrome runs them only once a minute in a tab that has been hidden for 5 minutes, and a background tab must not look disconnected just because it's waiting.

A participant who drops out keeps their data slot; presence, not the slot, says who is still here.

### Rejoining

`localStorage` never disconnects, so this adapter normally never reports a connection status. The exception is a **lapsed heartbeat**: a throttled background tab, or a page frozen in the back/forward cache, can go longer than `presenceTimeoutMs` without a heartbeat, and the other tabs then count it as gone. When that tab's next heartbeat runs (on its timer, when it becomes visible, or when it is restored), the adapter tells jsPsych the page resumed (`onResumed()`), and jsPsych tells the other tabs that this page is still here, so a participant they saw as `away` is `connected` again. `left` is final: a tab that stayed silent past the other tabs' `dropoutTimeout` stays `left` for them.

A **refresh** is different: the page starts the experiment again, so it can't rejoin. The same id comes back from the new page load (unless `persistParticipant: false`), the other tabs count that participant as `left`, and the new page finds `jsPsych.multiplayer.restarted === true`, and its connection closed. With `persistParticipant: false` the old participant simply stays `left` and the page joins as someone new.

## How it works

- **One `localStorage` key per participant** (`mp:<sessionId>:<participantId>`), never a shared blob. `localStorage` has no transactions, so a shared blob has a read-modify-write race between tabs. Per-participant keys mean a tab only ever writes its own key, and they reproduce the JATOS adapter's **REPLACE-the-whole-slot** `push` semantics exactly. `getAll()` returns each slot exactly as jsPsych wrote it; jsPsych owns the slot's format.
- **`participantId` is a random per-tab id**, not a claimed ordinal like `"player-1"` (which would reintroduce the very read-then-write race the per-key store avoids). No plugin orders by the id's value — ordering comes from data participants push (e.g. `plugin-multiplayer-role` sorts by `joinedAt`) — so random ids give stable, coordination-free assignment.
- **Each `connect()` opens an independent connection** with its own signal handler, heartbeat, and page listeners, so reconnecting with the same adapter object is safe.
- **The cross-tab message carries no payload** — just "something changed, re-read." The `localStorage` store stays the single source of truth. Neither `BroadcastChannel` nor the `storage` event fires in the writing tab; jsPsych's multiplayer session shows a tab its own writes directly.

## Development

```
npm test         # jest (pure store logic + multi-tab adapter behavior via in-memory doubles)
npm run tsc      # type-check
npm run build    # rollup bundle
```

The tests inject in-memory `storage` and `signal` doubles that model several tabs of one browser, so the full connect → push → cross-tab notify → presence → disconnect flow is exercised without a real `localStorage` or `BroadcastChannel`, including through real `jsPsych.multiplayer` sessions.
