import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { GroupSessionData, MultiplayerApiLike } from "./multiplayer-api";
import MultiplayerReadyPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the plugin codes against.
//
// `push` overwrites this participant's entry (mirroring the reference adapter's
// overwrite-per-participant semantics) and notifies any waiter. `wait` honours the fast-path and,
// failing that, re-checks the condition whenever a later push/seed lands; if it's still unmet when
// `timeout` ms elapse, it rejects. Tests use real timers with short timeouts, so no fake-timer
// plumbing is needed.
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
            reject(new Error(`wait timed out after ${timeout}ms`));
          }
        }, timeout);
      }
    });
  }
}

/** Minimal jsPsych double exposing `pluginAPI` (the mock) and capturing `finishTrial` data. */
function makeJsPsych(api: MockApi) {
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    pluginAPI: api,
    finishTrial: (data: Record<string, any>) => finished.push(data),
  };
  return { jsPsych, finished };
}

const display = () => document.createElement("div");
/** Resolve any pending microtasks so the plugin's promise chain settles before assertions. */
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Click the ready button rendered into `el`. */
const clickReady = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>("#jspsych-multiplayer-ready-btn")!.click();

describe("multiplayer-ready plugin", () => {
  it("pushes { ready: true } and ends once the group is ready (solo, expected_players 1)", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 1,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: null,
    } as never);

    clickReady(el);
    await done;

    expect(finished).toHaveLength(1);
    expect(finished[0].group).toEqual({ p1: { ready: true } });
    expect(finished[0].n_ready).toBe(1);
    expect(finished[0].timed_out).toBe(false);
    expect(finished[0].wait_error).toBeNull();
    expect(typeof finished[0].rt).toBe("number");
    expect(typeof finished[0].wait_time).toBe("number");
  });

  it("renders the stimulus and button, and fires on_load once the screen is rendered", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const on_load = jest.fn();
    const el = display();

    const done = plugin.trial(
      el,
      {
        expected_players: 1,
        stimulus: "<p>Are you ready to start?</p>",
        prompt: null,
        button_label: "Let's go",
        waiting_message: "<p>Waiting…</p>",
        push_data: null,
        timeout: null,
      } as never,
      on_load
    );

    expect(on_load).toHaveBeenCalledTimes(1);
    expect(el.innerHTML).toContain("Are you ready to start?");
    expect(el.querySelector("#jspsych-multiplayer-ready-btn")!.textContent).toBe("Let's go");

    clickReady(el);
    await done;
  });

  it("renders the optional secondary prompt below the button only when provided", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 1,
      stimulus: "<p>Ready?</p>",
      prompt: "<p>You'll be matched with one other player.</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: null,
    } as never);

    expect(el.querySelector(".jspsych-multiplayer-ready-prompt")!.innerHTML).toContain(
      "matched with one other player"
    );

    clickReady(el);
    await done;
  });

  it("merges push_data with the ready flag in a single overwrite", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 1,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: { name: "Ada" },
      timeout: null,
    } as never);

    clickReady(el);
    await done;

    expect(api.getAll()).toEqual({ p1: { name: "Ada", ready: true } });
    expect(finished[0].group).toEqual({ p1: { name: "Ada", ready: true } });
  });

  it("shows the waiting message after the click and holds until the whole group is ready", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 2,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting for the other player…</p>",
      push_data: null,
      timeout: null,
    } as never);

    clickReady(el);
    await flush();

    // Only p1 is ready so far — the barrier should still be holding, waiting message on screen.
    expect(finished).toHaveLength(0);
    expect(el.innerHTML).toContain("Waiting for the other player");

    // The second participant checks in.
    api.seed("p2", { ready: true });
    await done;

    expect(finished).toHaveLength(1);
    expect(finished[0].group).toEqual({ p1: { ready: true }, p2: { ready: true } });
    expect(finished[0].n_ready).toBe(2);
    expect(finished[0].timed_out).toBe(false);
  });

  it("does not count members who are present but not ready", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { status: "joined" }); // present, but no ready flag
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 2,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: null,
    } as never);

    clickReady(el);
    await flush();

    // p1 ready + p2 merely present = only 1 ready, so the barrier holds.
    expect(finished).toHaveLength(0);

    api.seed("p2", { ready: true }); // now p2 is actually ready
    await done;

    expect(finished[0].n_ready).toBe(2);
  });

  it("throws if expected_players is missing or not a positive integer", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);

    await expect(
      plugin.trial(display(), {
        expected_players: undefined,
        stimulus: "<p>Ready?</p>",
        button_label: "I'm ready",
        waiting_message: "<p>Waiting…</p>",
        push_data: null,
        timeout: null,
      } as never)
    ).rejects.toThrow(/expected_players/);
  });

  it("propagates a push failure instead of masking it as a timeout", async () => {
    const api = new MockApi("p1");
    jest.spyOn(api, "push").mockRejectedValue(new Error("connection lost"));
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 1,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: null,
      on_timeout,
    } as never);

    clickReady(el);
    await expect(done).rejects.toThrow(/connection lost/);

    // A push (infrastructure) failure must NOT be relabeled as a timeout.
    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
  });

  it("ends with timed_out and calls on_timeout when the group isn't ready in time", async () => {
    const api = new MockApi("p1");
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 2, // second player never checks in
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: 40,
      on_timeout,
    } as never);

    clickReady(el);
    await done;

    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].wait_error).toMatch(/timed out/); // rejection message preserved in the data
    expect(finished[0].group).toEqual(api.getAll()); // snapshot from getAll() on timeout
    expect(finished[0].n_ready).toBe(1); // only p1 ever became ready
  });

  it("records a non-timeout wait() rejection message in wait_error", async () => {
    const api = new MockApi("p1");
    jest.spyOn(api, "wait").mockRejectedValue(new Error("adapter disconnected"));
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 2,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: 40,
    } as never);

    clickReady(el);
    await done;

    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].wait_error).toBe("adapter disconnected");
  });

  it("still finishes gracefully when getAll() throws on the rejection path (adapter torn down)", async () => {
    const api = new MockApi("p1");
    jest.spyOn(api, "wait").mockRejectedValue(new Error("adapter disconnected"));
    jest.spyOn(api, "getAll").mockImplementation(() => {
      throw new Error("connect() must be called before using multiplayer methods");
    });
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 2,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: 40,
    } as never);

    clickReady(el);
    // A throwing getAll() must not escape and reject the trial; it falls back to an empty snapshot.
    await expect(done).resolves.toBeUndefined();

    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].wait_error).toBe("adapter disconnected"); // original error preserved, not masked
    expect(finished[0].group).toEqual({});
    expect(finished[0].n_ready).toBe(0);
  });

  it("holds the waiting message for at least minimum_wait when the group is already ready", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const t0 = performance.now();
    const done = plugin.trial(el, {
      expected_players: 1, // immediately satisfied after this participant pushes
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: null,
      minimum_wait: 60,
    } as never);

    clickReady(el);
    await done;

    expect(performance.now() - t0).toBeGreaterThanOrEqual(50); // held ~minimum_wait, not flashed
    expect(finished[0].timed_out).toBe(false);
  });

  it("does not extend a group wait that is already longer than minimum_wait", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 2,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: null,
      minimum_wait: 30,
    } as never);

    clickReady(el);
    // The second player doesn't arrive until ~80ms in — already longer than minimum_wait (30ms).
    setTimeout(() => api.seed("p2", { ready: true }), 80);
    await done;

    // wait_time reflects the natural ~80ms wait, NOT 80 + minimum_wait (slack for timer jitter).
    expect(finished[0].wait_time).toBeGreaterThanOrEqual(70);
    expect(finished[0].wait_time).toBeLessThan(80 + 30);
  });

  it("measures rt (time to click) and wait_time (time waiting for the group) separately", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerReadyPlugin(jsPsych as never);
    const el = display();

    const done = plugin.trial(el, {
      expected_players: 2,
      stimulus: "<p>Ready?</p>",
      button_label: "I'm ready",
      waiting_message: "<p>Waiting…</p>",
      push_data: null,
      timeout: null,
    } as never);

    // Click after ~40ms, then let the second player join ~60ms later.
    await new Promise((r) => setTimeout(r, 40));
    clickReady(el);
    setTimeout(() => api.seed("p2", { ready: true }), 60);
    await done;

    expect(finished[0].rt).toBeGreaterThanOrEqual(30);
    expect(finished[0].wait_time).toBeGreaterThanOrEqual(50);
  });

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    const api = new MockApi("p1");
    const jsPsych = initJsPsych();
    // Graft the multiplayer seam onto the real pluginAPI — everything else (parameter defaults,
    // finishTrial, data collection) is real jsPsych.
    Object.assign(jsPsych.pluginAPI, {
      push: api.push.bind(api),
      getAll: api.getAll.bind(api),
      wait: api.wait.bind(api),
    });

    const { getData, expectFinished, displayElement } = await startTimeline(
      [
        {
          type: MultiplayerReadyPlugin,
          expected_players: 1,
          stimulus: "<p>Ready?</p>",
        },
      ],
      jsPsych
    );

    displayElement.querySelector<HTMLButtonElement>("#jspsych-multiplayer-ready-btn")!.click();
    await expectFinished();

    const data = getData().values()[0];
    expect(data.group).toEqual({ p1: { ready: true } });
    expect(data.n_ready).toBe(1);
    expect(data.timed_out).toBe(false);
    expect(data.wait_error).toBeNull();
    expect(typeof data.rt).toBe("number");
    expect(typeof data.wait_time).toBe("number");
  });
});
