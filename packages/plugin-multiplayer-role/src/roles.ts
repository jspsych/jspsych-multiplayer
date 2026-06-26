/**
 * Pure, jsPsych-independent core for `plugin-multiplayer-role`.
 *
 * Everything here is a pure function over a group-session snapshot — no I/O, no jsPsych, no network.
 * The plugin wrapper (index.ts) supplies the snapshot and the readiness gate; this module owns the
 * deterministic-consensus logic that every client must compute identically. See
 * docs/role-assignment-plugin-plan.md for the full design rationale.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. */
export type Snapshot = Record<string, any>;

/** `group` is reserved for future partitioning/matching; v1 populates only `role`. */
export interface RoleAssignment {
  role: string;
  group?: number;
}

export type RoleMap = Record<string, RoleAssignment>;

/** Context passed to ranking/lookup/custom strategies so they can reach round-scoped data. */
export interface Ctx {
  ids: string[];
  round: number;
  seed: string;
}

export interface AssignOptions {
  /** `["proposer","responder"]` or `{ leader: 1, follower: 3 }`. */
  roles: string[] | Record<string, number>;
  strategy?: "join_order" | "random" | "rotate" | ((s: Snapshot, ctx: Ctx) => RoleMap);
  /** Shared seed for "random"; defaults to a hash of the sorted ids + round. */
  seed?: string;
  /** Round index, for "rotate" / per-round "random". */
  round?: number;
  /** For "rotate": use a balanced (Latin-square) rotation instead of a simple shift. */
  balanced?: boolean;
  /** Ordering key for attribute/outcome ranking. Entry is whole; read round data at entry.rounds[ctx.round]. */
  rankBy?: (entry: any, id: string, ctx: Ctx) => number;
  /** Direct lookup: the role *is* this value. Must return one of the declared roles. */
  roleFrom?: (entry: any, id: string, ctx: Ctx) => string;
  /** Role for participants beyond the declared slots; if unset, overflow throws. */
  overflowRole?: string;
}

/**
 * Expand a role spec into a flat list of slots, one per participant.
 *   ["proposer","responder"]   -> ["proposer","responder"]
 *   { leader: 1, follower: 3 } -> ["leader","follower","follower","follower"]
 */
export function expandSlots(roles: AssignOptions["roles"]): string[] {
  if (Array.isArray(roles)) return [...roles];
  return Object.entries(roles).flatMap(([role, n]) => Array(n).fill(role));
}

/** Deterministic string hash (cyrb53-style mix) so "random" is identical on every client. */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/**
 * Rotation offset for `rotate` with `balanced: true`, following a Williams-design Latin square.
 *
 * Plain `rotate` shifts the base order by `round`, so consecutive rounds always shift by 1 and every
 * participant walks the roles in the same ±1 cyclic order. The balanced variant instead shifts by the
 * round'th term of a balanced (Williams) sequence — 0, n-1, 1, n-2, 2, … — which makes the whole
 * group's role-to-role transitions carryover-balanced: over n rounds each role is immediately
 * preceded by every other role equally often. That balance is exact when n is even; a single square
 * cannot fully balance odd n (the classic Williams caveat). The per-round frequency guarantee — each
 * participant holds each role exactly once per n rounds — holds for all n, same as plain rotate.
 *
 * Pure in (n, round) so every client computes the same offset (the consensus property).
 */
export function balancedRotationShift(n: number, round: number): number {
  if (n <= 0) return 0;
  const k = ((round % n) + n) % n;
  // k-th term of the balanced starting sequence 0, n-1, 1, n-2, 2, …
  return k % 2 === 0 ? k >> 1 : n - 1 - (k >> 1);
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

/** Deterministic, consensus-consistent ordering of participants for a string-preset strategy. */
function orderParticipants(snapshot: Snapshot, opts: AssignOptions, ctx: Ctx): string[] {
  // CRITICAL: always start from a stable, identical base on every client.
  const ids = Object.keys(snapshot).sort();

  if (opts.rankBy) {
    return [...ids].sort(
      (a, b) =>
        opts.rankBy!(snapshot[b], b, ctx) - opts.rankBy!(snapshot[a], a, ctx) || a.localeCompare(b)
    );
  }

  switch (opts.strategy ?? "join_order") {
    case "join_order":
      // Reflects pushed `joinedAt` (subject to per-client clocks) but is consensus-consistent because
      // every client reads the same pushed values. Falls back to id order if joinedAt is absent.
      return [...ids].sort(
        (a, b) => (snapshot[a]?.joinedAt ?? 0) - (snapshot[b]?.joinedAt ?? 0) || a.localeCompare(b)
      );
    case "rotate": {
      const base = [...ids];
      const n = base.length;
      if (n === 0) return base;
      // Plain rotate shifts by the round; `balanced` shifts by the Williams-sequence term instead,
      // which counterbalances role-to-role carryover across the group (see balancedRotationShift).
      const k = opts.balanced ? balancedRotationShift(n, ctx.round) : ((ctx.round % n) + n) % n;
      return base.slice(k).concat(base.slice(0, k));
    }
    case "random": {
      const seed = opts.seed ?? `${ids.join("|")}#${ctx.round}`; // shared seed, per round, no coordinator
      const rnd = mulberry32(hashSeed(seed));
      const arr = [...ids]; // Fisher–Yates with the shared PRNG
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    default:
      return ids;
  }
}

/**
 * Deterministically map a group snapshot to roles. Same snapshot + options -> same map on every
 * client (this is the property the whole plugin exists to guarantee).
 */
export function assignRoles(snapshot: Snapshot, opts: AssignOptions): RoleMap {
  const ids = Object.keys(snapshot).sort();
  const ctx: Ctx = { ids, round: opts.round ?? 0, seed: opts.seed ?? "" };

  // Full custom strategy: caller owns everything (and the consensus burden).
  if (typeof opts.strategy === "function") {
    return opts.strategy(snapshot, ctx);
  }

  // Direct lookup: the role IS a value each participant carries.
  if (opts.roleFrom) {
    const declared = new Set(expandSlots(opts.roles));
    const map: RoleMap = {};
    for (const id of ids) {
      const role = opts.roleFrom(snapshot[id], id, ctx);
      if (!declared.has(role)) {
        throw new Error(
          `assignRoles: role_from returned "${role}" for ${id}, which is not a declared role ` +
            `(${[...declared].join(", ")}).`
        );
      }
      map[id] = { role };
    }
    return map;
    // NOTE: role_from does NOT enforce per-role counts. If you need "exactly one leader", validate
    // separately or use a slot-based strategy.
  }

  const ordered = orderParticipants(snapshot, opts, ctx);
  const slots = expandSlots(opts.roles);
  const map: RoleMap = {};
  ordered.forEach((id, i) => {
    if (i < slots.length) {
      map[id] = { role: slots[i] };
    } else if (opts.overflowRole != null) {
      map[id] = { role: opts.overflowRole };
    } else {
      throw new Error(
        `assignRoles: ${ordered.length} participants but only ${slots.length} role slots; ` +
          `set overflowRole to handle extras.`
      );
    }
  });
  return map;
}
