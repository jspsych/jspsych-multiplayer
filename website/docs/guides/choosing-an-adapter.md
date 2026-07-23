---
id: choosing-an-adapter
title: Choosing an adapter
sidebar_label: Choosing an adapter
sidebar_position: 1
description: Local vs JATOS vs Firebase — what each needs, what each can do, and when to use it.
---

# Choosing an adapter

An **adapter** is the network backend: it decides where the group session actually lives.
You register exactly one, in one line, before `jsPsych.run()`. Everything else in your
experiment — lobbies, roles, barriers, chat — is written against the same
`jsPsych.multiplayer` API regardless of which adapter you chose.

That is the point of the layer: **prototype on one adapter, collect data on another,
without touching experiment logic.**

## The decision table

| | `local` | `jatos` | `firebase` |
| --- | --- | --- | --- |
| Infrastructure you run | none | a JATOS server | none (Google-hosted) |
| Cross-device? | **no** | yes | yes |
| Cross-browser, same machine? | **no** | yes | yes |
| Setup cost | zero | install/administer JATOS | create a project, paste a config |
| Cost | free | server hosting | free tier, then usage-based |
| Participant recruitment | n/a | built into JATOS | bring your own |
| Suitable for real data collection | **no** | yes | yes |
| Use it for | development, tutorials, demos | labs already running JATOS | labs that want cross-device without administering a server |

## `adapter-multiplayer-local`

`localStorage` plus cross-tab signalling (`BroadcastChannel` and the `storage` event).

:::danger Development and demos only
Same-origin, same-browser, same-machine. Two "participants" are two tabs of one browser on
one computer. It cannot connect real participants, and it is not a data-collection backend.
:::

What it is genuinely excellent at is the inner loop: no server, no credentials, no build
step, instant reload. Nearly every example in the repository runs on the local adapter, and both
tutorials use it. Develop your entire game here, then swap the constructor.

Two options matter in practice:

- `persistParticipant: true` — keep this tab's participant ID in `sessionStorage`, so a
  refresh rejoins as the same participant rather than abandoning a ghost slot. Almost
  always what you want while developing.
- The session is identified by the `?mp_session=` URL parameter. A tab without one mints a
  fresh session, which is why joining means **copying the full URL** into the second tab.

## `adapter-multiplayer-jatos`

Maps the group session onto [JATOS](https://www.jatos.org/) group channels.

Choose this if your lab already runs JATOS, or is willing to. You get real cross-device
sessions, participant recruitment and data storage in the same system you already use for
single-player studies, and reconnection handling and optimistic-concurrency retries in the
adapter.

The cost is honest: someone has to install, secure, and keep a JATOS server running. If
that person does not exist, use Firebase.

```js
jatos.onLoad(async () => {
  const jsPsych = initJsPsych({ on_finish: () => jatos.endStudy() });
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
  jsPsych.run(timeline);
});
```

## `adapter-multiplayer-firebase`

Backs the group session with the Firebase Realtime Database.

Choose this for real cross-device data collection with essentially no backend to
administer: create a Firebase project, enable the Realtime Database, paste the config into
your experiment, and deploy the security rules the package ships. Small studies typically
sit inside the free tier.

Two things to plan for:

- **The config is public.** A Firebase web config is not a secret — it is in the page
  source of every experiment. The security rules are what protect the data, so deploy the
  session-locked rules from the package rather than leaving the database open.
- **Recruitment and data export are yours to arrange.** Unlike JATOS, Firebase gives you
  the shared-state backend and nothing else.

## Writing your own

The adapter contract is deliberately small — connect, push, get, getAll, subscribe,
disconnect — so a new backend (a WebSocket server, a lab's existing infrastructure) is a
couple of hundred lines and slots in without any experiment changing. See the
[`jsPsych.multiplayer` reference](/reference/multiplayer-api) for the shape each method
must satisfy.

## Recommended path

1. Build the whole experiment on `local`, in two tabs.
2. Pick `jatos` if you already run JATOS, `firebase` otherwise.
3. Change one constructor. Re-test with two *devices*, since that is the first point at
   which real latency and real clock skew appear.
