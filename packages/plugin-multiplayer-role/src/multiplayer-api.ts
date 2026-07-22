/**
 * Local, structural mirror of the jsPsych multiplayer API surface this plugin uses.
 *
 * The real API is `MultiplayerAPI`, which jsPsych flattens onto `jsPsych.pluginAPI`
 * (packages/jspsych/src/modules/plugin-api/index.ts). It ships in jsPsych core via
 * https://github.com/jspsych/jsPsych/pull/3694, which is not yet released — so the published
 * `jspsych` type for `pluginAPI` does not carry these members. Rather than take a build-time
 * dependency on an unmerged fork, the wrapper codes against this minimal interface and reaches the
 * real object with one cast (`pluginAPI as unknown as MultiplayerApiLike`). The cast is the single
 * seam to re-verify once #3694 lands; the method shapes here were copied from that PR's
 * `MultiplayerAPI` and confirmed against its ultimatum-game examples.
 *
 * Only the members the wrapper actually calls are declared. Mock-based tests implement this same
 * interface, so the wrapper is exercised end-to-end with no live group session.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches the API's `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

export interface MultiplayerApiLike {
  /** This participant's id within the group. `null` until the adapter has connected. */
  participantId: string | null;

  /** Write this participant's data into the shared group session. */
  push(data: Record<string, unknown>): Promise<void>;

  /** Read the full current group session (all participants). */
  getAll(): GroupSessionData;

  /** Read one participant's data. `undefined` if they haven't pushed yet. */
  get(participantId: string): Record<string, unknown> | undefined;

  /**
   * Resolve with the group snapshot once `condition` returns true (fast-path if already true);
   * reject with a `MultiplayerTimeoutError` if `timeout` ms elapse first. A throwing `condition`
   * is treated as a programming error, not a timeout: the promise rejects with the error the
   * predicate threw (whose `name` is therefore NOT `MultiplayerTimeoutError`). `undefined`
   * timeout waits forever.
   */
  wait(condition: (data: GroupSessionData) => boolean, timeout?: number): Promise<GroupSessionData>;
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
 * Reach the multiplayer API on a jsPsych instance.
 *
 * jsPsych#3694 moved this API from `jsPsych.pluginAPI` (where its members were flattened onto
 * jsPsych's general plugin-utility object) to its own `jsPsych.multiplayer` module, and removed the
 * old location rather than aliasing it. Neither spelling is in a released `jspsych`, so the
 * published types carry neither and both are reached with a cast.
 *
 * Preferring `multiplayer` with a `pluginAPI` fallback keeps this package working against both a
 * current preview build and an older one, instead of being stranded by whichever the experiment
 * happens to load. Drop the fallback once #3694 is released.
 */
export function resolveMultiplayerApi(jsPsych: unknown): MultiplayerApiLike {
  const instance = jsPsych as { multiplayer?: unknown; pluginAPI?: unknown };
  const api = (instance.multiplayer ?? instance.pluginAPI) as MultiplayerApiLike | undefined;
  if (!api || typeof api.getAll !== "function") {
    throw new Error(
      "No multiplayer API found on the jsPsych instance. This plugin needs jsPsych core with " +
        "multiplayer support (jsPsych#3694); see https://multiplayer.jspsych.org."
    );
  }
  return api;
}
