# @jspsych-multiplayer/adapter-multiplayer-firebase

A real-time, **cross-device** multiplayer adapter for jsPsych, backed by **Firebase Realtime Database (RTDB)** with anonymous auth. It gives you genuine multiplayer across separate devices, browsers, and machines — with essentially no backend to write or host.

It is a sibling of [`adapter-multiplayer-local`](../adapter-multiplayer-local) and [`adapter-multiplayer-jatos`](../adapter-multiplayer-jatos): all three implement the same `MultiplayerAdapter` contract, so plugins (`plugin-multiplayer-role`, `plugin-multiplayer-sync`, `plugin-multiplayer-chat`, …) behave identically on any of them. They form an infrastructure/integrity spectrum:

| Adapter | Reach | Backend to run | Use for |
| --- | --- | --- | --- |
| `local` | one browser, many tabs | none | dev, demos, tutorials, CI |
| **`firebase`** | **any device, anywhere** | **a free Firebase project** | **real cross-device data collection** |
| `jatos` | any device | a self-hosted JATOS server | lab-hosted studies |

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet released. The adapter implements a local interface mirroring that API's `MultiplayerAdapter` (`src/multiplayer-adapter.ts`) — the single seam to re-verify once #3694 lands. Connecting an adapter requires `pluginAPI.connect()`, which only exists in #3694, so experiments cannot *run* until that ships regardless of which adapter you choose.

## Usage

```js
import { initJsPsych } from "jspsych";
import jsPsychAdapterMultiplayerFirebase from "@jspsych-multiplayer/adapter-multiplayer-firebase";

const firebaseConfig = {
  apiKey: "…",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  // …the rest of the config object from the Firebase console
};

const jsPsych = initJsPsych();
await jsPsych.pluginAPI.connect(new jsPsychAdapterMultiplayerFirebase({ firebaseConfig }));
await jsPsych.run(timeline);
```

`firebase` is a **peer dependency** — install it in your experiment (`npm install firebase`) so you control its version and it isn't double-bundled.

Each run is namespaced by a **session id** carried in the URL as `?mp_session=…`. On first load with no `mp_session`, the adapter mints one and writes it into the URL; **bring another participant into the same run by sharing that full URL.** A bare URL starts a different session.

## One-time Firebase setup

1. Create a project at the [Firebase console](https://console.firebase.google.com/).
2. **Authentication → Sign-in method → enable Anonymous.**
3. **Realtime Database → create database** (pick a region).
4. Paste one of the rules blocks below (**Realtime Database → Rules**).
5. Copy your web app's config object (**Project settings → General → Your apps**) into `firebaseConfig`.

### Default rules — `auth != null`

Any signed-in (anonymous) client may read and write within a session. This is the right default for research demos and works with the default locally-minted participant id.

```json
{
  "rules": {
    "mp-sessions": {
      "$session": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

> **Session privacy / IRB:** with anonymous auth, anyone who holds or can guess a session id can read every participant's data in that session. That is fine for most research demos, but be aware of it for sensitive data. The mitigation is the **unguessable random session id** the adapter generates by default (not the rules) — don't hand out short or predictable session ids.

### Advanced rules — uid-as-slot-key (per-slot write integrity)

Pass `useUidAsParticipantId: true` and use these rules so **no participant can overwrite another's slot** — each client may only write the slot whose key equals its own auth uid. This is the property a sync barrier or economic game wants (nobody can forge your offer or flip your ready flag).

```json
{
  "rules": {
    "mp-sessions": {
      "$session": {
        ".read": "auth != null",
        "$slot": {
          ".write": "auth != null && $slot === auth.uid"
        }
      }
    }
  }
}
```

```js
new jsPsychAdapterMultiplayerFirebase({ firebaseConfig, useUidAsParticipantId: true });
```

In this mode the adapter adopts the anonymous auth uid as `participantId` during `connect()`, so **`participantId` is a placeholder until `connect()` resolves — don't read or cache it before connecting.** It is incompatible with a supplied `participantId` (constructing with both throws).

**What uid-as-key does and doesn't buy:** it guarantees **per-slot write integrity among the participants in a session** — not adversarial robustness. Anyone with the session URL can still mint a fresh uid, join as a new participant, spam slots, or read everyone's data. For that threat model you need real (non-anonymous) auth or a server tier (JATOS).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `firebaseConfig` | — | Firebase config object; the adapter initializes and owns a dedicated app. |
| `database` | — | An already-initialized RTDB `Database` (the caller owns the app + auth); use instead of `firebaseConfig`. |
| `sessionId` | `?mp_session=` or a fresh id | Session namespace under `<pathPrefix>/<sessionId>`. |
| `participantId` | a fresh random id | This participant's slot key. Incompatible with `useUidAsParticipantId`. |
| `useUidAsParticipantId` | `false` | Adopt the auth uid as the id during connect (enables strict rules). |
| `pathPrefix` | `"mp-sessions"` | RTDB path namespace. |
| `removeOnDisconnect` | `true` | Server-remove the slot on disconnect via `onDisconnect().remove()`. |
| `connectTimeoutMs` | `20000` | Timeout for the await-first-snapshot step of `connect()`. |

Ids (`participantId`, `sessionId`, `pathPrefix`) must not contain `. # $ [ ] /` (RTDB key rules) or `:` (reserved for cross-adapter portability with the local adapter). The default generated ids comply.

## Testing two tabs on one machine

Firebase Auth persists per **origin**, not per tab, so two tabs on the same machine share one anonymous uid. The adapter defaults its owned app to **per-tab auth persistence** so a two-tab test still behaves like two participants — but if you inject your own `database`, you own persistence and should configure it yourself.

For a fully local loop, run the [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite):

```
firebase emulators:start
```

and point your app at the emulator's database URL. No live project or credentials required.

## How it works

The contract's `getAll()`/`get()` are synchronous but every Firebase read is async, so the adapter keeps an in-memory **mirror** of the session node, kept live by a single `onValue` listener, and answers reads from it. `connect()` does not resolve until the first snapshot arrives (and rejects on a rules denial or a timeout). Each participant's payload is stored **JSON-encoded as a string**, so pushes round-trip exactly over RTDB's JSON coercion (empty arrays, `undefined`, and nested arrays are otherwise mangled). A `.info/connected` handler re-arms `onDisconnect` and re-pushes your last data after a transient network blip, so a brief drop can't erase a still-present participant.

The network layer sits behind a small `FirebaseBackend` interface (`src/firebase-backend.ts`); the whole adapter is unit-tested against an in-memory fake with zero Firebase credentials.
