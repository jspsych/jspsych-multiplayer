import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions, GroupSessionData, PresenceData } from "jspsych";

import { MemoryHub, scopeData } from "../../../test-utils/memory-backend";
import MultiplayerMatchPlugin from ".";

/**
 * A jsPsych stand-in whose `multiplayer` is a real session on an in-memory hub, so the plugin runs
 * against the actual core (frozen snapshots, presence, errors) while `finishTrial` is captured.
 * `api.seed(id, data)` writes another participant's slot, as if they had written it.
 */
async function setup(participantId = "a", connect?: ConnectOptions, sessionId?: string) {
  const hub = new MemoryHub();
  if (sessionId) hub.sessionId = sessionId;
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
  write_data: {},
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
    const jsPsych = { multiplayer: { participantId: null } };
    const plugin = new MultiplayerMatchPlugin(jsPsych as never);
    expect(() => plugin.trial(display(), { ...base, expected_players: 2 } as never)).toThrow(
      /participantId/i,
    );
  });

  it("partitions the group into pairs and records the partners", async () => {
    const { api, jsPsych, finished } = await setup("a");
    api.seed("b", {});
    api.seed("c", {});
    api.seed("d", {});

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 4,
    } as never);

    expect(finished).toHaveLength(1);
    const data = finished[0];
    expect(data.multiplayer_outcome).toBe("completed");
    expect(data.left_participant).toBeNull();
    expect(data.matched_self).toBe(true);
    expect(data.match_group).toBe(0); // a,b -> group 0
    expect(data.partners).toEqual(["b"]);
    expect(data.members).toEqual(["a", "b"]);
    expect(data.position).toBe(0);
    // The full agreed map covers everyone.
    expect(Object.keys(data.match_map).sort()).toEqual(["a", "b", "c", "d"]);
    expect(data.match_map.c.partners).toEqual(["d"]);
  });

  it("holds at the barrier until expected_players are present", async () => {
    const { api, jsPsych, finished } = await setup("a");
    api.seed("b", {});

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

  it("in a sealed group, expected_players defaults to the roster, without a warning", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { hub, jsPsych, finished } = await setup("a");
    hub.seal(["a", "b"]);

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: null,
    } as never);
    await flush();
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/expected_players/));
    expect(finished).toHaveLength(0); // b is on the roster but hasn't arrived

    const b = await hub.join("b");
    await b.jsPsych.multiplayer.update({ joinedAt: 2 });
    await done;
    expect(finished[0].partners).toEqual(["b"]);
    warn.mockRestore();
  });

  it("warns when neither expected_players nor a ready predicate is set", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { api, jsPsych } = await setup("a");

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      leftover: "spectator", // a alone -> spectator, so the trial still ends cleanly
    } as never);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/expected_players/));
    warn.mockRestore();
  });

  it("random strategy pairs deterministically and is stable across key order", async () => {
    const run = async (ids: string[]) => {
      const { api, jsPsych, finished } = await setup(ids[0]);
      ids.slice(1).forEach((id) => api.seed(id, {}));
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

  it("random strategy gives every participant in the session the same grouping", async () => {
    const hub = new MemoryHub();
    const ids = ["a", "b", "c", "d", "e", "f"];
    const players = await Promise.all(ids.map((id) => hub.join(id)));
    const maps = await Promise.all(
      players.map(async ({ jsPsych }) => {
        const finished: Array<Record<string, any>> = [];
        const stub = {
          multiplayer: jsPsych.multiplayer,
          finishTrial: (data: Record<string, any>) => finished.push(data),
        };
        await new MultiplayerMatchPlugin(stub as never).trial(display(), {
          ...base,
          expected_players: 6,
          strategy: "random",
          round: 3,
        } as never);
        return finished[0].match_map;
      }),
    );
    maps.forEach((map) => expect(map).toEqual(maps[0]));
  });

  describe("random strategy is seeded by the session", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const run = async (round: number, sessionId: string, connect?: ConnectOptions) => {
      const { api, jsPsych, finished } = await setup(ids[0], connect, sessionId);
      ids.slice(1).forEach((id) => api.seed(id, {}));
      await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
        ...base,
        expected_players: ids.length,
        strategy: "random",
        round,
      } as never);
      return finished[0].match_map;
    };
    const rounds = [0, 1, 2, 3, 4, 5, 6, 7];

    it("gives groups in different sessions different groupings", async () => {
      const differs = await Promise.all(
        rounds.map(
          async (round) =>
            JSON.stringify(await run(round, "session-1")) !==
            JSON.stringify(await run(round, "session-2")),
        ),
      );
      expect(differs).toContain(true);
    });

    it("gives the same grouping in every session with the randomSeed connect option", async () => {
      for (const round of rounds) {
        expect(await run(round, "session-1", { randomSeed: "x" })).toEqual(
          await run(round, "session-2", { randomSeed: "x" }),
        );
      }
    });
  });

  it("leftover 'spectator' leaves the odd participant unmatched (matched_self false, not a timeout)", async () => {
    const { api, jsPsych, finished } = await setup("c"); // c is the odd one out in a,b,c
    api.seed("a", {});
    api.seed("b", {});

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 3,
      leftover: "spectator",
    } as never);

    const data = finished[0];
    expect(data.matched_self).toBe(false); // c is a spectator
    expect(data.multiplayer_outcome).toBe("completed"); // ...distinct from a timeout
    expect(data.match_group).toBeNull();
    expect(data.partners).toEqual([]); // a spectator has zero partners, not null (null = timeout)
    expect(data.members).toBeNull();
    expect(data.match_map.c).toBeUndefined(); // absent from the map
    expect(data.match_map.a.partners).toEqual(["b"]); // a,b still matched
  });

  it("a non-divisible group with leftover 'error' rejects (config error, NOT relabeled a timeout)", async () => {
    const on_timeout = jest.fn();
    const { api, jsPsych, finished } = await setup("a");
    api.seed("b", {});
    api.seed("c", {}); // 3 players, group_size 2 -> not divisible

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
    const { jsPsych, finished } = await setup("a"); // alone; expected_players 4 never reached
    const on_timeout = jest.fn();

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 4,
      timeout: 40,
      on_timeout,
    } as never);

    expect(on_timeout).toHaveBeenCalledTimes(1);
    const data = finished[0];
    expect(data.multiplayer_outcome).toBe("timeout");
    expect(data.left_participant).toBeNull();
    expect(data.matched_self).toBe(false);
    expect(data.match_map).toBeNull();
  });

  it("propagates an unexpected wait() rejection instead of masking it as a timeout", async () => {
    const { jsPsych, finished, multiplayer } = await setup("a");
    jest.spyOn(multiplayer, "wait").mockRejectedValue(new Error("backend unavailable"));
    const on_timeout = jest.fn();

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
      timeout: 1000,
      on_timeout,
    } as never);

    await expect(done).rejects.toThrow(/backend unavailable/);
    expect(on_timeout).not.toHaveBeenCalled(); // NOT routed to the graceful timeout path
    expect(finished).toHaveLength(0); // trial halts loudly rather than finishing as a timeout
  });

  it("times out even while the backend keeps refusing this participant's write", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { jsPsych, finished, me } = await setup("a");
    me.connection.pushImpl = () => Promise.reject(new Error("backend unavailable"));

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
      timeout: 40,
    } as never);

    expect(finished[0].multiplayer_outcome).toBe("timeout");
    warn.mockRestore();
  });

  it("stops quietly when the wait is cancelled (experiment ending), without timing out", async () => {
    // jsPsych cancels pending waits when the trial or experiment ends, and so does disconnect(). That
    // is a teardown, not a readiness expiry: the trial must not run on_timeout, finish, or log.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { jsPsych, finished, multiplayer } = await setup("a"); // alone; 4 never reached
    const on_timeout = jest.fn();

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 4,
      timeout: 10000,
      on_timeout,
    } as never);
    await flush(); // the write has landed and the wait is pending

    await multiplayer.disconnect();
    await expect(done).resolves.toBeUndefined(); // returns, rather than rejecting

    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("join_order readiness waits until every present participant has pushed joinedAt", async () => {
    const { api, jsPsych, finished } = await setup("a");
    api.seed("b", {}); // present but no joinedAt yet

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
    const { api, jsPsych } = await setup("a");
    api.seed("a", { condition: "treatment" }); // an earlier trial wrote data
    api.seed("b", {});

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
    } as never);

    expect((api.get("a") as any).condition).toBe("treatment"); // survived the match push
    expect(typeof (api.get("a") as any).joinedAt).toBe("number"); // and joinedAt was stamped
  });

  it("includes the snapshot only when save_group is true", async () => {
    const withGroup = await setup("a");
    withGroup.api.seed("b", {});
    await new MultiplayerMatchPlugin(withGroup.jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
      save_group: true,
    } as never);
    expect(withGroup.finished[0].group).toBeDefined();

    const without = await setup("a");
    without.api.seed("b", {});
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
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    hub.addPeer("p2", {});
    hub.seed("p2", {}, { scope: "#0" }); // p2 has reached the trial

    const { getData, expectFinished } = await startTimeline(
      [{ type: MultiplayerMatchPlugin, expected_players: 2, group_size: 2 }],
      jsPsych,
    );
    await expectFinished();

    const data = getData().values()[0];
    expect(data.trial_type).toBe("multiplayer-match");
    expect(data.match_group).toBe(0);
    expect(data.partners).toEqual(["p2"]);
    expect(data.multiplayer_outcome).toBe("completed");
    for (const removed of ["timed_out", "partner_left", "connection_lost"]) {
      expect(data).not.toHaveProperty(removed);
    }
    expect(MultiplayerMatchPlugin.getMyPartners(jsPsych)).toEqual(["p2"]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-match — trial scope (real jsPsych timeline)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("writes joinedAt to the session scope and write_data to the trial's own scope", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    hub.addPeer("p2", { joinedAt: 1 });
    hub.seed("p2", {}, { scope: "#0" });

    const { expectFinished } = await startTimeline(
      [{ type: MultiplayerMatchPlugin, expected_players: 2, write_data: { team: "red" } }],
      jsPsych,
    );
    await expectFinished();

    expect(scopeData(hub.data.p1)).toEqual({ joinedAt: expect.any(Number) });
    expect(scopeData(hub.data.p1, "#0")).toEqual({ team: "red" });
  });

  it("orders join_order by a joinedAt written before the trial, and waits for arrivals", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    await jsPsych.multiplayer.update({ joinedAt: 300 }); // written at connect time, by the page
    hub.addPeer("p2", { joinedAt: 200 });
    hub.addPeer("p3", { joinedAt: 100 });
    hub.seed("p2", {}, { scope: "#0" });

    const { getData, expectFinished } = await startTimeline(
      [
        {
          type: MultiplayerMatchPlugin,
          strategy: "join_order",
          expected_players: 3,
          leftover: "spectator",
        },
      ],
      jsPsych,
    );
    await sleep(10);
    expect(getData().values()).toHaveLength(0); // p3 is in the session, but not at this trial yet

    hub.seed("p3", {}, { scope: "#0" });
    await expectFinished();

    const data = getData().values()[0];
    expect(data.match_map.p3.members).toEqual(["p3", "p2"]); // earliest joiners pair up
    expect(data.matched_self).toBe(false); // p1 joined last: the spectator
  });

  it("keeps each trial's write_data apart", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    hub.addPeer("p2", {});
    hub.seed("p2", { ok: true }, { scope: "#0" });
    const gate = {
      type: MultiplayerMatchPlugin,
      expected_players: 2,
      ready: (s: GroupSessionData) => Object.values(s).every((e) => e.ok === true),
    };

    const { getData, finished } = await startTimeline(
      [
        { ...gate, write_data: { ok: true } },
        // p1 writes no `ok` here, so its value from the first trial must not count
        { ...gate, timeout: 40 },
      ],
      jsPsych,
    );
    await finished;

    const [first, second] = getData().values();
    expect(first.multiplayer_outcome).toBe("completed");
    expect(second.multiplayer_outcome).toBe("timeout");
  });

  it("stops quietly when the experiment is aborted while it waits", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    const on_timeout = jest.fn();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { getData, expectFinished } = await startTimeline(
      [{ type: MultiplayerMatchPlugin, expected_players: 2, on_timeout }],
      jsPsych,
    );
    jsPsych.abortExperiment();
    await expectFinished();
    await sleep(0);

    expect(on_timeout).not.toHaveBeenCalled();
    expect(getData().filter({ multiplayer_outcome: "timeout" }).count()).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-match — accessors", () => {
  /** Run a two-player match trial as `me`, with `other` as a peer who has reached the trial. */
  async function runMatchTrial(me: string, other: string) {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join(me);
    hub.addPeer(other, {});
    hub.seed(other, {}, { scope: "#0" });
    const { expectFinished } = await startTimeline(
      [{ type: MultiplayerMatchPlugin, expected_players: 2 }],
      jsPsych,
    );
    await expectFinished();
    return jsPsych;
  }

  it("read the last match trial's data, per jsPsych instance", async () => {
    const first = await runMatchTrial("a", "b");
    const second = await runMatchTrial("d", "c");

    expect(MultiplayerMatchPlugin.getMyPartners(first)).toEqual(["b"]);
    expect(MultiplayerMatchPlugin.getMyPosition(first)).toBe(0);
    expect(MultiplayerMatchPlugin.getMyPosition(second)).toBe(1);
    expect(MultiplayerMatchPlugin.getMyGroup(second)).toBe(0);
    expect(MultiplayerMatchPlugin.getMyMatch(second)).toEqual({
      group: 0,
      members: ["c", "d"],
      partners: ["c"],
      position: 1,
    });
    expect(Object.keys(MultiplayerMatchPlugin.getMatchMap(first)!).sort()).toEqual(["a", "b"]);
    // Without an instance, they read the one that ran a match trial most recently
    expect(MultiplayerMatchPlugin.getMyPartners()).toEqual(["c"]);
  });

  it("read as unmatched after a match trial that ended without a match", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("a");
    const { finished } = await startTimeline(
      [{ type: MultiplayerMatchPlugin, expected_players: 2, timeout: 20 }],
      jsPsych,
    );
    await finished;

    expect(MultiplayerMatchPlugin.getMyMatch(jsPsych)).toBeUndefined();
    expect(MultiplayerMatchPlugin.getMyPartners(jsPsych)).toEqual([]);
    expect(MultiplayerMatchPlugin.getMatchMap(jsPsych)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-match — departures", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("ends unmatched with participant_left when a participant leaves before the group is ready", async () => {
    const { hub, jsPsych, finished } = await setup("a", { dropoutTimeout: 10 });
    const peer = await hub.join("b");
    const on_timeout = jest.fn();

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 4,
      on_timeout,
    } as never);
    await sleep(0);
    await peer.jsPsych.multiplayer.disconnect();
    await done;

    expect(finished[0]).toMatchObject({
      multiplayer_outcome: "participant_left",
      left_participant: "b",
      matched_self: false,
      match_map: null,
    });
    expect(on_timeout).not.toHaveBeenCalled();
  });

  it("waits out a leftover slot that is only away instead of matching it", async () => {
    const { hub, api, jsPsych, finished } = await setup("a", { dropoutTimeout: 20 });
    hub.seed("ghost", {}); // not connected, so `away` until it turns `left`

    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      ready: (s: GroupSessionData) => Object.keys(s).length >= 2,
    } as never) as Promise<void>;
    await sleep(5);
    expect(finished).toHaveLength(0);

    await sleep(40);
    api.seed("b", {});
    await done;
    expect(Object.keys(finished[0].match_map).sort()).toEqual(["a", "b"]);
  });

  it("neither counts nor partitions participants who have left", async () => {
    const { hub, api, jsPsych, finished } = await setup("a", { dropoutTimeout: 1 });
    const gone = await hub.join("z");
    await gone.jsPsych.multiplayer.update({ joinedAt: 1 });
    await gone.jsPsych.multiplayer.disconnect();
    await sleep(5);
    api.seed("b", {});

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
    } as never);

    expect(Object.keys(finished[0].match_map).sort()).toEqual(["a", "b"]);
    expect(finished[0].partners).toEqual(["b"]);
  });

  it("ends unmatched with connection_lost when this participant's connection closes", async () => {
    const { me, jsPsych, finished } = await setup("a");
    const done = new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 4,
    } as never);
    await sleep(0);
    me.connection.options.onStatus("closed");
    await done;
    expect(finished[0]).toMatchObject({
      multiplayer_outcome: "connection_lost",
      left_participant: null,
      matched_self: false,
    });
  });

  it("gives a custom ready predicate (snapshot, presence) and logs its error if never ready", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("a");
    api.seed("b", { list: [1] });
    const seen: PresenceData[] = [];

    await new MultiplayerMatchPlugin(jsPsych as never).trial(display(), {
      ...base,
      expected_players: 2,
      timeout: 40,
      ready: (s: GroupSessionData, presence: PresenceData) => {
        seen.push(presence);
        (s.b.list as number[]).push(2); // frozen: throws, so the group never counts as ready
        return true;
      },
    } as never);

    expect(seen[0]).toMatchObject({ a: "connected" });
    expect(finished[0].multiplayer_outcome).toBe("timeout");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][1]).toBeInstanceOf(TypeError);
    errSpy.mockRestore();
  });
});
