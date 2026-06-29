import { GroupSessionData, MultiplayerApiLike } from "./multiplayer-api";
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
// The published `jspsych` in this repo has no multiplayer API, so the fork's real-adapter +
// startTimeline tests can't run here; this mock + direct trial() call exercises the same logic
// without a live group session.
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
    expect(typeof finished[0].wait_time).toBe("number");
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
    expect(finished[0].group).toEqual(api.getAll()); // snapshot from getAll() on timeout
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
});
