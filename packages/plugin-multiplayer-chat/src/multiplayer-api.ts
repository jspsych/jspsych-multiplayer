/**
 * Local, structural mirror of the jsPsych multiplayer API surface this plugin uses.
 *
 * The real API is `MultiplayerAPI`, which jsPsych flattens onto `jsPsych.pluginAPI`. It ships in
 * jsPsych core via https://github.com/jspsych/jsPsych/pull/3694, which is not yet released — so the
 * published `jspsych` type for `pluginAPI` does not carry these members. Rather than take a
 * build-time dependency on an unmerged fork, the plugin codes against this minimal interface and
 * reaches the real object with one cast (`pluginAPI as unknown as MultiplayerApiLike`). The cast is
 * the single seam to re-verify once #3694 lands.
 *
 * Unlike the barrier-based `plugin-multiplayer-sync` (which uses `push`/`getAll`/`wait`), the chat
 * room is a continuously-open trial, so it additionally declares **`subscribe`** — the real-time
 * primitive — plus `participantId` and `get`, which are needed to read this client's own slot and
 * append to it without clobbering other keys (`push` REPLACES the whole slot; see `chat-core.ts`).
 * `wait` is not declared: the end condition is evaluated inside the single subscription callback.
 *
 * Mock-based tests implement this same interface, so the plugin is exercised end-to-end with no live
 * group session.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** Calling this removes the associated subscription. */
export type Unsubscribe = () => void;

export interface MultiplayerApiLike {
  /** This participant's stable identifier within the group session (set by `connect()`). */
  readonly participantId: string;

  /** Read one participant's slot. Returns undefined if they haven't pushed yet. */
  get(participantId: string): Record<string, unknown> | undefined;

  /**
   * Write this participant's data into the shared group session. REPLACES this participant's slot
   * (it does not merge), so callers that want to preserve other keys must read their own slot first
   * and push the whole thing back.
   */
  push(data: Record<string, unknown>): Promise<void>;

  /**
   * Shallow-merge `data` into this participant's own slot, then push the result. Equivalent to
   * `push({ ...get(participantId), ...data })` — use this instead of hand-rolling that
   * get-then-spread-then-push sequence for a top-level-key overwrite.
   */
  update(data: Record<string, unknown>): Promise<void>;

  /** Read the full current group session (all participants). */
  getAll(): GroupSessionData;

  /**
   * Register a callback fired on every group-session update. Returns an unsubscribe function — call
   * it to stop receiving updates. The core API replays the current snapshot on registration.
   */
  subscribe(callback: (data: GroupSessionData) => void): Unsubscribe;
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
