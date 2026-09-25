import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions, GroupSessionData, PresenceData } from "jspsych";

import { MemoryHub } from "../../../test-utils/memory-backend";
import MultiplayerRolePlugin from ".";

/**
 * A jsPsych stand-in whose `multiplayer` is a real session on an in-memory hub, so the plugin runs
 * against the actual core (frozen snapshots, presence, errors) while `finishTrial` is captured.
 * `api.seed(id, data)` writes a participant's slot as if they had written it, and marks them connected.
 */
async function setup(participantId = "p1", connect?: ConnectOptions) {
  const hub = new MemoryHub();
  const me = await hub.join(participantId, { connect });
  const multiplayer = me.jsPsych.multiplayer;
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    multiplayer,
    finishTrial: (data: Record<string, any>) => finished.push(data),
  };
  const api = {
    seed: (id: string, data: Record<string, unknown>) =>
      id === participantId ? void multiplayer.update(data) : hub.addPeer(id, data),
    get: (id: string) => multiplayer.get(id),
  };
  return { hub, me, multiplayer, jsPsych, finished, api };
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
      { roles: ["first", "second"], strategy: "join_order" },
    );
    expect(map.a.role).toBe("first");
    expect(map.b.role).toBe("second");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-role — trial wrapper", () => {
  it("guards: throws if the adapter is not connected (no participantId)", () => {
    const jsPsych = { multiplayer: { participantId: null } };
    const plugin = new MultiplayerRolePlugin(jsPsych as never);
    expect(() => plugin.trial(display(), { roles: ["a", "b"] } as never)).toThrow(/participantId/i);
  });

  it("guards: a custom strategy function requires an explicit `ready` predicate", () => {
    const jsPsych = { multiplayer: { participantId: "me" } };
    const plugin = new MultiplayerRolePlugin(jsPsych as never);
    expect(() => plugin.trial(display(), { roles: ["a"], strategy: () => ({}) } as never)).toThrow(
      /ready/i,
    );
  });

  it("happy path (join_order): assigns over the ready snapshot, finishes, and updates the store", async () => {
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p1", { joinedAt: 100 }); // p1 already joined (first); the wrapper keeps this first-seen value
    api.seed("p2", { joinedAt: 200 }); // p2 joined later

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
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { joinedAt: 5 });

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

  it("round-scoped write: joinedAt is first-seen-stable and per-round data is merged, not clobbered", async () => {
    const { api, jsPsych } = await setup("p1");
    api.seed("p2", { joinedAt: 1 });

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

  it("regression: the round write preserves pre-existing top-level state (role_from over a prior field)", async () => {
    // An earlier trial pushed a top-level `cond` field for each participant. A plain `push()` would
    // REPLACE this client's whole entry and wipe `cond` — and role_from (which reads it) could then
    // never resolve. The wrapper uses `update()`, which shallow-merges its two keys into the slot
    // and leaves every other one alone. This runs the wrapper end-to-end over that exact flow.
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p1", { joinedAt: 100, cond: "high" }); // pre-seeded by an earlier trial
    api.seed("p2", { joinedAt: 200, cond: "low" });

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
    // …and the pre-existing top-level field survived this trial's own write.
    const mine = api.get("p1") as any;
    expect(mine.cond).toBe("high");
    expect(mine.joinedAt).toBe(100); // still first-seen, not re-stamped
    expect(mine.rounds[0]).toEqual({}); // round data pushed alongside, not instead
  });

  it("rotate: returns the current round's role on re-run", async () => {
    const run = async (round: number) => {
      const { api, jsPsych, finished } = await setup("p1");
      api.seed("p2", {});

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
    const { api, jsPsych, finished } = await setup("p3");
    api.seed("p1", { joinedAt: 1 });
    api.seed("p2", { joinedAt: 2 });

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
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", {});

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
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p1", { joinedAt: 1 });
    api.seed("p2", { joinedAt: 2 });

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
    const { jsPsych, finished, multiplayer } = await setup("p1");
    jest.spyOn(multiplayer, "wait").mockRejectedValue(new Error("adapter disconnected"));
    const onTimeout = jest.fn();
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

  it("returns quietly when the wait is cancelled (experiment ending or aborting)", async () => {
    // Core cancels pending waits on cancelAllSubscriptions()/disconnect()/abortExperiment()/the end
    // of jsPsych.run(). The trial is already being torn down, so a cancel is neither a timeout nor a
    // failure: no on_timeout, no `timed_out: true` record, no rejection, nothing logged.
    const { jsPsych, finished, multiplayer } = await setup("p1"); // alone, group_size 2 never satisfied
    const onTimeout = jest.fn();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

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

    await flush();
    expect(finished).toHaveLength(0); // still waiting for the second participant

    multiplayer.cancelAllSubscriptions(); // the experiment ends / is aborted underneath the trial

    await expect(result).resolves.toBeUndefined(); // stopped quietly, did not reject
    expect(onTimeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0); // no bogus timed_out record
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("group_size exact-count gating: stalls at N-1, resolves when the Nth arrives", async () => {
    const { api, jsPsych, finished } = await setup("p1");

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

  it("in a sealed group, group_size defaults to the roster, without a warning", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { hub, jsPsych, finished } = await setup("p1");
    hub.seal(["p1", "p2"]);
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      round: 0,
      push_data: {},
      timeout: 30000,
    } as never);
    await flush();
    expect(warn).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0); // p2 is on the roster but hasn't arrived

    const p2 = await hub.join("p2");
    await p2.jsPsych.multiplayer.update({ joinedAt: 99 });
    await flush();
    expect(finished).toHaveLength(1);
    expect(Object.keys(finished[0].role_map).sort()).toEqual(["p1", "p2"]);
    warn.mockRestore();
  });

  it("warns and can resolve over a partial group when group_size and ready are both omitted", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1"); // only this client present, no group_size cap

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
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1"); // alone, group_size 2 never satisfied

    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 40,
      on_timeout: () => {
        throw new Error("hook boom");
      },
    } as never);

    await new Promise((r) => setTimeout(r, 80));

    // The hook threw, but finishTrial must still run so the trial doesn't hang.
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("timeout: rejects -> handleTimeout finishes role:null/timed_out:true, runs the hook, clears the store", async () => {
    const { api, jsPsych, finished } = await setup("p1"); // alone, group_size 2 never satisfied

    const onTimeout = jest.fn();
    const plugin = new MultiplayerRolePlugin(jsPsych as never);

    plugin.trial(display(), {
      roles: ["a", "b"],
      strategy: "join_order",
      group_size: 2,
      round: 0,
      push_data: {},
      timeout: 40,
      on_timeout: onTimeout,
    } as never);

    await new Promise((r) => setTimeout(r, 80)); // the 40 ms timeout fires

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
    // Real jsPsych instance connected to the in-memory backend.
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    await jsPsych.multiplayer.update({ joinedAt: 100 });
    hub.addPeer("p2", { joinedAt: 200 });

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
      jsPsych,
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

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-role — departures", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const trialBase = {
    roles: ["a", "b"],
    strategy: "join_order",
    group_size: 2,
    round: 0,
    push_data: {},
    timeout: 30000,
  };

  it("ends unassigned with partner_left when a participant leaves before the group is ready", async () => {
    const { hub, jsPsych, finished } = await setup("p1", { dropoutTimeout: 10 });
    const peer = await hub.join("p2");
    const onTimeout = jest.fn();

    const done = new MultiplayerRolePlugin(jsPsych as never).trial(display(), {
      ...trialBase,
      group_size: 3,
      on_timeout: onTimeout,
    } as never) as Promise<void>;
    await sleep(0);
    await peer.jsPsych.multiplayer.disconnect();
    await done;

    expect(finished[0]).toMatchObject({
      role: null,
      role_map: null,
      partner_left: true,
      left_participant: "p2",
      timed_out: false,
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("waits out a leftover slot that is only away instead of giving it a role", async () => {
    const { hub, api, jsPsych, finished } = await setup("p1", { dropoutTimeout: 20 });
    await jsPsych.multiplayer.update({ joinedAt: 100 });
    hub.seed("ghost", { joinedAt: 1 }); // not connected, so `away` until it turns `left`

    const done = new MultiplayerRolePlugin(jsPsych as never).trial(display(), {
      ...trialBase,
      group_size: null,
      ready: (s: GroupSessionData) => Object.keys(s).length >= 2,
    } as never) as Promise<void>;
    await sleep(5);
    expect(finished).toHaveLength(0);

    await sleep(40);
    api.seed("p2", { joinedAt: 200 });
    await done;
    expect(Object.keys(finished[0].role_map).sort()).toEqual(["p1", "p2"]);
    expect(finished[0].role).toBe("a");
  });

  it("neither counts nor assigns participants who have left", async () => {
    const { hub, api, jsPsych, finished } = await setup("p1", { dropoutTimeout: 0 });
    const gone = await hub.join("p0");
    await gone.jsPsych.multiplayer.update({ joinedAt: 1 });
    await gone.jsPsych.multiplayer.disconnect();
    await sleep(5);
    api.seed("p2", { joinedAt: 200 });

    await new MultiplayerRolePlugin(jsPsych as never).trial(display(), { ...trialBase } as never);

    expect(Object.keys(finished[0].role_map).sort()).toEqual(["p1", "p2"]);
  });

  it("ends unassigned with connection_lost when this participant's connection closes", async () => {
    const { me, jsPsych, finished } = await setup("p1");
    const done = new MultiplayerRolePlugin(jsPsych as never).trial(display(), {
      ...trialBase,
    } as never) as Promise<void>;
    await sleep(0);
    me.connection.options.onStatus("closed");
    await done;
    expect(finished[0]).toMatchObject({ connection_lost: true, role: null });
  });

  it("gives a custom ready (snapshot, presence) and logs its last error if the group never gets ready", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { list: [1] });
    const seen: PresenceData[] = [];

    await new MultiplayerRolePlugin(jsPsych as never).trial(display(), {
      ...trialBase,
      timeout: 40,
      ready: (s: GroupSessionData, presence: PresenceData) => {
        seen.push(presence);
        (s.p2.list as number[]).push(2); // frozen: throws, so the group never counts as ready
        return true;
      },
    } as never);

    expect(seen[0]).toMatchObject({ p1: "connected" });
    expect(finished[0].timed_out).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][1]).toBeInstanceOf(TypeError);
    errSpy.mockRestore();
  });

  it("does not log accessor errors when the group becomes ready", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1");
    const done = new MultiplayerRolePlugin(jsPsych as never).trial(display(), {
      ...trialBase,
      push_data: { score: 5 },
      strategy: undefined,
      rank_by: (entry: any) => entry.rounds[0].score, // throws until p2's round data arrives
    } as never) as Promise<void>;
    await sleep(0);
    api.seed("p2", { joinedAt: 2, rounds: { 0: { score: 9 } } });
    await done;

    expect(finished[0].role).toBe("b");
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-role — random draws from the session's shared randomness", () => {
  const ids = ["p1", "p2", "p3", "p4"];

  /** Every participant in one hub runs a `random` trial; returns each one's role_map. */
  async function runRandom(sessionId: string, round: number, connect?: ConnectOptions) {
    const hub = new MemoryHub();
    hub.sessionId = sessionId;
    const members = [];
    for (const id of ids) members.push(await hub.join(id, { connect }));
    const finished: Array<Record<string, any>> = [];
    for (const { jsPsych } of members) {
      const standIn = {
        multiplayer: jsPsych.multiplayer,
        finishTrial: (data: Record<string, any>) => finished.push(data),
      };
      new MultiplayerRolePlugin(standIn as never).trial(display(), {
        roles: ["a", "b", "c", "d"],
        strategy: "random",
        group_size: ids.length,
        round,
        push_data: {},
        timeout: 30000,
      } as never);
    }
    await flush();
    await flush();
    expect(finished).toHaveLength(ids.length);
    return finished.map((d) => d.role_map);
  }

  it("gives every participant in the session the same role map", async () => {
    const maps = await runRandom("session-a", 0);
    for (const map of maps) expect(map).toEqual(maps[0]);
    expect(Object.keys(maps[0]).sort()).toEqual(ids);
  });

  it("gives different sessions different assignments", async () => {
    let differs = false;
    for (let round = 0; round < 10 && !differs; round++) {
      const [a] = await runRandom("session-a", round);
      const [b] = await runRandom("session-b", round);
      differs = JSON.stringify(a) !== JSON.stringify(b);
    }
    expect(differs).toBe(true);
  });

  it("with the same randomSeed, different sessions agree", async () => {
    for (const round of [0, 1, 2]) {
      const [a] = await runRandom("session-a", round, { randomSeed: "x" });
      const [b] = await runRandom("session-b", round, { randomSeed: "x" });
      expect(a).toEqual(b);
    }
  });

  it("uses multiplayer.shuffle with a key built from the seed and round", async () => {
    const { api, jsPsych, multiplayer, finished } = await setup("p1");
    api.seed("p2", {});
    const shuffle = jest.spyOn(multiplayer, "shuffle");
    new MultiplayerRolePlugin(jsPsych as never).trial(display(), {
      roles: ["a", "b"],
      strategy: "random",
      group_size: 2,
      round: 3,
      seed: "s",
      push_data: {},
      timeout: 30000,
    } as never);
    await flush();
    expect(shuffle).toHaveBeenCalledWith('["plugin-multiplayer-role","s",3]', ["p1", "p2"]);
    const expected = multiplayer.shuffle('["plugin-multiplayer-role","s",3]', ["p1", "p2"]);
    expect(finished[0].role_map).toEqual({
      [expected[0]]: { role: "a" },
      [expected[1]]: { role: "b" },
    });
  });
});
