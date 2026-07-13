import {
  AuthorPaintState,
  GroupSessionData,
  Stroke,
  emptyPaintState,
  makeStrokeId,
  orderedStrokes,
  planAuthorPaint,
  planRepaint,
  readStrokes,
  shouldRecordPoint,
  undoLastStroke,
} from "./draw-core";

function stroke(overrides: Partial<Stroke> & { authorId: string; seq: number }): Stroke {
  return {
    id: makeStrokeId(overrides.authorId, overrides.seq),
    points: [{ x: 0, y: 0 }],
    tool: "pen",
    color: "#000",
    width: 0.01,
    done: true,
    ts: 0,
    ...overrides,
  };
}

describe("readStrokes", () => {
  it("returns [] for a missing slot, missing key, or non-array value", () => {
    expect(readStrokes(undefined, "draw_strokes")).toEqual([]);
    expect(readStrokes({}, "draw_strokes")).toEqual([]);
    expect(readStrokes({ draw_strokes: "not an array" }, "draw_strokes")).toEqual([]);
  });

  it("filters out malformed entries but keeps well-formed ones", () => {
    const good = stroke({ authorId: "a", seq: 0 });
    const result = readStrokes(
      { draw_strokes: [good, { authorId: "a" }, null, 42] },
      "draw_strokes"
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ authorId: "a", seq: 0 });
  });

  it("normalizes id from authorId+seq even if the stored id is tampered", () => {
    const tampered = { ...stroke({ authorId: "a", seq: 1 }), id: "forged" };
    const result = readStrokes({ draw_strokes: [tampered] }, "draw_strokes");
    expect(result[0].id).toBe("a#1");
  });
});

describe("orderedStrokes (global paint order — the eraser-correctness invariant)", () => {
  it("orders by (ts, authorId, seq) across all authors", () => {
    const group: GroupSessionData = {
      b: { draw_strokes: [stroke({ authorId: "b", seq: 0, ts: 100 })] },
      a: {
        draw_strokes: [
          stroke({ authorId: "a", seq: 0, ts: 50 }),
          stroke({ authorId: "a", seq: 1, ts: 150 }),
        ],
      },
    };
    const ordered = orderedStrokes(group, "draw_strokes");
    expect(ordered.map((s) => s.id)).toEqual(["a#0", "b#0", "a#1"]);
  });

  it("tie-breaks equal ts by authorId then seq, deterministically", () => {
    const group: GroupSessionData = {
      z: { draw_strokes: [stroke({ authorId: "z", seq: 0, ts: 100 })] },
      a: { draw_strokes: [stroke({ authorId: "a", seq: 0, ts: 100 })] },
    };
    const ordered = orderedStrokes(group, "draw_strokes");
    expect(ordered.map((s) => s.id)).toEqual(["a#0", "z#0"]);
  });
});

describe("planAuthorPaint (incremental rendering)", () => {
  it("paints all points of a brand-new stroke from a fresh state", () => {
    const s = stroke({
      authorId: "a",
      seq: 0,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    });
    const { instructions, nextState, needsFullRepaint } = planAuthorPaint([s], emptyPaintState());

    expect(needsFullRepaint).toBe(false);
    expect(instructions).toEqual([{ kind: "segment", stroke: s, fromPointIndex: 0 }]);
    expect(nextState).toEqual({ paintedStrokeIds: ["a#0"], pointsPaintedOfLast: 2 });
  });

  it("paints only the new points when the same stroke grew (the common in-progress-stroke case)", () => {
    const grown = stroke({
      authorId: "a",
      seq: 0,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    });
    const state: AuthorPaintState = { paintedStrokeIds: ["a#0"], pointsPaintedOfLast: 2 };

    const { instructions, nextState } = planAuthorPaint([grown], state);

    expect(instructions).toEqual([{ kind: "segment", stroke: grown, fromPointIndex: 2 }]);
    expect(nextState.pointsPaintedOfLast).toBe(3);
  });

  it("catches up across MULTIPLE stroke boundaries in one callback (coalesced updates)", () => {
    // Simulates a subscribe callback that skipped every intermediate state between "author just
    // started stroke 0" and "author finished 0, 1, and is partway into 2" — the local adapter
    // coalesces signals, JATOS updates can too, so this MUST NOT silently drop strokes 0/1.
    const s0 = stroke({
      authorId: "a",
      seq: 0,
      points: [
        { x: 0, y: 0 },
        { x: 0.1, y: 0.1 },
      ],
    });
    const s1 = stroke({
      authorId: "a",
      seq: 1,
      points: [
        { x: 1, y: 1 },
        { x: 1.1, y: 1.1 },
      ],
    });
    const s2 = stroke({
      authorId: "a",
      seq: 2,
      points: [
        { x: 2, y: 2 },
        { x: 2.1, y: 2.1 },
        { x: 2.2, y: 2.2 },
      ],
    });
    const state: AuthorPaintState = { paintedStrokeIds: [], pointsPaintedOfLast: 0 };

    const { instructions, nextState } = planAuthorPaint([s0, s1, s2], state);

    expect(instructions).toEqual([
      { kind: "segment", stroke: s0, fromPointIndex: 0 },
      { kind: "segment", stroke: s1, fromPointIndex: 0 },
      { kind: "segment", stroke: s2, fromPointIndex: 0 },
    ]);
    expect(nextState.paintedStrokeIds).toEqual(["a#0", "a#1", "a#2"]);
    expect(nextState.pointsPaintedOfLast).toBe(3);
  });

  it("emits no instructions when there is nothing new to paint", () => {
    const s = stroke({
      authorId: "a",
      seq: 0,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    });
    const state: AuthorPaintState = { paintedStrokeIds: ["a#0"], pointsPaintedOfLast: 2 };

    const { instructions } = planAuthorPaint([s], state);
    expect(instructions).toEqual([]);
  });

  it("requests a full repaint when a previously-painted strokeId is gone (undo), by content not length", () => {
    // Length alone would miss this: a peer could undo AND start a new stroke between two callbacks,
    // leaving the array length unchanged while the content is entirely different.
    const replacement = stroke({ authorId: "a", seq: 1, points: [{ x: 5, y: 5 }] });
    const state: AuthorPaintState = { paintedStrokeIds: ["a#0"], pointsPaintedOfLast: 1 };

    const { needsFullRepaint, instructions } = planAuthorPaint([replacement], state);

    expect(needsFullRepaint).toBe(true);
    expect(instructions).toEqual([]);
  });
});

describe("planRepaint (full repaint — must use global ts order, not per-author array order)", () => {
  it("returns strokes from all authors in global ts order and a paint state matching it", () => {
    const group: GroupSessionData = {
      a: { draw_strokes: [stroke({ authorId: "a", seq: 0, ts: 10 })] },
      b: { draw_strokes: [stroke({ authorId: "b", seq: 0, ts: 5 })] },
    };

    const { instruction, nextStates } = planRepaint(group, "draw_strokes");

    expect(instruction.kind).toBe("full-repaint");
    if (instruction.kind === "full-repaint") {
      expect(instruction.strokes.map((s) => s.id)).toEqual(["b#0", "a#0"]);
    }
    expect(nextStates.get("a")).toEqual({ paintedStrokeIds: ["a#0"], pointsPaintedOfLast: 1 });
    expect(nextStates.get("b")).toEqual({ paintedStrokeIds: ["b#0"], pointsPaintedOfLast: 1 });
  });

  it("an eraser stroke only removes ink painted before it in ts order — verified via paint order, not pixels", () => {
    // Pure-logic proxy for the visual claim: the pen stroke from a peer, drawn AFTER (higher ts than)
    // this participant's eraser stroke, must be painted AFTER the eraser in the repaint order (so it
    // survives), even though iterating getAll()'s per-author object keys could put them either way.
    const group: GroupSessionData = {
      me: { draw_strokes: [stroke({ authorId: "me", seq: 0, tool: "eraser", ts: 100 })] },
      peer: { draw_strokes: [stroke({ authorId: "peer", seq: 0, tool: "pen", ts: 200 })] },
    };
    const { instruction } = planRepaint(group, "draw_strokes");
    if (instruction.kind !== "full-repaint") throw new Error("expected full-repaint");
    const order = instruction.strokes.map((s) => `${s.authorId}:${s.tool}`);
    expect(order).toEqual(["me:eraser", "peer:pen"]); // eraser painted first, pen survives after it
  });

  it("skips authors with no strokes", () => {
    const group: GroupSessionData = { a: {}, b: { draw_strokes: [] } };
    const { instruction, nextStates } = planRepaint(group, "draw_strokes");
    expect(instruction.kind === "full-repaint" && instruction.strokes).toEqual([]);
    expect(nextStates.size).toBe(0);
  });
});

describe("shouldRecordPoint (decimation)", () => {
  it("always records the first point (no prior point)", () => {
    expect(shouldRecordPoint(undefined, { x: 0, y: 0 }, 0.01)).toBe(true);
  });

  it("rejects a point closer than minDistance to the last recorded point", () => {
    const last = { x: 0, y: 0 };
    expect(shouldRecordPoint(last, { x: 0.001, y: 0 }, 0.01)).toBe(false);
  });

  it("accepts a point at or beyond minDistance", () => {
    const last = { x: 0, y: 0 };
    expect(shouldRecordPoint(last, { x: 0.01, y: 0 }, 0.01)).toBe(true);
    expect(shouldRecordPoint(last, { x: 1, y: 1 }, 0.01)).toBe(true);
  });
});

describe("undoLastStroke", () => {
  it("removes the last stroke and returns a NEW array (no mutation)", () => {
    const s0 = stroke({ authorId: "a", seq: 0 });
    const s1 = stroke({ authorId: "a", seq: 1 });
    const original = [s0, s1];

    const result = undoLastStroke(original);

    expect(result).toEqual([s0]);
    expect(original).toHaveLength(2); // unmutated
  });

  it("returns [] when undoing the only stroke", () => {
    expect(undoLastStroke([stroke({ authorId: "a", seq: 0 })])).toEqual([]);
  });

  it("is a no-op on an already-empty array", () => {
    expect(undoLastStroke([])).toEqual([]);
  });
});
