---
id: upgrading
title: Upgrading from 0.x
sidebar_label: Upgrading from 0.x
description: Every change you need to make to an experiment written for the 0.x multiplayer API and packages.
---

# Upgrading from 0.x

Version 1.0 of the multiplayer API and of the packages in this repository changes a few names
and one important behavior: **each trial now has its own shared data**. This page lists
everything an experiment written for 0.x may need to change. Work through it from top to
bottom; most experiments need only the first few sections.

## Each trial has its own shared data

In 0.x, every participant had one slot that all trials read and wrote. In 1.0, the shared data
is split into **scopes**. During a trial, reads, writes, subscriptions, and waits use that
trial's own scope, so data written in one trial is not visible in the next one. Data that must
last the whole session goes in the **session scope**. See
[Scopes](../reference/multiplayer-api#scopes).

What to change:

- **Values a later trial reads.** If one trial writes something (a nickname, a group, a
  condition) that a later trial reads from the shared data, write and read it with
  `{ scope: "session" }`:

  ```js
  await jsPsych.multiplayer.update({ nickname }, { scope: "session" });
  jsPsych.multiplayer.get(partnerId, { scope: "session" })?.nickname;
  ```

  Or read the earlier result from jsPsych's own data, where the plugins record it.
- **Trials whose participants run different timelines.** Participants share a trial's scope
  because the scope is named after the trial's position in the timeline. If two participants
  reach the "same" step through different trials (for example, a proposer's and a responder's
  trials in separate conditional timelines), give those trials the same `multiplayer_scope`.
  For a trial that repeats, build the name from a timeline variable so each repetition gets a
  new scope. See [Naming a scope](../reference/multiplayer-api#naming-a-scope-with-multiplayer_scope).
- **"Carry forward" fields.** In 0.x, a sync trial's `push_data` replaced the whole slot, so every
  push had to repeat fields such as `joinedAt`. Remove those extra fields: nothing a plugin does
  replaces your data any more, and `joinedAt` now lives in the session scope.
- **Per-trial keys.** Parameters whose only job was to keep trials apart are gone (see the
  plugin list below). Each trial's scope already keeps them apart.

## API renames and removals

| 0.x | 1.0 |
| --- | --- |
| `jsPsych.multiplayer.push(data)` | `jsPsych.multiplayer.replace(data)`. Usually you want `update(data)`, which merges. |
| `connect()` resolved with a `MultiplayerSession` | `connect()` resolves with nothing. Call methods on `jsPsych.multiplayer`. |
| `jsPsych.multiplayer.session` | Removed. Use `jsPsych.multiplayer` directly. |
| `jsPsych.multiplayer.previousInstance` | `jsPsych.multiplayer.restarted` (`true` or `false`). |
| `jsPsych.multiplayer.cancelAllSubscriptions()` | Removed. Subscriptions and waits made during a trial end with the trial; session-scope ones end with the experiment. |
| `onParticipantRejoined` option | Removed. A participant who has `left` can no longer come back, so there is nothing to report. |
| `onParticipantRestarted` option | Removed. A participant who reloads counts as `left`, so `onParticipantLeft` is called. |
| `MultiplayerTimeoutError`, `MultiplayerCancelledError`, `MultiplayerParticipantLeftError`, `MultiplayerConnectionClosedError` | One error, `MultiplayerError`, with a `code`: `"timeout"`, `"cancelled"`, `"participant_left"`, `"connection_lost"`, `"not_connected"`, or `"unsupported"`. |
| The reserved `$mp` key (`MULTIPLAYER_RESERVED_KEY`) | Removed. The session's bookkeeping is kept apart from your data, so every key is yours to use. |

Update error checks like this:

```js
// 0.x
if (error.name === "MultiplayerTimeoutError") { /* … */ }

// 1.0
if (error.name === "MultiplayerError" && error.code === "timeout") { /* … */ }
```

## Behavior changes in the API

- **`left` is final.** A participant who reaches `left` stays `left`, even if their connection
  comes back on the same page. The group agrees on who has left. To give participants more
  time to come back, raise `dropoutTimeout`; see [Handling dropouts](handling-dropouts#rejoining).
- **Timeouts must be positive numbers or `null`.** `wait()`, `waitForGroup()`, and `connect()`'s
  timeout options throw a `TypeError` for `0`, a negative number, `NaN`, or a string. Use `null`
  for no limit. (Plugin `timeout` parameters still accept `0` or a negative number to mean no
  limit.)
- **Reads keep working after the session closes.** `getAll()`, `get()`, `presence()`, and
  `group()` return the last state instead of throwing, so you can drop any "safe read" wrappers.
- **`update()` removes keys set to `undefined`.**
- **Group formation.** With a backend that forms groups, reads include only the group's members.

## New connect options

| Option | Default | What it does |
| --- | --- | --- |
| `connectTimeout` | `20000` | How long to wait for the adapter to connect before rejecting with a `timeout` error. Replaces the adapters' own `connectTimeoutMs`. |
| `reconnectTimeout` | `null` | How long this participant's connection may stay `"reconnecting"` before the session gives up. Replaces the JATOS adapter's `closeAfterReconnectingMs`. |
| `recordIds` | `true` | Adds `multiplayer_participant_id` and `multiplayer_session_id` columns to **every** row of jsPsych's data recorded while connected. Set it to `false` if you don't want them. |

## Plugin data: `multiplayer_outcome`

Every plugin that waits on other participants now records how the trial ended in one field,
`multiplayer_outcome`, instead of several true/false fields:

| 0.x field | 1.0 |
| --- | --- |
| `timed_out: true` | `multiplayer_outcome: "timeout"` |
| `partner_left: true` | `multiplayer_outcome: "participant_left"` (`left_participant` still says who) |
| `connection_lost: true` | `multiplayer_outcome: "connection_lost"` |
| `wait_error` | Removed. |
| (none of the above) | `multiplayer_outcome: "completed"` |

The live plugins (chat, draw, reference-game) can also record `"cancelled"`, when the
experiment disconnects during the trial. Update any `on_finish` or `conditional_function` that
checks the old fields:

```js
// 0.x
if (data.partner_left || data.timed_out || data.connection_lost) { /* … */ }

// 1.0
if (data.multiplayer_outcome !== "completed") { /* … */ }
```

## Plugin parameters

| Plugin | Change |
| --- | --- |
| [sync](../reference/plugin-multiplayer-sync) | `push_data` is now `write_data`, and it **merges** into your data instead of replacing it. `participants` now defaults to `null` (depend on the rest of the group); pass `participants: []` to keep ignoring departures, for example in a lobby. `group` is saved only with the new `save_group: true`. |
| [ready](../reference/plugin-multiplayer-ready) | `push_data` is now `write_data`, and it goes to the trial's scope. `data_key` (parameter and data field) removed. The session-wide `ready: true` flag is no longer written. `group` is saved only with the new `save_group: true`. |
| [choice](../reference/plugin-multiplayer-choice) | `data_key` (parameter and data field) removed. |
| [scoreboard](../reference/plugin-multiplayer-scoreboard) | `data_key` (parameter and data field) removed. `display_label`'s second argument is now the session-scope data. A `timeout` of `0` or less now means no limit. |
| [role](../reference/plugin-multiplayer-role) | `push_data` is now `write_data`, and it is no longer nested under `rounds[round]` (read `entry.score`, not `entry.rounds[round].score`). A `timeout` of `0` now means no limit. `joinedAt` is written once, to the session scope. |
| [match](../reference/plugin-multiplayer-match) | `push_data` is now `write_data`. A `timeout` of `0` now means no limit. `joinedAt` is written once, to the session scope. |
| [countdown](../reference/plugin-multiplayer-countdown) | `name` removed: each countdown starts a fresh clock. Give several trials the same `multiplayer_scope` to share one clock. |
| [chat](../reference/plugin-multiplayer-chat) | `data_key` removed: each chat trial starts empty. Give several trials the same `multiplayer_scope` to continue one conversation. `ended_by` now only says which end condition completed the trial. |
| [draw](../reference/plugin-multiplayer-draw) | `data_key` removed: each draw trial starts with a blank canvas. Give several trials the same `multiplayer_scope` to keep one canvas. `ended_by` now only says which end condition completed the trial. |
| [reference-game](../reference/plugin-multiplayer-reference-game) | `data_key` and `typing_key` removed. `ended_by` removed from the data. With `chat_persists`, the chat is kept in the session scope. |

## Adapter options

| Adapter | Change |
| --- | --- |
| [Local](../reference/adapter-multiplayer-local) | `keyPrefix` is now `namespace`. `persistParticipant` now defaults to `true`: a reload keeps the tab's participant ID, and the group sees that participant restart. IDs may not contain `: / . # $ [ ]`. |
| [JATOS](../reference/adapter-multiplayer-jatos) | `connectTimeoutMs` and `closeAfterReconnectingMs` removed; pass `connectTimeout` and `reconnectTimeout` to `jsPsych.multiplayer.connect()` instead. The adapter now tells every member when the group is sealed. |
| [Firebase](../reference/adapter-multiplayer-firebase) | `pathPrefix` is now `namespace`. `connectTimeoutMs` removed; pass `connectTimeout` to `jsPsych.multiplayer.connect()`. `persistParticipant` (new, default `true`) keeps the participant ID across a reload. `sessionBinding` now defaults to `true`. |

## Firebase: deploy the new security rules

The Firebase adapter's security rules changed. Each connection now claims its participant ID,
and only that sign-in can write the participant's data; matchmaking groups are stored
differently. **Deploy the new rules** from the
[adapter's page](../reference/adapter-multiplayer-firebase#deploy-the-security-rules) before
running a study with 1.0; the 0.x rules don't work with it. Matchmaking groups formed by an
earlier version aren't read, so start a new lobby after upgrading.

## Your data files

- Every row now has `multiplayer_participant_id` and `multiplayer_session_id` columns (turn
  them off with `recordIds: false`).
- The multiplayer plugins record `multiplayer_outcome` and `left_participant` in place of the
  old `timed_out`, `partner_left`, `connection_lost`, and `wait_error` fields.
- `data_key` is gone from the ready, choice, and scoreboard data.
- sync and ready save the `group` field only when you set `save_group: true`.
- `group` snapshots hold only what participants wrote in that trial, not data from earlier
  trials.
