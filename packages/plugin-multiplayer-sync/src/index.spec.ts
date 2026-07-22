import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import {
  GroupSessionData,
  MULTIPLAYER_TIMEOUT_ERROR_NAME,
  MultiplayerApiLike,
} from "./multiplayer-api";
import MultiplayerSyncPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the plugin codes against.
//
// `push` overwrites this participant's entry (mirroring the reference adapter's
// overwrite-per-participant semantics) and notifies any waiter. `wait` honours the fast-path and,
// failing that, re-checks the condition whenever a later push/seed lands; if it's still unmet when
// `timeout` ms elapse, it rejects. Tests use real timers with short timeouts, so no fake-timer
// plumbing is needed.
//
// The published `jspsych` in this repo has no multiplayer API, so the fork's real-adapter tests
// can't run here; this mock + direct trial() calls exercise the same logic without a live group
// session, and one startTimeline smoke test runs the plugin through the real jsPsych pipeline with
// the mock grafted onto `multiplayer`.
// ---------------------------------------------------------------------------------------------------
class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  private waiters: Array<() => void> = [];

  constructor(public participantId: string) {}

  /** Seed another participant's entry directly (simulating their push), notifying any waiter. */
  seed(id: string, data: Record<string, unknown>) {
    this.session[id] = data;
    this.waiters.forEach((notify) => notify());
  }

  async push(data: Record<string, unknown>) {
    this.session[this.participantId] = data; // overwrite-per-participant, like the real adapter
    this.waiters.forEach((notify) => notify());
  }

  getAll() {
    return this.session;
  }

  wait(condition: (d: GroupSessionData) => boolean, timeout?: number) {
    return new Promise<GroupSessionData>((resolve, reject) => {
      if (condition(this.session)) return resolve(this.session); // fast path
      let settled = false;
      const check = () => {
        if (!settled && condition(this.session)) {
          settled = true;
          resolve(this.session);
        }
      };
      this.waiters.push(check);
      if (timeout !== undefined) {
        setTimeout(() => {
          if (!settled) {
            settled = true;
            // Mirrors the real MultiplayerTimeoutError: a named Error, since the plugin can't
            // import that class (see multiplayer-api.ts) and matches on `error.name` instead.
            const err = new Error(`wait timed out after ${timeout}ms`);
            err.name = MULTIPLAYER_TIMEOUT_ERROR_NAME;
            reject(err);
          }
        }, timeout);
      }
    });
  }
}

/** Minimal jsPsych double exposing `multiplayer` (the mock) and capturing `finishTrial` data. */
function makeJsPsych(api: MockApi) {
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    multiplayer: api,
    finishTrial: (data: Record<string, any>) => finished.push(data),
  };
  return { jsPsych, finished };
}

const display = () => document.createElement("div");
/** Resolve any pending microtasks so the plugin's promise chain settles before assertions. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("multiplayer-sync plugin", () => {
  it("pushes data and ends once the condition is met by its own push", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    await plugin.trial(display(), {
      push_data: { ready: true },
      wait_for: (group: GroupSessionData) => Object.keys(group).length >= 1,
      message: "<p>Waiting…</p>",
      timeout: null,
      minimum_wait: 0,
    } as never);

    expect(finished).toHaveLength(1);
    expect(finished[0].group).toEqual({ p1: { ready: true } });
    expect(finished[0].timed_out).toBe(false);
    expect(finished[0].wait_error).toBeNull();
    expect(typeof finished[0].wait_time).toBe("number");
  });

  it("fires the on_load callback once the waiting screen is rendered", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);
    const on_load = jest.fn();

    await plugin.trial(
      display(),
      {
        push_data: { ready: true },
        wait_for: () => true,
        message: "<p>Waiting…</p>",
        timeout: null,
        minimum_wait: 0,
      } as never,
      on_load
    );

    expect(on_load).toHaveBeenCalledTimes(1);
  });

  it("propagates a push failure instead of masking it as a timeout", async () => {
    const api = new MockApi("p1");
    jest.spyOn(api, "push").mockRejectedValue(new Error("connection lost"));
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    await expect(
      plugin.trial(display(), {
        push_data: { ready: true },
        wait_for: () => true,
        message: "<p>Waiting…</p>",
        timeout: null,
        on_timeout,
        minimum_wait: 0,
      } as never)
    ).rejects.toThrow(/connection lost/);

    // A push (infrastructure) failure must NOT be relabeled as a timeout.
    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
  });

  it("renders the waiting message and holds until a second participant satisfies the condition", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      push_data: { role: "a" },
      wait_for: (group: GroupSessionData) => Object.keys(group).length >= 2,
      message: "<p>Waiting for another player…</p>",
      timeout: null,
      minimum_wait: 0,
    } as never);
    await flush();

    // Only p1 has pushed so far — the barrier should still be holding, message on screen.
    expect(finished).toHaveLength(0);
    expect(el.innerHTML).toContain("Waiting for another player");

    // A second participant joins and pushes, meeting the condition.
    api.seed("p2", { role: "b" });
    await done;

    expect(finished).toHaveLength(1);
    expect(finished[0].group).toEqual({ p1: { role: "a" }, p2: { role: "b" } });
    expect(finished[0].timed_out).toBe(false);
  });

  it("waits without pushing when push_data is null", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { ready: true }); // someone else is already present
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    await plugin.trial(display(), {
      push_data: null,
      wait_for: (group: GroupSessionData) => "p2" in group,
      message: "<p>Waiting…</p>",
      timeout: null,
      minimum_wait: 0,
    } as never);

    // p1 never pushed, so it must not appear in the session.
    expect(api.getAll()).toEqual({ p2: { ready: true } });
    expect(finished[0].group).toEqual({ p2: { ready: true } });
    expect(finished[0].timed_out).toBe(false);
  });

  it("ends with timed_out and calls on_timeout when the timeout elapses", async () => {
    const api = new MockApi("p1");
    api.seed("p1", { ready: true });
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    await plugin.trial(display(), {
      push_data: null,
      wait_for: () => false, // never satisfied
      message: "<p>Waiting…</p>",
      timeout: 40,
      on_timeout,
      minimum_wait: 0,
    } as never);

    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].wait_error).toMatch(/timed out/); // rejection message preserved in the data
    expect(finished[0].group).toEqual(api.getAll()); // snapshot from getAll() on timeout
  });

  it("propagates a non-timeout wait() rejection instead of mislabeling it a timeout", async () => {
    // #3694 exports a typed MultiplayerTimeoutError so a genuine timeout can be told apart from
    // another wait() failure. Anything else (a throwing wait_for, an adapter error) must fail the
    // trial loudly rather than being recorded as `timed_out: true`, matching push-failure handling.
    const api = new MockApi("p1");
    jest.spyOn(api, "wait").mockRejectedValue(new Error("adapter disconnected"));
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    await expect(
      plugin.trial(display(), {
        push_data: null,
        wait_for: () => false,
        message: "<p>Waiting…</p>",
        timeout: 40,
        on_timeout,
        minimum_wait: 0,
      } as never)
    ).rejects.toThrow(/adapter disconnected/);

    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished.length).toBe(0);
  });

  it("still finishes gracefully when getAll() throws on the timeout path (adapter torn down)", async () => {
    // On a genuine timeout the adapter may already be torn down, so getAll() throws
    // ("connect() must be called…"). That must not escape and reject the trial — it falls back to
    // an empty snapshot so the timeout still finishes as data. Mirrors the ready plugin's guard.
    const api = new MockApi("p1");
    jest.spyOn(api, "getAll").mockImplementation(() => {
      throw new Error("connect() must be called before using multiplayer methods");
    });
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    await expect(
      plugin.trial(display(), {
        push_data: null,
        wait_for: () => false, // never satisfied → MockApi wait() rejects with a MultiplayerTimeoutError
        message: "<p>Waiting…</p>",
        timeout: 40,
        minimum_wait: 0,
      } as never)
    ).resolves.toBeUndefined();

    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].wait_error).toMatch(/timed out/); // original error preserved, not masked
    expect(finished[0].group).toEqual({}); // empty fallback snapshot
  });

  it("holds the message for minimum_wait even when the timeout elapses first", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    const t0 = performance.now();
    await plugin.trial(display(), {
      push_data: null,
      wait_for: () => false, // never satisfied
      message: "<p>Waiting…</p>",
      timeout: 20, // shorter than minimum_wait
      minimum_wait: 60,
    } as never);

    expect(performance.now() - t0).toBeGreaterThanOrEqual(50); // held ~minimum_wait, not just 20ms
    expect(finished[0].timed_out).toBe(true);
  });

  it("keeps the message on screen for at least minimum_wait when the condition is already met", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    const t0 = performance.now();
    await plugin.trial(display(), {
      push_data: { ready: true },
      wait_for: () => true, // immediately satisfied
      message: "<p>Waiting…</p>",
      timeout: null,
      minimum_wait: 60,
    } as never);

    expect(performance.now() - t0).toBeGreaterThanOrEqual(50); // held ~minimum_wait
    expect(finished[0].timed_out).toBe(false);
  });

  it("does not extend a wait that is already longer than minimum_wait", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerSyncPlugin(jsPsych as never);

    const done = plugin.trial(display(), {
      push_data: { role: "a" },
      wait_for: (g: GroupSessionData) => Object.keys(g).length >= 2,
      message: "<p>Waiting…</p>",
      timeout: null,
      minimum_wait: 30,
    } as never);

    // The condition isn't met until ~80ms in — already longer than minimum_wait (30ms).
    setTimeout(() => api.seed("p2", { role: "b" }), 80);
    await done;

    // wait_time reflects the natural ~80ms wait, NOT 80 + minimum_wait (slack for timer jitter).
    expect(finished[0].wait_time).toBeGreaterThanOrEqual(70);
    expect(finished[0].wait_time).toBeLessThan(80 + 30);
  });

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    const api = new MockApi("p1");
    const jsPsych = initJsPsych();
    // Graft the multiplayer seam onto the real instance — same stubbing strategy as the tests
    // above, but everything else (parameter defaults, finishTrial, data collection) is real jsPsych.
    // A released jsPsych has no `multiplayer` module (jsPsych#3694 is unmerged), so create it here.
    const core = jsPsych as unknown as { multiplayer: Record<string, unknown> };
    core.multiplayer = {};
    Object.assign(core.multiplayer, {
      push: api.push.bind(api),
      getAll: api.getAll.bind(api),
      wait: api.wait.bind(api),
    });

    const { getData, expectFinished } = await startTimeline(
      [
        {
          type: MultiplayerSyncPlugin,
          push_data: { ready: true },
          wait_for: (group: GroupSessionData) => Object.keys(group).length >= 1,
        },
      ],
      jsPsych
    );

    await expectFinished();

    const data = getData().values()[0];
    expect(data.group).toEqual({ p1: { ready: true } });
    expect(data.timed_out).toBe(false);
    expect(data.wait_error).toBeNull();
    expect(typeof data.wait_time).toBe("number");
  });
});
