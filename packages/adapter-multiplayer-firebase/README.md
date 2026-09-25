# @jspsych-multiplayer/adapter-multiplayer-firebase

A real-time, **cross-device** multiplayer adapter for jsPsych, backed by **Firebase Realtime Database (RTDB)** with anonymous auth. It gives you genuine multiplayer across separate devices, browsers, and machines — with essentially no backend to write or host.

It is a sibling of [`adapter-multiplayer-local`](../adapter-multiplayer-local) and [`adapter-multiplayer-jatos`](../adapter-multiplayer-jatos): all three implement the same `MultiplayerAdapter` contract, so plugins (`plugin-multiplayer-role`, `plugin-multiplayer-sync`, `plugin-multiplayer-chat`, …) behave identically on any of them. They form an infrastructure/integrity spectrum:

| Adapter | Reach | Backend to run | Use for |
| --- | --- | --- | --- |
| `local` | one browser, many tabs | none | dev, demos, tutorials, CI |
| **`firebase`** | **any device, anywhere** | **a free Firebase project** | **real cross-device data collection** |
| `jatos` | any device | a self-hosted JATOS server | lab-hosted studies |

> **Status:** built against the jsPsych multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694), which is not yet in a jsPsych release. The adapter implements that API's `MultiplayerAdapter` and `MultiplayerConnection` interfaces, imported from `jspsych`. Experiments need a jsPsych build that includes `jsPsych.multiplayer`.

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
await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerFirebase({ firebaseConfig }));
await jsPsych.run(timeline);
```

`firebase` is a **peer dependency** — install it in your experiment (`npm install firebase`) so you control its version and it isn't double-bundled.

Each group is namespaced by a **session id** carried in the URL as `?mp_session=…`. On first load with no `mp_session`, the adapter mints one and writes it into the URL; **bring another participant into the same group by sharing that full URL.** A bare URL starts a different session. In this mode you form the groups (by handing out links), so the connection doesn't report a group: `jsPsych.multiplayer.group()` lists whoever has joined, and `sealGroup()` / `waitForGroup()` aren't available.

### Matchmaking

To group participants as they arrive from one shared link, pass `matchmaking`:

```js
new jsPsychAdapterMultiplayerFirebase({
  firebaseConfig,
  matchmaking: { lobby: "study-1", groupSize: 2 },
});
```

Each arrival takes a free seat in the group that is filling, or the lobby starts a new group. The group is sealed when its last seat is taken, or earlier with `jsPsych.multiplayer.sealGroup()`; every member then sees `sealed: true` and the same final roster, including members who drop out later. Before the seal, a participant who leaves (or whose connection drops) frees their seat for someone new. Use `jsPsych.multiplayer.waitForGroup()` as a waiting room.

### Participant ids and reloads

By default each browser tab gets a random participant id, kept in the tab's `sessionStorage` (`persistParticipant: true`). A reload of the tab comes back as the **same** participant, in the same session (and, with matchmaking, the same group), so jsPsych reports it as a restart: `jsPsych.multiplayer.restarted` is `true` on the reloaded page, and the others see that participant as `left`. A new tab is a new participant. With `persistParticipant: false`, every page load is a new participant.

Alternatively, pass your own `participantId` (e.g. a recruitment-platform id), or set `useUidAsParticipantId: true` to use the anonymous auth uid (which an adapter-owned app also keeps per tab). Read the id from `jsPsych.multiplayer.participantId` once `connect()` resolves.

How long connecting may take is up to jsPsych: pass `connectTimeout` (and `reconnectTimeout`) to `jsPsych.multiplayer.connect()`.

## One-time Firebase setup

1. Create a project at the [Firebase console](https://console.firebase.google.com/).
2. **Authentication → Sign-in method → enable Anonymous.**
3. **Realtime Database → create database** (pick a region).
4. Paste one of the rules blocks below (**Realtime Database → Rules**).
5. Copy your web app's config object (**Project settings → General → Your apps**) into `firebaseConfig`.

### Recommended rules (use these for data collection)

These are the rules shipped as [`database.rules.json`](./database.rules.json). They work with the default options, in every identity mode, with or without matchmaking:

```json
{
  "rules": {
    "mp-sessions": {
      "$session": {
        ".read": "auth != null && root.child('mp-sessions-memberships').child(auth.uid).val() === $session",
        "$pid": {
          ".write": "auth != null && root.child('mp-sessions-owners').child($session).child($pid).val() === auth.uid && root.child('mp-sessions-memberships').child(auth.uid).val() === $session",
          ".validate": "newData.isString() && newData.val().length < 131072"
        }
      }
    },
    "mp-sessions-presence": {
      "$session": {
        ".read": "auth != null && root.child('mp-sessions-memberships').child(auth.uid).val() === $session",
        "$pid": {
          ".write": "auth != null && root.child('mp-sessions-owners').child($session).child($pid).val() === auth.uid && root.child('mp-sessions-memberships').child(auth.uid).val() === $session",
          ".validate": "newData.isString() && newData.val().length < 64"
        }
      }
    },
    "mp-sessions-owners": {
      "$session": {
        "$pid": {
          ".write": "auth != null && newData.val() === auth.uid && (!data.exists() || data.val() === auth.uid) && root.child('mp-sessions-memberships').child(auth.uid).val() === $session",
          ".validate": "newData.isString() && $pid.length < 128"
        }
      }
    },
    "mp-sessions-memberships": {
      "$uid": {
        ".read": "auth != null && $uid === auth.uid",
        ".write": "auth != null && $uid === auth.uid && (!data.exists() || data.val() === newData.val())",
        ".validate": "newData.isString() && newData.val().length < 256"
      }
    },
    "mp-sessions-lobby": {
      "$lobby": {
        ".read": "auth != null",
        ".write": "auth != null && newData.isString() && newData.val().length < 128 && !root.child('mp-sessions-groups').child(newData.val()).exists() && (!data.exists() || root.child('mp-sessions-groups').child(data.val()).child('sealed').exists())"
      }
    },
    "mp-sessions-groups": {
      "$session": {
        ".read": "auth != null",
        "seats": {
          "$seat": {
            ".write": "auth != null && !data.parent().parent().child('sealed').exists() && ((!data.exists() && newData.child('uid').val() === auth.uid) || (data.child('uid').val() === auth.uid && !newData.exists()))",
            ".validate": "$seat.matches(/^[0-9]{1,4}$/) && newData.hasChildren(['uid', 'id'])",
            "uid": { ".validate": "newData.isString()" },
            "id": { ".validate": "newData.isString() && newData.val().length < 128" },
            "$other": { ".validate": false }
          }
        },
        "sealed": {
          ".write": "auth != null && !data.exists() && newData.child('by').isString() && data.parent().child('seats').child(newData.child('by').val()).child('uid').val() === auth.uid",
          ".validate": "newData.hasChildren(['by', 'seats']) && newData.child('seats').child(newData.child('by').val()).exists()",
          "by": { ".validate": "newData.isString()" },
          "seats": {
            "$seat": {
              ".validate": "newData.child('uid').val() === data.parent().parent().parent().child('seats').child($seat).child('uid').val() && newData.child('id').val() === data.parent().parent().parent().child('seats').child($seat).child('id').val()"
            }
          },
          "$other": { ".validate": false }
        },
        "$other": { ".validate": false }
      }
    }
  }
}
```

The adapter keeps its data in six sibling nodes, all named after `namespace` (default `mp-sessions`):

| Node | Holds | Who may write |
| --- | --- | --- |
| `<namespace>/<session>/<participant>` | each participant's data, JSON-encoded | the uid that claimed that participant id |
| `<namespace>-presence/<session>/<participant>` | who is connected; the server removes an entry when its connection drops | the same uid |
| `<namespace>-owners/<session>/<participant>` | the slot claim: which auth uid owns this participant id in this session | first write wins; only that uid can re-assert it, nobody can change or delete it |
| `<namespace>-memberships/<uid>` | the session binding: the one session this uid may use | first write wins, by that uid only |
| `<namespace>-lobby/<lobby>` | matchmaking: the session id of the group that is filling | anyone signed in, but only to start the first group, or to move the lobby off a **sealed** group onto a group that doesn't exist yet |
| `<namespace>-groups/<session>` | matchmaking: `seats/<n> = {uid, id}` per place, and `sealed = {by, seats}`, the final roster | a seat: only its holder (take an empty seat as yourself, or free your own), never once sealed. The roster: once, by a member, and each entry must match the seat on the server |

What the rules enforce, all **server-side** (Firebase evaluates rules on its servers — a client that modifies or skips its half of the protocol is simply denied):

1. **Own-slot writes only.** During `connect()` the adapter claims `<namespace>-owners/<session>/<participant> = <uid>`. The claim is first-write-wins, and every write to a data slot or presence entry must come from the uid that holds the claim, so no participant can forge another's data or flip another's presence.
2. **Session binding.** During `connect()` the adapter also registers `<namespace>-memberships/<uid> = <session>`, before it attaches any listener. Once set, the record can be re-asserted but never changed or deleted, and every read and write of a session requires it. So one anonymous identity can read and write only the session it first joined: a reload of its own session passes, joining a different one is `PERMISSION_DENIED`.
3. **Matchmaking can't be hijacked.** A client can only take an empty seat as itself or free its own; it can't remove other members, write a seat for someone else, or add itself to a sealed group. Only a member can seal, only once, and only with a roster that matches the seats on the server. The lobby can't be pointed at an existing group, and it moves on only when its group is sealed.
4. **Bounded writes.** Data slots are capped at 128 KB, and ids and presence values are short, so a buggy or hostile client can't balloon your database.

What each identity mode gets from rule 1:

| Identity mode | Enforced | Not enforced |
| --- | --- | --- |
| Default (`persistParticipant: true`): a random id kept for the tab | Nobody else can write the slot: the id is an unguessable UUID claimed by this tab's uid. A reload of the tab keeps both the id and (with an adapter-owned app) the uid, so it passes. | With an injected `database` whose auth doesn't keep the uid across a reload, the reloaded page can't reclaim its id and `connect()` rejects. |
| `persistParticipant: false`: a new random id every page load | Same as above. A reload is a new participant. | — |
| `useUidAsParticipantId: true` | The id *is* the uid, so nobody else can claim it. | — |
| A supplied `participantId` (e.g. a recruitment-platform id) | The first uid to connect with an id owns it; nobody else can write that slot afterwards. | Someone who knows the id and connects first takes it, locking the real participant out (denial of service, not forgery). The same id can't be reused from a second device or browser. |

**What the rules can't enforce:**

- **Joining.** Who can join is controlled by the **unguessable session URL** (or the lobby name, with matchmaking), not by the rules — anyone who has the URL can sign in anonymously with a *fresh* uid and join as a new participant, and then read the session. Don't hand out short or predictable session ids, and treat session contents accordingly for IRB purposes. Blocking uninvited identities requires real (non-anonymous) auth or a server tier (JATOS).
- **Reading.** Every member of a session can read every participant's data in it.
- **A complete roster.** Rules can't loop over the seats, so they check that each roster entry matches a seat, not that every seat is on the roster. A hostile member could seal a roster that leaves someone out; that participant's connection is then closed. It can't add anyone who doesn't hold a seat.
- **Payload contents.** The rules check that a slot is a string of bounded size, not what's in it.

Membership records and slot claims are a few bytes per participant and are deliberately never deleted; clear them with your project's normal data-retention tooling if desired.

### Quick-start rules — prototyping only

Any signed-in (anonymous) client may read and write **any** node. They cover the same nodes as the recommended rules, so the default options work with both, but they enforce nothing — any participant can overwrite any slot, seat, or lobby they can name. Fine for a first smoke test; not for data collection.

```json
{
  "rules": {
    "mp-sessions": { "$session": { ".read": "auth != null", ".write": "auth != null" } },
    "mp-sessions-presence": { "$session": { ".read": "auth != null", ".write": "auth != null" } },
    "mp-sessions-owners": { "$session": { ".read": "auth != null", ".write": "auth != null" } },
    "mp-sessions-memberships": { "$uid": { ".read": "auth != null", ".write": "auth != null" } },
    "mp-sessions-lobby": { "$lobby": { ".read": "auth != null", ".write": "auth != null" } },
    "mp-sessions-groups": { "$session": { ".read": "auth != null", ".write": "auth != null" } }
  }
}
```

If you rename the nodes with `namespace`, rename them in your rules too.

### Choosing `sessionBinding`

`sessionBinding` is on by default, and both rule sets above allow its record, so you rarely need to change it. The cost of the binding is that one anonymous identity can join only one session. With an app the adapter owns, the identity lasts for one tab, so a participant who opens a *different* session link (or, with matchmaking, whose group filled up while they were away) in the **same tab** is refused and has to use a new tab. With an injected `database`, the identity lasts as long as that app's auth persistence says, often the whole browser profile. Set `sessionBinding: false` if you write your own rules without the memberships node, or for pilot testing where one tab visits many sessions.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `firebaseConfig` | — | Firebase config object; the adapter initializes and owns a dedicated app. |
| `database` | — | An already-initialized RTDB `Database` (the caller owns the app + auth); use instead of `firebaseConfig`. |
| `sessionId` | `?mp_session=` or a fresh id | The group's session. Also seeds jsPsych's shared randomness. Incompatible with `matchmaking`. |
| `matchmaking` | — | `{ lobby, groupSize }`: group participants as they arrive (see [Matchmaking](#matchmaking)). |
| `participantId` | an id kept for the tab | This participant's id. Incompatible with `useUidAsParticipantId`. |
| `persistParticipant` | `true` | Keep the default participant id (and matchmaking group) in the tab's `sessionStorage`, so a reload is the same participant. |
| `useUidAsParticipantId` | `false` | Use the anonymous auth uid as the participant id. |
| `sessionBinding` | `true` | Register the first-write-wins `<namespace>-memberships/<uid>` record during connect (see [Choosing `sessionBinding`](#choosing-sessionbinding)). |
| `namespace` | `"mp-sessions"` | Names the adapter's RTDB nodes (see the rules). Replaces `pathPrefix`. |

Ids (`participantId`, `sessionId`, `namespace`, `matchmaking.lobby`) must be non-empty and must not contain `: / . # $ [ ]`, so every jsPsych multiplayer adapter can store them. The default generated ids comply.

## Testing two tabs on one machine

Firebase Auth persists per **origin**, not per tab, so two tabs on the same machine share one anonymous uid. The adapter defaults its owned app to **per-tab auth persistence** so a two-tab test still behaves like two participants — but if you inject your own `database`, you own persistence and should configure it yourself.

For a fully local loop, run the [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite). This package ships the config it needs (`firebase.json` + the recommended `database.rules.json`), so from this package's directory:

```
npx firebase-tools emulators:start --project demo-local
```

(any `demo-*` project id runs the emulators fully offline — no live project or credentials required). Then point your app at the emulator's database URL (`http://127.0.0.1:9000?ns=demo-local-default-rtdb`) and auth emulator. The emulator UI at the printed URL shows rule evaluations live, which is the fastest way to watch the session-binding rules allow/deny in practice.

## How it works

The adapter holds configuration only; each `connect()` opens a new connection with its own Firebase app (or your injected database), listeners, and state.

- **Data.** jsPsych reads the shared data synchronously, but every Firebase read is async, so each connection keeps an in-memory **mirror** of the session node, kept live by an `onValue` listener. Each participant's slot is stored **JSON-encoded as a string**, so pushes round-trip exactly over RTDB's JSON coercion (empty arrays and nested arrays are otherwise mangled).
- **Claims.** Before attaching any listener, `connect()` registers the session binding and the slot claim that the rules check (see above). Neither is removed on disconnect.
- **Presence.** Each connection writes `<namespace>-presence/<sessionId>/<participantId>` and arms `onDisconnect().remove()` on it, so the server removes it when the participant's connection drops. A second listener mirrors the presence node, which is how jsPsych learns that a participant is `away` or has `left`. Data slots are never removed: a participant who drops out keeps their last data, and presence tells the others they're gone.
- **Connecting.** `connect()` resolves once the session and presence nodes (and, with matchmaking, the group node) have delivered a first snapshot. It rejects on a rules denial, or when jsPsych cancels the attempt, including when jsPsych's `connectTimeout` runs out.
- **Connection status.** When `.info/connected` goes false, the connection reports `reconnecting`. When it comes back, the connection re-arms and re-writes its presence node (and, with matchmaking, takes back its seat if the group is still filling), then reports `connected`. If the server removes its presence while the connection never saw a drop, it restores it and tells jsPsych, which re-announces the participant. If a listener is cancelled after connecting (for example, because the rules no longer grant read access), or its group filled up without it, it reports `closed`.
- **Matchmaking.** Each seat is taken with a transaction on that seat alone, so the server settles who gets the last one, and the rules can check who writes it. The removal of a seat is armed right after it is taken; a tab that closes in between leaves a ghost seat, and the group seals with that participant as a dropout. A member who sees the group full but unsealed seals it, in case the last arrival couldn't.
- **Rejoining.** A participant whose network drops and comes back on the same page keeps their participant id, so the others see them as back, unless they had already reached `left`, which is final. A reload is a new page load: it restarts the experiment, so jsPsych reports it as a restart and the others count that participant as `left`.
- **Disconnecting.** `disconnect()` removes this participant's presence node (and a seat in a group that is still filling), cancels the armed removals, and releases an app the adapter created. The data slot stays.

The network layer sits behind a small `FirebaseBackend` interface (`src/firebase-backend.ts`); the whole adapter is unit-tested against an in-memory fake with zero Firebase credentials.
