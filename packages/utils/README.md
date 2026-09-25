# @jspsych-multiplayer/utils

Shared helpers for plugins and adapters built on the jsPsych multiplayer API (`jsPsych.multiplayer`). Researchers writing experiments don't need this package; the plugins use it.

## For plugins

| Helper | What it does |
| --- | --- |
| `getMultiplayer(jsPsych, packageName)` | Returns `jsPsych.multiplayer`, or throws a clear error on a jsPsych build without it. |
| `isMultiplayerError(e, code?)` | True when `e` is a `MultiplayerError`, with the given `code` if one is passed. Matches by name, so it works across bundles. |
| `outcomeOf(e)` | The `multiplayer_outcome` a trial records for a failed wait (`timeout`, `participant_left`, `connection_lost`, `cancelled`), or `null` for an error to rethrow. |
| `pluginTimeout(value)` | A plugin's `timeout` parameter as milliseconds, or `null` for no limit (plugins treat `null`, `0`, and negative values as no limit). |
| `remainingParticipants(multiplayer)` | The other participants a wait should depend on: the sealed roster minus those who left, or else the others connected now. |
| `sealedGroupSize(multiplayer)` | Members of a sealed group who haven't left, or `null` before the group is sealed. |
| `withoutLeft(ids, presence)` | The IDs whose participants haven't left. |
| `waitForAll(multiplayer, key, { count, participants, timeout, signal })` | Resolves once `count` participants have a value under `key` in the current trial's data. |

Every multiplayer plugin records how its trial ended in `multiplayer_outcome` (`completed`, `timeout`, `participant_left`, `connection_lost`, or `cancelled`), plus `left_participant` when someone left. The `MultiplayerOutcome` type lists the values.

## For adapters

| Helper | What it does |
| --- | --- |
| `sessionIdFromUrl(param?)` | Reads `?mp_session=` (or `param`), or mints one and writes it into the URL so the link can be shared. |
| `tabId(storageKey)` | An ID that survives reloads of this tab, kept in `sessionStorage`. |
| `generateId()` | A random UUID. |
| `validateId(adapterName, label, value)` | Throws unless `value` is an ID every adapter can store: non-empty, without `: / . # $ [ ]`. |
