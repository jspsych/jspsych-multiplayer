/**
 * Pure, framework-free core for the draw plugin: the stroke data model, merge/paint-planning
 * logic, and point decimation. None of this touches jsPsych, the DOM, or the multiplayer API — it
 * is plain data in, plain data out, so it can be unit-tested in isolation (mirroring `chat-core.ts`
 * in `plugin-multiplayer-chat`). The thin `index.ts` trial wires these functions to
 * `subscribe`/`push`, the canvas, and pointer events.
 *
 * See `docs/draw-plugin-design.md` for the full design rationale, in particular why:
 *  - points are normalized against a FIXED-aspect-ratio canvas, not independently per axis;
 *  - a full repaint must sort strokes globally by `ts`, not iterate `getAll()`'s per-author order
 *    (destination-out erasing makes paint order a correctness property, not cosmetic);
 *  - incremental rendering must walk forward through EVERY unseen stroke per author, not just look
 *    at "the latest" one (subscribe callbacks can skip intermediate states); and
 *  - undo detection must be content-based (a strokeId set), not array-length-based, for the same
 *    reason.
 */

/** A point in canvas-normalized space: both axes 0..1 against the canvas's fixed aspect ratio. */
export interface Point {
  x: number;
  y: number;
}

export type Tool = "pen" | "eraser";

/** One continuous pen-down-to-pen-up stroke. */
export interface Stroke {
  /** `${authorId}#${seq}` — stable identity, mirrors chat's message id scheme. */
  id: string;
  authorId: string;
  /** Per-author monotonic counter (0, 1, 2, …). */
  seq: number;
  points: Point[];
  tool: Tool;
  /** CSS color; irrelevant when `tool === "eraser"`. */
  color: string;
  /** Brush width, normalized against the same fixed dimension as points. */
  width: number;
  /** False while the stroke is still being drawn (may still receive new points); true after pointerup. */
  done: boolean;
  /** `Date.now()` on the author's own clock when the stroke STARTED. Drives global paint order. */
  ts: number;
}

/** A group-session snapshot: participantId -> that participant's pushed data. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** Build the stable stroke id for a given author + sequence number. */
export function makeStrokeId(authorId: string, seq: number): string {
  return `${authorId}#${seq}`;
}

function isPoint(p: unknown): p is Point {
  if (typeof p !== "object" || p === null) return false;
  const pt = p as Record<string, unknown>;
  return typeof pt.x === "number" && typeof pt.y === "number";
}

function isStroke(s: unknown): s is Stroke {
  if (typeof s !== "object" || s === null) return false;
  const st = s as Record<string, unknown>;
  return (
    typeof st.authorId === "string" &&
    typeof st.seq === "number" &&
    Array.isArray(st.points) &&
    st.points.every(isPoint) &&
    (st.tool === "pen" || st.tool === "eraser") &&
    typeof st.color === "string" &&
    typeof st.width === "number" &&
    typeof st.done === "boolean" &&
    typeof st.ts === "number"
  );
}

/**
 * Read one participant's stroke array out of their slot, tolerating a missing slot, a missing key,
 * or malformed entries. Only well-formed `Stroke` objects are returned. `id` is normalized from
 * `authorId`+`seq` so a tampered/missing id can't break de-duplication or lookup elsewhere.
 */
export function readStrokes(slot: Record<string, unknown> | undefined, dataKey: string): Stroke[] {
  const raw = slot?.[dataKey];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isStroke).map((s) => ({ ...s, id: makeStrokeId(s.authorId, s.seq) }));
}

/**
 * Flatten every participant's stroke array from the group snapshot into a single list, globally
 * ordered by `(ts, authorId, seq)`. This is the ONLY correct order to paint in when erasing is in
 * play: an eraser stroke only removes ink painted before it in this order, so any repaint (full or
 * partial) that doesn't use this exact order can resurrect erased ink or erase ink drawn later.
 */
export function orderedStrokes(group: GroupSessionData, dataKey: string): Stroke[] {
  const all: Stroke[] = [];
  for (const authorId of Object.keys(group)) {
    all.push(...readStrokes(group[authorId], dataKey));
  }
  all.sort((a, b) => a.ts - b.ts || compareStrings(a.authorId, b.authorId) || a.seq - b.seq);
  return all;
}

/** Code-unit string comparison — locale-independent so ordering never diverges across clients. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// -------------------------------------------------------------------------------------------------
// Incremental paint planning
// -------------------------------------------------------------------------------------------------

/** What this client has already painted for one author: up through which stroke, how many points. */
export interface AuthorPaintState {
  /** strokeIds this client has painted at least one segment of, in the order first seen. */
  paintedStrokeIds: string[];
  /** How many points of the LAST entry in `paintedStrokeIds` have been painted so far. */
  pointsPaintedOfLast: number;
}

export function emptyPaintState(): AuthorPaintState {
  return { paintedStrokeIds: [], pointsPaintedOfLast: 0 };
}

export type PaintInstruction =
  | { kind: "segment"; stroke: Stroke; fromPointIndex: number }
  | { kind: "full-repaint"; strokes: Stroke[] };

/**
 * Decide what to paint next for ONE author, given their current ordered strokes (oldest first) and
 * what this client has already painted of them. Does not mutate `state` — returns a new state
 * alongside the instructions; the caller applies both.
 *
 * Two cases force a full repaint (of the WHOLE canvas, all authors — see `planRepaint` below) rather
 * than an incremental append:
 *  - a strokeId this client previously painted is no longer present in the author's array (undo);
 *  - `authorStrokes` is otherwise not a superset of what's already been painted in order (defensive;
 *    should not happen absent undo, but a stale/out-of-order snapshot must not paint garbage).
 *
 * Otherwise, returns one segment instruction per stroke from the first unfinished one onward — NOT
 * just the newest stroke — because a subscribe callback can skip intermediate states (the local
 * adapter coalesces signals; JATOS updates can do the same), so a client must be able to catch up
 * across more than one stroke boundary per callback.
 */
export function planAuthorPaint(
  authorStrokes: Stroke[],
  state: AuthorPaintState
): { instructions: PaintInstruction[]; nextState: AuthorPaintState; needsFullRepaint: boolean } {
  const byId = new Map(authorStrokes.map((s) => [s.id, s]));

  for (const paintedId of state.paintedStrokeIds) {
    if (!byId.has(paintedId)) {
      // A stroke we'd already painted vanished — undo. Caller must full-repaint the whole canvas.
      return { instructions: [], nextState: state, needsFullRepaint: true };
    }
  }

  const lastPaintedId = state.paintedStrokeIds[state.paintedStrokeIds.length - 1];
  const lastPaintedIndex = lastPaintedId
    ? authorStrokes.findIndex((s) => s.id === lastPaintedId)
    : -1;

  const instructions: PaintInstruction[] = [];
  const newPaintedIds = [...state.paintedStrokeIds];
  let pointsPaintedOfLast = state.pointsPaintedOfLast;

  for (let i = Math.max(lastPaintedIndex, 0); i < authorStrokes.length; i++) {
    const stroke = authorStrokes[i];
    const isResumingLast = i === lastPaintedIndex;
    const fromPointIndex = isResumingLast ? pointsPaintedOfLast : 0;

    if (fromPointIndex < stroke.points.length) {
      instructions.push({ kind: "segment", stroke, fromPointIndex });
    }

    if (!isResumingLast) {
      newPaintedIds.push(stroke.id);
    }
    pointsPaintedOfLast = stroke.points.length;
  }

  return {
    instructions,
    nextState: { paintedStrokeIds: newPaintedIds, pointsPaintedOfLast },
    needsFullRepaint: false,
  };
}

/** Build the full-repaint instruction (all authors, globally `ts`-ordered) and the fresh paint state. */
export function planRepaint(
  group: GroupSessionData,
  dataKey: string
): { instruction: PaintInstruction; nextStates: Map<string, AuthorPaintState> } {
  const strokes = orderedStrokes(group, dataKey);
  const nextStates = new Map<string, AuthorPaintState>();
  for (const authorId of Object.keys(group)) {
    const own = strokes.filter((s) => s.authorId === authorId);
    if (own.length === 0) continue;
    nextStates.set(authorId, {
      paintedStrokeIds: own.map((s) => s.id),
      pointsPaintedOfLast: own[own.length - 1].points.length,
    });
  }
  return { instruction: { kind: "full-repaint", strokes }, nextStates };
}

// -------------------------------------------------------------------------------------------------
// Point decimation (bounds payload/render growth — see design doc "Payload growth" section)
// -------------------------------------------------------------------------------------------------

/**
 * Whether a candidate point is far enough from the last recorded point to be worth keeping.
 * `minDistance` is in the same normalized units as the points themselves.
 */
export function shouldRecordPoint(
  last: Point | undefined,
  candidate: Point,
  minDistance: number
): boolean {
  if (!last) return true;
  const dx = candidate.x - last.x;
  const dy = candidate.y - last.y;
  return dx * dx + dy * dy >= minDistance * minDistance;
}

// -------------------------------------------------------------------------------------------------
// Undo (own-slot-only — safe by construction, see design doc "Data model")
// -------------------------------------------------------------------------------------------------

/**
 * Remove the most recent stroke from an author's own array (undo). If the last stroke is still
 * in-progress (`done: false`), this drops it entirely rather than partially. Returns a NEW array;
 * the input is not mutated.
 */
export function undoLastStroke(ownStrokes: Stroke[]): Stroke[] {
  return ownStrokes.slice(0, -1);
}
