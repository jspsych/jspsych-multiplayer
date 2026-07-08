import { RoleMap, Snapshot, assignRoles, balancedRotationShift, expandSlots } from "./roles";

/** Reorder an object's keys to simulate a different client's snapshot key order. */
const reorder = (s: Snapshot): Snapshot =>
  Object.fromEntries(
    Object.keys(s)
      .reverse()
      .map((k) => [k, s[k]])
  );

const roleOf = (m: RoleMap, id: string) => m[id].role;

describe("expandSlots", () => {
  it("passes through an array spec", () => {
    expect(expandSlots(["proposer", "responder"])).toEqual(["proposer", "responder"]);
  });
  it("expands a count spec", () => {
    expect(expandSlots({ leader: 1, follower: 3 })).toEqual([
      "leader",
      "follower",
      "follower",
      "follower",
    ]);
  });
});

describe("assignRoles — determinism / consensus", () => {
  const snapshot: Snapshot = {
    p3: { joinedAt: 30 },
    p1: { joinedAt: 10 },
    p2: { joinedAt: 20 },
  };

  it("is invariant to snapshot key order (every client agrees)", () => {
    const a = assignRoles(snapshot, { roles: { leader: 1, follower: 2 }, strategy: "join_order" });
    const b = assignRoles(reorder(snapshot), {
      roles: { leader: 1, follower: 2 },
      strategy: "join_order",
    });
    expect(a).toEqual(b);
  });

  it("join_order ranks by joinedAt", () => {
    const m = assignRoles(snapshot, { roles: ["a", "b", "c"], strategy: "join_order" });
    expect([roleOf(m, "p1"), roleOf(m, "p2"), roleOf(m, "p3")]).toEqual(["a", "b", "c"]);
  });

  it("breaks ties by id when joinedAt is equal", () => {
    const tied: Snapshot = { pB: { joinedAt: 5 }, pA: { joinedAt: 5 } };
    const m = assignRoles(tied, { roles: ["first", "second"], strategy: "join_order" });
    expect(roleOf(m, "pA")).toBe("first");
    expect(roleOf(m, "pB")).toBe("second");
  });

  it("tie-breaks by UTF-16 code unit, not locale collation (cross-client determinism)", () => {
    // Mixed-case ids where locale collation ('a' before 'B') and code-unit order ('B'=66 before
    // 'a'=97) DISAGREE. The plugin must use code-unit order so two clients in different locales (or
    // with different ICU versions) never order tied ids differently and compute divergent maps.
    const tied: Snapshot = { a: { joinedAt: 5 }, B: { joinedAt: 5 } };

    const byJoin = assignRoles(tied, { roles: ["first", "second"], strategy: "join_order" });
    expect(roleOf(byJoin, "B")).toBe("first"); // 'B' (66) sorts before 'a' (97) by code unit
    expect(roleOf(byJoin, "a")).toBe("second");

    // rankBy ties fall through to the same id tie-break.
    const byRank = assignRoles(tied, { roles: ["first", "second"], rankBy: () => 0 });
    expect(roleOf(byRank, "B")).toBe("first");
    expect(roleOf(byRank, "a")).toBe("second");
  });
});

describe("assignRoles — input validation", () => {
  it("throws a clear error when roles is missing", () => {
    expect(() => assignRoles({ p1: {} }, {} as never)).toThrow(/`roles` option is required/);
  });

  it("throws a clear error when roles is an empty array", () => {
    expect(() => assignRoles({ p1: {} }, { roles: [] })).toThrow(/`roles` option is required/);
  });

  it("throws a clear error when roles is an empty object (would send everyone to overflow)", () => {
    expect(() => assignRoles({ p1: {} }, { roles: {} })).toThrow(/empty object/);
  });

  it("throws a clear error on a negative role count (not an opaque Array RangeError)", () => {
    expect(() => assignRoles({ p1: {} }, { roles: { leader: -1 } })).toThrow(
      /count for role "leader" must be a non-negative integer/
    );
  });

  it("throws a clear error on a non-integer role count", () => {
    expect(() => assignRoles({ p1: {} }, { roles: { leader: 1.5 } })).toThrow(
      /count for role "leader" must be a non-negative integer/
    );
  });

  it("allows a zero count (a role declared but not handed out this round)", () => {
    const map = assignRoles({ p1: {} }, { roles: { leader: 1, observer: 0 } });
    expect(map.p1.role).toBe("leader");
  });
});

describe("assignRoles — random", () => {
  const ids: Snapshot = { a: {}, b: {}, c: {}, d: {} };

  it("is reproducible across clients for the same ids + round (default shared seed)", () => {
    const a = assignRoles(ids, { roles: ["w", "x", "y", "z"], strategy: "random", round: 0 });
    const b = assignRoles(reorder(ids), {
      roles: ["w", "x", "y", "z"],
      strategy: "random",
      round: 0,
    });
    expect(a).toEqual(b);
  });

  it("re-randomizes across rounds (round folded into the default seed)", () => {
    const r0 = assignRoles(ids, { roles: ["w", "x", "y", "z"], strategy: "random", round: 0 });
    const r1 = assignRoles(ids, { roles: ["w", "x", "y", "z"], strategy: "random", round: 1 });
    expect(r0).not.toEqual(r1);
  });

  it("respects an explicit shared seed", () => {
    const a = assignRoles(ids, { roles: ["w", "x", "y", "z"], strategy: "random", seed: "fixed" });
    const b = assignRoles(ids, { roles: ["w", "x", "y", "z"], strategy: "random", seed: "fixed" });
    expect(a).toEqual(b);
  });
});

describe("assignRoles — rotate", () => {
  const ids: Snapshot = { a: {}, b: {}, c: {} };

  it("shifts the base order by the round", () => {
    const r0 = assignRoles(ids, { roles: ["lead", "x", "y"], strategy: "rotate", round: 0 });
    const r1 = assignRoles(ids, { roles: ["lead", "x", "y"], strategy: "rotate", round: 1 });
    // base order is sorted ids [a,b,c]; round 0 -> a leads, round 1 -> b leads
    expect(roleOf(r0, "a")).toBe("lead");
    expect(roleOf(r1, "b")).toBe("lead");
  });

  it("is consensus-consistent across clients and across rounds", () => {
    for (let round = 0; round < 5; round++) {
      const a = assignRoles(ids, { roles: ["lead", "x", "y"], strategy: "rotate", round });
      const b = assignRoles(reorder(ids), {
        roles: ["lead", "x", "y"],
        strategy: "rotate",
        round,
      });
      expect(a).toEqual(b);
    }
  });
});

describe("assignRoles — rotate (balanced / Latin-square)", () => {
  const four: Snapshot = { a: {}, b: {}, c: {}, d: {} };
  const roles = ["lead", "w", "x", "y"];

  const leaderAt = (round: number) => {
    const m = assignRoles(four, { roles, strategy: "rotate", balanced: true, round });
    return Object.keys(m).find((id) => roleOf(m, id) === "lead");
  };

  it("uses the Williams starting sequence 0, n-1, 1, n-2, … as the per-round shift", () => {
    expect([0, 1, 2, 3].map((r) => balancedRotationShift(4, r))).toEqual([0, 3, 1, 2]);
  });

  it("differs from plain rotate (it is not the trivial +round shift)", () => {
    const plain = assignRoles(four, { roles, strategy: "rotate", round: 1 });
    const balanced = assignRoles(four, { roles, strategy: "rotate", balanced: true, round: 1 });
    expect(balanced).not.toEqual(plain);
  });

  it("still gives every participant the lead role exactly once over n rounds", () => {
    const leaders = [0, 1, 2, 3].map(leaderAt);
    expect([...leaders].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("is consensus-consistent across clients (invariant to key order)", () => {
    for (let round = 0; round < 6; round++) {
      const a = assignRoles(four, { roles, strategy: "rotate", balanced: true, round });
      const b = assignRoles(reorder(four), { roles, strategy: "rotate", balanced: true, round });
      expect(a).toEqual(b);
    }
  });

  it("balances first-order carryover for even n (each role preceded by each other equally often)", () => {
    const n = 4;
    // For each participant, collect the ordered (prevRole -> role) transitions across n rounds.
    const transitions: Record<string, number> = {};
    for (const id of Object.keys(four)) {
      for (let round = 1; round < n; round++) {
        const prev = roleOf(
          assignRoles(four, { roles, strategy: "rotate", balanced: true, round: round - 1 }),
          id
        );
        const cur = roleOf(
          assignRoles(four, { roles, strategy: "rotate", balanced: true, round }),
          id
        );
        transitions[`${prev}->${cur}`] = (transitions[`${prev}->${cur}`] ?? 0) + 1;
      }
    }
    // All 12 distinct ordered pairs of the 4 roles appear, each exactly once.
    const counts = Object.values(transitions);
    expect(Object.keys(transitions)).toHaveLength(n * (n - 1));
    expect(counts.every((c) => c === 1)).toBe(true);
  });

  it("handles edge sizes (n = 1, n = 2) without error", () => {
    const one: Snapshot = { solo: {} };
    expect(
      roleOf(assignRoles(one, { roles: ["only"], strategy: "rotate", balanced: true }), "solo")
    ).toBe("only");
    const two: Snapshot = { a: {}, b: {} };
    const r0 = assignRoles(two, {
      roles: ["p", "q"],
      strategy: "rotate",
      balanced: true,
      round: 0,
    });
    const r1 = assignRoles(two, {
      roles: ["p", "q"],
      strategy: "rotate",
      balanced: true,
      round: 1,
    });
    expect(roleOf(r0, "a")).toBe("p");
    expect(roleOf(r1, "a")).toBe("q");
  });
});

describe("assignRoles — rankBy with round-scoped data", () => {
  const snapshot: Snapshot = {
    lo: { rounds: { 0: { score: 1 } } },
    hi: { rounds: { 0: { score: 9 } } },
  };

  it("orders by the ranking key (higher first)", () => {
    const m = assignRoles(snapshot, {
      roles: ["winner", "loser"],
      rankBy: (e, _id, { round }) => e.rounds[round].score,
      round: 0,
    });
    expect(roleOf(m, "hi")).toBe("winner");
    expect(roleOf(m, "lo")).toBe("loser");
  });
});

describe("assignRoles — roleFrom", () => {
  const snapshot: Snapshot = { a: { cond: "treatment" }, b: { cond: "control" } };

  it("maps the carried value to the role", () => {
    const m = assignRoles(snapshot, {
      roles: ["treatment", "control"],
      roleFrom: (e) => e.cond,
    });
    expect(roleOf(m, "a")).toBe("treatment");
    expect(roleOf(m, "b")).toBe("control");
  });

  it("throws on a value outside the declared roles", () => {
    expect(() =>
      assignRoles(snapshot, { roles: ["treatment", "control"], roleFrom: () => "typo" })
    ).toThrow(/not a declared role/);
  });

  it("takes precedence over rankBy and a string strategy when several are supplied", () => {
    // role_from > rank_by > strategy preset. If precedence were wrong, rankBy (by score, highest
    // first) would make p2 the proposer; role_from must win and honor each participant's carried role.
    const snap: Snapshot = {
      p1: { role: "responder", score: 1 },
      p2: { role: "proposer", score: 99 },
    };
    const m = assignRoles(snap, {
      roles: ["proposer", "responder"],
      strategy: "join_order",
      rankBy: (e) => e.score,
      roleFrom: (e) => e.role,
    });
    expect(roleOf(m, "p1")).toBe("responder");
    expect(roleOf(m, "p2")).toBe("proposer");
  });
});

describe("assignRoles — overflow", () => {
  const snapshot: Snapshot = { a: { joinedAt: 1 }, b: { joinedAt: 2 }, c: { joinedAt: 3 } };

  it("throws when participants exceed slots and no overflowRole is set", () => {
    expect(() => assignRoles(snapshot, { roles: ["proposer", "responder"] })).toThrow(/role slots/);
  });

  it("assigns extras to overflowRole when provided", () => {
    const m = assignRoles(snapshot, {
      roles: ["proposer", "responder"],
      strategy: "join_order",
      overflowRole: "spectator",
    });
    expect(roleOf(m, "c")).toBe("spectator");
  });
});

describe("assignRoles — custom strategy", () => {
  it("delegates fully and receives ctx", () => {
    const snapshot: Snapshot = { a: {}, b: {} };
    const m = assignRoles(snapshot, {
      roles: ["x", "y"],
      round: 2,
      strategy: (_s, ctx) =>
        Object.fromEntries(ctx.ids.map((id) => [id, { role: `r${ctx.round}` }])),
    });
    expect(roleOf(m, "a")).toBe("r2");
  });
});
