---
"@jspsych-multiplayer/plugin-multiplayer-chat": minor
---

Add `plugin-multiplayer-chat`, a real-time chat-room trial for the jsPsych multiplayer API.

It is the first plugin built on the API's real-time `subscribe` primitive rather than the `push → wait` barrier used by `plugin-multiplayer-sync`: the trial stays open, subscribes to the shared group session, renders the merged transcript of every participant's messages, and lets this participant send messages. It ends on any configured condition — a `duration` timeout, an `end_button_label` click, or an `end_when` predicate over the group session — and stores the transcript this client saw in the trial data. Message text is rendered as text (never HTML), and because the API's `push` replaces a participant's slot, sending reads the client's own slot first so other pushed data (e.g. a role) is preserved. Built against a local interface mirroring the multiplayer API so it carries no build-time dependency on the unreleased core (jsPsych#3694); a pure `chat-core` module (message merge/sort/dedup) is unit-tested in isolation, and the trial is exercised against an in-memory mock that fires subscribers on every push.
