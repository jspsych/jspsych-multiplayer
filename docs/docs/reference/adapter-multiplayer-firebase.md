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
await jsPsych.multiplayer.connect(
  new FirebaseAdapter({ firebaseConfig, useUidAsParticipantId: true }),
);
await jsPsych.run(timeline);
```

| | |
| --- | --- |
| Package | `@jspsych-multiplayer/adapter-multiplayer-firebase` |
| Browser global | None. Load it as a JavaScript module; see [Loading the adapter](#loading-the-adapter). |
| Requires | The `firebase` package, version 10 or later |
| Use it for | Data collection across devices without running a server. |

## Options

Pass these to the constructor. Give either `firebaseConfig` or `database`; if you give both,
`database` is used.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `firebaseConfig` | `object` | — | Your web app's Firebase config object, from the Firebase console. The adapter starts its own Firebase app from it. |
| `database` | `Database` | — | A Realtime Database you have already set up with the Firebase SDK. Use this instead of `firebaseConfig` when your page already uses Firebase, or to connect to the emulator. You are then responsible for its sign-in settings. |
| `sessionId` | `string` | the `?mp_session=` URL parameter, or a new random ID | Which session (group) to join. If the URL has no `mp_session` parameter, the adapter makes a new ID and adds it to the URL. It is also the session ID that seeds [shared randomness](multiplayer-api#shared-randomness). Cannot be combined with `matchmaking`. |
| `matchmaking` | `{ lobby, groupSize }` | — | Put participants who open the same link into groups of `groupSize` as they arrive. `lobby` names the queue they wait in. See [Forming groups](#forming-groups). |
| `participantId` | `string` | a new random ID | This participant's ID. Cannot be combined with `useUidAsParticipantId`. |
| `useUidAsParticipantId` | `boolean` | `false` | Use the participant's anonymous Firebase sign-in ID as their participant ID. The recommended security rules require this. |
| `sessionBinding` | `boolean` | same as `useUidAsParticipantId` | Record which session this participant joined, so the recommended rules can keep them out of every other session. Set it to `false` with the prototyping rules, which do not allow that record. |
| `pathPrefix` | `string` | `"mp-sessions"` | Where in the database the adapter stores its data. If you change it, rename the top-level entries in your security rules to match. |
| `connectTimeoutMs` | `number` | `20000` | How long, in ms, `connect()` waits for the first data from the database before it fails. |
| `backend` | `FirebaseBackend` | the real Firebase SDK | A stand-in database for automated tests. |

`sessionId`, `participantId`, `pathPrefix`, and `matchmaking.lobby` cannot be empty or contain
`.`, `#`, `$`, `[`, `]`, `/`, or `:`. Once `connect()` resolves, this participant's ID is in
`jsPsych.multiplayer.participantId`.

## Forming groups

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
    useUidAsParticipantId: true,
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
  then takes their place again. If someone else took it while they were gone, their session
  closes, and waiting trials end with `connection_lost: true`.
- **Once a group is sealed**, its members are final. `jsPsych.multiplayer.group().members` lists
  them, and a member who leaves counts as a dropout: nobody replaces them. See
  [Handling dropouts](../guides/handling-dropouts).
- **To start before a group is full**, for example when the waiting room times out with enough
  people present, call `jsPsych.multiplayer.sealGroup()`. It seals the group with the members it
  has now, for every member.
- **The lobby name** groups participants: only participants who connect with the same `lobby`
  are grouped together. Use a new lobby name for each study. To group each condition separately,
  give each condition its own lobby.
- **Each group gets its own session ID**, so each group gets its own
  [shared random values](multiplayer-api#shared-randomness).
- **A participant who reloads the tab** with `useUidAsParticipantId: true` goes back to the
  group they joined first. The reload restarted their experiment, so the others keep them `left`
  (see [Rejoining](../guides/handling-dropouts#rejoining)). Without `useUidAsParticipantId`, a
  reload arrives as a new participant and takes a place in whichever group is filling.

The database settles who gets each place: every step of joining is a
[transaction](https://firebase.google.com/docs/database/web/read-and-write#save_data_as_transactions),
so two participants who arrive at the same moment can't both take the last place.

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
`node_modules/@jspsych-multiplayer/adapter-multiplayer-firebase/`.

These rules let each participant write only their own data, read only the session they first
joined, and store at most 128 KB each. They also cover matchmaking, and keep a sealed group's
members from being changed. They need `useUidAsParticipantId: true`.

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

Deploy again if you change `pathPrefix`, or if a new version of the package changes the rules.

The rules can't stop everyone. With one link per group, anyone who has a session's link can
join that session, so use session IDs that cannot be guessed (the default random IDs are fine)
and share each link only with its group. With matchmaking, anyone who has the study link can
join a group, and the rules can't check a group's size, so a participant who modifies the
experiment's code could crowd a group that is still filling. Once a group is sealed, the rules
refuse any change to its members.

**For a first test only**, these rules let any signed-in participant read and write any session.
Use them with the default options (no `useUidAsParticipantId`), never for data collection:

```json
{
  "rules": {
    "mp-sessions": {
      "$session": { ".read": "auth != null", ".write": "auth != null" }
    },
    "mp-sessions-presence": {
      "$session": { ".read": "auth != null", ".write": "auth != null" }
    },
    "mp-sessions-lobby": {
      "$lobby": { ".read": "auth != null", ".write": "auth != null" }
    },
    "mp-sessions-groups": {
      "$session": { ".read": "auth != null", ".write": "auth != null" }
    }
  }
}
```

The last two entries are needed only with `matchmaking`.

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

await jsPsych.multiplayer.connect(new FirebaseAdapter({ database, useUidAsParticipantId: true }));
```

The emulator's web page, at the address it prints, shows each rule allowing or denying requests.

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
  Firebase SDK reconnects, with no time limit. The others see this participant as `away`, and
  then `left`. When the SDK reconnects, this participant is back on the same page, so the others
  see them as `connected` again: they rejoin. The adapter reports a lost connection
  only when the database stops allowing it to read the session, for example after the rules
  change.
- **`jsPsych.multiplayer.disconnect()`** removes this participant from the connected list at
  once. Their data stays in the session. With matchmaking, it also gives up their place in a
  group that is still filling.

See [Handling dropouts](../guides/handling-dropouts) for what each plugin records.

Each tab signs in separately, so two tabs on one computer are two participants. With
`useUidAsParticipantId: true`, a participant who reloads the tab keeps their ID, but the reload
restarted their experiment, so the others keep them `left` and their own page sees
`previousInstance` (see [Rejoining](../guides/handling-dropouts#rejoining)). Without it, a reload
joins as a new participant.

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
      push_data: { status: "ready" },
      wait_for: (group, presence) =>
        Object.values(presence).filter((status) => status === "connected").length >= 2,
      message: "<p>Waiting for another player to join...</p>",
    };

    const start = {
      type: jsPsychHtmlKeyboardResponse,
      stimulus: "<p>Both players are here. Press any key to begin.</p>",
    };

    try {
      await jsPsych.multiplayer.connect(
        new FirebaseAdapter({ firebaseConfig, useUidAsParticipantId: true }),
      );
    } catch (error) {
      // A wrong config, missing rules, or no network ends up here.
      document.body.textContent = `Could not connect: ${error.message}`;
      throw error;
    }
    await jsPsych.run([lobby, start]);
  </script>
</html>
```
