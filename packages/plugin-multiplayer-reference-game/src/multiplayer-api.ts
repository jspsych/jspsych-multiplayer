/**
 * Local, structural mirror of the jsPsych multiplayer API surface this plugin uses.
 *
 * The real API is `MultiplayerAPI`, which jsPsych core exposes as its own `jsPsych.multiplayer`
 * module. It ships via https://github.com/jspsych/jsPsych/pull/3694, which is not yet released — so
 * the published `jspsych` types carry no such module. Rather than take a build-time dependency on an
 * unmerged fork, the plugin codes against this minimal interface and reaches the real object through
 * `resolveMultiplayerApi()` (below).
 *
 * Like the chat room (and unlike the barrier-based `plugin-multiplayer-sync`), the reference game is
 * a continuously-open trial, so it declares **`subscribe`** — the real-time primitive — plus
 * `participantId` and `get`, which read this client's own slot (the chat history to seed from, the
 * earlier rounds to carry forward). Writes go through **`update`**, which merges just the one key
 * into the slot instead of replacing it (`push` REPLACES the whole slot; see `chat-core.ts`).
 * `wait` is not declared: the end condition (the matcher's submitted assignment) is evaluated inside
 * the single subscription callback, so this plugin has no wait that a cancellation
 * (`cancelAllSubscriptions()`, `disconnect()`, `abortExperiment()`) could reject.
 *
 * Mock-based tests implement this same interface, so the plugin is exercised end-to-end with no live
 * group session.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** Calling this removes the associated subscription. */
export type Unsubscribe = () => void;

export interface MultiplayerApiLike {
  /** This participant's id within the group. Read-only: `null` until `connect()` resolves and after `disconnect()`. */
  readonly participantId: string | null;

  /** Read one participant's slot. `undefined` if they haven't pushed yet. Returns a JSON copy; throws when not connected. */
  get(participantId: string): Record<string, unknown> | undefined;

  /**
   * Write this participant's data into the shared group session. REPLACES this participant's slot
   * (it does not merge) — use `update()` to merge keys into the slot instead. Rejects, rather than
   * throwing synchronously, when the API is not connected.
   */
  push(data: Record<string, unknown>): Promise<void>;

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
   * Fire `callback` on every group-session update, plus once immediately with the current snapshot.
   * Each callback gets its own JSON copy. Returns an unsubscribe function. jsPsych cancels all
   * subscriptions when the experiment ends or is aborted, but a trial must still unsubscribe itself
   * when the trial finishes. Throws when not connected.
   */
  subscribe(callback: (data: GroupSessionData) => void): Unsubscribe;
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
