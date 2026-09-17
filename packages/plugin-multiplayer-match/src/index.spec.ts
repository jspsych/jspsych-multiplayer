import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import {
  GroupSessionData,
  MULTIPLAYER_CANCELLED_ERROR_NAME,
  MULTIPLAYER_TIMEOUT_ERROR_NAME,
  MultiplayerApiLike,
} from "./multiplayer-api";
import MultiplayerMatchPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the wrapper codes against, modelling the
// jsPsych#3694 contract closely enough to catch regressions against it:
//   - reads (`get`, `getAll`, the `wait` snapshot and the condition's argument) hand back JSON
//     copies, never the live session, so a wrapper that mutated or aliased a snapshot would be caught;
//   - `update` shallow-merges onto this client's LAST WRITE (falling back to its entry before the
//     first write) and, like the real API, rejects rather than throwing when it fails;
//   - `wait` honours the fast path, re-checks whenever a write/seed lands, treats null/negative/
//     non-finite timeouts as "no timeout", rejects with a `MultiplayerTimeoutError`-named error on
//     expiry, and can be cancelled (`cancelAllWaits`) with a `MultiplayerCancelledError`-named one,
//     as jsPsych does at experiment end/abort.
// `seed` simulates a peer's write. Timeout tests use Jest fake timers.
// ---------------------------------------------------------------------------------------------------
class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  /** Pending waits, each able to settle itself — a cancel rejects them the way jsPsych's teardown does. */
  private waiters: Array<{ check: () => void; cancel: () => void }> = [];
  /** This client's last successful write: the merge base `update()` uses, as the real API does. */
  private lastWrite: Record<string, unknown> | null = null;

  constructor(public participantId: string | null) {}

  /** Seed another participant's entry directly (simulating their write), notifying any waiter. */
  seed(id: string, data: Record<string, unknown>) {
    this.session[id] = data;
    this.notify();
  }

  /** Reject every pending wait, as cancelAllSubscriptions()/disconnect()/abortExperiment() do. */
  cancelAllWaits() {
    this.waiters.splice(0).forEach((waiter) => waiter.cancel());
  }

  async push(data: Record<string, unknown>) {
    this.lastWrite = copy(data);
    this.session[this.participantId as string] = copy(data); // overwrite-per-participant, like the real adapter
    this.notify();
  }

  async update(data: Record<string, unknown>) {
    const base = this.lastWrite ?? this.session[this.participantId as string] ?? {};
    await this.push({ ...copy(base), ...data });
  }

  getAll() {
    return copy(this.session);
  }

  get(id: string) {
    const entry = this.session[id];
    return entry === undefined ? undefined : copy(entry);
  }

  wait(condition: (d: GroupSessionData) => boolean, timeout?: number | null) {
    return new Promise<GroupSessionData>((resolve, reject) => {
      const snapshot = copy(this.session);
      if (condition(snapshot)) return resolve(snapshot); // fast path

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        finish();
      };
      const rejectNamed = (name: string, message: string) =>
        settle(() => {
          const err = new Error(message);
          err.name = name; // the real API's rejections are identified by name, not class
          reject(err);
        });

      this.waiters.push({
        check: () => {
          const current = copy(this.session);
          if (!settled && condition(current)) settle(() => resolve(current));
        },
        cancel: () => rejectNamed(MULTIPLAYER_CANCELLED_ERROR_NAME, "wait cancelled"),
      });

      // Only a finite, non-negative timeout bounds the wait: null/undefined/negative/non-finite all
      // mean "wait forever", while 0 times out at once.
      if (timeout != null && Number.isFinite(timeout) && timeout >= 0) {
        timer = setTimeout(
          () => rejectNamed(MULTIPLAYER_TIMEOUT_ERROR_NAME, `wait timed out after ${timeout}ms`),
          timeout,
        );
      }
    });
  }

  private notify() {
    this.waiters.forEach((waiter) => waiter.check());
  }
}

/** JSON deep copy, exactly what the real API hands out of every read. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
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
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Default params so each test only overrides what it cares about. */
const base = {
  group_size: 2,
  expected_players: null,
  strategy: "ordered",
  seed: null,
  round: 0,
  leftover: "error",
  ready: null,
  push_data: {},
  save_group: false,
  timeout: 30000,
  on_timeout: null,
  message: "<p>matching…</p>",
};

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-match — package surface", () => {
  it("exposes the pure partition core and the match accessors as statics", () => {
    expect(typeof MultiplayerMatchPlugin.buildMatches).toBe("function");
    expect(typeof MultiplayerMatchPlugin.getMyMatch).toBe("function");
    expect(typeof MultiplayerMatchPlugin.getMyPartners).toBe("function");
    expect(typeof MultiplayerMatchPlugin.getMyGroup).toBe("function");
    expect(typeof MultiplayerMatchPlugin.getMyPosition).toBe("function");
    expect(typeof MultiplayerMatchPlugin.getMatchMap).toBe("function");
  });

  it("the static buildMatches works (sanity check of the public path)", () => {
    const map = MultiplayerMatchPlugin.buildMatches({ b: {}, a: {}, d: {}, c: {} });
    expect(map.a.partners).toEqual(["b"]);
    expect(map.c.partners).toEqual(["d"]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-match — trial wrapper", () => {
  it("guards: throws if the adapter is not connected (no participantId)", () => {
    const api = new MockApi(null);
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerMatchPlugin(jsPsych as never);
    expect(() => plugin.trial(display(), { ...base, expected_players: 2 } as never)).toThrow(
      /participantId/i,
    );
  });

  it("partitions the group into pairs, exposes partners, and publishes the store", async () => {
    const api = new MockApi("a");
    api.seed("b", {});
    api.seed("c", {});
    api.seed("d", {});
    const { jsPsych, finished } = makeJsPsych(api);

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 4,
    } as never);

    expect(finished).toHaveLength(1);
    const data = finished[0];
    expect(data.timed_out).toBe(false);
    expect(data.matched_self).toBe(true);
    expect(data.match_group).toBe(0); // a,b -> group 0
    expect(data.partners).toEqual(["b"]);
    expect(data.members).toEqual(["a", "b"]);
    expect(data.position).toBe(0);
    // The full agreed map covers everyone.
    expect(Object.keys(data.match_map).sort()).toEqual(["a", "b", "c", "d"]);
    expect(data.match_map.c.partners).toEqual(["d"]);
    // Store is published for downstream trials.
    expect(MultiplayerMatchPlugin.getMyPartners()).toEqual(["b"]);
    expect(MultiplayerMatchPlugin.getMyGroup()).toBe(0);
  });

  it("holds at the barrier until expected_players are present", async () => {
    const api = new MockApi("a");
    api.seed("b", {});
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 4,
    } as never);
    await flush();

    expect(finished).toHaveLength(0); // only a + b present, waiting
    expect(el.innerHTML).toContain("matching");

    api.seed("c", {});
    api.seed("d", {}); // now four are present
    await done;

    expect(finished).toHaveLength(1);
    expect(Object.keys(finished[0].match_map)).toHaveLength(4);
  });

  it("warns when neither expected_players nor a ready predicate is set", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MockApi("a");
    const { jsPsych } = makeJsPsych(api);

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      leftover: "spectator", // a alone -> spectator, so the trial still ends cleanly
    } as never);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/expected_players/));
    warn.mockRestore();
  });

  it("random strategy pairs deterministically and is stable across key order", async () => {
    const run = async (ids: string[]) => {
      const api = new MockApi(ids[0]);
      ids.slice(1).forEach((id) => api.seed(id, {}));
      const { jsPsych, finished } = makeJsPsych(api);
      await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
        ...base,
        expected_players: 4,
        strategy: "random",
      } as never);
      return finished[0].match_map;
    };
    const m1 = await run(["a", "b", "c", "d"]);
    const m2 = await run(["d", "c", "b", "a"]); // different arrival/key order
    // Same partners for each id regardless of who is "me" or key order (consensus).
    expect(m1.a.partners).toEqual(m2.a.partners);
    expect(m1.d.partners).toEqual(m2.d.partners);
  });

  it("leftover 'spectator' leaves the odd participant unmatched (matched_self false, not a timeout)", async () => {
    const api = new MockApi("c"); // c is the odd one out in a,b,c
    api.seed("a", {});
    api.seed("b", {});
    const { jsPsych, finished } = makeJsPsych(api);

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 3,
      leftover: "spectator",
    } as never);

    const data = finished[0];
    expect(data.matched_self).toBe(false); // c is a spectator
    expect(data.timed_out).toBe(false); // ...distinct from a timeout
    expect(data.match_group).toBeNull();
    expect(data.partners).toEqual([]); // a spectator has zero partners, not null (null = timeout)
    expect(data.members).toBeNull();
    expect(data.match_map.c).toBeUndefined(); // absent from the map
    expect(data.match_map.a.partners).toEqual(["b"]); // a,b still matched
    expect(MultiplayerMatchPlugin.getMyMatch()).toBeUndefined();
  });

  it("a non-divisible group with leftover 'error' rejects (config error, NOT relabeled a timeout)", async () => {
    const on_timeout = jest.fn();
    const api = new MockApi("a");
    api.seed("b", {});
    api.seed("c", {}); // 3 players, group_size 2 -> not divisible
    const { jsPsych, finished } = makeJsPsych(api);

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 3,
      on_timeout, // must NOT fire — readiness was met; buildMatches threw a config error
    } as never);

    await expect(done).rejects.toThrow(/not a multiple/);
    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
  });

  it("times out (fail loud) when the group never reaches readiness", async () => {
    jest.useFakeTimers();
    try {
      const api = new MockApi("a"); // alone; expected_players 4 never reached
      const on_timeout = jest.fn();
      const { jsPsych, finished } = makeJsPsych(api);

      const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
        ...base,
        expected_players: 4,
        timeout: 1000,
        on_timeout,
      } as never);

      await Promise.resolve(); // let push resolve + register the wait timer
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await done;

      expect(on_timeout).toHaveBeenCalledTimes(1);
      const data = finished[0];
      expect(data.timed_out).toBe(true);
      expect(data.matched_self).toBe(false);
      expect(data.match_map).toBeNull();
      expect(MultiplayerMatchPlugin.getMyMatch()).toBeUndefined(); // stale assignment cleared
    } finally {
      jest.useRealTimers();
    }
  });

  it("propagates a non-timeout rejection (e.g. write failure) instead of masking it as a timeout", async () => {
    const api = new MockApi("a");
    api.update = () => Promise.reject(new Error("backend unavailable")); // not a MultiplayerTimeoutError
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
      timeout: 1000,
      on_timeout,
    } as never);

    await expect(done).rejects.toThrow(/backend unavailable/);
    expect(on_timeout).not.toHaveBeenCalled(); // NOT routed to the graceful timeout path
    expect(finished).toHaveLength(0); // trial halts loudly rather than finishing timed_out
  });

  it("stops quietly when the wait is cancelled (experiment ending), without timing out", async () => {
    // jsPsych cancels pending waits at the end of run()/on abortExperiment(). That is a teardown,
    // not a readiness expiry: the trial must not run on_timeout, finish a timed_out record, or log.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("a"); // alone; expected_players 4 is never reached
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 4,
      timeout: 10000,
      on_timeout,
    } as never);
    await flush(); // the write has landed and the wait is pending

    api.cancelAllWaits();
    await expect(done).resolves.toBeUndefined(); // returns, rather than rejecting

    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("join_order readiness waits until every present participant has pushed joinedAt", async () => {
    const api = new MockApi("a");
    api.seed("b", {}); // present but no joinedAt yet
    const { jsPsych, finished } = makeJsPsych(api);

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
      strategy: "join_order",
    } as never);
    await flush();

    expect(finished).toHaveLength(0); // b has no joinedAt -> not ready despite the count

    api.seed("b", { joinedAt: 5 }); // now b is field-ready
    await done;
    expect(finished).toHaveLength(1);
    // a pushed joinedAt = now (large), b = 5, so join order is b, a -> they pair (only two).
    expect(finished[0].partners).toEqual(["b"]);
  });

  it("preserves keys already in this client's slot (update merges over the existing entry)", async () => {
    const api = new MockApi("a");
    api.seed("a", { condition: "treatment" }); // an earlier trial wrote data
    api.seed("b", {});
    const { jsPsych } = makeJsPsych(api);

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
    } as never);

    expect((api.get("a") as any).condition).toBe("treatment"); // survived the match push
    expect(typeof (api.get("a") as any).joinedAt).toBe("number"); // and joinedAt was stamped
  });

  it("includes the snapshot only when save_group is true", async () => {
    const api = new MockApi("a");
    api.seed("b", {});
    const withGroup = makeJsPsych(api);
    await new MultiplayerMatchPlugin(withGroup.jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
      save_group: true,
    } as never);
    expect(withGroup.finished[0].group).toBeDefined();

    const api2 = new MockApi("a");
    api2.seed("b", {});
    const without = makeJsPsych(api2);
    await new MultiplayerMatchPlugin(without.jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
    } as never);
    expect(without.finished[0].group).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-match — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type and the match", async () => {
    const jsPsych = initJsPsych();
    const api = new MockApi("p1");
    api.seed("p2", {});
    // A released jsPsych has no `multiplayer` module (jsPsych#3694 is unmerged), so create it here.
    const core = jsPsych as unknown as { multiplayer: Record<string, unknown> };
    core.multiplayer = {
      participantId: api.participantId,
      get: api.get.bind(api),
      update: api.update.bind(api),
      getAll: api.getAll.bind(api),
      wait: api.wait.bind(api),
    };

    const { getData, expectFinished } = await startTimeline(
      [{ type: MultiplayerMatchPlugin, expected_players: 2, group_size: 2 }],
      jsPsych,
    );
    await expectFinished();

    const data = getData().values()[0];
    expect(data.trial_type).toBe("multiplayer-match");
    expect(data.match_group).toBe(0);
    expect(data.partners).toEqual(["p2"]);
    expect(MultiplayerMatchPlugin.getMyPartners()).toEqual(["p2"]);
  });
});
