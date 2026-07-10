/**
 * Local, structural mirror of the jsPsych multiplayer API surface this plugin uses.
 *
 * The real API is `MultiplayerAPI`, which jsPsych flattens onto `jsPsych.pluginAPI`. It ships in
 * jsPsych core via https://github.com/jspsych/jsPsych/pull/3694, which is not yet released — so the
 * published `jspsych` type for `pluginAPI` does not carry these members. Rather than take a
 * build-time dependency on an unmerged fork, the wrapper codes against this minimal interface and
 * reaches the real object with one cast (`pluginAPI as unknown as MultiplayerApiLike`). The cast is
 * the single seam to re-verify once #3694 lands.
 *
 * Like `plugin-multiplayer-role`, matching is a barrier-then-compute trial: it pushes this client's
 * `joinedAt`/round data, waits (via `communicate` = push + `wait`) until the group is ready, then
 * partitions the resolved snapshot. It declares `participantId`/`get`/`push`/`getAll`/`wait`/
 * `communicate`. Mock-based tests implement this same interface, so the wrapper is exercised
 * end-to-end with no live group session.
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
   * reject if `timeout` ms elapse first. `undefined` timeout waits forever.
   */
  wait(condition: (data: GroupSessionData) => boolean, timeout?: number): Promise<GroupSessionData>;

  /** Convenience: push `data`, then `wait(condition, timeout)`. One promise so one `.catch` covers both. */
  communicate(
    data: Record<string, unknown>,
    condition: (data: GroupSessionData) => boolean,
    timeout?: number
  ): Promise<GroupSessionData>;
}
