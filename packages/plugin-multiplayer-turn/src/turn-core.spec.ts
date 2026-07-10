import {
  GroupSessionData,
  activeIndex,
  collectMoves,
  isComplete,
  readMove,
  resolveTurnOrder,
} from "./turn-core";

/** Build a snapshot where the given ids have moved (in the given order) under "turn". */
const withMoves = (moves: Array<[string, unknown]>, extra: string[] = []): GroupSessionData => {
  const g: GroupSessionData = {};
  for (const [id, move] of moves) g[id] = { turn: { move } };
  for (const id of extra) g[id] = {}; // present but has not moved
  return g;
};

describe("resolveTurnOrder", () => {
  it("defaults to id order", () => {
    expect(resolveTurnOrder(["c", "a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("uses an explicit array as-is", () => {
    expect(resolveTurnOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("passes the id-sorted participants to a custom function", () => {
    const seen: string[][] = [];
    const order = resolveTurnOrder(["c", "a", "b"], (ids) => {
      seen.push(ids);
      return [...ids].reverse();
    });
    expect(seen[0]).toEqual(["a", "b", "c"]); // sorted before handing off
    expect(order).toEqual(["c", "b", "a"]);
  });
});

describe("readMove", () => {
  it("reads a move, treating falsy values (null/0/false) as 'moved'", () => {
    expect(readMove({ turn: { move: "offer" } }, "turn")).toEqual({ move: "offer" });
    expect(readMove({ turn: { move: 0 } }, "turn")).toEqual({ move: 0 });
    expect(readMove({ turn: { move: null } }, "turn")).toEqual({ move: null });
    expect(readMove({ turn: { move: false } }, "turn")).toEqual({ move: false });
  });

  it("returns null when the slot/key/move is absent", () => {
    expect(readMove(undefined, "turn")).toBeNull();
    expect(readMove({}, "turn")).toBeNull();
    expect(readMove({ turn: {} }, "turn")).toBeNull(); // no `move` key
    expect(readMove({ other: { move: 1 } }, "turn")).toBeNull(); // wrong data_key
  });
});

describe("activeIndex / isComplete", () => {
  const order = ["a", "b", "c"];

  it("points at the first player who has not moved", () => {
    expect(activeIndex(withMoves([], ["a", "b", "c"]), "turn", order)).toBe(0); // no one moved
    expect(activeIndex(withMoves([["a", 1]], ["b", "c"]), "turn", order)).toBe(1); // a moved
    expect(
      activeIndex(
        withMoves(
          [
            ["a", 1],
            ["b", 2],
          ],
          ["c"]
        ),
        "turn",
        order
      )
    ).toBe(2);
  });

  it("equals order.length and is complete once everyone has moved", () => {
    const g = withMoves([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(activeIndex(g, "turn", order)).toBe(3);
    expect(isComplete(g, "turn", order)).toBe(true);
  });

  it("does not advance past a gap: an out-of-turn move by a later player is ignored", () => {
    // c moved but a hasn't — the pointer stays at a (index 0), not c.
    const g = withMoves([["c", 9]], ["a", "b"]);
    expect(activeIndex(g, "turn", order)).toBe(0);
    expect(isComplete(g, "turn", order)).toBe(false);
  });
});

describe("collectMoves", () => {
  const order = ["a", "b", "c"];

  it("returns the contiguous leading run of moves, tagged with position", () => {
    const g = withMoves(
      [
        ["a", "x"],
        ["b", "y"],
      ],
      ["c"]
    );
    expect(collectMoves(g, "turn", order)).toEqual([
      { participantId: "a", move: "x", position: 0 },
      { participantId: "b", move: "y", position: 1 },
    ]);
  });

  it("stops at the first gap, ignoring an out-of-turn move", () => {
    const g = withMoves(
      [
        ["a", "x"],
        ["c", "z"],
      ],
      ["b"]
    ); // b hasn't moved; c's move is out of turn
    expect(collectMoves(g, "turn", order)).toEqual([
      { participantId: "a", move: "x", position: 0 },
    ]);
  });

  it("is empty when no one has moved", () => {
    expect(collectMoves(withMoves([], ["a", "b", "c"]), "turn", order)).toEqual([]);
  });
});
