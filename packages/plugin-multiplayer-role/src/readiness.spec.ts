import { makeReadiness } from "./readiness";
import { Snapshot } from "./roles";

describe("makeReadiness — count gate (plan §7)", () => {
  it("requires exactly groupSize participants, not >=", () => {
    const ready = makeReadiness({ groupSize: 2, strategy: "random" });
    expect(ready({ a: {} })).toBe(false); // too few
    expect(ready({ a: {}, b: {} })).toBe(true); // exactly N
  });

  it("stalls on overshoot (count > groupSize) — fail loud, not silent subset", () => {
    const ready = makeReadiness({ groupSize: 2, strategy: "random" });
    expect(ready({ a: {}, b: {}, c: {} })).toBe(false);
  });

  it("skips the count check when groupSize is null (assume upstream barrier)", () => {
    const ready = makeReadiness({ groupSize: null, strategy: "random" });
    expect(ready({ a: {} })).toBe(true);
  });
});

describe("makeReadiness — field readiness", () => {
  it("join_order waits until every participant has joinedAt", () => {
    const ready = makeReadiness({ groupSize: 2, strategy: "join_order" });
    expect(ready({ a: { joinedAt: 1 }, b: {} })).toBe(false); // b not propagated
    expect(ready({ a: { joinedAt: 1 }, b: { joinedAt: 2 } })).toBe(true);
  });

  it("rankBy waits until every key is finite", () => {
    const ready = makeReadiness({
      groupSize: 2,
      rankBy: (e, _id, { round }) => e.rounds[round].score,
      round: 0,
    });
    // b's round-0 data hasn't landed; the natural accessor THROWS, treated as not-ready (no crash).
    const partial: Snapshot = { a: { rounds: { 0: { score: 5 } } }, b: { rounds: {} } };
    expect(ready(partial)).toBe(false);
    const full: Snapshot = {
      a: { rounds: { 0: { score: 5 } } },
      b: { rounds: { 0: { score: 7 } } },
    };
    expect(ready(full)).toBe(true);
  });

  it("roleFrom waits until every value is defined", () => {
    const ready = makeReadiness({ groupSize: 2, roleFrom: (e) => e.cond });
    expect(ready({ a: { cond: "x" }, b: {} })).toBe(false);
    expect(ready({ a: { cond: "x" }, b: { cond: "y" } })).toBe(true);
  });

  it("a custom ready predicate is honored and shielded from throws", () => {
    const ready = makeReadiness({
      groupSize: 2,
      strategy: () => ({}),
      ready: (s) => Object.values(s).every((e: any) => e.go.length > 0), // throws if .go missing
    });
    expect(ready({ a: { go: "" }, b: {} })).toBe(false);
    expect(ready({ a: { go: "y" }, b: { go: "y" } })).toBe(true);
  });
});
