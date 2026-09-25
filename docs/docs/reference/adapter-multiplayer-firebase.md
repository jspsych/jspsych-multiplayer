---
id: adapter-multiplayer-firebase
title: adapter-multiplayer-firebase
sidebar_label: adapter-multiplayer-firebase
description: Run a multiplayer experiment across devices using a Firebase Realtime Database, with no server of your own.
---

# `adapter-multiplayer-firebase`

The Firebase adapter shares data through a
[Firebase Realtime Database](https://firebase.google.com/docs/database). Participants can be on
any device, anywhere, and you host no server: the experiment can be a static web page.
Participants sign in anonymously, without seeing a
login.

There are two ways to put participants into groups. By default, everyone who opens the
experiment with the same `?mp_session=` value in the address is in the same group, so you hand
each group its own link. With the `matchmaking` option, everyone opens the same link instead, and
the adapter fills groups as participants arrive. See [Forming groups](#forming-groups), and
[Choosing a backend](../guides/choosing-a-backend) for how the adapter compares with JATOS.

```js
import FirebaseAdapter from "@jspsych-multiplayer/adapter-multiplayer-firebase";

const firebaseConfig = {
  apiKey: "...",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
};

const jsPsych = initJsPsych();
await jsPsych.multiplayer.connect(new FirebaseAdapter({ firebaseConfig }));
await jsPsych.run(timeline);
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/adapter-multiplayer-firebase` |
| Browser global | None. Load it as a JavaScript module; see [Loading the adapter](#loading-the-adapter). |
| Requires | The `firebase` package, version 10 or later |
| Use it for | Data collection across devices without running a server. |

## Options

Pass these to the constructor. Give either `firebaseConfig` or `database`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `firebaseConfig` | `object` | — | Your web app's Firebase config object, from the Firebase console. The adapter starts its own Firebase app from it. |
| `database` | `Database` | — | A Realtime Database you have already set up with the Firebase SDK. Use this instead of `firebaseConfig` when your page already uses Firebase, or to connect to the emulator. You are then responsible for its sign-in settings. |
| `sessionId` | `string` | the `?mp_session=` URL parameter, or a new random ID | Which session (group) to join. If the URL has no `mp_session` parameter, the adapter makes a new ID and adds it to the URL. It is also the session ID that seeds [shared randomness](multiplayer-api#shared-randomness). Cannot be combined with `matchmaking`. |
| `matchmaking` | `{ lobby, groupSize }` | — | Put participants who open the same link into groups of `groupSize` as they arrive. `lobby` names the queue they wait in. See [Forming groups](#forming-groups). |
| `participantId` | `string` | a random ID, kept for the tab | This participant's ID, for example a recruitment-platform ID. Cannot be combined with `useUidAsParticipantId`. |
| `persistParticipant` | `boolean` | `true` | Keep the default participant ID (and, with matchmaking, the group) in the tab's `sessionStorage`, so a reload comes back as the same participant and the others can tell they restarted. Set `false` for a new participant on every page load. |
| `useUidAsParticipantId` | `boolean` | `false` | Use the participant's anonymous Firebase sign-in ID as their participant ID. |
| `sessionBinding` | `boolean` | `true` | Record which session this participant joined, so the rules can keep them out of every other session. See [Choosing `sessionBinding`](#choosing-sessionbinding). |
| `namespace` | `string` | `"mp-sessions"` | Names the adapter's entries in the database. If you change it, rename the top-level entries in your security rules to match. |

`participantId`, `sessionId`, `namespace`, and `matchmaking.lobby` must be non-empty and must
not contain any of `: / . # $ [ ]`. The default IDs follow these rules. Once `connect()`
resolves, this participant's ID is in `jsPsych.multiplayer.participantId`.

How long connecting may take is an option of `jsPsych.multiplayer.connect()`: pass
`connectTimeout` (default 20 seconds), and `reconnectTimeout` to give up on a connection that
stays down. Options that changed in 1.0 are listed in
[Upgrading from 0.x](../guides/upgrading); passing a removed option throws an error that names
its replacement.

## Forming groups

The [Forming groups](../guides/forming-groups) guide explains both ways of forming groups and the
waiting room; this section covers what is specific to Firebase.

### One link per group

Without `matchmaking`, the session ID decides the group. The first participant to open the
experiment gets a new `?mp_session=` value added to their address; everyone who opens that same
address joins their group. You decide who is grouped with whom by deciding who gets which link.
This suits studies where you schedule participants together, for example a lab session.

In this mode the adapter can't tell how big a group should be or when it is complete, so
`jsPsych.multiplayer.waitForGroup()` rejects. Wait for enough connected participants with a
lobby trial instead, as in the [Example](#example) below.

### One link for everyone (matchmaking)

With `matchmaking`, everyone opens the same link. Each participant who arrives takes a place in
the group that is filling. When the group has `groupSize` members it is **sealed**, and the next
participant to arrive starts a new group:

```js
await jsPsych.multiplayer.connect(
  new FirebaseAdapter({
    firebaseConfig,
    matchmaking: { lobby: "ultimatum-pilot", groupSize: 2 },
  }),
);
```

`connect()` resolves as soon as the participant has a place, which is usually before their group
is full. So begin the experiment with a waiting room that holds everyone until the group is
sealed:

```js
const waitingRoom = {
  type: jsPsychCallFunction,
  async: true,
  func: (done) => {
    jsPsych.getDisplayElement().innerHTML = "<p>Waiting for the other player to arrive...</p>";
    jsPsych.multiplayer
      .waitForGroup({ timeout: 5 * 60000 })
      .then((group) => done({ group_members: group.members }))
      .catch(() => jsPsych.abortExperiment("<p>No other player arrived. Thank you for waiting.</p>"));
  },
};
```

What happens along the way:

- **While a group is filling**, a participant who closes the tab or loses their network gives
  up their place, and the next arrival takes it. A participant whose network comes back before
  then takes their place again. If the group filled up without them while they were gone, their
  session closes, and waiting trials end with `multiplayer_outcome: "connection_lost"`.
- **Once a group is sealed**, its members are final. Every member sees `sealed: true` and the
  same roster in `jsPsych.multiplayer.group().members`, including members who drop out later. A
  member who leaves counts as a dropout: nobody replaces them. See
  [Handling dropouts](../guides/handling-dropouts).
- **To start before a group is full**, for example when the waiting room times out with enough
  people present, call `jsPsych.multiplayer.sealGroup()`. It seals the group with the members it
  has now, for every member.
- **The lobby name** groups participants: only participants who connect with the same `lobby`
  are grouped together. Use a new lobby name for each study. To group each condition separately,
  give each condition its own lobby.
- **Each group gets its own session ID**, so each group gets its own
  [shared random values](multiplayer-api#shared-randomness).
- **A participant who reloads the tab** goes back to the group they joined first (with the
  default `persistParticipant: true`). The reload restarted their experiment, so the others count
  them as `left` and their own page sees `jsPsych.multiplayer.restarted === true` (see
  [Rejoining](../guides/handling-dropouts#rejoining)). With `persistParticipant: false`, a
  reload arrives as a new participant and takes a place in whichever group is filling.

The database settles who gets each place: each place is taken with a
[transaction](https://firebase.google.com/docs/database/web/read-and-write#save_data_as_transactions),
so two participants who arrive at the same moment can't both take the last place.

Groups formed by a version of the adapter before 1.0 aren't read. Start a new lobby name after
upgrading.

## Setup

### Create the Firebase project

1. Create a project in the [Firebase console](https://console.firebase.google.com/).
2. Under **Authentication**, open **Sign-in method** and enable **Anonymous**.
3. Under **Realtime Database**, create a database and choose a region.
4. Under **Project settings > General > Your apps**, add a web app and copy its config object.
   Use it as `firebaseConfig`. It must include `databaseURL`.

### Deploy the security rules

The rules decide who can read and write what. Without them, the database either refuses the
adapter or lets anyone change anything. The package ships the recommended rules in
`database.rules.json`, next to a `firebase.json` that points to them. After
`npm install @jspsych-multiplayer/adapter-multiplayer-firebase` they are in
`node_modules/@jspsych-multiplayer/adapter-multiplayer-firebase/`. The package README also shows
them in full.

The recommended rules work with the default options, in every way of choosing participant IDs,
with or without matchmaking. Firebase checks them on its own servers, so a participant who
modifies the experiment's code is still held to them:

- **Each participant writes only their own data.** When a participant connects, the adapter
  claims their participant ID for their anonymous sign-in. The first claim wins, and only that
  sign-in can then write that participant's data or presence.
- **Each participant reads only the session they first joined.** The adapter records which
  session a sign-in joined (`sessionBinding`). The record can't be changed afterward, and every
  read and write of a session requires it.
- **Matchmaking can't be tampered with.** A participant can take an empty place only for
  themselves and free only their own. Only a member can seal a group, only once, and only with a
  roster that matches the places on the server. Once a group is sealed, its members can't change.
- **Writes are limited in size.** Each participant's data can be at most 128 KB. See
  [How much data fits](#how-much-data-fits).

Deploy them in either of two ways:

- **In the console.** Open **Realtime Database > Rules**, replace the contents with the contents
  of `database.rules.json`, and click **Publish**.
- **From the command line.** Copy `database.rules.json` and `firebase.json` into a folder, and
  in that folder run:

  ```bash
  npx firebase-tools login
  npx firebase-tools deploy --only database --project your-project-id
  ```

  `deploy --only database` uploads the rules and nothing else. Your project ID is shown in
  **Project settings**.

Deploy again if you change `namespace`, or if a new version of the package changes the rules.
**Version 1.0 changed the rules**: it adds the `mp-sessions-owners` and `mp-sessions-memberships`
entries and stores matchmaking groups differently. If you deployed the rules from an earlier
version, deploy the new ones before running a study with 1.0.

The rules can't stop everyone:

- **Joining.** Anyone who has a session's link (or, with matchmaking, the study link) can join as
  a new participant and read that session. Use session IDs that cannot be guessed (the default
  random IDs are fine) and share each link only with its group.
- **Reading.** Every member of a session can read every participant's data in it.
- **A supplied `participantId`.** If you pass your own IDs, whoever connects first with an ID
  owns it. Someone who knows another participant's ID and connects first can lock them out,
  though not write as them. The same ID can't be used from a second device or browser.
- **A complete roster.** A participant who modifies the experiment's code could seal a group
  with a roster that leaves someone out; that participant's connection then closes. Nobody can be
  added who doesn't hold a place.

Claims and session records are a few bytes each and are never deleted by the adapter. Clear them
with your project's usual data-retention tools if you wish.

**For a first test only**, these rules let any signed-in participant read and write anything.
They work with the default options but enforce nothing, so never use them for data collection:

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

If you rename the entries with `namespace`, rename them in your rules too.

### Choosing `sessionBinding`

`sessionBinding` is on by default, and both sets of rules above allow it, so you rarely need to
change it. Its cost is that one anonymous sign-in can join only one session. With the default
`firebaseConfig`, a sign-in lasts for one tab, so a participant who opens a *different* session
link in the same tab (or, with matchmaking, whose group filled up while they were away) is
refused and has to use a new tab. With your own `database`, the sign-in lasts as long as that
app's sign-in settings say, often the whole browser profile. Set `sessionBinding: false` if you
write your own rules without the `mp-sessions-memberships` entry, or for pilot testing where one
tab visits many sessions.

### Loading the adapter

The adapter imports the Firebase SDK, so it loads as a JavaScript module rather than a plain
`<script>` tag. With a bundler, `npm install firebase` and import the adapter. On a plain HTML
page, an import map tells the browser where to find Firebase:

```html
<script type="importmap">
  {
    "imports": {
      "firebase/app": "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
      "firebase/auth": "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
      "firebase/database": "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js"
    }
  }
</script>
<script type="module">
  import FirebaseAdapter from "https://cdn.jsdelivr.net/npm/@jspsych-multiplayer/adapter-multiplayer-firebase/dist/index.js";
  // ...
</script>
```

### Saving the data

The database holds only what participants share with each other while the experiment runs.
Save the jsPsych trial data the way you normally would, for example by sending it to your own
server or a data-collection service in `initJsPsych`'s `on_finish`.

### Testing without a Firebase project

The [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite) runs a local
database on your computer. In the folder with the package's `firebase.json` and
`database.rules.json`, run:

```bash
npx firebase-tools emulators:start --project demo-local
```

Then connect with a `database` pointed at the emulator:

```js
import { initializeApp } from "firebase/app";
import {
  browserSessionPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
} from "firebase/auth";
import { connectDatabaseEmulator, getDatabase } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  projectId: "demo-local",
  databaseURL: "https://demo-local-default-rtdb.firebaseio.com",
});
connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
// One sign-in per tab, so two tabs are two participants.
await setPersistence(getAuth(app), browserSessionPersistence);
const database = getDatabase(app);
connectDatabaseEmulator(database, "127.0.0.1", 9000);

await jsPsych.multiplayer.connect(new FirebaseAdapter({ database }));
```

The emulator's web page, at the address it prints, shows each rule allowing or denying requests.

## How much data fits

The recommended rules allow each participant's data to be up to 128 KB. Every write sends all of
a participant's data, including what they wrote in earlier trials, so a long experiment that
shares a lot can reach this limit. A write over the limit is refused. To allow more, raise the
number in the `.validate` rule for `mp-sessions/$session/$pid` (`131072` characters); Firebase
itself accepts values of several megabytes. See
[How much data you can share](multiplayer-api#how-much-data-you-can-share).

## Presence and dropouts

The adapter counts a participant as connected while Firebase has an open connection from them.
When the connection closes, Firebase's servers remove them from the session's list of connected
participants.

- **Another participant closes the tab.** Firebase notices at once. That participant becomes
  `away`, then `left` after the dropout timeout (10 seconds by default, set in `connect()`).
- **Another participant loses their network.** Firebase notices only when the connection times
  out, which can take a minute or more. They then become `away`, and `left` after the dropout
  timeout.
- **This participant loses their network.** The connection status is `reconnecting` until the
  Firebase SDK reconnects, with no time limit unless you pass `reconnectTimeout` to `connect()`.
  The others see this participant as `away`. If the SDK reconnects before the others' dropout
  timeout, this participant is back on the same page, so the others see them as `connected`
  again: they rejoin. After that, they stay `left`, because `left` is final. If Firebase dropped
  this participant's presence without the page noticing, the adapter restores it when it finds
  out. The adapter itself reports a lost connection only when the database stops allowing it to
  read the session, for example after the rules change.
- **`jsPsych.multiplayer.disconnect()`** removes this participant from the connected list at
  once. Their data stays in the session. With matchmaking, it also gives up their place in a
  group that is still filling.

See [Handling dropouts](../guides/handling-dropouts) for what each plugin records.

Each tab signs in separately, so two tabs on one computer are two participants. A participant
who reloads the tab keeps their ID (with the default `persistParticipant: true`), but the reload
restarted their experiment, so the others count them as `left` and their own page sees
`jsPsych.multiplayer.restarted === true` (see [Rejoining](../guides/handling-dropouts#rejoining)).
With `persistParticipant: false`, a reload joins as a new participant.

## Example

A complete page for a two-player lobby, using the recommended rules and one link per group.
Serve it from any web host, open it, and send the address it shows (with `?mp_session=...`) to
the other player. To use matchmaking instead, add the `matchmaking` option and replace the lobby
trial with the waiting room from [Forming groups](#forming-groups).

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- a jsPsych build with jsPsych.multiplayer; see Getting started -->
    <script src="jspsych.js"></script>
    <script src="https://unpkg.com/@jspsych/plugin-html-keyboard-response"></script>
    <script src="https://unpkg.com/@jspsych-multiplayer/plugin-multiplayer-sync"></script>
    <script type="importmap">
      {
        "imports": {
          "firebase/app": "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
          "firebase/auth": "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
          "firebase/database": "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js"
        }
      }
    </script>
  </head>
  <body></body>
  <script type="module">
    import FirebaseAdapter from "https://cdn.jsdelivr.net/npm/@jspsych-multiplayer/adapter-multiplayer-firebase/dist/index.js";

    const firebaseConfig = {
      apiKey: "YOUR_API_KEY",
      authDomain: "YOUR_PROJECT.firebaseapp.com",
      databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
      projectId: "YOUR_PROJECT",
    };

    const jsPsych = initJsPsych();

    const lobby = {
      type: jsPsychMultiplayerSync,
      participants: [],
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

    const start = {
      type: jsPsychHtmlKeyboardResponse,
      stimulus: "<p>Both players are here. Press any key to begin.</p>",
    };

    try {
      await jsPsych.multiplayer.connect(new FirebaseAdapter({ firebaseConfig }));
    } catch (error) {
      // A wrong config, missing rules, or no network ends up here.
      document.body.textContent = `Could not connect: ${error.message}`;
      throw error;
    }
    if (jsPsych.multiplayer.restarted) {
      document.body.innerHTML = "<p>You reloaded the page, so you can't rejoin your group.</p>";
    } else {
      await jsPsych.run([lobby, start]);
    }
  </script>
</html>
```
