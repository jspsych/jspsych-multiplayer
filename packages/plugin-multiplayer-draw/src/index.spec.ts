import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions, GroupSessionData, PresenceData } from "jspsych";

import { MemoryHub } from "../../../test-utils/memory-backend";
import * as drawCore from "./draw-core";
import MultiplayerDrawPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Every test runs the real jsPsych multiplayer session over the in-memory backend in test-utils, so
// reads are frozen snapshots, own writes show up at once (and notify subscribers synchronously),
// and presence is real. `makeApi` wraps that session with a few test conveniences:
//   - `pushAs(id, data)` writes a peer's slot, as if another connected participant had written it.
//   - `failNextWrite = true` makes this participant's next write to the backend reject.
// ---------------------------------------------------------------------------------------------------

async function makeApi(participantId = "me", connect?: ConnectOptions) {
  const hub = new MemoryHub();
  const joined = await hub.join(participantId, { connect });
  const multiplayer = joined.jsPsych.multiplayer;
  const connection = joined.connection;
  const send = connection.pushImpl;
  return {
    hub,
    connection,
    multiplayer,
    participantId,
    get: (id: string) => multiplayer.get(id),
    getAll: () => multiplayer.getAll(),
    push: (data: Record<string, unknown>) => multiplayer.push(data),
    update: (data: Record<string, unknown>) => multiplayer.update(data),
    pushAs(id: string, data: Record<string, unknown>) {
      if (![...hub.connections].some((c) => c.participantId === id)) {
        // A connected peer with no jsPsych instance of its own
        hub.connections.add({
          participantId: id,
          online: true,
          options: { onChange() {}, onStatus() {} },
        } as never);
      }
      hub.seed(id, data);
    },
    set failNextWrite(fail: boolean) {
      if (!fail) return;
      connection.pushImpl = async () => {
        connection.pushImpl = send;
        throw new Error("network down");
      };
    },
  };
}

type Api = Awaited<ReturnType<typeof makeApi>>;

/**
 * jsPsych double. `pluginAPI.setTimeout` is a real `setTimeout` that also records its handle, and
 * `clearAllTimeouts` drops every recorded one — the same registry jsPsych keeps, so
 * `abortTrialTimers()` reproduces what `abortExperiment()` does to a trial's timers.
 */
function makeJsPsych(api: Api) {
  const finished: Array<Record<string, any>> = [];
  const timeouts: Array<ReturnType<typeof setTimeout>> = [];
  const jsPsych = {
    multiplayer: api.multiplayer,
    finishTrial: (data: Record<string, any>) => finished.push(data),
    pluginAPI: {
      setTimeout: (cb: () => void, ms: number) => {
        const handle = setTimeout(cb, ms);
        timeouts.push(handle);
        return handle as unknown as number;
      },
      clearAllTimeouts: () => {
        for (const handle of timeouts) clearTimeout(handle);
        timeouts.length = 0;
      },
    },
  };
  return { jsPsych, finished, abortTrialTimers: () => jsPsych.pluginAPI.clearAllTimeouts() };
}

const display = () => {
  const el = document.createElement("div");
  // jsdom returns 0 for clientWidth/clientHeight by default; the plugin falls back to sane defaults
  // when this happens (see sizeCanvas), so no override needed for most tests.
  document.body.appendChild(el);
  return el;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Dispatch a pointer-like event on the canvas at a given client (x, y). jsdom has no PointerEvent
 * constructor, so build a MouseEvent (which the plugin only reads clientX/clientY/type from) and
 * stamp a pointerId onto it; jsdom also lacks real layout, so getBoundingClientRect() returns
 * all-zero — client coordinates ARE canvas-local coordinates here. */
function pointerEvent(type: string, x: number, y: number, pointerId = 1) {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(e, "pointerId", { value: pointerId });
  return e as unknown as PointerEvent;
}

function canvasOf(el: HTMLElement) {
  return el.querySelector(".jspsych-multiplayer-draw-canvas") as HTMLCanvasElement;
}

/** Draw a two-point stroke: pointerdown then pointermove then pointerup, each far enough apart to
 * survive decimation at the default min_point_distance. */
function drawStroke(el: HTMLElement, from: [number, number], to: [number, number]) {
  const canvas = canvasOf(el);
  canvas.dispatchEvent(pointerEvent("pointerdown", ...from));
  canvas.dispatchEvent(pointerEvent("pointermove", ...to));
  canvas.dispatchEvent(pointerEvent("pointerup", ...to));
}

const base = {
  prompt: "",
  data_key: "draw_strokes",
  aspect_ratio: 4 / 3,
  colors: ["#111", "#222"],
  brush_sizes: [0.004, 0.01, 0.02],
  min_point_distance: 0.004,
  push_interval_ms: 60,
  duration: null,
  end_button_label: null,
  end_when: null,
  show_roster: false,
  roster_label: null,
  store_full_strokes: true,
  end_on_participant_left: true,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const peerStroke = {
  id: "peer#0",
  authorId: "peer",
  seq: 0,
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 },
  ],
  tool: "pen",
  color: "#000",
  width: 0.01,
  done: true,
  ts: 1,
};

describe("multiplayer-draw plugin", () => {
  it("trial() is synchronous (returns undefined) so jsPsych waits for finishTrial", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);

    const returned = new MultiplayerDrawPlugin(jsPsych as never).trial(display(), {
      ...base,
    } as never);

    expect(returned).toBeUndefined();
  });

  it("drawing a stroke pushes it into my own slot", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
    drawStroke(el, [10, 10], [50, 50]);
    await flush();

    const mine = api.getAll().me.draw_strokes as any[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ authorId: "me", seq: 0, tool: "pen", done: true });
    expect(mine[0].points.length).toBeGreaterThanOrEqual(2);
  });

  it("does not repaint own strokes when the client's own push echoes back (no double-paint)", async () => {
    // Own strokes are painted optimistically as the pointer moves; the subscribe echo of our own
    // push must NOT repaint the same segments. Regression guard for the applyUpdate `authorId === me`
    // skip — without it, each own stroke was painted twice (once optimistically, once on the echo).
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);

    const ctx = canvasOf(el).getContext("2d") as CanvasRenderingContext2D;
    const strokeSpy = jest.spyOn(ctx, "stroke");

    // The session notifies subscribers synchronously on our own writes, so the notification for
    // the pointerup flush has already been delivered by the time drawStroke returns. A two-point
    // stroke paints exactly one segment as it's drawn; the notification would add a second call if
    // own strokes were not skipped.
    drawStroke(el, [10, 10], [50, 50]);
    expect(strokeSpy).toHaveBeenCalledTimes(1);

    await flush();
    expect(strokeSpy).toHaveBeenCalledTimes(1);

    strokeSpy.mockRestore();
  });

  it("drawing preserves unrelated keys in my own slot (the push-replaces-slot crux)", async () => {
    const api = await makeApi();
    await api.push({ role: "proposer" });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
    drawStroke(el, [10, 10], [50, 50]);
    await flush();

    expect(api.getAll().me.role).toBe("proposer");
    expect((api.getAll().me.draw_strokes as any[]).length).toBe(1);
  });

  it("seeds the seq counter past a gap in existing own strokes (no id collision)", async () => {
    const api = await makeApi();
    await api.push({
      draw_strokes: [
        {
          id: "me#0",
          authorId: "me",
          seq: 0,
          points: [{ x: 0, y: 0 }],
          tool: "pen",
          color: "#000",
          width: 0.01,
          done: true,
          ts: 1,
        },
        {
          id: "me#2",
          authorId: "me",
          seq: 2,
          points: [{ x: 0, y: 0 }],
          tool: "pen",
          color: "#000",
          width: 0.01,
          done: true,
          ts: 2,
        },
      ],
    });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
    drawStroke(el, [10, 10], [50, 50]);
    await flush();

    const mine = api.getAll().me.draw_strokes as any[];
    expect(mine).toHaveLength(3);
    expect(mine[2].seq).toBe(3); // max-based seeding, not length-based (length would collide at seq 2)
  });

  it("undo removes only my own last stroke, not a peer's", async () => {
    const api = await makeApi();
    api.pushAs("peer", {
      draw_strokes: [
        {
          id: "peer#0",
          authorId: "peer",
          seq: 0,
          points: [{ x: 0, y: 0 }],
          tool: "pen",
          color: "#000",
          width: 0.01,
          done: true,
          ts: 1,
        },
      ],
    });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
    drawStroke(el, [10, 10], [50, 50]);
    await flush();
    expect((api.getAll().me.draw_strokes as any[]).length).toBe(1);

    (el.querySelector(".jspsych-multiplayer-draw-undo") as HTMLButtonElement).click();
    await flush();

    expect((api.getAll().me.draw_strokes as any[]).length).toBe(0);
    expect((api.getAll().peer.draw_strokes as any[]).length).toBe(1); // untouched
  });

  it("undo on an in-progress stroke discards it entirely and stops its push timer", async () => {
    jest.useFakeTimers();
    try {
      const api = await makeApi();
      const { jsPsych } = makeJsPsych(api);
      const el = display();

      await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
      const canvas = canvasOf(el);
      canvas.dispatchEvent(pointerEvent("pointerdown", 10, 10));
      canvas.dispatchEvent(pointerEvent("pointermove", 50, 50));
      // Never fires pointerup — the stroke is still "active" when undo is clicked.

      (el.querySelector(".jspsych-multiplayer-draw-undo") as HTMLButtonElement).click();
      await Promise.resolve();

      expect((api.getAll().me.draw_strokes as any[] | undefined) ?? []).toHaveLength(0);

      // The throttle timer must be stopped — advancing time must not resurrect a push containing
      // the discarded stroke.
      jest.advanceTimersByTime(500);
      expect((api.getAll().me.draw_strokes as any[] | undefined) ?? []).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("undo and redo buttons are enabled/disabled correctly", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);

    const undoBtn = el.querySelector(".jspsych-multiplayer-draw-undo") as HTMLButtonElement;
    const redoBtn = el.querySelector(".jspsych-multiplayer-draw-redo") as HTMLButtonElement;

    // Initially both are disabled (no strokes)
    expect(undoBtn.disabled).toBe(true);
    expect(redoBtn.disabled).toBe(true);

    // Draw a stroke -> Undo is enabled, Redo is disabled
    drawStroke(el, [10, 10], [50, 50]);
    await flush();
    expect(undoBtn.disabled).toBe(false);
    expect(redoBtn.disabled).toBe(true);

    // Undo -> Undo is disabled, Redo is enabled
    undoBtn.click();
    await flush();
    expect(undoBtn.disabled).toBe(true);
    expect(redoBtn.disabled).toBe(false);

    // Redo -> Undo is enabled, Redo is disabled
    redoBtn.click();
    await flush();
    expect(undoBtn.disabled).toBe(false);
    expect(redoBtn.disabled).toBe(true);
  });

  it("redoing a stroke restores it, updates its timestamp, and pushes it to the API", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);

    drawStroke(el, [10, 10], [50, 50]);
    await flush();

    const originalStroke = (api.getAll().me.draw_strokes as any[])[0];
    const originalTs = originalStroke.ts;

    // Undo
    (el.querySelector(".jspsych-multiplayer-draw-undo") as HTMLButtonElement).click();
    await flush();
    expect((api.getAll().me.draw_strokes as any[]).length).toBe(0);

    // Sleep a tiny bit to guarantee a newer timestamp if we redo
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Redo
    (el.querySelector(".jspsych-multiplayer-draw-redo") as HTMLButtonElement).click();
    await flush();

    const redoneStrokes = api.getAll().me.draw_strokes as any[];
    expect(redoneStrokes.length).toBe(1);
    expect(redoneStrokes[0].id).toBe(originalStroke.id);
    expect(redoneStrokes[0].ts).toBeGreaterThan(originalTs);
  });

  it("starting a new stroke clears the redo stack", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);

    const undoBtn = el.querySelector(".jspsych-multiplayer-draw-undo") as HTMLButtonElement;
    const redoBtn = el.querySelector(".jspsych-multiplayer-draw-redo") as HTMLButtonElement;

    drawStroke(el, [10, 10], [50, 50]);
    await flush();

    // Undo to put it in redo stack
    undoBtn.click();
    await flush();
    expect(redoBtn.disabled).toBe(false);

    // Draw a new stroke
    drawStroke(el, [20, 20], [60, 60]);
    await flush();

    // Redo should be disabled now
    expect(redoBtn.disabled).toBe(true);
    expect(undoBtn.disabled).toBe(false);

    // Checking the API state contains only the second stroke
    const mine = api.getAll().me.draw_strokes as any[];
    expect(mine.length).toBe(1);
    expect(mine[0].points[0]).toMatchObject({ x: 20 / 320 });
  });

  it("switching to the eraser tool tags new strokes with tool: 'eraser'", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
    (el.querySelector(".jspsych-multiplayer-draw-eraser") as HTMLButtonElement).click();
    drawStroke(el, [10, 10], [50, 50]);
    await flush();

    const mine = api.getAll().me.draw_strokes as any[];
    expect(mine[0].tool).toBe("eraser");
  });

  it("selecting a color and brush size tags new strokes accordingly", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
    const colorButtons = el.querySelectorAll(".jspsych-multiplayer-draw-color");
    (colorButtons[1] as HTMLButtonElement).click(); // second swatch: "#222"
    const sizeButtons = el.querySelectorAll(".jspsych-multiplayer-draw-size");
    (sizeButtons[2] as HTMLButtonElement).click(); // largest: 0.02
    drawStroke(el, [10, 10], [50, 50]);
    await flush();

    const mine = api.getAll().me.draw_strokes as any[];
    expect(mine[0].color).toBe("#222");
    expect(mine[0].width).toBe(0.02);
  });

  it("picking a color switches the active tool back to pen", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
    const eraserButton = el.querySelector(".jspsych-multiplayer-draw-eraser") as HTMLButtonElement;
    const penButton = el.querySelector(".jspsych-multiplayer-draw-pen") as HTMLButtonElement;
    eraserButton.click();
    expect(eraserButton.classList.contains("is-selected")).toBe(true);

    const colorButtons = el.querySelectorAll(".jspsych-multiplayer-draw-color");
    (colorButtons[1] as HTMLButtonElement).click();

    expect(penButton.classList.contains("is-selected")).toBe(true);
    expect(eraserButton.classList.contains("is-selected")).toBe(false);

    drawStroke(el, [10, 10], [50, 50]);
    await flush();
    const mine = api.getAll().me.draw_strokes as any[];
    expect(mine[0].tool).toBe("pen");
    expect(mine[0].color).toBe("#222");
  });

  it("re-renders (via subscribe) when a peer pushes a stroke — no throw, roster updates", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
      ...base,
      show_roster: true,
    } as never);

    expect(() =>
      api.pushAs("peer", {
        draw_strokes: [
          {
            id: "peer#0",
            authorId: "peer",
            seq: 0,
            points: [
              { x: 0, y: 0 },
              { x: 0.5, y: 0.5 },
            ],
            tool: "pen",
            color: "#000",
            width: 0.01,
            done: true,
            ts: 5,
          },
        ],
      }),
    ).not.toThrow();

    const roster = el.querySelector(".jspsych-multiplayer-draw-roster") as HTMLElement;
    expect(roster.textContent).toContain("peer");
  });

  it("labels roster entries via roster_label when provided", async () => {
    const api = await makeApi();
    api.pushAs("peer", { name: "Bob" });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
      ...base,
      show_roster: true,
      roster_label: (id: string, group: GroupSessionData) =>
        id === "me" ? "You" : ((group[id] as any)?.name ?? id),
    } as never);

    const roster = el.querySelector(".jspsych-multiplayer-draw-roster") as HTMLElement;
    expect(roster.textContent).toContain("Bob");
    expect(roster.textContent).not.toContain("peer");
  });

  it("clears a peer's LAST stroke when they undo it to an empty array (full repaint)", async () => {
    // Regression guard: a peer undoing down to zero strokes leaves their slot as { draw_strokes: [] }.
    // applyUpdate must still detect the vanished stroke and full-repaint — otherwise the peer's last
    // stroke stays painted on our canvas forever. doFullRepaint is the only caller of clearRect, so a
    // clearRect after the empty push is the observable proof the repaint happened.
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);

    api.pushAs("peer", {
      draw_strokes: [
        {
          id: "peer#0",
          authorId: "peer",
          seq: 0,
          points: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 },
          ],
          tool: "pen",
          color: "#000",
          width: 0.01,
          done: true,
          ts: 5,
        },
      ],
    });

    // Spy on clearRect (the only caller is doFullRepaint) and reset it: the canvas mock's clearRect
    // is a persistent jest.fn that already recorded the init repaint, so we must mockClear to count
    // only calls from here on. Otherwise the init repaint would satisfy the assertion by itself.
    const clearSpy = jest.spyOn(
      canvasOf(el).getContext("2d") as CanvasRenderingContext2D,
      "clearRect",
    );
    clearSpy.mockClear();

    api.pushAs("peer", { draw_strokes: [] }); // peer undoes their only stroke

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("does not drop own unpushed stroke when a peer triggers a full repaint", async () => {
    const api = await makeApi();
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);

    api.pushAs("peer", {
      draw_strokes: [
        {
          id: "peer#0",
          authorId: "peer",
          seq: 0,
          points: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 },
          ],
          tool: "pen",
          color: "#000",
          width: 0.01,
          done: true,
          ts: 5,
        },
      ],
    });

    const canvas = canvasOf(el);
    canvas.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    canvas.dispatchEvent(pointerEvent("pointermove", 20, 20));

    expect(api.get("me")).toBeUndefined();

    const planRepaintSpy = jest.spyOn(drawCore, "planRepaint");
    planRepaintSpy.mockClear();

    api.pushAs("peer", { draw_strokes: [] });

    expect(planRepaintSpy).toHaveBeenCalled();
    const calledGroup = planRepaintSpy.mock.calls[0][0];
    expect(calledGroup.me).toBeDefined();
    expect(calledGroup.me.draw_strokes).toHaveLength(1);
    expect(calledGroup.me.draw_strokes[0]).toMatchObject({
      authorId: "me",
      tool: "pen",
    });

    planRepaintSpy.mockRestore();
  });

  it("ends on the end button with ended_by 'button' and includes stroke data", async () => {
    const api = await makeApi();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
      ...base,
      end_button_label: "Done",
    } as never);
    drawStroke(el, [10, 10], [50, 50]);
    await flush();
    (el.querySelector(".jspsych-multiplayer-draw-end") as HTMLButtonElement).click();

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("button");
    expect(finished[0].stroke_count).toBe(1);
    expect(finished[0].strokes_drawn).toBe(1);
    expect(finished[0].strokes).toHaveLength(1);
  });

  it("omits raw stroke points from trial data when store_full_strokes is false", async () => {
    const api = await makeApi();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
      ...base,
      end_button_label: "Done",
      store_full_strokes: false,
    } as never);
    drawStroke(el, [10, 10], [50, 50]);
    await flush();
    (el.querySelector(".jspsych-multiplayer-draw-end") as HTMLButtonElement).click();

    expect(finished[0].strokes).toBeUndefined();
    expect(finished[0].stroke_count).toBe(1);
  });

  it("ends on duration timeout with ended_by 'duration'", async () => {
    jest.useFakeTimers();
    try {
      const api = await makeApi();
      const { jsPsych, finished } = makeJsPsych(api);

      await new MultiplayerDrawPlugin(jsPsych as never).trial(display(), {
        ...base,
        duration: 40,
      } as never);
      expect(finished).toHaveLength(0);

      jest.advanceTimersByTime(40);
      expect(finished).toHaveLength(1);
      expect(finished[0].ended_by).toBe("duration");
    } finally {
      jest.useRealTimers();
    }
  });

  it("ends when end_when becomes true, with ended_by 'condition'", async () => {
    const api = await makeApi();
    const { jsPsych, finished } = makeJsPsych(api);

    await new MultiplayerDrawPlugin(jsPsych as never).trial(display(), {
      ...base,
      end_when: (g: GroupSessionData) => Object.values(g).some((p) => (p as any).done),
    } as never);
    expect(finished).toHaveLength(0);

    api.pushAs("peer", { done: true });

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("condition");
  });

  it("unsubscribes on finish and stops responding to further pushes or timers", async () => {
    jest.useFakeTimers();
    try {
      const api = await makeApi();
      const { jsPsych, finished } = makeJsPsych(api);
      const el = display();

      await new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
        ...base,
        end_button_label: "Done",
        duration: 30,
      } as never);
      (el.querySelector(".jspsych-multiplayer-draw-end") as HTMLButtonElement).click();

      expect(() =>
        api.pushAs("peer", {
          draw_strokes: [
            {
              id: "peer#0",
              authorId: "peer",
              seq: 0,
              points: [{ x: 0, y: 0 }],
              tool: "pen",
              color: "#000",
              width: 0.01,
              done: true,
              ts: 1,
            },
          ],
        }),
      ).not.toThrow();
      jest.advanceTimersByTime(60);

      expect(finished).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("the stroke push ticking is registered through pluginAPI, so an abort mid-stroke stops it", async () => {
    // Regression guard: a raw setInterval survives `abortExperiment()` (which clears pluginAPI
    // timers and cancels multiplayer subscriptions). Aborting mid-stroke never runs `end()`, and
    // the canvas is gone so no pointerup ever arrives to clear the timer — the interval would keep
    // calling api.update() forever, against a finished experiment. Every tick must sit in jsPsych's
    // registry, including the ones scheduled by earlier ticks.
    jest.useFakeTimers();
    try {
      const api = await makeApi();
      const { jsPsych, finished, abortTrialTimers } = makeJsPsych(api);
      const el = display();

      new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);

      const canvas = canvasOf(el);
      canvas.dispatchEvent(pointerEvent("pointerdown", 10, 10));
      canvas.dispatchEvent(pointerEvent("pointermove", 50, 50));
      // No pointerup — the stroke is still active, so the push tick is running.
      jest.advanceTimersByTime(60);
      expect((api.getAll().me.draw_strokes as any[]).length).toBe(1); // a tick did push

      const updateSpy = jest.spyOn(api, "update");
      abortTrialTimers(); // what abortExperiment() does to this trial's timers

      expect(jest.getTimerCount()).toBe(0); // nothing of ours is still scheduled
      jest.advanceTimersByTime(10_000);
      expect(updateSpy).not.toHaveBeenCalled(); // no pushes against a finished experiment
      expect(finished).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a throwing end_when does not propagate into the adapter's notify loop or kill the trial", async () => {
    const api = await makeApi();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
      ...base,
      end_when: (g: GroupSessionData) => {
        if (Object.keys(g).length > 0) throw new Error("boom");
        return false;
      },
    } as never);

    expect(() =>
      api.pushAs("peer", {
        draw_strokes: [
          {
            id: "peer#0",
            authorId: "peer",
            seq: 0,
            points: [{ x: 0, y: 0 }],
            tool: "pen",
            color: "#000",
            width: 0.01,
            done: true,
            ts: 1,
          },
        ],
      }),
    ).not.toThrow();
    expect(finished).toHaveLength(0);
  });

  it("shows a connection-trouble note on a failed push, and the next tick's push self-heals", async () => {
    const api = await makeApi();
    api.failNextWrite = true;
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
    drawStroke(el, [10, 10], [50, 50]); // the flush on pointerup fails
    await flush();

    const note = el.querySelector(".jspsych-multiplayer-draw-error") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/retrying/i);

    // A second, successful action re-pushes the FULL current array (self-healing) — nothing is lost.
    drawStroke(el, [20, 20], [60, 60]);
    await flush();
    expect((api.getAll().me.draw_strokes as any[]).length).toBe(2);
  });

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("me");

    const { displayElement, expectFinished, getData } = await startTimeline(
      [{ type: MultiplayerDrawPlugin, end_button_label: "Done" }],
      jsPsych,
    );

    drawStroke(displayElement, [10, 10], [50, 50]);
    await flush();

    (displayElement.querySelector(".jspsych-multiplayer-draw-end") as HTMLButtonElement).click();
    await expectFinished();

    const data = getData().values()[0];
    expect(data.ended_by).toBe("button");
    expect(data.stroke_count).toBe(1);
    expect(data.strokes_drawn).toBe(1);
  });

  describe("presence and the session closing", () => {
    it("ends with ended_by 'participant_left' when a participant who was there leaves", async () => {
      const api = await makeApi("me", { dropoutTimeout: 0 });
      const peer = await api.hub.join("peer");
      await peer.jsPsych.multiplayer.push({ draw_strokes: [peerStroke] });
      const { jsPsych, finished } = makeJsPsych(api);
      new MultiplayerDrawPlugin(jsPsych as never).trial(display(), { ...base } as never);

      await peer.jsPsych.multiplayer.disconnect();
      await sleep(5);

      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({
        ended_by: "participant_left",
        partner_left: true,
        left_participant: "peer",
        connection_lost: false,
        stroke_count: 1,
      });
    });

    it("keeps going when end_on_participant_left is false, marking them in the roster", async () => {
      const api = await makeApi("me", { dropoutTimeout: 0 });
      const peer = await api.hub.join("peer");
      const { jsPsych, finished } = makeJsPsych(api);
      const el = display();
      new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
        ...base,
        show_roster: true,
        end_on_participant_left: false,
      } as never);
      const roster = () => el.querySelector(".jspsych-multiplayer-draw-roster")!.textContent;

      expect(roster()).toBe("Participants: me, peer");
      await peer.jsPsych.multiplayer.disconnect();
      expect(roster()).toBe("Participants: me, peer (away)");
      await sleep(5);
      expect(roster()).toBe("Participants: me, peer (left)");
      expect(finished).toHaveLength(0);
    });

    it("passes presence to end_when and roster_label", async () => {
      const api = await makeApi();
      await api.hub.join("peer");
      const { jsPsych } = makeJsPsych(api);
      const seen: PresenceData[] = [];
      new MultiplayerDrawPlugin(jsPsych as never).trial(display(), {
        ...base,
        show_roster: true,
        end_when: (_g: GroupSessionData, presence: PresenceData) => {
          seen.push(presence);
          return false;
        },
        roster_label: (id: string, _g: GroupSessionData, presence: PresenceData) =>
          `${id}:${presence[id]}`,
      } as never);
      expect(seen[seen.length - 1]).toEqual({ me: "connected", peer: "connected" });
    });

    it("ends with ended_by 'connection_lost' and keeps this client's strokes", async () => {
      const api = await makeApi();
      const { jsPsych, finished } = makeJsPsych(api);
      const el = display();
      new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);
      drawStroke(el, [10, 10], [50, 50]);

      api.connection.options.onStatus("closed");

      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({
        ended_by: "connection_lost",
        connection_lost: true,
        strokes_drawn: 1,
      });
      expect(el.querySelector(".jspsych-multiplayer-draw-error")).toBeNull();
    });

    it("also ends cleanly when the experiment calls disconnect() mid-trial", async () => {
      const api = await makeApi();
      const { jsPsych, finished } = makeJsPsych(api);
      new MultiplayerDrawPlugin(jsPsych as never).trial(display(), { ...base } as never);
      await api.multiplayer.disconnect();
      expect(finished[0].ended_by).toBe("connection_lost");
    });

    it("says the connection was lost instead of 'retrying' after it closes", async () => {
      const api = await makeApi();
      const { jsPsych } = makeJsPsych(api);
      const el = display();
      new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
        ...base,
        end_button_label: "Done",
      } as never);
      api.connection.pushImpl = async () => {
        throw Object.assign(new Error("gone"), { name: "MultiplayerConnectionClosedError" });
      };
      drawStroke(el, [10, 10], [50, 50]);
      await flush();
      expect(el.querySelector(".jspsych-multiplayer-draw-error")!.textContent).toMatch(/lost/);
    });
  });

  describe("frozen snapshots", () => {
    it("can redo a stroke that was restored from the slot (e.g. after a reload)", async () => {
      const api = await makeApi();
      await api.push({ draw_strokes: [{ ...peerStroke, id: "me#0", authorId: "me" }] });
      const { jsPsych } = makeJsPsych(api);
      const el = display();
      new MultiplayerDrawPlugin(jsPsych as never).trial(el, { ...base } as never);

      const undo = el.querySelector(".jspsych-multiplayer-draw-undo") as HTMLButtonElement;
      const redo = el.querySelector(".jspsych-multiplayer-draw-redo") as HTMLButtonElement;
      expect(() => {
        undo.click();
        redo.click();
      }).not.toThrow();
      expect((api.get("me")!.draw_strokes as any[]).length).toBe(1);
    });

    it("stores strokes in trial data that can be modified", async () => {
      const api = await makeApi();
      api.pushAs("peer", { draw_strokes: [peerStroke] });
      const { jsPsych, finished } = makeJsPsych(api);
      const el = display();
      new MultiplayerDrawPlugin(jsPsych as never).trial(el, {
        ...base,
        end_button_label: "Done",
      } as never);
      (el.querySelector(".jspsych-multiplayer-draw-end") as HTMLButtonElement).click();

      const strokes = finished[0].strokes;
      expect(Object.isFrozen(strokes[0].points)).toBe(false);
    });
  });

  it("throws a clear error when the adapter isn't connected yet, or jsPsych has no multiplayer module", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("me");
    await jsPsych.multiplayer.disconnect();
    expect(() => new MultiplayerDrawPlugin(jsPsych).trial(display(), base as never)).toThrow(
      "no participantId",
    );
    expect(() => new MultiplayerDrawPlugin({} as never).trial(display(), base as never)).toThrow(
      "no multiplayer module",
    );
  });
});
