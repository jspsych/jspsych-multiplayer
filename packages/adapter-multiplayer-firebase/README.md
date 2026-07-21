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

### Recommended rules — session-locked (use these for data collection)

These are the rules shipped as [`database.rules.json`](./database.rules.json). Pair them with `useUidAsParticipantId: true`:

```js
new jsPsychAdapterMultiplayerFirebase({ firebaseConfig, useUidAsParticipantId: true });
```

```json
{
  "rules": {
    "mp-sessions": {
      "$session": {
        ".read": "auth != null && root.child('mp-sessions-memberships').child(auth.uid).val() === $session",
        "$slot": {
          ".write": "auth != null && $slot === auth.uid && root.child('mp-sessions-memberships').child(auth.uid).val() === $session",
          ".validate": "newData.isString() && newData.val().length < 131072"
        }
      }
    },
    "mp-sessions-memberships": {
      "$uid": {
        ".read": "auth != null && $uid === auth.uid",
        ".write": "auth != null && $uid === auth.uid && (!data.exists() || data.val() === newData.val())",
        ".validate": "newData.isString() && newData.val().length < 256"
      }
    }
  }
}
```

They enforce three properties, all **server-side** (Firebase evaluates rules on its servers — a client that modifies or skips its half of the protocol is simply denied):

1. **Own-slot writes only.** A client may only write the slot whose key equals its own auth uid — no participant can forge another's offer or flip another's ready flag (`$slot === auth.uid`, which is why these rules require uid-as-key mode).
2. **Session binding — a client can only touch the session it first joined.** During `connect()` the adapter registers `mp-sessions-memberships/<uid> = sessionId` *before* attaching the session listener. The membership rule is **first-write-wins**: only that uid can write its own record, and once set it can be re-asserted but never changed or deleted (`!data.exists() || data.val() === newData.val()`). Every session read and write then requires the membership to match (`…memberships/<uid> === $session`). So the same client identity cannot read or write any *other* session — rejoining its own session after a refresh works (same value, re-assertion passes), joining a different one is `PERMISSION_DENIED`.
3. **Bounded writes.** Slot payloads are capped (128 KB) so a buggy or hostile client can't balloon your database.

> **Why this is enforceable despite running only client-side code:** the client cannot be trusted, but it doesn't need to be. The rules are the enforcement point and they run on Firebase's servers; the client's only job is the one-time membership write, and the rules make that write self-limiting (own uid only, immutable once set). A client that lies, skips the write, or replays another session's id gets denied by the server.

**What this does *not* buy:** joining is still controlled by the **unguessable session URL**, not by the rules — anyone who has the URL can sign in anonymously with a *fresh* uid and join that session as a new participant (and then read it, since members can read their session). Don't hand out short or predictable session ids, and treat session contents accordingly for IRB purposes. Blocking uninvited *fresh* identities requires real (non-anonymous) auth or a server tier (JATOS) — anonymous auth has no notion of an invite list.

Note: with per-tab auth persistence (the adapter's default for its owned app), every new tab is a fresh uid, so the one-session-per-uid binding never gets in a legitimate participant's way; a same-tab reload keeps both the uid and the `?mp_session=` URL and rejoins cleanly. Membership records are a few bytes per participant and are deliberately never deleted; clear them with your project's normal data-retention tooling if desired.

### Quick-start rules — prototyping only

Any signed-in (anonymous) client may read and write **any** session. Fine for a first smoke test with the default constructor options (locally-minted participant id, no session binding); not for data collection — any participant can overwrite any slot in any session they can name.

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

These rules have no memberships node, so don't combine them with `useUidAsParticipantId: true` (which defaults `sessionBinding` on — the membership write would be denied). If you need uid-as-key without session binding for some reason, pass `sessionBinding: false` explicitly.

In uid-as-key mode the adapter adopts the anonymous auth uid as `participantId` during `connect()`, so **`participantId` is a placeholder until `connect()` resolves — don't read or cache it before connecting.** It is incompatible with a supplied `participantId` (constructing with both throws).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `firebaseConfig` | — | Firebase config object; the adapter initializes and owns a dedicated app. |
| `database` | — | An already-initialized RTDB `Database` (the caller owns the app + auth); use instead of `firebaseConfig`. |
| `sessionId` | `?mp_session=` or a fresh id | Session namespace under `<pathPrefix>/<sessionId>`. |
| `participantId` | a fresh random id | This participant's slot key. Incompatible with `useUidAsParticipantId`. |
| `useUidAsParticipantId` | `false` | Adopt the auth uid as the id during connect (enables the recommended rules). |
| `sessionBinding` | same as `useUidAsParticipantId` | Register the first-write-wins `mp-sessions-memberships/<uid>` record during connect (required by the recommended rules; must be `false` with the quick-start rules). |
| `pathPrefix` | `"mp-sessions"` | RTDB path namespace. |
| `removeOnDisconnect` | `true` | Server-remove the slot on disconnect via `onDisconnect().remove()`. |
| `connectTimeoutMs` | `20000` | Timeout for the await-first-snapshot step of `connect()`. |

Ids (`participantId`, `sessionId`, `pathPrefix`) must not contain `. # $ [ ] /` (RTDB key rules) or `:` (reserved for cross-adapter portability with the local adapter). The default generated ids comply.

## Testing two tabs on one machine

Firebase Auth persists per **origin**, not per tab, so two tabs on the same machine share one anonymous uid. The adapter defaults its owned app to **per-tab auth persistence** so a two-tab test still behaves like two participants — but if you inject your own `database`, you own persistence and should configure it yourself.

For a fully local loop, run the [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite). This package ships the config it needs (`firebase.json` + the recommended `database.rules.json`), so from this package's directory:

```
npx firebase-tools emulators:start --project demo-local
```

(any `demo-*` project id runs the emulators fully offline — no live project or credentials required). Then point your app at the emulator's database URL (`http://127.0.0.1:9000?ns=demo-local-default-rtdb`) and auth emulator. The emulator UI at the printed URL shows rule evaluations live, which is the fastest way to watch the session-binding rules allow/deny in practice.

## How it works

The contract's `getAll()`/`get()` are synchronous but every Firebase read is async, so the adapter keeps an in-memory **mirror** of the session node, kept live by a single `onValue` listener, and answers reads from it. `connect()` does not resolve until the first snapshot arrives (and rejects on a rules denial or a timeout). Each participant's payload is stored **JSON-encoded as a string**, so pushes round-trip exactly over RTDB's JSON coercion (empty arrays, `undefined`, and nested arrays are otherwise mangled). A `.info/connected` handler re-arms `onDisconnect` and re-pushes your last data after a transient network blip, so a brief drop can't erase a still-present participant.

The network layer sits behind a small `FirebaseBackend` interface (`src/firebase-backend.ts`); the whole adapter is unit-tested against an in-memory fake with zero Firebase credentials.
