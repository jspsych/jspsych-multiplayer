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

The adapter does not put participants into groups. Everyone who opens the experiment with the
same `?mp_session=` value in the address is in the same group, so you hand each group its own
link. See [Choosing a backend](../guides/choosing-a-backend) for how it compares with JATOS.

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
| `sessionId` | `string` | the `?mp_session=` URL parameter, or a new random ID | Which session (group) to join. If the URL has no `mp_session` parameter, the adapter makes a new ID and adds it to the URL. |
| `participantId` | `string` | a new random ID | This participant's ID. Cannot be combined with `useUidAsParticipantId`. |
| `useUidAsParticipantId` | `boolean` | `false` | Use the participant's anonymous Firebase sign-in ID as their participant ID. The recommended security rules require this. |
| `sessionBinding` | `boolean` | same as `useUidAsParticipantId` | Record which session this participant joined, so the recommended rules can keep them out of every other session. Set it to `false` with the prototyping rules, which do not allow that record. |
| `pathPrefix` | `string` | `"mp-sessions"` | Where in the database the adapter stores its data. If you change it, rename the three top-level entries in your security rules to match. |
| `connectTimeoutMs` | `number` | `20000` | How long, in ms, `connect()` waits for the first data from the database before it fails. |
| `backend` | `FirebaseBackend` | the real Firebase SDK | A stand-in database for automated tests. |

`sessionId`, `participantId`, and `pathPrefix` cannot be empty or contain `.`, `#`, `$`, `[`, `]`,
`/`, or `:`. Once `connect()` resolves, this participant's ID is in
`jsPsych.multiplayer.participantId`.

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
joined, and store at most 128 KB each. They need `useUidAsParticipantId: true`.

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

Anyone who has a session's link can still join that session. Use session IDs that cannot be
guessed (the default random IDs are fine), and share each link only with its group.

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
    }
  }
}
```

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
  once. Their data stays in the session.

See [Handling dropouts](../guides/handling-dropouts) for what each plugin records.

Each tab signs in separately, so two tabs on one computer are two participants. With
`useUidAsParticipantId: true`, a participant who reloads the tab keeps their ID, but the reload
restarted their experiment, so the others keep them `left` and their own page sees
`previousInstance` (see [Rejoining](../guides/handling-dropouts#rejoining)). Without it, a reload
joins as a new participant.

## Example

A complete page for a two-player lobby, using the recommended rules. Serve it from any web
host, open it, and send the address it shows (with `?mp_session=...`) to the other player.

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
