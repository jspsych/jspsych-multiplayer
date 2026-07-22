import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import {
  GroupSessionData,
  MULTIPLAYER_TIMEOUT_ERROR_NAME,
  MultiplayerApiLike,
} from "./multiplayer-api";
import MultiplayerRolePlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the wrapper codes against.
//
// `push` merges into an in-memory session (mirroring the reference adapter's overwrite-per-participant
// semantics — a later push for `me` replaces my whole entry, which is exactly why the wrapper folds
// `joinedAt`/`rounds` forward itself). `wait` honours the fast-path and, failing that, re-checks the
// condition whenever a later push lands; if it's still unmet when `timeout` ms elapse, it rejects —
// driven by Jest fake timers in the timeout test.
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

  get(id: string) {
    return this.session[id];
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
/** Resolve any pending microtasks so the wrapper's promise chain settles before assertions. */
const flush = () => new Promise((r) => setTimeout(r, 0));

// The accessor store is module-level. Tests that assert store state each run a trial that sets it
// first, so there is no cross-test leakage to reset here.

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-role — package surface", () => {
  it("exposes the pure assignment core and the role accessors as statics", () => {
    expect(typeof MultiplayerRolePlugin.assignRoles).toBe("function");
    expect(typeof MultiplayerRolePlugin.getMyRole).toBe("function");
    expect(typeof MultiplayerRolePlugin.getMyAssignment).toBe("function");
    expect(typeof MultiplayerRolePlugin.getRoleMap).toBe("function");
    expect(typeof MultiplayerRolePlugin.participantsByRole).toBe("function");
  });

  it("the static assignRoles actually works (sanity check of the public path)", () => {
    const map = MultiplayerRolePlugin.assignRoles(
      { b: {}, a: {} },
      { roles: ["first", "second"], strategy: "join_order" }
    );
    expect(map.a.role).toBe("first");
    expect(map.b.role).toBe("second");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-role — trial wrapper", () => {
  it("guards: throws if the adapter is not connected (no participantId)", () => {
    const api = new MockApi(null as never);
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);
    expect(() => plugin.trial(display(), { roles: ["a", "b"] } as never)).toThrow(/participantId/i);
  });

  it("guards: a custom strategy function requires an explicit `ready` predicate", () => {
    const api = new MockApi("me");
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);
    expect(() => plugin.trial(display(), { roles: ["a"], strategy: () => ({}) } as never)).toThrow(
      /ready/i
    );
  });

  it("happy path (join_order): assigns over the ready snapshot, finishes, and updates the store", async () => {
    const api = new MockApi("p1");
    api.seed("p1", { joinedAt: 100 }); // p1 already joined (first); the wrapper keeps this first-seen value
    api.seed("p2", { joinedAt: 200 }); // p2 joined later
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["proposer", "responder"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 30000,
    } as never);
    await flush();

    expect(finished).toHaveLength(1);
    const data = finished[0];
    expect(data.timed_out).toBe(false);
    expect(data.assigned_self).toBe(true);
    expect(data.role).toBe("proposer"); // p1 joined first (100 < 200)
    expect(data.role_map.p1.role).toBe("proposer");
    expect(data.role_map.p2.role).toBe("responder");
    // store reflects the assignment for downstream trials
    expect(MultiplayerRolePlugin.getMyRole()).toBe("proposer");
    expect(MultiplayerRolePlugin.participantsByRole().responder).toEqual(["p2"]);
    // group not saved by default
    expect(data.group).toBeUndefined();
  });

  it("save_group: true includes the snapshot assigned over", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { joinedAt: 5 });
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      save_group: true,
      timeout: 30000,
    } as never);
    await flush();

    expect(finished[0].group).toBeDefined();
    expect(Object.keys(finished[0].group).sort()).toEqual(["p1", "p2"]);
  });

  it("round-scoped push: joinedAt is first-seen-stable and per-round data is merged, not clobbered", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { joinedAt: 1 });
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    // Round 0
    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: { score: 10 },
      timeout: 30000,
    } as never);
    await flush();
    const afterR0 = { ...(api.get("p1") as any) };
    const joinedAt0 = afterR0.joinedAt;

    // Round 1: re-run for the same client
    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 1,
      push_data: { score: 20 },
      timeout: 30000,
    } as never);
    await flush();
    const afterR1 = api.get("p1") as any;

    expect(afterR1.joinedAt).toBe(joinedAt0); // never re-stamped
    expect(afterR1.rounds[0]).toEqual({ score: 10 }); // round 0 survived
    expect(afterR1.rounds[1]).toEqual({ score: 20 }); // round 1 added
  });

  it("regression: the push preserves pre-existing top-level state (role_from over a prior field)", async () => {
    // An earlier trial pushed a top-level `cond` field for each participant. The role trial's own
    // push REPLACES this client's whole entry (overwrite-per-participant), so unless the wrapper
    // spreads the previous entry into its payload, `cond` is wiped — and role_from (which reads it)
    // can then never resolve. This runs the wrapper end-to-end over that exact flow.
    const api = new MockApi("p1");
    api.seed("p1", { joinedAt: 100, cond: "high" }); // pre-seeded by an earlier trial
    api.seed("p2", { joinedAt: 200, cond: "low" });
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["high", "low"],
      role_from: (entry: any) => entry.cond, // the role IS the carried field
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 30000,
    } as never);
    await flush();

    // The role resolved from the pre-seeded field…
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(false);
    expect(finished[0].role).toBe("high");
    expect(finished[0].role_map.p2.role).toBe("low");
    // …and the pre-existing top-level field survived this trial's own push.
    const mine = api.get("p1") as any;
    expect(mine.cond).toBe("high");
    expect(mine.joinedAt).toBe(100); // still first-seen, not re-stamped
    expect(mine.rounds[0]).toEqual({}); // round data pushed alongside, not instead
  });

  it("rotate: returns the current round's role on re-run", async () => {
    const run = async (round: number) => {
      const api = new MockApi("p1");
      api.seed("p2", {});
      const { jsPsych, finished } = makeJsPsych(api);
      new MultiplayerRolePlugin(jsPsych as never).trial(display(), {
        roles: ["a", "b"],
        strategy: "rotate",
        group_size: 2,
        round,
        push_data: {},
        timeout: 30000,
      } as never);
      await flush();
      return finished[0].role_map;
    };
    const r0 = await run(0);
    const r1 = await run(1);
    // base order is sorted ids [p1, p2]; round 1 rotates by 1 so the roles swap.
    expect(r0.p1.role).toBe(r1.p2.role);
    expect(r0.p2.role).toBe(r1.p1.role);
  });

  it("overflow: an extra participant is placed in the map with overflow_role (assigned_self true)", async () => {
    const api = new MockApi("p3");
    api.seed("p1", { joinedAt: 1 });
    api.seed("p2", { joinedAt: 2 });
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["proposer", "responder"],
      strategy: "join_order",
      group_size: 3, // exactly 3 present (p1, p2, p3) — but only 2 slots
      round: 0,
      push_data: {},
      overflow_role: "spectator",
      timeout: 30000,
    } as never);
    await flush();

    expect(finished[0].timed_out).toBe(false);
    expect(finished[0].role).toBe("spectator");
    expect(finished[0].assigned_self).toBe(true); // p3 IS in the map, as overflow
  });

  it("assigned_self false: a custom strategy that omits me yields role null but not a timeout", async () => {
    const api = new MockApi("p1");
    api.seed("p2", {});
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["x"],
      // Custom strategy hands p2 a role and leaves p1 (me) out — a deliberate spectator.
      strategy: (snapshot: Record<string, unknown>) => ({ p2: { role: "x" } }),
      ready: (snapshot: Record<string, unknown>) => Object.keys(snapshot).length === 2,
      round: 0,
      push_data: {},
      timeout: 30000,
    } as never);
    await flush();

    expect(finished[0].timed_out).toBe(false); // an assignment DID run
    expect(finished[0].role).toBeNull(); // but I'm not in it
    expect(finished[0].assigned_self).toBe(false);
    expect(finished[0].role_map.p2.role).toBe("x"); // the map exists (unlike a timeout)
  });

  it("config error (overflow, no overflow_role) propagates — NOT relabelled as a timeout", async () => {
    const api = new MockApi("p1");
    api.seed("p1", { joinedAt: 1 });
    api.seed("p2", { joinedAt: 2 });
    const { jsPsych, finished } = makeJsPsych(api);
    const onTimeout = jest.fn();
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    // Two ready participants but only one slot and no overflow_role -> assignRoles throws AFTER
    // readiness passed. That is a config bug, so it must surface, not masquerade as a timeout.
    const result = plugin.trial(display(), {
      roles: ["only_one"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 30000,
      on_timeout: onTimeout,
    } as never) as Promise<void>;

    await expect(result).rejects.toThrow(/role slots/i);
    expect(onTimeout).not.toHaveBeenCalled(); // not the timeout path
    expect(finished).toHaveLength(0); // trial did not finish as timed_out
  });

  it("propagates a non-timeout wait() rejection instead of mislabeling it a timeout", async () => {
    // Only a rejection named "MultiplayerTimeoutError" is a genuine timeout. Anything else (a
    // throwing wait_for, an adapter/backend error) must fail the trial loudly instead of being
    // routed through handleTimeout.
    const api = new MockApi("p1");
    jest.spyOn(api, "wait").mockRejectedValue(new Error("adapter disconnected"));
    const onTimeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    const result = plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 30000,
      on_timeout: onTimeout,
    } as never) as Promise<void>;

    await expect(result).rejects.toThrow(/adapter disconnected/);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
  });

  it("group_size exact-count gating: stalls at N-1, resolves when the Nth arrives", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 30000,
    } as never);
    await flush();
    expect(finished).toHaveLength(0); // only p1 present so far — not ready

    api.seed("p2", { joinedAt: 99 }); // Nth participant arrives with required field
    await flush();
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(false);
  });

  it("warns and can resolve over a partial group when group_size and ready are both omitted", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MockApi("p1"); // only this client present, no group_size cap
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      round: 0,
      push_data: {},
      timeout: 30000,
    } as never);
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/group_size/);
    // The hazard the warning describes: readiness resolved over just p1, a partial group.
    expect(finished).toHaveLength(1);
    expect(finished[0].role).toBe("a");
    expect(Object.keys(finished[0].role_map)).toEqual(["p1"]);
    warn.mockRestore();
  });

  it("a throwing on_timeout hook still ends the trial (no hang)", async () => {
    jest.useFakeTimers();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1"); // alone, group_size 2 never satisfied
    const { jsPsych, finished } = makeJsPsych(api);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 30000,
      on_timeout: () => {
        throw new Error("hook boom");
      },
    } as never);

    await Promise.resolve();
    jest.advanceTimersByTime(30000);
    jest.useRealTimers();
    await flush();

    // The hook threw, but finishTrial must still run so the trial doesn't hang.
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("timeout: rejects -> handleTimeout finishes role:null/timed_out:true, runs the hook, clears the store", async () => {
    jest.useFakeTimers();
    const api = new MockApi("p1"); // alone, group_size 2 never satisfied
    const { jsPsych, finished } = makeJsPsych(api);
    const onTimeout = jest.fn();
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 30000,
      on_timeout: onTimeout,
    } as never);

    await Promise.resolve(); // let communicate's push/await settle and the wait subscribe
    jest.advanceTimersByTime(30000); // fire the timeout
    jest.useRealTimers();
    await flush(); // let the rejection propagate through .catch

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      role: null,
      role_map: null,
      assigned_self: false,
      timed_out: true,
    });
    expect(MultiplayerRolePlugin.getMyRole()).toBeUndefined(); // store cleared
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-role — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type, and saves the assignment", async () => {
    // Real jsPsych instance; only the multiplayer seam (its own module in jsPsych core as of
    // jsPsych#3694, not yet in the published types) is stubbed with the same mock the unit tests use.
    const jsPsych = initJsPsych();
    const api = new MockApi("p1");
    api.seed("p1", { joinedAt: 100 });
    api.seed("p2", { joinedAt: 200 });
    // A released jsPsych has no `multiplayer` module (jsPsych#3694 is unmerged), so create it here.
    const core = jsPsych as unknown as { multiplayer: Record<string, unknown> };
    core.multiplayer = {};
    Object.assign(core.multiplayer, {
      participantId: api.participantId,
      push: api.push.bind(api),
      get: api.get.bind(api),
      getAll: api.getAll.bind(api),
      wait: api.wait.bind(api),
    });

    // jsPsych's parameter pipeline warns when a FUNCTION-typed parameter receives a string — the
    // documented, deliberate tradeoff of typing `strategy` as FUNCTION (see info.parameters). Capture
    // the warning so it is asserted (the tradeoff is known) rather than leaking into test output.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { getData, expectFinished, finished } = await startTimeline(
      [
        {
          type: MultiplayerRolePlugin,
          roles: ["proposer", "responder"],
          strategy: "join_order",
          group_size: 2,
        },
      ],
      jsPsych
    );

    await finished;
    await expectFinished();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/non-function value.*strategy/i));
    warn.mockRestore();

    const data = getData().values()[0];
    expect(data.trial_type).toBe("multiplayer-role"); // jsPsych records info.name (sans plugin- prefix)
    expect(data.role).toBe("proposer"); // p1 joined first
    expect(data.role_map.p2.role).toBe("responder");
    expect(data.timed_out).toBe(false);
    expect(MultiplayerRolePlugin.getMyRole()).toBe("proposer");
  });
});
