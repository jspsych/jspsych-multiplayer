import { MatchMap, Snapshot, buildMatches } from "./match-core";

/** A snapshot with the given ids (each an empty entry unless `data` provides one). */
const snap = (ids: string[], data: Record<string, any> = {}): Snapshot =>
  Object.fromEntries(ids.map((id) => [id, data[id] ?? {}]));

/** Compact view: sorted list of member-arrays, so group order/labels don't matter. */
const groupsOf = (map: MatchMap): string[][] => {
  const seen = new Map<number, string[]>();
  for (const a of Object.values(map)) if (!seen.has(a.group)) seen.set(a.group, a.members);
  return [...seen.values()];
};

describe("buildMatches — pairing", () => {
  it("pairs participants into dyads by id order (default)", () => {
    const map = buildMatches(snap(["a", "b", "c", "d"]));
    expect(groupsOf(map)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(map.a).toEqual({ group: 0, members: ["a", "b"], partners: ["b"], position: 0 });
    expect(map.b).toEqual({ group: 0, members: ["a", "b"], partners: ["a"], position: 1 });
    expect(map.d).toEqual({ group: 1, members: ["c", "d"], partners: ["c"], position: 1 });
  });

  it("orders by id regardless of snapshot key order (consensus base)", () => {
    const forward = buildMatches(snap(["a", "b", "c", "d"]));
    const shuffled = buildMatches(snap(["d", "b", "a", "c"]));
    expect(groupsOf(forward)).toEqual(groupsOf(shuffled));
  });

  it("supports triads and larger groups via groupSize", () => {
    const map = buildMatches(snap(["a", "b", "c", "d", "e", "f"]), { groupSize: 3 });
    expect(groupsOf(map)).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
    expect(map.b.partners).toEqual(["a", "c"]);
    expect(map.b.position).toBe(1);
  });

  it("orders by joinedAt under the join_order strategy", () => {
    const map = buildMatches(
      snap(["a", "b", "c", "d"], {
        a: { joinedAt: 40 },
        b: { joinedAt: 10 },
        c: { joinedAt: 30 },
        d: { joinedAt: 20 },
      }),
      { strategy: "join_order" }
    );
    // Join order is b(10), d(20), c(30), a(40) -> pairs (b,d) and (c,a).
    expect(groupsOf(map)).toEqual([
      ["b", "d"],
      ["c", "a"],
    ]);
  });
});

describe("buildMatches — random strategy", () => {
  it("is deterministic across clients for the same ids + round (consensus)", () => {
    const a = buildMatches(snap(["a", "b", "c", "d", "e", "f"]), { strategy: "random" });
    const b = buildMatches(snap(["f", "e", "d", "c", "b", "a"]), { strategy: "random" }); // different key order
    expect(groupsOf(a)).toEqual(groupsOf(b));
  });

  it("re-pairs across rounds (a different round generally yields different groups)", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const r0 = JSON.stringify(groupsOf(buildMatches(snap(ids), { strategy: "random", round: 0 })));
    const r1 = JSON.stringify(groupsOf(buildMatches(snap(ids), { strategy: "random", round: 1 })));
    expect(r0).not.toEqual(r1);
  });

  it("honours an explicit shared seed", () => {
    const ids = ["a", "b", "c", "d"];
    const s1 = groupsOf(buildMatches(snap(ids), { strategy: "random", seed: "trial-7" }));
    const s2 = groupsOf(buildMatches(snap(ids), { strategy: "random", seed: "trial-7" }));
    expect(s1).toEqual(s2);
  });
});

describe("buildMatches — leftover policy", () => {
  it("throws on a non-divisible count by default (fail loud)", () => {
    expect(() => buildMatches(snap(["a", "b", "c"]))).toThrow(/not a multiple/);
  });

  it("leaves the trailing extras unmatched under 'spectator'", () => {
    const map = buildMatches(snap(["a", "b", "c"]), { leftover: "spectator" });
    expect(map.a).toBeDefined();
    expect(map.b).toBeDefined();
    expect(map.c).toBeUndefined(); // the odd one out is absent (a spectator)
    expect(groupsOf(map)).toEqual([["a", "b"]]);
  });

  it("puts the trailing extras in one undersized group under 'smaller_group'", () => {
    const map = buildMatches(snap(["a", "b", "c", "d", "e"]), { leftover: "smaller_group" });
    expect(groupsOf(map)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(map.e).toEqual({ group: 2, members: ["e"], partners: [], position: 0 });
  });
});

describe("buildMatches — validation & edges", () => {
  it("rejects a groupSize below 2 or non-integer", () => {
    expect(() => buildMatches(snap(["a", "b"]), { groupSize: 1 })).toThrow(/groupSize/);
    expect(() => buildMatches(snap(["a", "b"]), { groupSize: 2.5 })).toThrow(/groupSize/);
  });

  it("rejects an unknown strategy rather than silently ordering by id", () => {
    expect(() => buildMatches(snap(["a", "b"]), { strategy: "rotate" as never })).toThrow(
      /unknown strategy/
    );
  });

  it("rejects an unknown leftover value rather than silently acting like smaller_group", () => {
    // A typo must not slip past the "error"/"spectator" checks and quietly make an undersized group.
    expect(() => buildMatches(snap(["a", "b", "c"]), { leftover: "spectators" as never })).toThrow(
      /unknown leftover/
    );
  });

  it("returns an empty map for an empty snapshot", () => {
    expect(buildMatches(snap([]))).toEqual({});
  });

  it("makes everyone a spectator when groupSize exceeds the count under 'spectator'", () => {
    expect(buildMatches(snap(["a", "b"]), { groupSize: 3, leftover: "spectator" })).toEqual({});
  });
});
