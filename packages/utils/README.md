# @jspsych-multiplayer/utils

Shared helpers for plugins and adapters built on the jsPsych multiplayer API (`jsPsych.multiplayer`), including an opt-in round coordinator for experiment authors.

## Fixed-authority rounds (prototype)

`createRoundCoordinator<T>(multiplayer, { authorityId, members, roundIndex, deadlines, validate, signal? })`
returns a `RoundCoordinator<T>`. This prototype supports exactly two fixed participants.
Both clients must use the same configuration and payload validator. `roundIndex` is a unique
nonnegative integer within the session and authority; reusing an own round record throws.
Deadlines are positive milliseconds: `response`, `preparation`, `receipt`, `feedback`, `write`.
The first result is immutable; only the authority may submit a validated JSON payload.

| Handle member | Meaning |
| --- | --- |
| `state` | Frozen snapshot with `roundId`, `phase`, `revision`, `result`, `failure`, `pendingWrites`. |
| `ready()` | Acknowledge construction; authority activates only after both are ready. |
| `submit(value)` | Authority only. Strictly before expiry selects; at expiry commits timeout. Returns whether committed. |
| `ack("result", id)` | Acknowledge accepting this result. |
| `ack("feedback", id)` | Acknowledge local feedback finish, after receipt. |
| `subscribe(callback)` | Immediate snapshot and later changes; returns unsubscribe. |
| `abort(reason = "cancelled")` | Fail explicitly, retaining any accepted result. |
| `dispose()` | Remove timers/waits/subscriptions; required at handoff or cleanup. |

Phases are `preparing`, `active`, `result`, `complete`, `failed`. Result is
`{ id, kind: "selection" | "timeout", value, rt }`; timeout has null value.
`rt` is authority-local monotonic time from activation, not physical stimulus onset.
Completion requires both result and feedback acknowledgments; consume completion only when
`pendingWrites === 0`. Keep accepted results even if a later acknowledgment/write fails.
The handle scores nothing, and has no renderer, shared clock or authority election.

Cumulative records use separate session keys per `(sessionId, authorityId, roundIndex)`
so core push coalescing can skip phases without losing results or acknowledgments.
Observers can skip active/result snapshots. Preparation, delivery, receipt, feedback and write
confirmation have local bounds. Transport close, departure, cancellation, identity/restart
or a lost record fail explicitly; none becomes a behavioral timeout. A frozen page cannot run
its watchdog until resumed. Partitions may prevent result delivery or agreement on failure reasons.
Protocol sender validation assumes cooperative authenticated participants; this is not a
server-enforced protection against a member forging their own data.

Use the reference-game's [public factory hooks](../plugin-multiplayer-reference-game/README.md#coordinated-rounds-prototype)
to connect the handle to normal plugin scoring, feedback and cleanup. No core or adapter changes
are required by this prototype. Deployment lifecycle checks remain pending.

For local diagnosis, set the handle option `diagnostics: true` (default false).
`state.diagnostics` then contains monotonic timestamps, wall timestamps, configured budgets,
write confirmations, phase transitions, accepted local acknowledgments, observed peer acknowledgment
state and failure details. The existing watchdog records callback gaps of at least 1000ms and
maximum monotonic/wall gaps. Only its actual interval callbacks count as watchdog samples;
subscription-triggered deadline checks do not reset that measure. The last 128 events are retained,
with `droppedEvents` reporting overflow. Diagnostics add no timers or shared transport fields,
do not extend deadlines, and are local observations rather than clock synchronization evidence.

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
