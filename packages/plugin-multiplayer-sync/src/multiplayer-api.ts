/**
 * Local, structural mirror of the jsPsych multiplayer API surface this plugin uses.
 *
 * The real API is `MultiplayerAPI`, which jsPsych flattens onto `jsPsych.pluginAPI`
 * (packages/jspsych/src/modules/plugin-api/index.ts). It ships in jsPsych core via
 * https://github.com/jspsych/jsPsych/pull/3694, which is not yet released — so the published
 * `jspsych` type for `pluginAPI` does not carry these members. Rather than take a build-time
 * dependency on an unmerged fork, the plugin codes against this minimal interface and reaches the
 * real object with one cast (`pluginAPI as unknown as MultiplayerApiLike`). The cast is the single
 * seam to re-verify once #3694 lands; the method shapes here were copied from that PR's
 * `MultiplayerAPI` and confirmed against its ultimatum-game examples.
 *
 * Only the members this plugin actually calls are declared (`push`, `getAll`, `wait`). Mock-based
 * tests implement this same interface, so the plugin is exercised end-to-end with no live group
 * session.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches the API's `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

export interface MultiplayerApiLike {
  /** Write this participant's data into the shared group session. */
  push(data: Record<string, unknown>): Promise<void>;

  /** Read the full current group session (all participants). */
  getAll(): GroupSessionData;

  /**
   * Resolve with the group snapshot once `condition` returns true (fast-path if already true);
   * reject if `timeout` ms elapse first. `undefined` timeout waits forever.
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
