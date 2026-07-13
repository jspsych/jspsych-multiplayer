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
 * Like `plugin-multiplayer-chat`, the countdown is a continuously-open trial, so it declares
 * **`subscribe`** — the real-time primitive — to re-resolve the consensus start time whenever a
 * new (lower) timestamp arrives, plus `participantId` and `get` to read this client's own slot and
 * merge the timestamp into it without clobbering other keys (`push` REPLACES the whole slot; see
 * `countdown-core.ts` and the read-own-slot → spread → push rule). `wait` is not declared: there is
 * no group barrier — each client ends when its own derived time hits the duration.
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

  /** Read the full current group session (all participants). */
  getAll(): GroupSessionData;

  /**
   * Register a callback fired on every group-session update. Returns an unsubscribe function — call
   * it to stop receiving updates. The core API replays the current snapshot on registration.
   */
  subscribe(callback: (data: GroupSessionData) => void): Unsubscribe;
}
