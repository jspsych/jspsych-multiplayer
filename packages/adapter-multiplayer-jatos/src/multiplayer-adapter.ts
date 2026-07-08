/**
 * Local, structural mirror of the jsPsych multiplayer *adapter* contract.
 *
 * The real types live in jsPsych core (`packages/jspsych/src/modules/plugin-api/MultiplayerAPI.ts`),
 * shipped via https://github.com/jspsych/jsPsych/pull/3694, which is not yet released — so the
 * published `jspsych` package does not export `MultiplayerAdapter` / `GroupSessionData` /
 * `Unsubscribe` yet. Rather than take a build-time dependency on an unmerged fork, this adapter
 * implements the interface declared here, copied verbatim from that PR's `MultiplayerAPI.ts`. It is
 * the single seam to re-verify once #3694 lands: at that point `implements MultiplayerAdapter` from
 * `jspsych` should typecheck against this same shape.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** Calling this removes the associated subscription. */
export type Unsubscribe = () => void;

/**
 * Contract that any multiplayer network backend must implement. The core MultiplayerAPI calls these
 * methods; adapters handle the network layer. Plugin authors code against MultiplayerAPI and never
 * touch the adapter directly.
 */
export interface MultiplayerAdapter {
  /** Stable identifier for this participant within the group session namespace. */
  readonly participantId: string;

  /** Open the communication channel and establish group membership. */
  connect(): Promise<void>;

  /** Write this participant's data into the shared group session. */
  push(data: Record<string, unknown>): Promise<void>;

  /** Read the full current group session (all participants). */
  getAll(): GroupSessionData;

  /** Read one participant's data. Returns undefined if they haven't pushed yet. */
  get(participantId: string): Record<string, unknown> | undefined;

  /**
   * Register a callback to fire on every group session update.
   * Returns an unsubscribe function — call it to stop receiving updates.
   */
  subscribe(callback: (data: GroupSessionData) => void): Unsubscribe;

  /** Close the channel cleanly. */
  disconnect(): Promise<void>;
}
