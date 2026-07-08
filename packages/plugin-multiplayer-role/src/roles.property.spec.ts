/**
 * Property-based tests for the pure consensus core, written dependency-free.
 *
 * The invariants here are the plugin's reason to exist (every client computes the SAME map) and are
 * fully determined by a small, structured input space — group size `n` and `round mod n`, invariant
 * to id values and snapshot key order. So we check them *exhaustively* where it's cheap (every key
 * permutation for n <= 6) and with representative reorderings beyond, rather than sampling. See the
 * design notes for why exhaustive-small-n beats random sampling for these particular properties.
 */
import { AssignOptions, Snapshot, assignRoles } from "./roles";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const idsOf = (n: number) => range(n).map((i) => `p${i}`);
const distinctRoles = (n: number) => range(n).map((i) => `role${i}`);
const emptySnapshot = (n: number): Snapshot => Object.fromEntries(idsOf(n).map((id) => [id, {}]));

/** All permutations of `arr`. Only used for small arrays (n <= 6 => <= 720). */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  arr.forEach((x, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

/** Deterministic shuffle, for representative key orderings when exhaustive enumeration is too large. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Client key orderings to test agreement against: exhaustive for small n, representative beyond. */
function keyOrderings(ids: string[]): string[][] {
  if (ids.length <= 6) return permutations(ids);
  return [
    ids,
    [...ids].reverse(),
    [...ids.slice(2), ...ids.slice(0, 2)],
    seededShuffle(ids, 0x9e3779b9),
  ];
}

/** Rebuild a snapshot with its keys in a specific order; each value stays with its own id. */
function withKeyOrder(snapshot: Snapshot, order: string[]): Snapshot {
  return Object.fromEntries(order.map((k) => [k, snapshot[k]]));
}

/**
 * The string-preset / sugar strategies, each as a snapshot + options factory over n distinct roles.
 * `roundSensitive` flags the ones whose output depends on the round (so only those loop over rounds).
 */
interface StrategyCase {
  name: string;
  roundSensitive: boolean;
  snapshot: (n: number) => Snapshot;
  opts: (n: number, round: number) => AssignOptions;
}

const cases: StrategyCase[] = [
  {
    name: "join_order (distinct joinedAt)",
    roundSensitive: false,
    snapshot: (n) => Object.fromEntries(idsOf(n).map((id, i) => [id, { joinedAt: i * 10 }])),
    opts: (n) => ({ roles: distinctRoles(n), strategy: "join_order" }),
  },
  {
    name: "join_order (all joinedAt tied -> id tie-break)",
    roundSensitive: false,
    snapshot: (n) => Object.fromEntries(idsOf(n).map((id) => [id, { joinedAt: 5 }])),
    opts: (n) => ({ roles: distinctRoles(n), strategy: "join_order" }),
  },
  {
    name: "rank_by (distinct scores)",
    roundSensitive: false,
    snapshot: (n) => Object.fromEntries(idsOf(n).map((id, i) => [id, { score: i }])),
    opts: (n) => ({ roles: distinctRoles(n), rankBy: (e) => e.score }),
  },
  {
    name: "rank_by (all scores tied -> id tie-break)",
    roundSensitive: false,
    snapshot: (n) => Object.fromEntries(idsOf(n).map((id) => [id, { score: 1 }])),
    opts: (n) => ({ roles: distinctRoles(n), rankBy: (e) => e.score }),
  },
  {
    name: "role_from (carried role value)",
    roundSensitive: false,
    snapshot: (n) => Object.fromEntries(idsOf(n).map((id, i) => [id, { role: `role${i}` }])),
    opts: (n) => ({ roles: distinctRoles(n), roleFrom: (e) => e.role }),
  },
  {
    name: "rotate",
    roundSensitive: true,
    snapshot: emptySnapshot,
    opts: (n, round) => ({ roles: distinctRoles(n), strategy: "rotate", round }),
  },
  {
    name: "rotate (balanced)",
    roundSensitive: true,
    snapshot: emptySnapshot,
    opts: (n, round) => ({ roles: distinctRoles(n), strategy: "rotate", balanced: true, round }),
  },
  {
    name: "random",
    roundSensitive: true,
    snapshot: emptySnapshot,
    opts: (n, round) => ({ roles: distinctRoles(n), strategy: "random", round }),
  },
];

const CONSENSUS_SIZES = [2, 3, 4, 5, 6, 8]; // <=6 exhaustive over all permutations, 8 representative
const roundsFor = (c: StrategyCase, n: number) => (c.roundSensitive ? [0, 1, n, n + 1] : [0]);

describe("property: consensus is invariant to snapshot key order (every client agrees)", () => {
  for (const c of cases) {
    for (const n of CONSENSUS_SIZES) {
      it(`${c.name} — n=${n}`, () => {
        const snapshot = c.snapshot(n);
        const orderings = keyOrderings(Object.keys(snapshot));
        for (const round of roundsFor(c, n)) {
          const opts = c.opts(n, round);
          const canonical = assignRoles(snapshot, opts);
          for (const order of orderings) {
            expect(assignRoles(withKeyOrder(snapshot, order), opts)).toEqual(canonical);
          }
        }
      });
    }
  }
});

describe("property: every assignment is a bijection over the declared roles", () => {
  for (const c of cases) {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      it(`${c.name} — n=${n}`, () => {
        const snapshot = c.snapshot(n);
        const expectedIds = Object.keys(snapshot).sort();
        const expectedRoles = [...distinctRoles(n)].sort();
        for (const round of roundsFor(c, n)) {
          const m = assignRoles(snapshot, c.opts(n, round));
          expect(Object.keys(m).sort()).toEqual(expectedIds);
          expect(
            Object.values(m)
              .map((a) => a.role)
              .sort()
          ).toEqual(expectedRoles);
        }
      });
    }
  }
});

describe("property: rotate gives each participant each role exactly once per n rounds", () => {
  for (const balanced of [false, true]) {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      it(`balanced=${balanced} — n=${n}`, () => {
        const snapshot = emptySnapshot(n);
        const roles = distinctRoles(n);
        const expected = [...roles].sort();
        // Any window of n consecutive rounds must give a full sweep, regardless of where it starts.
        for (const start of [0, 1, n, 2 * n + 1]) {
          const seen: Record<string, Set<string>> = {};
          for (const id of Object.keys(snapshot)) seen[id] = new Set();
          for (let r = start; r < start + n; r++) {
            const m = assignRoles(snapshot, { roles, strategy: "rotate", balanced, round: r });
            for (const [id, a] of Object.entries(m)) seen[id].add(a.role);
          }
          for (const id of Object.keys(snapshot)) {
            expect([...seen[id]].sort()).toEqual(expected);
          }
        }
      });
    }
  }
});

describe("property: balanced rotate balances first-order carryover for even n", () => {
  for (const n of [2, 4, 6, 8]) {
    it(`n=${n}: each of the n*(n-1) ordered role pairs occurs exactly once across the group`, () => {
      const snapshot = emptySnapshot(n);
      const roles = distinctRoles(n);
      const pairCounts: Record<string, number> = {};
      for (const id of Object.keys(snapshot)) {
        let prev: string | undefined;
        for (let r = 0; r < n; r++) {
          const role = assignRoles(snapshot, {
            roles,
            strategy: "rotate",
            balanced: true,
            round: r,
          })[id].role;
          if (prev !== undefined) {
            const key = `${prev}->${role}`;
            pairCounts[key] = (pairCounts[key] ?? 0) + 1;
          }
          prev = role;
        }
      }
      expect(Object.keys(pairCounts)).toHaveLength(n * (n - 1));
      expect(Object.values(pairCounts).every((c) => c === 1)).toBe(true);
    });
  }
});
