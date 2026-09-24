import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { startedAtKey } from "./countdown-core";
import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import MultiplayerCountdownPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the plugin codes against. Semantics
// mirror the jsPsych#3694 contract (and the reference adapter):
//   - `push` REPLACES this participant's slot (it does NOT merge), then fires subscribers. A merge
//     mock would hide the "preserves unrelated keys" crux `update()` exists to solve.
//   - `update` shallow-merges onto this client's LAST SUCCESSFUL WRITE, falling back to the current
//     slot before the first write — not onto whatever the session happens to hold now.
//   - every read (`get`, `getAll`, each subscriber argument) hands back a JSON deep copy, so a test
//     can never pass by holding a live reference into the mock's session.
//   - `subscribe` registers a callback, replays the current snapshot on registration (as core does),
//     and returns an unsubscribe function.
//   - `pushAs(id, data)` simulates a peer's push (also replace), firing subscribers.
// ---------------------------------------------------------------------------------------------------
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  /** When true, the next write rejects (registration failure) without touching the session. */
  failNextWrite = false;
  private subs = new Set<(g: GroupSessionData) => void>();
  /** This client's last successful write — the merge base `update()` uses, per the core contract. */
  private lastWrite: Record<string, unknown> | null = null;

  constructor(public participantId: string) {}

  get(id: string) {
    const slot = this.session[id];
    return slot === undefined ? undefined : jsonCopy(slot);
  }

  getAll() {
    return jsonCopy(this.session);
  }

  async push(data: Record<string, unknown>) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("network down");
    }
    this.lastWrite = jsonCopy(data);
    this.session[this.participantId] = jsonCopy(data); // REPLACE, like the real adapter
    this.fire();
  }

  async update(data: Record<string, unknown>) {
    const base = this.lastWrite ?? this.session[this.participantId] ?? {};
    await this.push({ ...base, ...data });
  }

  subscribe(cb: (g: GroupSessionData) => void): Unsubscribe {
    this.subs.add(cb);
    cb(this.getAll()); // replay-on-registration, like core
    return () => this.subs.delete(cb);
  }

  /** Simulate a peer pushing into their own slot. */
  pushAs(id: string, data: Record<string, unknown>) {
    this.session[id] = jsonCopy(data);
    this.fire();
  }

  /** Number of live subscriptions — 0 after a clean teardown. */
  subCount() {
    return this.subs.size;
  }

  private fire() {
    for (const cb of [...this.subs]) cb(this.getAll()); // a fresh copy per subscriber, like core
  }
}

/**
 * Minimal jsPsych double exposing `multiplayer` (the mock) and capturing `finishTrial` data.
 *
 * `pluginAPI.setTimeout` is a real `setTimeout` that also records its handle, and `clearAllTimeouts`
 * drops every recorded one — the same registry jsPsych keeps, so `abortTrialTimers()` reproduces
 * what `abortExperiment()` does to a trial's timers.
 */
function makeJsPsych(api: MockApi) {
  const finished: Array<Record<string, any>> = [];
  const timeouts: Array<ReturnType<typeof setTimeout>> = [];
  const jsPsych = {
    multiplayer: api,
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

const display = () => document.createElement("div");
/** Flush pending microtasks (e.g. a rejected push's `.catch`) without advancing faked timers. */
const flushMicro = async () => {
  await Promise.resolve();
  await Promise.resolve();
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

function run(api: MockApi, params: Record<string, unknown>) {
  const { jsPsych, finished, abortTrialTimers } = makeJsPsych(api);
  const el = display();
  new MultiplayerCountdownPlugin(jsPsych as never).trial(el, { ...base, ...params } as never);
  return { finished, el, abortTrialTimers };
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
    it("throws when `name` is missing or empty", () => {
      const api = new MockApi("me");
      expect(() => run(api, { name: undefined })).toThrow(/`name` parameter is required/);
      expect(() => run(api, { name: "   " })).toThrow(/`name` parameter is required/);
    });

    it("throws when `duration` is missing or non-positive", () => {
      const api = new MockApi("me");
      expect(() => run(api, { duration: undefined })).toThrow(/`duration` parameter is required/);
      expect(() => run(api, { duration: 0 })).toThrow(/`duration` parameter is required/);
      expect(() => run(api, { duration: -100 })).toThrow(/`duration` parameter is required/);
    });
  });

  it("trial() is synchronous (returns undefined) so jsPsych waits for finishTrial", () => {
    const api = new MockApi("me");
    const { jsPsych } = makeJsPsych(api);
    const returned = new MultiplayerCountdownPlugin(jsPsych as never).trial(display(), {
      ...base,
    } as never);
    expect(returned).toBeUndefined();
  });

  it("registers this client's timestamp with a one-key update (preserves unrelated keys)", () => {
    const api = new MockApi("me");
    api.pushAs("me", { role: "proposer" }); // pre-existing data in my slot
    const updateSpy = jest.spyOn(api, "update");
    run(api, {});

    // Only the countdown key is written — merging the rest of the slot is `update`'s job, not the
    // plugin's (a spread-and-push here would clobber any key a peer-side write added meanwhile).
    expect(updateSpy).toHaveBeenCalledWith({ [KEY]: BASE });
    // Both the earlier role AND the new start timestamp must survive the write.
    expect(api.getAll().me.role).toBe("proposer");
    expect(api.getAll().me[KEY]).toBe(BASE);
  });

  it("keep-if-present: does not overwrite an existing timestamp, and does not re-write", () => {
    const api = new MockApi("me");
    api.session.me = { [KEY]: BASE - 500, role: "x" }; // seed directly (no notify) — an earlier run
    const pushSpy = jest.spyOn(api, "push");
    const updateSpy = jest.spyOn(api, "update");

    run(api, {});

    expect(api.getAll().me[KEY]).toBe(BASE - 500); // kept, not refreshed to BASE
    expect(updateSpy).not.toHaveBeenCalled(); // no redundant write
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("renders the countdown and ends at `duration` (not a tick early)", () => {
    const api = new MockApi("me");
    const { finished, el } = run(api, { duration: 3000 });

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
    });
    expect(finished[0].displayed_duration).toEqual(expect.any(Number));
  });

  it("count-up mode displays elapsed with floor rounding and ends at `duration`", () => {
    const api = new MockApi("me");
    const { finished, el } = run(api, { mode: "countup", duration: 5000 });

    expect(timeText(el)).toBe("0:00"); // elapsed 0 at start (floor)
    jest.advanceTimersByTime(1500);
    expect(timeText(el)).toBe("0:01"); // floor(1.5s) — stopwatch convention

    jest.advanceTimersByTime(3500); // reach 5000ms
    expect(finished).toHaveLength(1);
    expect(finished[0].mode).toBe("countup");
  });

  it("a late joiner resumes at the group's remaining time (min-across-slots), not full duration", () => {
    const api = new MockApi("me");
    api.session.peer = { [KEY]: BASE - 2000 }; // peer started 2s ago
    const { el } = run(api, { duration: 5000 });

    // min start = BASE-2000, so remaining = 5000 - 2000 = 3000ms, not the full 5000.
    expect(timeText(el)).toBe("0:03");
  });

  it("re-resolves the min when a lower peer timestamp arrives, and can end via subscribe", () => {
    const api = new MockApi("me");
    const { finished } = run(api, { duration: 1000 }); // remaining 1000 from own BASE start
    expect(finished).toHaveLength(0);

    // A peer whose start is >1s older than ours drops the consensus min below now-duration → expired.
    api.pushAs("peer", { [KEY]: BASE - 2000 });

    expect(finished).toHaveLength(1);
    expect(finished[0].started_at).toBe(BASE - 2000); // ended off the consensus min, not own start
  });

  it("warns and ends immediately when the countdown has already expired at start (reused name)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MockApi("me");
    api.session.me = { [KEY]: BASE - 2000 }; // a stale timestamp from an earlier same-named countdown
    const { finished } = run(api, { duration: 1000 }); // remaining = -1000 → expired

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("already expired"));
    expect(finished).toHaveLength(1);
    expect(finished[0].started_at).toBe(BASE - 2000);
  });

  it("surfaces a registration write failure loudly (console.error) and keeps displaying", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("me");
    api.failNextWrite = true;
    const { finished, el } = run(api, { duration: 5000 });
    await flushMicro();

    expect(err).toHaveBeenCalledWith(expect.stringContaining("failed to push"), expect.any(Error));
    // Non-fatal: the trial keeps running, displaying from this client's own local fallback start.
    expect(finished).toHaveLength(0);
    expect(timeText(el)).toBe("0:05");
  });

  it("announces only the final 5 seconds to screen readers, once per second", () => {
    const api = new MockApi("me");
    const { el } = run(api, { duration: 8000 });
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

  it("uses a custom `format` function when provided", () => {
    const api = new MockApi("me");
    const { el } = run(api, { duration: 5000, format: (ms: number) => `left:${ms}` });
    expect(timeText(el)).toBe("left:5000");
  });

  it("stores the group snapshot only when save_group is true", () => {
    const withSave = new MockApi("me");
    const a = run(withSave, { duration: 200, save_group: true });
    jest.advanceTimersByTime(200);
    expect(a.finished[0].group).toEqual(withSave.getAll());

    const without = new MockApi("me2");
    const b = run(without, { duration: 200, save_group: false });
    jest.advanceTimersByTime(200);
    expect(b.finished[0].group).toBeUndefined();
  });

  it("unsubscribes and stops ticking on finish (no leak, no double-finish)", () => {
    const api = new MockApi("me");
    const { finished } = run(api, { duration: 200 });

    jest.advanceTimersByTime(200);
    expect(finished).toHaveLength(1);
    expect(api.subCount()).toBe(0); // subscription torn down
    expect(jest.getTimerCount()).toBe(0); // no tick left scheduled

    // A late peer push and further time must not re-render or re-finish.
    api.pushAs("peer", { [KEY]: BASE });
    jest.advanceTimersByTime(1000);
    expect(finished).toHaveLength(1);
  });

  it("the re-render tick is registered through pluginAPI, so an abort stops it dead", () => {
    // Regression guard: a raw setInterval survives `abortExperiment()` (which clears pluginAPI
    // timers and cancels multiplayer subscriptions), so it kept re-rendering a torn-down display
    // and could still call finishTrial() after the run was over. Every tick must sit in jsPsych's
    // registry — including the ones scheduled by earlier ticks, which is why the tick reschedules
    // itself through pluginAPI rather than registering once.
    const api = new MockApi("me");
    const { finished, el, abortTrialTimers } = run(api, { duration: 5000 });

    jest.advanceTimersByTime(1000); // a few ticks have run and re-scheduled through pluginAPI
    expect(timeText(el)).toBe("0:04");

    abortTrialTimers(); // what abortExperiment() does to this trial's timers
    expect(jest.getTimerCount()).toBe(0); // nothing of ours is still scheduled

    // Well past the deadline: no tick, so no render and — crucially — no finishTrial after the run.
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

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    jest.useRealTimers(); // startTimeline drives real async; fake timers would stall it
    jest.spyOn(console, "warn").mockImplementation(() => {}); // already-expired path warns; silence it
    const api = new MockApi("me");
    // Pre-seed an already-elapsed start so the trial ends SYNCHRONOUSLY at load. test-utils'
    // expectFinished flushes microtasks rather than waiting real wall-clock, so a 100 ms
    // tick would never fire — the synchronous end path is what exercises the pipeline here.
    api.session.me = { [startedAtKey("smoke")]: 0 };
    const jsPsych = initJsPsych();
    // Graft the multiplayer API seam onto jsPsych.multiplayer, where connect() puts it (jsPsych#3694).
    // A released jsPsych has no `multiplayer` module (jsPsych#3694 is unmerged), so create it here.
    const core = jsPsych as unknown as { multiplayer: Record<string, unknown> };
    core.multiplayer = {
      participantId: api.participantId,
      get: api.get.bind(api),
      push: api.push.bind(api),
      update: api.update.bind(api),
      getAll: api.getAll.bind(api),
      subscribe: api.subscribe.bind(api),
    };

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
    expect(data.group).toEqual(api.getAll());
  });
});
