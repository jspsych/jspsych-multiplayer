import {
  SlotAssignment,
  assignObject,
  displayOrder,
  hashSeed,
  independentOrders,
  isComplete,
  mergeRoundData,
  nextUnfilledSlot,
  readRoundData,
  readSubmission,
  runningScore,
  scoreAssignment,
  scramble,
} from "./reference-core";

describe("reference-core: deterministic scramble", () => {
  it("hashSeed is deterministic and input-sensitive", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });

  it("scramble is a permutation and is stable for a given seed", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const once = scramble(ids, "seed#0");
    const twice = scramble(ids, "seed#0");
    expect(once).toEqual(twice); // same seed -> same order
    expect([...once].sort()).toEqual([...ids].sort()); // same multiset (a permutation)
    expect(scramble(ids, "seed#1")).not.toEqual(once); // different seed -> different order
    expect(ids).toEqual(["a", "b", "c", "d", "e", "f"]); // input not mutated
  });

  it("independent mode gives the director and matcher different-but-stable layouts", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const dir = displayOrder(ids, "director", "independent", 0, "P1", null);
    const mat = displayOrder(ids, "matcher", "independent", 0, "P2", null);
    expect(dir).not.toEqual(mat);
    // Stable: recomputing for the same participant/round yields the same order.
    expect(displayOrder(ids, "director", "independent", 0, "P1", null)).toEqual(dir);
    // Re-scrambles across rounds.
    expect(displayOrder(ids, "director", "independent", 1, "P1", null)).not.toEqual(dir);
  });

  it("shared mode gives both roles an identical layout", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const dir = displayOrder(ids, "director", "shared", 0, "P1", null);
    const mat = displayOrder(ids, "matcher", "shared", 0, "P2", null);
    expect(dir).toEqual(mat);
  });

  it("matcher_only leaves the director in canonical order and scrambles the matcher", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(displayOrder(ids, "director", "matcher_only", 0, "P1", null)).toEqual(ids);
    expect(displayOrder(ids, "matcher", "matcher_only", 0, "P2", null)).not.toEqual(ids);
  });

  it("independentOrders GUARANTEES different layouts even at N=2, and is order-agnostic in its ids", () => {
    const ids = ["a", "b"]; // only two permutations — plain scrambles collide 50% of the time
    for (const [p1, p2] of [
      ["u1", "u2"],
      ["z", "a"],
      ["alice", "bob"],
      ["1", "2"],
      ["x", "y"],
    ]) {
      const o = independentOrders(ids, 0, p1, p2, null);
      expect(o[p1]).not.toEqual(o[p2]); // never identical
      expect([...o[p1]].sort()).toEqual(["a", "b"]); // still a permutation
      // Consistent regardless of which id is passed first (both clients agree).
      const swapped = independentOrders(ids, 0, p2, p1, null);
      expect(swapped[p1]).toEqual(o[p1]);
      expect(swapped[p2]).toEqual(o[p2]);
    }
  });

  it("displayOrder(independent) with a known partner never matches the partner's order (N=2)", () => {
    const ids = ["a", "b"];
    const mine = displayOrder(ids, "director", "independent", 0, "P1", null, "P2");
    const theirs = displayOrder(ids, "matcher", "independent", 0, "P2", null, "P1");
    expect(mine).not.toEqual(theirs);
  });
});

describe("reference-core: slot-assignment model", () => {
  it("assigns, reassigns, and clears a slot with matching events", () => {
    let a: SlotAssignment = {};
    let r = assignObject(a, 1, "x", 10);
    a = r.next;
    expect(a).toEqual({ 1: "x" });
    expect(r.events).toEqual([{ t: 10, action: "assign", slot: 1, object_id: "x" }]);

    r = assignObject(a, 1, "y", 20);
    a = r.next;
    expect(a).toEqual({ 1: "y" });
    expect(r.events).toEqual([{ t: 20, action: "reassign", slot: 1, object_id: "y" }]);

    r = assignObject(a, 1, null, 30);
    a = r.next;
    expect(a).toEqual({});
    expect(r.events).toEqual([{ t: 30, action: "clear", slot: 1, object_id: null }]);
  });

  it("moving an object out of its old slot clears the old slot first", () => {
    const a: SlotAssignment = { 1: "x", 2: "y" };
    const { next, events } = assignObject(a, 3, "x", 40); // x moves from slot 1 to slot 3
    expect(next).toEqual({ 2: "y", 3: "x" });
    expect(events).toEqual([
      { t: 40, action: "clear", slot: 1, object_id: null },
      { t: 40, action: "assign", slot: 3, object_id: "x" },
    ]);
  });

  it("isComplete is true only once every slot 1..k is filled", () => {
    expect(isComplete({ 1: "a" }, 1)).toBe(true);
    expect(isComplete({ 1: "a" }, 2)).toBe(false);
    expect(isComplete({ 1: "a", 2: "b" }, 2)).toBe(true);
  });

  it("nextUnfilledSlot scans forward with wraparound and returns null when full", () => {
    expect(nextUnfilledSlot({}, 3, 0)).toBe(1);
    expect(nextUnfilledSlot({ 1: "a" }, 3, 1)).toBe(2);
    // From the last filled slot it wraps to find an earlier empty one.
    expect(nextUnfilledSlot({ 2: "b", 3: "c" }, 3, 3)).toBe(1);
    expect(nextUnfilledSlot({ 1: "a", 2: "b", 3: "c" }, 3, 1)).toBeNull();
  });
});

describe("reference-core: scoring", () => {
  it("per_slot ordered counts slot-by-slot matches", () => {
    expect(scoreAssignment({ 1: "a", 2: "b" }, ["a", "b"], { ordered: true })).toMatchObject({
      nCorrect: 2,
      nTargets: 2,
      accuracy: 1,
      correct: true,
    });
    expect(scoreAssignment({ 1: "a", 2: "c" }, ["a", "b"], { ordered: true })).toMatchObject({
      nCorrect: 1,
      correct: false,
    });
  });

  it("unordered scores as sets (order does not matter)", () => {
    expect(scoreAssignment({ 1: "b", 2: "a" }, ["a", "b"], { ordered: false })).toMatchObject({
      nCorrect: 2,
      correct: true,
    });
  });

  it("all_or_nothing yields k or 0 while `correct` still reflects a true full match", () => {
    expect(
      scoreAssignment({ 1: "a", 2: "c" }, ["a", "b"], { ordered: true, scoring: "all_or_nothing" })
    ).toMatchObject({ nCorrect: 0, correct: false });
    expect(
      scoreAssignment({ 1: "a", 2: "b" }, ["a", "b"], { ordered: true, scoring: "all_or_nothing" })
    ).toMatchObject({ nCorrect: 2, correct: true });
  });

  it("a custom scoring function is coerced and clamped into [0, k]", () => {
    const spec = { ordered: true, scoring: () => 99 } as const;
    expect(scoreAssignment({ 1: "a", 2: "b" }, ["a", "b"], spec).nCorrect).toBe(2); // clamped to k
    const negative = { ordered: true, scoring: () => -5 } as const;
    expect(scoreAssignment({ 1: "a" }, ["a", "b"], negative).nCorrect).toBe(0);
  });

  it("k=1 single-target defaults to an unordered (set-membership) comparison", () => {
    expect(scoreAssignment({ 1: "a" }, ["a"]).correct).toBe(true);
    expect(scoreAssignment({ 1: "b" }, ["a"]).correct).toBe(false);
  });
});

describe("reference-core: per-round group-session helpers", () => {
  it("mergeRoundData preserves other keys and keeps rounds separate", () => {
    const slot = { joinedAt: 5, reference_game: { 0: { assignment: { 1: "x" } } } };
    const merged = mergeRoundData(slot, "reference_game", 1, { assignment: { 1: "y" } });
    expect(merged.joinedAt).toBe(5); // unrelated key survives
    expect(merged.reference_game).toEqual({
      0: { assignment: { 1: "x" } }, // earlier round untouched
      1: { assignment: { 1: "y" } },
    });
  });

  it("readRoundData returns the round's data and tolerates malformed slots", () => {
    const slot = { reference_game: { 2: { rt: 100 } } };
    expect(readRoundData(slot, "reference_game", 2)).toEqual({ rt: 100 });
    expect(readRoundData(undefined, "reference_game", 2)).toBeUndefined();
    expect(readRoundData({ reference_game: "nope" }, "reference_game", 2)).toBeUndefined();
    expect(readRoundData({ reference_game: {} }, "reference_game", 9)).toBeUndefined();
  });

  it("readSubmission parses a valid assignment and ignores malformed entries", () => {
    const group = {
      matcher: {
        reference_game: {
          0: { assignment: { 1: "c", 2: "a", bogus: 7, 0: "skip" }, rt: 250, timed_out: true },
        },
      },
    };
    expect(readSubmission(group, "matcher", "reference_game", 0)).toEqual({
      assignment: { 1: "c", 2: "a" }, // non-string / slot<1 entries dropped
      rt: 250,
      timed_out: true,
    });
    expect(readSubmission(group, "matcher", "reference_game", 5)).toBeUndefined();
    expect(readSubmission({}, "matcher", "reference_game", 0)).toBeUndefined();
  });

  it("runningScore sums n_correct across rounds, tolerating gaps", () => {
    const slot = {
      reference_game: {
        0: { n_correct: 1 },
        1: { n_correct: 3 },
        2: { assignment: {} }, // no score yet
      },
    };
    expect(runningScore(slot, "reference_game")).toBe(4);
    expect(runningScore(undefined, "reference_game")).toBe(0);
  });
});
