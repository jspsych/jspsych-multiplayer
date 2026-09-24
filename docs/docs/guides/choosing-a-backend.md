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
jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerLocal()).then(() => {
  jsPsych.run(timeline);
});
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
| Who forms groups | you, by sharing a link | JATOS | you, by sharing a link |
| Cost | free | your server | free tier, then pay per use |
| Recruitment and data storage | — | built into JATOS | yours to arrange |
| Use it for | building, testing, demos | labs that already run JATOS | cross-device studies without a server |

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
jatos.onLoad(() => {
  const jsPsych = initJsPsych({
    on_finish: () => jatos.endStudy(jsPsych.data.get().json()),
  });
  jsPsych.multiplayer.connect(new jsPsychAdapterMultiplayerJatos()).then(() => {
    jsPsych.run(timeline);
  });
});
```

## Firebase: cross-device without a server

[`adapter-multiplayer-firebase`](../reference/adapter-multiplayer-firebase) keeps the shared
data in a Google Firebase Realtime Database. You create a free Firebase project, paste its
configuration into your experiment, and deploy the security rules that come with the package.
Small studies usually stay within the free tier.

Three things to plan for:

- **You form the groups.** Everyone who opens the experiment with the same `?mp_session=`
  value in the address is in the same group, so each group needs its own link. JATOS, by
  contrast, puts arriving participants into groups for you.
- **The configuration is public.** Anyone can read it from your experiment's page. The
  security rules are what protect the data, so always deploy them.
- **Recruitment and saving the jsPsych data are up to you.** Firebase only carries the shared
  data between participants. Save each participant's jsPsych data the way you would in a
  single-player study, for example with [DataPipe](https://pipe.jspsych.org/).

## Before you collect data

Whichever backend you choose, test with two **different computers** before launching. The
local adapter is nearly instant; a real network adds delay, and that is when timing problems
and missed dropouts show up.

## Other backends

An adapter is a small object with four methods, so connecting to another backend, such as your
lab's own WebSocket server, does not require changing any experiment code. See [The adapter
interface](../reference/multiplayer-api#the-adapter-interface).
