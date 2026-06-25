import { RoleMap, Snapshot, assignRoles, expandSlots } from "./roles";

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

  it("throws for the not-yet-implemented balanced variant", () => {
    expect(() =>
      assignRoles(ids, { roles: ["lead", "x", "y"], strategy: "rotate", balanced: true })
    ).toThrow(/balanced/i);
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
