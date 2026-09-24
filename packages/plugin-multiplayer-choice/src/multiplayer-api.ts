/**
 * Local, structural mirror of the jsPsych multiplayer API surface this plugin uses.
 *
 * The real API is `MultiplayerAPI`, which jsPsych core exposes as its own `jsPsych.multiplayer`
 * module. It ships via https://github.com/jspsych/jsPsych/pull/3694, which is not yet released — so
 * the published `jspsych` types carry no such module. Rather than take a build-time dependency on an
 * unmerged fork, the plugin codes against this minimal interface and reaches the real object through
 * `resolveMultiplayerApi()` (below) — the single seam to re-verify when the API ships in a release.
 *
 * Like `plugin-multiplayer-sync`, the simultaneous-choice trial is a barrier-then-reveal trial: it
 * collects this participant's pick, writes it once (`update`, which merges the pick into this
 * client's slot instead of replacing the slot as `push` would), then waits (`wait`) until the group
 * has chosen. `subscribe`/`communicate` are not declared: the reveal renders once from the barrier
 * snapshot.
 *
 * Mock-based tests implement this same interface, so the plugin is exercised end-to-end with no live
 * group session.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

export interface MultiplayerApiLike {
  /** This participant's id within the group. Read-only: `null` until `connect()` resolves and after `disconnect()`. */
  readonly participantId: string | null;

  /**
   * Shallow-merge `data` into this participant's slot and push the result. The merge base is this
   * client's last successful write, so it does not depend on when the backend echoes writes back.
   * One write is in flight at a time; calls made meanwhile merge into a single follow-up write
   * (later calls win per key), so updating faster than the backend confirms cannot build a queue.
   * Rejects when the API is not connected.
   */
  update(data: Record<string, unknown>): Promise<void>;

  /** Read the full current group session (all participants). Returns a JSON copy; throws when not connected. */
  getAll(): GroupSessionData;

  /**
   * Resolve with a JSON copy of the group snapshot once `condition` returns true (fast-path if it
   * already is). Rejects with a `MultiplayerTimeoutError` if `timeout` ms elapse first — `null`,
   * `undefined`, negative and non-finite values mean no timeout, while `0` times out at once.
   * Rejects with a `MultiplayerCancelledError` when the wait is cancelled: `cancelAllSubscriptions()`,
   * `disconnect()`, `abortExperiment()`, or the end of `jsPsych.run()`. Rejects, rather than throwing
   * synchronously, when the API is not connected.
   */
  wait(
    condition: (data: GroupSessionData) => boolean,
    timeout?: number | null,
  ): Promise<GroupSessionData>;
}

/**
 * The `name` of the error jsPsych#3694's `wait()` rejects with when `timeout` elapses. Defined once
 * per package — the class itself is not importable here (the published `jspsych` doesn't carry it
 * yet), so the name string is the contract.
 */
export const MULTIPLAYER_TIMEOUT_ERROR_NAME = "MultiplayerTimeoutError";

/**
 * True when `e` is a genuine multiplayer `wait()` timeout, as opposed to any other rejection (a
 * throwing condition predicate, an adapter/backend failure). Matches on `error.name` rather than
 * `instanceof` — that is what the class's own doc recommends, since `instanceof` breaks across
 * duplicate loaded copies of jspsych.
 */
export function isMultiplayerTimeoutError(e: unknown): e is Error {
  return e instanceof Error && e.name === MULTIPLAYER_TIMEOUT_ERROR_NAME;
}

/**
 * The `name` of the error jsPsych#3694's `wait()` rejects with when the wait is cancelled —
 * `cancelAllSubscriptions()`, `disconnect()`, `abortExperiment()`, or the end of `jsPsych.run()`.
 * The class itself is not importable here (the published `jspsych` doesn't carry it yet), so the
 * name string is the contract.
 */
export const MULTIPLAYER_CANCELLED_ERROR_NAME = "MultiplayerCancelledError";

/**
 * True when `e` is a cancelled `wait()`: the trial is being torn down, so the plugin should stop
 * quietly rather than treat it as a timeout or a backend failure. Matches on `error.name` rather
 * than `instanceof`, which breaks across duplicate loaded copies of jspsych.
 */
export function isMultiplayerCancelledError(e: unknown): e is Error {
  return e instanceof Error && e.name === MULTIPLAYER_CANCELLED_ERROR_NAME;
}

/**
 * Reach the multiplayer API on a jsPsych instance.
 *
 * jsPsych#3694 adds this API as jsPsych's own `jsPsych.multiplayer` module. It is not in a
 * released `jspsych`, so the published types don't carry it and it is reached with a cast. Builds
 * that exposed these methods on `jsPsych.pluginAPI` predate the current contract (synchronous
 * throws, no cancellation, uncopied snapshots), so they are no longer supported.
 */
export function resolveMultiplayerApi(jsPsych: unknown): MultiplayerApiLike {
  const instance = jsPsych as { multiplayer?: unknown };
  const api = instance.multiplayer as MultiplayerApiLike | undefined;
  if (!api || typeof api.getAll !== "function") {
    throw new Error(
      "No multiplayer API found on the jsPsych instance. This plugin needs jsPsych core with " +
        "multiplayer support (jsPsych#3694); see https://multiplayer.jspsych.org.",
    );
  }
  return api;
}
