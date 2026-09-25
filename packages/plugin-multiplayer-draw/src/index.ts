import {
  getMultiplayer,
  isMultiplayerError,
  MultiplayerOutcome,
  outcomeOf,
  remainingParticipants,
} from "@jspsych-multiplayer/utils";
import {
  GroupSessionData,
  JsPsych,
  JsPsychPlugin,
  ParameterType,
  PresenceData,
  TrialType,
} from "jspsych";

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
    /**
     * How often (ms) an in-progress stroke's points are written to the group session. Each write
     * serializes this participant's whole stroke array and redraws subscribers, so this bounds that
     * work; the multiplayer API separately sends at most one write to the backend at a time.
     */
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
     * Predicate `(group, presence) => boolean` evaluated on every update; the trial ends as soon as
     * it returns true. `group` holds this trial's data; both arguments are frozen snapshots, so
     * don't modify them.
     */
    end_when: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /**
     * Show the list of participants in the group session. Participants whose connection dropped
     * are marked "(away)", and those who have left the study are marked "(left)".
     */
    show_roster: {
      type: ParameterType.BOOL,
      default: false,
    },
    /**
     * How to label each participant in the roster. `(participantId, group, presence) => string`.
     * Defaults to showing the raw participant id; supply this to show display names. `group` holds
     * this trial's data, so read a name an earlier trial wrote from the session scope, e.g.
     * `(id) => jsPsych.multiplayer.get(id, { scope: "session" })?.name ?? id`. Only used when
     * `show_roster` is true.
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
    /**
     * End the trial when another participant leaves the study (their presence becomes `left`):
     * a member of the sealed group, or, without one, a participant who was connected when the
     * trial started. The trial then ends with `multiplayer_outcome: "participant_left"`.
     */
    end_on_participant_left: {
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
    /**
     * How the trial ended: `"completed"` (by one of its end conditions), `"participant_left"`,
     * `"connection_lost"`, or `"cancelled"` (the experiment disconnected during the trial).
     */
    multiplayer_outcome: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /** The participant whose departure ended the trial, or null. */
    left_participant: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /**
     * Which end condition completed the trial: `"duration"`, `"button"`, or `"condition"`
     * (`end_when`). Null when the trial didn't complete (see `multiplayer_outcome`).
     */
    ended_by: {
      type: ParameterType.STRING,
      default: undefined,
    },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;
type EndCondition = "duration" | "button" | "condition";

/** The group-session field each participant keeps their stroke array under. */
const STROKES_KEY = "draw_strokes";

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
 * only ever removes this participant's own last stroke. The trial also ends when another
 * participant leaves the study (unless `end_on_participant_left` is false) or when this
 * participant's connection is lost for good.
 *
 * Strokes live in the trial's own part of the shared data, so each draw trial starts with a blank
 * canvas. Give several draw trials the same `multiplayer_scope` to keep drawing on one canvas.
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
    const api = getMultiplayer(this.jsPsych, "multiplayer-draw");
    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "multiplayer-draw: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.multiplayer.connect(adapter)) before this trial runs.",
      );
    }
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
          "way to end. Provide at least one end condition.",
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
                    c,
                  )}" aria-label="Color ${escapeAttr(c)}"></button>`,
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
                    4 + (w / Math.max(...brushSizes, 1e-9)) * 14,
                  )}px;height:${Math.round(
                    4 + (w / Math.max(...brushSizes, 1e-9)) * 14,
                  )}px;border-radius:50%;background:currentColor"></span></button>`,
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
      ".jspsych-multiplayer-draw-canvas-wrap",
    ) as HTMLElement;
    const canvas = display_element.querySelector(
      ".jspsych-multiplayer-draw-canvas",
    ) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    // Suppress text selection and touch scrolling/panning on the canvas so a drag always draws
    // rather than selecting or scrolling the page. (Complements preventDefault in onPointerDown.)
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    (canvas.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = "none";
    const roster = display_element.querySelector(
      ".jspsych-multiplayer-draw-roster",
    ) as HTMLElement | null;
    const endButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-end",
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
    // This participant's strokes, kept locally because an in-progress stroke gains points between
    // writes. Seeded from our slot (e.g. after a reload) with fresh copies: slot data is frozen,
    // and these strokes are modified (redo updates `ts`).
    let ownStrokes: Stroke[] = readStrokes(api.get(me), STROKES_KEY).map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ ...point })),
    }));
    let undoneStrokes: Stroke[] = [];
    let nextSeq = ownStrokes.reduce((max, s) => Math.max(max, s.seq), -1) + 1;
    let activeStroke: Stroke | null = null;
    // `number`, not ReturnType<typeof setTimeout>: pluginAPI.setTimeout returns a numeric handle.
    let pushTimer: number | null = null;

    // Per-author record of what THIS client has already painted, for incremental rendering.
    let paintStates = new Map<string, AuthorPaintState>();

    const start = performance.now();
    let ended = false;
    // `number`, not ReturnType<typeof setTimeout>: pluginAPI.setTimeout returns a numeric handle.
    let endTimer: number | null = null;
    let resizeTimer: number | null = null;

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
      const { instruction, nextStates } = planRepaint(group, STROKES_KEY);
      if (instruction.kind === "full-repaint") {
        for (const stroke of instruction.strokes) strokeSegment(stroke, 0);
      }
      paintStates = nextStates;
      if (roster) updateRoster(group, api.presence());
    }

    function applyUpdate(group: GroupSessionData, presence: PresenceData) {
      let needsFull = false;
      const pending: Array<{ stroke: Stroke; fromPointIndex: number }> = [];

      for (const authorId of Object.keys(group)) {
        // Skip our own slot: our strokes are painted as the pointer moves, so the notification that
        // follows each of our own writes would repaint the same segments a second time (wasted
        // work, and for any future non-opaque brush it would darken overlaps). Our own undo/redo
        // repaint directly, and a peer-triggered full repaint below still paints everyone.
        if (authorId === me) continue;
        const strokes = readStrokes(group[authorId], STROKES_KEY);
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
      if (roster) updateRoster(group, presence);
    }

    // The group as this client should see it right now: everyone's latest data with our own
    // `ownStrokes` on top. Between write ticks, an in-progress stroke has points that haven't been
    // written yet, so a full repaint from this keeps its tail from vanishing until the next write.
    function localGroup(): GroupSessionData {
      const group = api.getAll();
      return { ...group, [me]: { ...(group[me] ?? {}), [STROKES_KEY]: ownStrokes } };
    }

    function updateRoster(group: GroupSessionData, presence: PresenceData) {
      if (!roster) return;
      // This participant first, then everyone else in the session
      const ids = [...new Set([me, ...Object.keys(group), ...Object.keys(presence)])];
      const labels = ids.map((id) => {
        let label = id;
        if (typeof trial.roster_label === "function") {
          try {
            label = String(trial.roster_label(id, group, presence));
          } catch {
            // A throwing label function must not break rendering — fall back to the raw id.
          }
        }
        const status = id === me ? "connected" : presence[id];
        return label + (status === "away" ? " (away)" : status === "left" ? " (left)" : "");
      });
      roster.textContent = `Participants: ${labels.join(", ")}`;
    }

    // --- Pushing (throttled while a stroke is active) --------------------------------------------
    function flushPush() {
      // Always writes the author's FULL current array, so the write is idempotent and order-
      // insensitive: core coalesces updates issued while one is in flight into a single follow-up
      // write, and the surviving one still carries every point drawn so far.
      // The core retries a failed write itself, and a write only rejects once the session has
      // closed, which ends the trial.
      api.update({ [STROKES_KEY]: ownStrokes }).catch(() => {});
    }

    // Tick the in-progress stroke's pushes with a self-rescheduling `pluginAPI.setTimeout`, NOT a
    // raw `setInterval`: jsPsych clears the timers it registered when a trial is ended from the
    // outside (abortExperiment / endCurrentTimeline / a forced finishTrial), and it cancels
    // multiplayer subscriptions there too. A raw interval would survive all of that — and an abort
    // mid-stroke never runs `end()` and never delivers a pointerup (the canvas is gone), so it
    // would go on pushing to a finished experiment forever. Rescheduling from inside the tick
    // (rather than one registration up front) keeps every future tick inside jsPsych's registry.
    const schedulePushTick = () => {
      pushTimer = this.jsPsych.pluginAPI.setTimeout(
        () => {
          if (ended) {
            pushTimer = null;
            return;
          }
          flushPush();
          schedulePushTick();
        },
        Math.max(1, trial.push_interval_ms),
      );
    };

    /** Stop the push ticking. `pushTimer != null` only ever holds while a stroke is in progress. */
    const stopPushTicking = () => {
      if (pushTimer != null) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
    };

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
      if (pushTimer == null) schedulePushTick();
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
      stopPushTicking();
      flushPush(); // final flush so the tail and done:true are not stuck behind the last tick
    };

    const onPointerUp = () => endActiveStroke();
    const onPointerCancel = () => endActiveStroke();

    // --- Toolbar --------------------------------------------------------------------------------
    const colorButtons = [...display_element.querySelectorAll(".jspsych-multiplayer-draw-color")];
    const sizeButtons = [...display_element.querySelectorAll(".jspsych-multiplayer-draw-size")];
    const penButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-pen",
    ) as HTMLButtonElement;
    const eraserButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-eraser",
    ) as HTMLButtonElement;
    const undoButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-undo",
    ) as HTMLButtonElement;
    const redoButton = display_element.querySelector(
      ".jspsych-multiplayer-draw-redo",
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
      stopPushTicking(); // stop the in-progress stroke's throttle timer, if any
      activeStroke = null; // drop the in-progress stroke itself, before any further push
      if (ownStrokes.length > 0) {
        const undone = ownStrokes[ownStrokes.length - 1];
        undoneStrokes.push(undone);
        ownStrokes = undoLastStroke(ownStrokes);
      }
      doFullRepaint(localGroup()); // our own writes don't repaint us, so repaint here
      flushPush();
      updateUndoRedoButtons();
    };
    undoButton.addEventListener("click", onUndoClick);

    const onRedoClick = () => {
      if (ended) return;
      const strokeToRestore = undoneStrokes.pop();
      if (!strokeToRestore) return;
      strokeToRestore.ts = Date.now(); // update timestamp so it renders on top collaboratively
      ownStrokes.push(strokeToRestore);
      doFullRepaint(localGroup()); // our own writes don't repaint us, so repaint here
      flushPush();
      updateUndoRedoButtons();
    };
    redoButton.addEventListener("click", onRedoClick);

    // --- Resize (forces a full repaint — normalized coordinates survive, the paint-progress cursor
    // tracking does not, since the pixel canvas was cleared) -------------------------------------
    const onResize = () => {
      if (resizeTimer != null) clearTimeout(resizeTimer);
      resizeTimer = this.jsPsych.pluginAPI.setTimeout(() => {
        sizeCanvas();
        doFullRepaint(localGroup());
      }, 100);
    };
    window.addEventListener("resize", onResize);

    // --- Ending -------------------------------------------------------------------------------
    const end = (
      outcome: MultiplayerOutcome,
      endedBy: EndCondition | null,
      leftParticipant: string | null = null,
    ) => {
      if (ended) return;
      ended = true;
      endActiveStroke(); // stops the push ticking too, but only when a stroke was active…
      stopPushTicking(); // …so stop it unconditionally rather than lean on that invariant.
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

      // Copied so trial data doesn't hold the multiplayer API's frozen arrays
      const merged: Stroke[] = JSON.parse(
        JSON.stringify(orderedStrokes(localGroup(), STROKES_KEY)),
      );
      this.jsPsych.finishTrial({
        ...(trial.store_full_strokes ? { strokes: merged } : {}),
        stroke_count: merged.length,
        strokes_drawn: merged.filter((s) => s.authorId === me).length,
        draw_time: Math.round(performance.now() - start),
        multiplayer_outcome: outcome,
        left_participant: leftParticipant,
        ended_by: endedBy,
      });
    };
    const complete = (endedBy: EndCondition) => end("completed", endedBy);
    const onEndClick = () => complete("button");
    endButton?.addEventListener("click", onEndClick);

    // --- Wire up --------------------------------------------------------------------------------
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);

    sizeCanvas();
    // Paint everything, including our own existing strokes, which the incremental painter skips
    doFullRepaint(localGroup());

    // subscribe() calls back at once with the current state, so end_when is checked before the
    // trial is visible. The subscription ends with the trial; `ended` covers the moment between
    // finishTrial() and then.
    api.subscribe((group, presence) => {
      if (ended) return;
      try {
        applyUpdate(group, presence);
      } catch {
        // A bad paint frame must not tear down the subscription or the trial.
      }
      let shouldEnd = false;
      try {
        shouldEnd =
          typeof trial.end_when === "function" && Boolean(trial.end_when(group, presence));
      } catch {
        // A throwing end_when predicate must not propagate into the session's notify loop.
      }
      if (shouldEnd) complete("condition");
    });

    // A wait that never succeeds, for how the trial can end from outside: it fails when a
    // participant it depends on leaves, or when the session closes. The trial ending cancels it too
    // (and aborting the experiment does), which must not end anything.
    if (!ended) {
      api
        .wait(() => false, {
          participants: trial.end_on_participant_left ? remainingParticipants(api) : [],
        })
        .catch((error) => {
          const outcome = outcomeOf(error);
          if (ended || outcome === null) return;
          if (outcome === "cancelled" && api.status !== "closed") return;
          end(outcome, null, isMultiplayerError(error) ? (error.participantId ?? null) : null);
        });
    }

    if (hasDuration && !ended) {
      endTimer = this.jsPsych.pluginAPI.setTimeout(
        () => complete("duration"),
        trial.duration as number,
      );
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
