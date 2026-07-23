import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import {
  AuthorPaintState,
  Point,
  Stroke,
  Tool,
  emptyPaintState,
  makeStrokeId,
  orderedStrokes,
  planAuthorPaint,
  planRepaint,
  readStrokes,
  shouldRecordPoint,
  undoLastStroke,
} from "./draw-core";
import {
  GroupSessionData,
  MultiplayerApiLike,
  Unsubscribe,
  resolveMultiplayerApi,
} from "./multiplayer-api";

const DEFAULT_COLORS = ["#1a1a1a", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
const DEFAULT_BRUSH_SIZES = [0.004, 0.01, 0.02]; // normalized against canvas width

const info = <const>{
  name: "multiplayer-draw",
  version: version,
  parameters: {
    /** Instructions rendered above the canvas (experimenter-authored, so HTML is allowed). */
    prompt: {
      type: ParameterType.HTML_STRING,
      default: "",
    },
    /**
     * Group-session field this trial stores its stroke array under. Namespacing keeps the drawing
     * from colliding with other data a participant has pushed (e.g. a role), and lets two draw
     * trials in one timeline keep separate canvases.
     */
    data_key: {
      type: ParameterType.STRING,
      default: "draw_strokes",
    },
    /** Canvas width:height ratio. Fixed and shared across clients so normalized points stay geometrically consistent regardless of each client's viewport. */
    aspect_ratio: {
      type: ParameterType.FLOAT,
      default: 4 / 3,
    },
    /** Swatches offered in the color picker. First color is selected by default. */
    colors: {
      type: ParameterType.STRING,
      array: true,
      default: DEFAULT_COLORS,
    },
    /** Brush width choices, normalized against canvas width. Middle value is selected by default. */
    brush_sizes: {
      type: ParameterType.FLOAT,
      array: true,
      default: DEFAULT_BRUSH_SIZES,
    },
    /** Minimum normalized distance between recorded points (decimation) — bounds payload/render growth. */
    min_point_distance: {
      type: ParameterType.FLOAT,
      default: 0.004,
    },
    /** How often (ms) an in-progress stroke's points are pushed to the group session. */
    push_interval_ms: {
      type: ParameterType.INT,
      default: 60,
    },
    /**
     * Auto-end the trial after this many milliseconds. Null (or non-positive) means no time limit —
     * in which case you must provide `end_button_label` and/or `end_when`, or the trial can never end.
     */
    duration: {
      type: ParameterType.INT,
      default: null,
    },
    /** If set, show a button with this label that ends the trial when clicked. Null hides it. */
    end_button_label: {
      type: ParameterType.STRING,
      default: null,
    },
    /**
     * Predicate `(group) => boolean` evaluated against the full group session on every update; the
     * trial ends as soon as it returns true.
     */
    end_when: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /** Show the list of participants currently present in the group session. */
    show_roster: {
      type: ParameterType.BOOL,
      default: false,
    },
    /**
     * How to label each participant in the roster. `(participantId, group) => string`. Defaults to
     * showing the raw participant id; supply this to show display names (e.g. read a `name` field a
     * lobby pushed into each participant's slot). Only used when `show_roster` is true.
     */
    roster_label: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /** Include the full stroke arrays (with points) in trial data. Set false to store only counts. */
    store_full_strokes: {
      type: ParameterType.BOOL,
      default: true,
    },
  },
  data: {
    /** The merged, `ts`-ordered stroke list as this client saw it when the trial ended (omitted if `store_full_strokes` is false). */
    strokes: {
      type: ParameterType.OBJECT,
      array: true,
      default: undefined,
    },
    /** Total number of distinct strokes across all participants at trial end. */
    stroke_count: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** How many strokes this participant drew (after any undos). */
    strokes_drawn: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** Time from trial start until the trial ended, in milliseconds. */
    draw_time: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** What ended the trial: `"duration"`, `"button"`, or `"condition"`. */
    ended_by: {
      type: ParameterType.STRING,
      default: undefined,
    },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;
type EndReason = "duration" | "button" | "condition";

/**
 * **multiplayer-draw**
 *
 * A real-time collaborative drawing canvas for multiplayer experiments. Like
 * `plugin-multiplayer-chat`, it stays open and subscribes to the shared group session — but where
 * chat pushes once per message (sparse, human-paced), this pushes continuously while a stroke is
 * active, making it the first plugin that stresses the multiplayer API's `subscribe` primitive at a
 * genuinely real-time rate.
 *
 * Every participant draws on one shared canvas; strokes from everyone appear live on everyone's
 * screen. Includes pen/eraser tools, a fixed color palette, brush sizes, and an undo button that
 * only ever removes this participant's own last stroke.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-draw multiplayer-draw plugin documentation}
 */
class MultiplayerDrawPlugin implements JsPsychPlugin<Info> {
  static info = info;

  constructor(private jsPsych: JsPsych) {}

  // Deliberately synchronous (returns undefined, NOT a Promise) — see plugin-multiplayer-chat for
  // why: jsPsych races a returned promise against `finishTrial()`.
  trial(display_element: HTMLElement, trial: TrialType<Info>) {
    const api = resolveMultiplayerApi(this.jsPsych);
    const me = api.participantId;
    const dataKey = trial.data_key;
    const aspectRatio = trial.aspect_ratio > 0 ? trial.aspect_ratio : 4 / 3;
    const colors = trial.colors.length > 0 ? trial.colors : DEFAULT_COLORS;
    const brushSizes = trial.brush_sizes.length > 0 ? trial.brush_sizes : DEFAULT_BRUSH_SIZES;

    const hasDuration = typeof trial.duration === "number" && trial.duration > 0;
    // An empty-string label is treated as "no button" — it would otherwise render a blank-but-live
    // end button and silently suppress the no-end-condition warning below.
    const hasEndButton = trial.end_button_label != null && trial.end_button_label !== "";
    if (!hasDuration && !hasEndButton && typeof trial.end_when !== "function") {
      console.warn(
        "multiplayer-draw: no `duration`, `end_button_label`, or `end_when` set — the trial has no " +
          "way to end. Provide at least one end condition."
      );
    }

    // --- Render the shell -----------------------------------------------------------------------
    display_element.innerHTML = `
      <div class="jspsych-multiplayer-draw">
        ${trial.prompt ? `<div class="jspsych-multiplayer-draw-prompt">${trial.prompt}</div>` : ""}
        <div class="jspsych-multiplayer-draw-toolbar">
          <span class="jspsych-multiplayer-draw-colors">
            ${colors
              .map(
                (c, i) =>
                  `<button type="button" class="jspsych-multiplayer-draw-color${
                    i === 0 ? " is-selected" : ""
                  }" data-color="${escapeAttr(c)}" style="background:${escapeAttr(
                    c
                  )}" aria-label="Color ${escapeAttr(c)}"></button>`
              )
              .join("")}
          </span>
          <span class="jspsych-multiplayer-draw-sizes">
            ${brushSizes
              .map(
                (w, i) =>
                  // The size indicator is a CSS circle sized in px (not a ● glyph, whose ink isn't
                  // centered in its line box), so it stays perfectly centered at any brush size.
                  `<button type="button" class="jspsych-multiplayer-draw-size${
                    i === Math.floor(brushSizes.length / 2) ? " is-selected" : ""
                  }" data-width="${w}"><span class="jspsych-multiplayer-draw-dot" style="display:block;width:${Math.round(
                    4 + (w / Math.max(...brushSizes, 1e-9)) * 14
                  )}px;height:${Math.round(
                    4 + (w / Math.max(...brushSizes, 1e-9)) * 14
                  )}px;border-radius:50%;background:currentColor"></span></button>`
              )
              .join("")}
          </span>
          <button type="button" class="jspsych-multiplayer-draw-pen is-selected">Pen</button>
          <button type="button" class="jspsych-multiplayer-draw-eraser">Eraser</button>
          <button type="button" class="jspsych-multiplayer-draw-undo">Undo</button>
          <button type="button" class="jspsych-multiplayer-draw-redo">Redo</button>
        </div>
        ${trial.show_roster ? `<div class="jspsych-multiplayer-draw-roster"></div>` : ""}
        <div class="jspsych-multiplayer-draw-canvas-wrap">
          <canvas class="jspsych-multiplayer-draw-canvas"></canvas>
        </div>
        ${
          hasEndButton ? `<button type="button" class="jspsych-multiplayer-draw-end"></button>` : ""
        }
      </div>`;

    const canvasWrap = display_element.querySelector(
      ".jspsych-multiplayer-draw-canvas-wrap"
    ) as HTMLElement;
    const canvas = display_element.querySelector(
      ".jspsych-multiplayer-draw-canvas"
    ) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    // Suppress text selection and touch scrolling/panning on the canvas so a drag always draws
    // rather than selecting or scrolling the page. (Complements preventDefault in onPointerDown.)
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    (canvas.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = "none";
    const roster = display_element.querySelector(
      ".jspsych-multiplayer-draw-roster"
    ) as HTMLElement | null;
    const endButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-end"
    ) as HTMLButtonElement | null;
    if (endButton && hasEndButton) endButton.textContent = trial.end_button_label as string;

    // --- Tool state -------------------------------------------------------------------------------
    let currentColor = colors[0];
    let currentWidth = brushSizes[Math.floor(brushSizes.length / 2)];
    let currentTool: Tool = "pen";

    // --- Canvas sizing (fixed aspect ratio, letterboxed) -------------------------------------------
    // Both axes normalize against `canvas.width` (the fixed dimension) — NOT independently against
    // width and height — so a fixed aspect ratio keeps geometry consistent across differently-sized
    // client viewports.
    function sizeCanvas() {
      const availW = Math.max(1, canvasWrap.clientWidth || 320);
      const availH = Math.max(1, canvasWrap.clientHeight || availW / aspectRatio);
      let w = availW;
      let h = w / aspectRatio;
      if (h > availH) {
        h = availH;
        w = h * aspectRatio;
      }
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;
    }

    function toPixel(p: Point): Point {
      return { x: p.x * canvas.width, y: p.y * canvas.width };
    }

    function toNormalized(px: number, py: number): Point {
      return { x: px / canvas.width, y: py / canvas.width };
    }

    // --- Own stroke state ---------------------------------------------------------------------
    let ownStrokes: Stroke[] = readStrokes(api.get(me), dataKey);
    let undoneStrokes: Stroke[] = [];
    let nextSeq = ownStrokes.reduce((max, s) => Math.max(max, s.seq), -1) + 1;
    let activeStroke: Stroke | null = null;
    let pushTimer: ReturnType<typeof setInterval> | null = null;

    // Per-author record of what THIS client has already painted, for incremental rendering.
    let paintStates = new Map<string, AuthorPaintState>();

    const start = performance.now();
    let ended = false;
    let unsubscribe: Unsubscribe | null = null;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    // --- Painting -------------------------------------------------------------------------------
    function strokeSegment(stroke: Stroke, fromPointIndex: number) {
      const points = stroke.points;
      if (points.length === 0) return;
      if (points.length === 1) {
        // A single-point stroke (a tap with no drag) — render as a dot, once.
        if (fromPointIndex === 0) drawDot(stroke, points[0]);
        return;
      }
      const startIndex = Math.max(0, fromPointIndex - 1);
      ctx.save();
      ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = Math.max(1, stroke.width * canvas.width);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      const first = toPixel(points[startIndex]);
      ctx.moveTo(first.x, first.y);
      for (let i = startIndex + 1; i < points.length; i++) {
        const p = toPixel(points[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawDot(stroke: Stroke, point: Point) {
      const p = toPixel(point);
      ctx.save();
      ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
      ctx.fillStyle = stroke.color;
      const r = Math.max(0.5, (stroke.width * canvas.width) / 2);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function doFullRepaint(group: GroupSessionData) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const { instruction, nextStates } = planRepaint(group, dataKey);
      if (instruction.kind === "full-repaint") {
        for (const stroke of instruction.strokes) strokeSegment(stroke, 0);
      }
      paintStates = nextStates;
      if (roster) updateRoster(group);
    }

    function applyUpdate(group: GroupSessionData) {
      let needsFull = false;
      const pending: Array<{ stroke: Stroke; fromPointIndex: number }> = [];

      for (const authorId of Object.keys(group)) {
        // Skip our own slot: our strokes are painted optimistically as the pointer moves, so the
        // echo of our own push would repaint the same segments a second time (wasted work, and for
        // any future non-opaque brush it would darken overlaps). Our own undo repaints directly via
        // onUndoClick, and a peer-triggered full repaint below still paints everyone including us.
        if (authorId === me) continue;
        const strokes = readStrokes(group[authorId], dataKey);
        // NB: do NOT early-continue on an empty array. When a peer undoes their LAST stroke their
        // slot becomes empty, and skipping here would leave that stroke painted on our canvas forever
        // (planAuthorPaint below is what detects the vanished strokeId and asks for a full repaint).
        const state = paintStates.get(authorId) ?? emptyPaintState();
        const result = planAuthorPaint(strokes, state);
        if (result.needsFullRepaint) {
          needsFull = true;
          break;
        }
        paintStates.set(authorId, result.nextState);
        for (const instr of result.instructions) {
          if (instr.kind === "segment")
            pending.push({ stroke: instr.stroke, fromPointIndex: instr.fromPointIndex });
        }
      }

      if (needsFull) {
        doFullRepaint(localGroup());
        return;
      }
      for (const p of pending) strokeSegment(p.stroke, p.fromPointIndex);
      if (roster) updateRoster(group);
    }

    // The group snapshot as this client should see it right now, with our own (possibly un-pushed,
    // mid-stroke) `ownStrokes` overlaid on top of the last-pushed session. Using this for a full
    // repaint keeps an in-progress stroke's not-yet-pushed tail from vanishing until the next push.
    function localGroup(): GroupSessionData {
      return { ...api.getAll(), [me]: { ...(api.get(me) ?? {}), [dataKey]: ownStrokes } };
    }

    function updateRoster(group: GroupSessionData) {
      if (!roster) return;
      const labels = Object.keys(group).map((id) => {
        if (typeof trial.roster_label === "function") {
          try {
            return String(trial.roster_label(id, group));
          } catch {
            // A throwing label function must not break rendering — fall back to the raw id.
          }
        }
        return id;
      });
      roster.textContent = labels.length ? `Present: ${labels.join(", ")}` : "";
    }

    // --- Pushing (throttled while a stroke is active) --------------------------------------------
    function flushPush() {
      api.update({ [dataKey]: ownStrokes }).catch(() => {
        // Self-healing: the NEXT scheduled push resends the full current array, so a dropped/failed
        // push here is repaired automatically. No manual retry needed.
        showSendError();
      });
    }

    function showSendError() {
      let note = display_element.querySelector(".jspsych-multiplayer-draw-error") as HTMLElement;
      if (!note) {
        note = document.createElement("div");
        note.className = "jspsych-multiplayer-draw-error";
        canvasWrap.after(note);
      }
      note.textContent = "Connection trouble — retrying automatically.";
    }

    // --- Pointer handling ---------------------------------------------------------------------
    function pointFromEvent(e: PointerEvent): Point {
      const rect = canvas.getBoundingClientRect();
      return toNormalized(e.clientX - rect.left, e.clientY - rect.top);
    }

    const onPointerDown = (e: PointerEvent) => {
      if (ended) return;
      // Claim the gesture: without this, pressing on the canvas while text elsewhere on the page is
      // selected is interpreted as a native drag of that selection (the cursor turns into a "no"
      // symbol and only single dots register). preventDefault suppresses that drag.
      e.preventDefault();
      // Not implemented in every test/DOM environment (e.g. jsdom) — real browsers all support it.
      canvas.setPointerCapture?.(e.pointerId);
      const p = pointFromEvent(e);
      undoneStrokes = []; // clear redo stack on new draw
      activeStroke = {
        id: makeStrokeId(me, nextSeq),
        authorId: me,
        seq: nextSeq++,
        points: [p],
        tool: currentTool,
        color: currentColor,
        width: currentWidth,
        done: false,
        ts: Date.now(),
      };
      ownStrokes.push(activeStroke);
      drawDot(activeStroke, p); // optimistic local feedback
      if (pushTimer == null) {
        pushTimer = setInterval(flushPush, Math.max(1, trial.push_interval_ms));
      }
      updateUndoRedoButtons();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (ended || !activeStroke) return;
      const p = pointFromEvent(e);
      const last = activeStroke.points[activeStroke.points.length - 1];
      if (!shouldRecordPoint(last, p, trial.min_point_distance)) return;
      const fromIndex = activeStroke.points.length;
      activeStroke.points.push(p);
      strokeSegment(activeStroke, fromIndex); // optimistic local feedback, drawn immediately
    };

    const endActiveStroke = () => {
      if (!activeStroke) return;
      activeStroke.done = true;
      activeStroke = null;
      if (pushTimer != null) {
        clearInterval(pushTimer);
        pushTimer = null;
      }
      flushPush(); // final flush so the tail and done:true are not stuck behind the last interval tick
    };

    const onPointerUp = () => endActiveStroke();
    const onPointerCancel = () => endActiveStroke();

    // --- Toolbar --------------------------------------------------------------------------------
    const colorButtons = [...display_element.querySelectorAll(".jspsych-multiplayer-draw-color")];
    const sizeButtons = [...display_element.querySelectorAll(".jspsych-multiplayer-draw-size")];
    const penButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-pen"
    ) as HTMLButtonElement;
    const eraserButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-eraser"
    ) as HTMLButtonElement;
    const undoButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-undo"
    ) as HTMLButtonElement;
    const redoButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-redo"
    ) as HTMLButtonElement;

    const updateUndoRedoButtons = () => {
      if (undoButton) {
        undoButton.disabled = ownStrokes.length === 0;
      }
      if (redoButton) {
        redoButton.disabled = undoneStrokes.length === 0;
      }
    };
    updateUndoRedoButtons();

    const onPenClick = () => {
      currentTool = "pen";
      penButton.classList.add("is-selected");
      eraserButton.classList.remove("is-selected");
    };
    const onEraserClick = () => {
      currentTool = "eraser";
      eraserButton.classList.add("is-selected");
      penButton.classList.remove("is-selected");
    };
    penButton.addEventListener("click", onPenClick);
    eraserButton.addEventListener("click", onEraserClick);

    colorButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        currentColor = (btn as HTMLElement).dataset.color as string;
        colorButtons.forEach((b) => b.classList.remove("is-selected"));
        btn.classList.add("is-selected");
        onPenClick(); // picking a color implies you want to draw with it
      });
    });
    sizeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        currentWidth = Number((btn as HTMLElement).dataset.width);
        sizeButtons.forEach((b) => b.classList.remove("is-selected"));
        btn.classList.add("is-selected");
      });
    });

    // Undo: removes ONLY this participant's own last stroke (or the in-progress one). Safe by
    // construction — a participant only ever writes their own slot.
    const onUndoClick = () => {
      if (ended) return;
      if (pushTimer != null) {
        clearInterval(pushTimer); // stop the in-progress stroke's throttle timer, if any
        pushTimer = null;
      }
      activeStroke = null; // drop the in-progress stroke itself, before any further push
      if (ownStrokes.length > 0) {
        const undone = ownStrokes[ownStrokes.length - 1];
        undoneStrokes.push(undone);
        ownStrokes = undoLastStroke(ownStrokes);
      }
      doFullRepaint(localGroup()); // instant local feedback; peers repaint when the push echoes
      api.update({ [dataKey]: ownStrokes }).catch(() => showSendError());
      updateUndoRedoButtons();
    };
    undoButton.addEventListener("click", onUndoClick);

    const onRedoClick = () => {
      if (ended) return;
      const strokeToRestore = undoneStrokes.pop();
      if (!strokeToRestore) return;
      strokeToRestore.ts = Date.now(); // update timestamp so it renders on top collaboratively
      ownStrokes.push(strokeToRestore);
      doFullRepaint(localGroup()); // instant local feedback; peers repaint when the push echoes
      api.update({ [dataKey]: ownStrokes }).catch(() => showSendError());
      updateUndoRedoButtons();
    };
    redoButton.addEventListener("click", onRedoClick);

    // --- Resize (forces a full repaint — normalized coordinates survive, the paint-progress cursor
    // tracking does not, since the pixel canvas was cleared) -------------------------------------
    const onResize = () => {
      if (resizeTimer != null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        sizeCanvas();
        doFullRepaint(localGroup());
      }, 100);
    };
    window.addEventListener("resize", onResize);

    // --- Ending -------------------------------------------------------------------------------
    const end = (reason: EndReason) => {
      if (ended) return;
      ended = true;
      endActiveStroke();
      unsubscribe?.();
      if (endTimer != null) clearTimeout(endTimer);
      if (resizeTimer != null) clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      penButton.removeEventListener("click", onPenClick);
      eraserButton.removeEventListener("click", onEraserClick);
      undoButton.removeEventListener("click", onUndoClick);
      redoButton.removeEventListener("click", onRedoClick);
      endButton?.removeEventListener("click", onEndClick);

      const group = api.getAll();
      const merged = orderedStrokes(group, dataKey);
      this.jsPsych.finishTrial({
        ...(trial.store_full_strokes ? { strokes: merged } : {}),
        stroke_count: merged.length,
        strokes_drawn: merged.filter((s) => s.authorId === me).length,
        draw_time: Math.round(performance.now() - start),
        ended_by: reason,
      });
    };
    const onEndClick = () => end("button");
    endButton?.addEventListener("click", onEndClick);

    // --- Wire up --------------------------------------------------------------------------------
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);

    sizeCanvas();
    doFullRepaint(api.getAll());

    if (typeof trial.end_when === "function" && trial.end_when(api.getAll())) {
      end("condition");
      return;
    }

    unsubscribe = api.subscribe((group) => {
      if (ended) return;
      try {
        applyUpdate(group);
      } catch {
        // A bad paint frame must not tear down the subscription or the trial.
      }
      let shouldEnd = false;
      try {
        shouldEnd = typeof trial.end_when === "function" && Boolean(trial.end_when(group));
      } catch {
        // A throwing end_when predicate must not propagate into the adapter's notify loop.
      }
      if (shouldEnd) end("condition");
    });

    if (hasDuration) {
      endTimer = setTimeout(() => end("duration"), trial.duration as number);
    }
  }
}

/** Escape a string for safe interpolation into a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default MultiplayerDrawPlugin;
