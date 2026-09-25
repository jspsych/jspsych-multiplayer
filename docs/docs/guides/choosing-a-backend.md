---
id: choosing-a-backend
title: Choosing a backend
sidebar_label: Choosing a backend
description: Local, JATOS or Firebase — what each needs, what each can do, and when to use it.
---

# Choosing a backend

The backend, or **adapter**, decides where the shared data lives and how it travels between
participants. You choose one per experiment and connect it in one line, before the timeline
runs:

```js
async function runExperiment() {
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal());
  await jsPsych.run(timeline);
}

runExperiment();
```

Nothing else in the experiment depends on which adapter you chose. So the usual path is to
build and test with the local adapter in a few browser tabs, then switch to JATOS or Firebase
to collect data.

## At a glance

| | [Local](../reference/adapter-multiplayer-local) | [JATOS](../reference/adapter-multiplayer-jatos) | [Firebase](../reference/adapter-multiplayer-firebase) |
| --- | --- | --- | --- |
| Participants on different computers | **no** | yes | yes |
| For real data collection | **no** | yes | yes |
| Server you run | none | a JATOS server | none (Google hosts it) |
| Setup | none | a JATOS group study | a Firebase project and its security rules |
| Who forms groups | you, by sharing a link | JATOS | you, by sharing a link, or the adapter with `matchmaking` |
| Shared data capacity | about 5 MB for the whole group (browser `localStorage`) | the JATOS group session's limit, set by your JATOS server | 128 KB per participant with the recommended rules (can be raised) |
| Cost | free | your server | free tier, then pay per use |
| Recruitment and data storage | — | built into JATOS | yours to arrange |
| Use it for | building, testing, demos | labs that already run JATOS | cross-device studies without a server |

## How much data each backend holds

Every write sends all of a participant's shared data, including what they wrote in earlier
trials, and it stays there until the session ends. So a long study that shares a lot, such as
many rounds of chat or drawing, can run into a backend's limit. When a write is too large, the
backend rejects it, and none of that participant's later writes reach the group either.

- **Local** keeps the whole group's data in the browser's `localStorage`, which holds about
  5 MB per site. That is plenty for testing.
- **JATOS** keeps the whole group's data in one JATOS group session. The size limit is part of
  the JATOS server's configuration; ask your JATOS administrator before running a long study.
- **Firebase** allows each participant up to 128 KB with the adapter's recommended security
  rules. You can raise the limit in your rules; Firebase itself allows several megabytes.

Most studies share only choices, scores, and short messages and stay far below these limits.
Keep response times and full trial records in jsPsych's own data, which is not shared. See
[How much data you can share](../reference/multiplayer-api#how-much-data-you-can-share).

## Local: for building and testing

[`adapter-multiplayer-local`](../reference/adapter-multiplayer-local) shares data between tabs
of **one browser on one computer**. It cannot connect participants on different computers, so
it is never the backend for a real study.

It is the fastest way to develop: no server, no account, instant reloads. Every example and
guide on this site uses it. Open one tab per participant, and copy the page address, including
its `?mp_session=…`, from the first tab into the others.

## JATOS: if your lab runs JATOS

[`adapter-multiplayer-jatos`](../reference/adapter-multiplayer-jatos) runs the experiment as a
[JATOS](https://www.jatos.org/) group study. You get cross-device sessions, and recruitment and
data storage in the system you already use for other studies.

The cost is the server: someone has to install JATOS, keep it secure and keep it running. If
nobody in your lab can do that, use Firebase.

```js
jatos.onLoad(async () => {
  const jsPsych = initJsPsych({
    on_finish: () => jatos.endStudy(jsPsych.data.get().json()),
  });
  await jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos());
  await jsPsych.run(timeline);
});
```

JATOS forms the groups. When a group is full, the adapter seals it and makes sure every member
sees the seal and the same final roster, so `jsPsych.multiplayer.waitForGroup()` works as a
waiting room (see [Forming groups](forming-groups)). How long to wait for the connection, or
for a dropped connection to come back, is set with jsPsych's own `connectTimeout` and
`reconnectTimeout` options to `connect()`.

## Firebase: cross-device without a server

[`adapter-multiplayer-firebase`](../reference/adapter-multiplayer-firebase) keeps the shared
data in a Google Firebase Realtime Database. You create a free Firebase project, paste its
configuration into your experiment, and deploy the security rules that come with the package.
Small studies usually stay within the free tier.

Three things to plan for:

- **Choose how groups form.** By default, everyone who opens the experiment with the same
  `?mp_session=` value in the address is in the same group, so each group needs its own link.
  With the adapter's `matchmaking` option, everyone opens one link and the adapter fills
  groups as participants arrive, as JATOS does. Either way,
  `jsPsych.multiplayer.waitForGroup()` holds matched participants in a waiting room until their
  group is full (see [Forming groups](../reference/adapter-multiplayer-firebase#forming-groups)).
- **The configuration is public.** Anyone can read it from your experiment's page. The
  security rules are what protect the data, so always deploy them. The rules let each
  participant write only their own data: every connection claims its participant ID, and only
  that sign-in can write it. If you used an earlier version of the adapter, deploy the new
  rules from the [adapter's page](../reference/adapter-multiplayer-firebase#deploy-the-security-rules);
  the old ones don't work with it (see [Upgrading from 0.x](upgrading)).
- **Recruitment and saving the jsPsych data are up to you.** Firebase only carries the shared
  data between participants. Save each participant's jsPsych data the way you would in a
  single-player study, for example with [DataPipe](https://pipe.jspsych.org/).

## Before you collect data

Whichever backend you choose, test with two **different computers** before launching. The
local adapter is nearly instant; a real network adds delay, and that is when timing problems
and missed dropouts show up.

## Other backends

An adapter is a small object with a handful of methods, so connecting to another backend, such as your
lab's own WebSocket server, does not require changing any experiment code. See [The adapter
interface](../reference/multiplayer-api#the-adapter-interface).
