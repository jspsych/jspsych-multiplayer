/**
 * Pure, jsPsych-independent core for `plugin-multiplayer-match`.
 *
 * Everything here is a pure function over a group-session snapshot — no I/O, no jsPsych, no network.
 * The plugin wrapper (index.ts) supplies the snapshot and the readiness gate; this module owns the
 * deterministic-consensus partition: given the same snapshot and options, EVERY client computes the
 * byte-identical set of match groups (same members, same order), so each participant learns its
 * partners locally with no coordinator and no extra round-trip — exactly the property
 * `plugin-multiplayer-role` relies on for role assignment.
 *
 * The ordering/hash/PRNG helpers are copied from the role plugin's `roles.ts` so this package is
 * self-contained (the repo's per-package mirror convention); they must stay behaviourally identical
 * for the consensus guarantee.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. */
export type Snapshot = Record<string, any>;

/** One participant's match assignment. */
export interface MatchAssignment {
  /** Zero-based index of the group this participant belongs to. */
  group: number;
  /** All members of this participant's group, in consensus order (includes this participant). */
  members: string[];
  /** The other members of the group (everyone in `members` except this participant). */
  partners: string[];
  /** This participant's zero-based position within `members` (e.g. 0 = first seat, for role-within-pair). */
  position: number;
}

/** participantId -> assignment. Participants left unmatched (see `leftover: "spectator"`) are absent. */
export type MatchMap = Record<string, MatchAssignment>;

export interface MatchOptions {
  /** Members per group. Default 2 (dyads). Must be an integer >= 2. */
  groupSize?: number;
  /**
   * How participants are ordered before being chunked into groups:
   *   - `"ordered"` (default): by participantId (stable, arbitrary-but-consistent pairings).
   *   - `"join_order"`: by pushed `joinedAt`, then id.
   *   - `"random"`: a seeded Fisher–Yates shuffle. The seed defaults to a hash of the sorted ids +
   *     `round`, so pairings are unpredictable-by-id yet identical on every client, and change each
   *     round (increment `round` to re-pair).
   */
  strategy?: "ordered" | "join_order" | "random";
  /** Shared seed for `"random"`; defaults to `${sortedIds}#${round}`. */
  seed?: string;
  /** Round index, for per-round `"random"` re-pairing. */
  round?: number;
  /**
   * What to do when the participant count is not a multiple of `groupSize`:
   *   - `"error"` (default): throw (fail loud) — the caller must supply a divisible group.
   *   - `"spectator"`: the trailing leftover participants are left unmatched (absent from the map).
   *   - `"smaller_group"`: the trailing leftovers form one final, undersized group.
   */
  leftover?: "error" | "spectator" | "smaller_group";
}

/**
 * Compare ids by UTF-16 code unit, the SAME order as `Array.prototype.sort()` with no comparator.
 * Used as the universal tie-break so ordering never depends on the runtime's locale/collation
 * (`localeCompare` is locale- and ICU-version-dependent, which would let two clients order tied ids
 * differently and compute divergent partitions — breaking the consensus guarantee).
 */
export function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic string hash (cyrb53-style mix) so `"random"` is identical on every client. */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32). Same seed -> same sequence on every client. */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic, consensus-consistent ordering of participants before they are chunked into groups. */
function orderParticipants(snapshot: Snapshot, opts: MatchOptions): string[] {
  // CRITICAL: always start from a stable, identical base on every client.
  const ids = Object.keys(snapshot).sort(byId);
  const round = opts.round ?? 0;

  switch (opts.strategy ?? "ordered") {
    case "join_order":
      // Reflects pushed `joinedAt` (subject to per-client clocks) but is consensus-consistent because
      // every client reads the same pushed values. Falls back to id order when joinedAt is absent.
      return [...ids].sort(
        (a, b) => (snapshot[a]?.joinedAt ?? 0) - (snapshot[b]?.joinedAt ?? 0) || byId(a, b)
      );
    case "random": {
      const seed = opts.seed ?? `${ids.join("|")}#${round}`; // shared seed, per round, no coordinator
      const rnd = mulberry32(hashSeed(seed));
      const arr = [...ids]; // Fisher–Yates with the shared PRNG
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    case "ordered":
    default:
      return ids;
  }
}

/**
 * Deterministically partition a group snapshot into matched sub-groups. Same snapshot + options ->
 * same map on every client (the property the whole plugin exists to guarantee).
 */
export function buildMatches(snapshot: Snapshot, opts: MatchOptions = {}): MatchMap {
  const groupSize = opts.groupSize ?? 2;
  if (!Number.isInteger(groupSize) || groupSize < 2) {
    throw new Error(
      `buildMatches: groupSize must be an integer >= 2 (got ${groupSize}). Use 2 for dyads, 3 for triads, etc.`
    );
  }
  // Validate the string enums up front rather than letting an unknown value fall through to a silent
  // default: an unknown `strategy` would otherwise order as "ordered", and an unknown `leftover` would
  // slip past both the "error" throw and the "spectator" break below and silently act like
  // "smaller_group" — producing unintended undersized groups with no signal.
  const strategy = opts.strategy ?? "ordered";
  if (strategy !== "ordered" && strategy !== "join_order" && strategy !== "random") {
    throw new Error(
      `buildMatches: unknown strategy "${strategy}" — use "ordered", "join_order", or "random".`
    );
  }
  const leftover = opts.leftover ?? "error";
  if (leftover !== "error" && leftover !== "spectator" && leftover !== "smaller_group") {
    throw new Error(
      `buildMatches: unknown leftover "${leftover}" — use "error", "spectator", or "smaller_group".`
    );
  }

  const ordered = orderParticipants(snapshot, opts);
  const n = ordered.length;
  const remainder = n % groupSize;

  if (remainder !== 0 && leftover === "error") {
    throw new Error(
      `buildMatches: ${n} participants is not a multiple of groupSize ${groupSize}. Ensure a ` +
        `divisible group, or set leftover to "spectator" (leave extras unmatched) or ` +
        `"smaller_group" (put extras in one undersized group).`
    );
  }

  const map: MatchMap = {};
  let group = 0;
  for (let i = 0; i < n; i += groupSize) {
    const members = ordered.slice(i, i + groupSize);
    // A short trailing chunk is the leftover: under "spectator" the extras stay unmatched (absent
    // from the map); under "smaller_group" they form one final, undersized group. ("error" already
    // threw above, so any short chunk here is a deliberate policy.)
    if (members.length < groupSize && leftover === "spectator") break;
    members.forEach((id, position) => {
      map[id] = {
        group,
        members,
        partners: members.filter((m) => m !== id),
        position,
      };
    });
    group++;
  }
  return map;
}
