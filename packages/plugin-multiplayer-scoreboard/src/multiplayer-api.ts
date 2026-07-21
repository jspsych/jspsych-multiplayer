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
 * Like `plugin-multiplayer-role`, the end-of-game scoreboard is a barrier-then-render trial: it
 * pushes this client's score once (`push`), then waits (`wait`) until the group is ready — kept as
 * two separate calls so a push failure is distinguishable from a barrier timeout — then computes and
 * renders the final board. It declares `push`/`get`/`getAll`/`wait` — but not `subscribe`; the live
 * standings demo (examples/live-scoreboard-room.html) renders from the pure core plus
 * `pluginAPI.subscribe` directly, without going through this interface.
 *
 * Mock-based tests implement this same interface, so the plugin is exercised end-to-end with no live
 * group session.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

export interface MultiplayerApiLike {
  /** This participant's id within the group. `null` until the adapter has connected. */
  participantId: string | null;

  /** Read one participant's slot. `undefined` if they haven't pushed yet. */
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
   * Resolve with the group snapshot once `condition` returns true (fast-path if already true);
   * reject if `timeout` ms elapse first. `undefined` timeout waits forever.
   */
  wait(condition: (data: GroupSessionData) => boolean, timeout?: number): Promise<GroupSessionData>;
}
