import { startTimeline } from "@jspsych/test-utils";
import { GroupSessionData } from "jspsych";

import { MemoryHub } from "../../../test-utils/memory-backend";
import { startedAtKey } from "./countdown-core";
import MultiplayerCountdownPlugin from ".";

/**
 * Connect "me" to an in-memory hub (optionally pre-seeded with slots, as if written by earlier
 * trials) and hand the plugin a jsPsych stand-in whose `multiplayer` is the real session.
 *
 * `pluginAPI.setTimeout` is a real (here: faked) `setTimeout` that also records its handle, and
 * `clearAllTimeouts` drops every recorded one — the same registry jsPsych keeps, so
 * `abortTrialTimers()` reproduces what `abortExperiment()` does to a trial's timers. Dropout timers
 * are off (`dropoutTimeout: null`) so seeded, unconnected peers don't add timers of their own.
 */
async function setup(seed: GroupSessionData = {}) {
  const hub = new MemoryHub();
  hub.data = { ...seed };
  const me = await hub.join("me", { connect: { dropoutTimeout: null } });
  const multiplayer = me.jsPsych.multiplayer;
  const finished: Array<Record<string, any>> = [];
  const timeouts: Array<ReturnType<typeof setTimeout>> = [];
  const jsPsych = {
    multiplayer,
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
  return {
    hub,
    me,
    multiplayer,
    jsPsych,
    finished,
    abortTrialTimers: () => jsPsych.pluginAPI.clearAllTimeouts(),
  };
}

const display = () => document.createElement("div");
/** Flush pending microtasks (e.g. a rejected write's `.catch`) without advancing faked timers. */
const flushMicro = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const timeText = (el: HTMLElement) =>
  (el.querySelector(".jspsych-multiplayer-countdown-time") as HTMLElement).textContent;

/** Default params so each test only overrides what it cares about. */
const base = {
  duration: 5000,
  mode: "countdown",
  name: "t",
  stimulus: null,
  prompt: null,
  format: null,
  save_group: false,
};

const KEY = startedAtKey("t");
const BASE = 1_000_000; // fixed fake "now" so Date.now() is deterministic

async function run(params: Record<string, unknown>, seed?: GroupSessionData) {
  const ctx = await setup(seed);
  const el = display();
  new MultiplayerCountdownPlugin(ctx.jsPsych as never).trial(el, { ...base, ...params } as never);
  return { ...ctx, el };
}

describe("multiplayer-countdown plugin", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe("required-param validation (the core deliberately does not validate)", () => {
    it("throws when `name` is missing or empty", async () => {
      await expect(run({ name: undefined })).rejects.toThrow(/`name` parameter is required/);
      await expect(run({ name: "   " })).rejects.toThrow(/`name` parameter is required/);
    });

    it("throws when `duration` is missing or non-positive", async () => {
      await expect(run({ duration: undefined })).rejects.toThrow(
        /`duration` parameter is required/,
      );
      await expect(run({ duration: 0 })).rejects.toThrow(/`duration` parameter is required/);
      await expect(run({ duration: -100 })).rejects.toThrow(/`duration` parameter is required/);
    });
  });

  it("trial() is synchronous (returns undefined) so jsPsych waits for finishTrial", async () => {
    const { jsPsych } = await setup();
    const returned = new MultiplayerCountdownPlugin(jsPsych as never).trial(display(), {
      ...base,
    } as never);
    expect(returned).toBeUndefined();
  });

  it("registers this client's timestamp with a one-key update (preserves unrelated keys)", async () => {
    const { jsPsych, multiplayer } = await setup({ me: { role: "proposer" } });
    const updateSpy = jest.spyOn(multiplayer, "update");
    new MultiplayerCountdownPlugin(jsPsych as never).trial(display(), { ...base } as never);

    // Only the countdown key is written — merging the rest of the slot is `update`'s job.
    expect(updateSpy).toHaveBeenCalledWith({ [KEY]: BASE });
    expect(multiplayer.getAll().me).toEqual({ role: "proposer", [KEY]: BASE });
  });

  it("keep-if-present: does not overwrite an existing timestamp, and does not re-write", async () => {
    const { jsPsych, multiplayer, me } = await setup({ me: { [KEY]: BASE - 500, role: "x" } });
    const updateSpy = jest.spyOn(multiplayer, "update");
    // The session announces itself when it connects; count only what the trial sends
    const pushesBefore = me.connection.pushes.length;
    new MultiplayerCountdownPlugin(jsPsych as never).trial(display(), { ...base } as never);

    expect(multiplayer.getAll().me[KEY]).toBe(BASE - 500); // kept, not refreshed to BASE
    expect(updateSpy).not.toHaveBeenCalled(); // no redundant write
    expect(me.connection.pushes).toHaveLength(pushesBefore);
  });

  it("renders the countdown and ends at `duration` (not a tick early)", async () => {
    const { finished, el } = await run({ duration: 3000 });

    expect(timeText(el)).toBe("0:03"); // full duration at start (ceil rounding)
    expect(finished).toHaveLength(0);

    jest.advanceTimersByTime(2999);
    expect(finished).toHaveLength(0); // last tick was at 2900ms — still 100ms left

    jest.advanceTimersByTime(1); // reaches 3000ms → the 3000ms tick expires it
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      started_at: BASE,
      own_started_at: BASE,
      mode: "countdown",
      connection_lost: false,
    });
    expect(finished[0].displayed_duration).toEqual(expect.any(Number));
  });

  it("count-up mode displays elapsed with floor rounding and ends at `duration`", async () => {
    const { finished, el } = await run({ mode: "countup", duration: 5000 });

    expect(timeText(el)).toBe("0:00"); // elapsed 0 at start (floor)
    jest.advanceTimersByTime(1500);
    expect(timeText(el)).toBe("0:01"); // floor(1.5s) — stopwatch convention

    jest.advanceTimersByTime(3500); // reach 5000ms
    expect(finished).toHaveLength(1);
    expect(finished[0].mode).toBe("countup");
  });

  it("a late joiner resumes at the group's remaining time (min-across-slots), not full duration", async () => {
    const { el } = await run({ duration: 5000 }, { peer: { [KEY]: BASE - 2000 } });
    // min start = BASE-2000, so remaining = 5000 - 2000 = 3000ms, not the full 5000.
    expect(timeText(el)).toBe("0:03");
  });

  it("re-resolves the min when a lower peer timestamp arrives, and can end via subscribe", async () => {
    const { finished, hub } = await run({ duration: 1000 }); // remaining 1000 from own BASE start
    expect(finished).toHaveLength(0);

    // A peer whose start is >1s older than ours drops the consensus min below now-duration → expired.
    hub.seed("peer", { [KEY]: BASE - 2000 });

    expect(finished).toHaveLength(1);
    expect(finished[0].started_at).toBe(BASE - 2000); // ended off the consensus min, not own start
  });

  it("warns and ends immediately when the countdown has already expired at start (reused name)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    // A stale timestamp from an earlier same-named countdown
    const { finished } = await run({ duration: 1000 }, { me: { [KEY]: BASE - 2000 } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("already expired"));
    expect(finished).toHaveLength(1);
    expect(finished[0].started_at).toBe(BASE - 2000);
  });

  it("surfaces a registration write failure loudly (console.error) and keeps displaying", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { jsPsych, finished, me } = await setup();
    me.connection.pushImpl = () => Promise.reject(new Error("network down"));
    const el = display();
    new MultiplayerCountdownPlugin(jsPsych as never).trial(el, { ...base } as never);
    await flushMicro();

    expect(err).toHaveBeenCalledWith(expect.stringContaining("failed to push"), expect.any(Error));
    // Non-fatal: the trial keeps running from this client's own start time.
    expect(finished).toHaveLength(0);
    expect(timeText(el)).toBe("0:05");
  });

  it("keeps counting down and records connection_lost when the connection closes", async () => {
    const { finished, me } = await run({ duration: 1000 });
    me.connection.options.onStatus("closed");
    jest.advanceTimersByTime(1000);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ started_at: BASE, connection_lost: true });
  });

  it("announces only the final 5 seconds to screen readers, once per second", async () => {
    const { el } = await run({ duration: 8000 });
    const srText = () =>
      (el.querySelector(".jspsych-multiplayer-countdown-sr") as HTMLElement).textContent;

    expect(srText()).toBe(""); // silent well before the deadline
    jest.advanceTimersByTime(2900); // 5100ms remaining — still outside the window
    expect(srText()).toBe("");

    jest.advanceTimersByTime(200); // 4900ms remaining → enters the window
    expect(srText()).toBe("5 seconds remaining");

    jest.advanceTimersByTime(4000); // 900ms remaining
    expect(srText()).toBe("1 second remaining"); // singular
  });

  it("uses a custom `format` function when provided", async () => {
    const { el } = await run({ duration: 5000, format: (ms: number) => `left:${ms}` });
    expect(timeText(el)).toBe("left:5000");
  });

  it("stores the group snapshot only when save_group is true", async () => {
    const a = await run({ duration: 200, save_group: true });
    jest.advanceTimersByTime(200);
    expect(a.finished[0].group).toEqual({ me: { [KEY]: BASE } });

    const b = await run({ duration: 200, save_group: false });
    jest.advanceTimersByTime(200);
    expect(b.finished[0].group).toBeUndefined();
  });

  it("unsubscribes and stops ticking on finish (no leak, no double-finish)", async () => {
    const { finished, hub, el } = await run({ duration: 200 });

    jest.advanceTimersByTime(200);
    expect(finished).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0); // no tick left scheduled

    // A late peer write and further time must not re-render or re-finish.
    const before = timeText(el);
    hub.seed("peer", { [KEY]: BASE - 100_000 });
    jest.advanceTimersByTime(1000);
    expect(finished).toHaveLength(1);
    expect(timeText(el)).toBe(before);
  });

  it("the re-render tick is registered through pluginAPI, so an abort stops it dead", async () => {
    // A raw setInterval survives `abortExperiment()` (which clears pluginAPI timers and cancels
    // multiplayer subscriptions), so every tick must sit in jsPsych's registry — including the ones
    // scheduled by earlier ticks, which is why the tick reschedules itself through pluginAPI.
    const { finished, el, abortTrialTimers } = await run({ duration: 5000 });

    jest.advanceTimersByTime(1000); // a few ticks have run and re-scheduled through pluginAPI
    expect(timeText(el)).toBe("0:04");

    abortTrialTimers(); // what abortExperiment() does to this trial's timers
    expect(jest.getTimerCount()).toBe(0); // nothing of ours is still scheduled

    jest.advanceTimersByTime(60_000);
    expect(timeText(el)).toBe("0:04");
    expect(finished).toHaveLength(0);
  });

  it("exposes the pure core as statics on the default export", () => {
    for (const name of [
      "startedAtKey",
      "resolveStartedAt",
      "computeRemaining",
      "computeElapsed",
      "formatTime",
    ] as const) {
      expect(typeof (MultiplayerCountdownPlugin as any)[name]).toBe("function");
    }
  });

  it("throws a clear error on a jsPsych without the multiplayer API", () => {
    expect(() =>
      new MultiplayerCountdownPlugin({} as never).trial(display(), { ...base } as never),
    ).toThrow(/multiplayer API/);
  });

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    jest.useRealTimers(); // startTimeline drives real async; fake timers would stall it
    jest.spyOn(console, "warn").mockImplementation(() => {}); // already-expired path warns; silence it
    // Pre-seed an already-elapsed start so the trial ends SYNCHRONOUSLY at load: expectFinished
    // flushes microtasks rather than waiting real wall-clock, so a 100 ms tick would never fire.
    const hub = new MemoryHub();
    hub.data = { me: { [startedAtKey("smoke")]: 0 } };
    const { jsPsych } = await hub.join("me");

    const { getData, expectFinished } = await startTimeline(
      [{ type: MultiplayerCountdownPlugin, name: "smoke", duration: 1000, save_group: true }],
      jsPsych,
    );
    await expectFinished();

    const data = getData().values()[0];
    expect(data.mode).toBe("countdown");
    expect(data.started_at).toBe(0); // resolved off the pre-seeded consensus start
    expect(data.own_started_at).toBe(0); // kept (keep-if-present), not refreshed to Date.now()
    expect(data.displayed_duration).toEqual(expect.any(Number));
    expect(data.group).toEqual({ me: { [startedAtKey("smoke")]: 0 } });
  });
});
