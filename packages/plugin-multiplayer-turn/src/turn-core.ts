/**
 * Pure, jsPsych-independent core for `plugin-multiplayer-turn`.
 *
 * Everything here is a pure function over a group-session snapshot — no I/O, no jsPsych, no network.
 * The plugin wrapper (index.ts) supplies the snapshot; this module owns "whose turn is it": the turn
 * pointer is DERIVED from how many moves have landed, so no separate shared counter is needed and
 * every client agrees on the active player from the same snapshot. Each participant stores its move
 * under the trial's `data_key` as `{ move }`; the active player is the first participant in the turn
 * order that has not yet recorded a move.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** One recorded move (its value is opaque to the core — the experimenter supplies it). */
export interface Move {
  move: unknown;
}

/** One entry of the ordered move history. */
export interface MoveRecord {
  /** The participant who moved. */
  participantId: string;
  /** The move value they submitted. */
  move: unknown;
  /** Their zero-based position in the turn order. */
  position: number;
}

/**
 * Compare ids by UTF-16 code unit, matching `Array.prototype.sort()` with no comparator. Used as the
 * default turn order so it never depends on the runtime's locale/collation (`localeCompare` is
 * locale-dependent, which would let two clients disagree on the order and thus on whose turn it is).
 */
export function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve the turn order from the participant set. `turnOrder` may be an explicit array of ids (used
 * as-is), a function of the id-sorted participants (`(ids) => ids`), or omitted (default: sorted ids).
 * The result must be identical on every client for the turn pointer to agree, so a custom function
 * must be a pure function of its input.
 */
export function resolveTurnOrder(
  participantIds: string[],
  turnOrder?: string[] | ((ids: string[]) => string[])
): string[] {
  const sorted = [...participantIds].sort(byId);
  if (Array.isArray(turnOrder)) return [...turnOrder];
  if (typeof turnOrder === "function") return turnOrder(sorted);
  return sorted;
}

/**
 * Read one participant's recorded move under `dataKey`, or `null` if they have not moved. A slot may
 * exist (the participant pushed other keys) without a move, so the `move` key must be present — even a
 * `null`/`0`/`false` move value counts as "moved" (only the absence of the key is "not moved").
 */
export function readMove(slot: Record<string, unknown> | undefined, dataKey: string): Move | null {
  if (!slot) return null;
  const raw = slot[dataKey];
  if (raw == null || typeof raw !== "object") return null;
  if (!("move" in (raw as object))) return null;
  return { move: (raw as Record<string, unknown>).move };
}

/**
 * The index of the active player in `order`: the first participant that has not yet recorded a move.
 * Equals `order.length` when every player has moved (the sequence is complete). Scanning for the first
 * gap (rather than counting moves) keeps a stray out-of-turn push from advancing the pointer past a
 * player who hasn't actually moved.
 */
export function activeIndex(group: GroupSessionData, dataKey: string, order: string[]): number {
  let i = 0;
  while (i < order.length && readMove(group[order[i]], dataKey)) i++;
  return i;
}

/** True once every player in `order` has recorded a move. */
export function isComplete(group: GroupSessionData, dataKey: string, order: string[]): boolean {
  return activeIndex(group, dataKey, order) >= order.length;
}

/**
 * The ordered move history: the leading run of players (from the front of `order`) that have moved,
 * each tagged with its move value and position. Stops at the first player yet to move, so it reflects
 * the true turn sequence rather than any out-of-turn push.
 */
export function collectMoves(
  group: GroupSessionData,
  dataKey: string,
  order: string[]
): MoveRecord[] {
  const out: MoveRecord[] = [];
  for (let position = 0; position < order.length; position++) {
    const participantId = order[position];
    const m = readMove(group[participantId], dataKey);
    if (!m) break; // the sequence is contiguous from the front; stop at the first gap
    out.push({ participantId, move: m.move, position });
  }
  return out;
}
