import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions, GroupSessionData, PresenceData } from "jspsych";

import { MemoryHub } from "../../../test-utils/memory-backend";
import MultiplayerSyncPlugin from ".";

/**
 * A jsPsych stand-in whose `multiplayer` is a real session on an in-memory hub, so the plugin runs
 * against the actual core (frozen snapshots, presence, errors) while `finishTrial` is captured.
 */
async function setup(connect?: ConnectOptions, existing: GroupSessionData = {}) {
  const hub = new MemoryHub();
  hub.data = existing;
  const me = await hub.join("p1", { connect });
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    multiplayer: me.jsPsych.multiplayer,
    finishTrial: (data: Record<string, any>) => finished.push(data),
    pluginAPI: {
      setTimeout: (cb: () => void, delay: number) => setTimeout(cb, delay),
    },
  };
  const plugin = new MultiplayerSyncPlugin(jsPsych as never);
  return { hub, me, multiplayer: me.jsPsych.multiplayer, finished, plugin };
}

const display = () => document.createElement("div");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const defaults = {
  push_data: null,
  message: "<p>Waiting…</p>",
  timeout: null,
  on_timeout: null,
  participants: null,
  minimum_wait: 0,
};

describe("multiplayer-sync plugin", () => {
  it("pushes data and ends once the condition is met by its own push", async () => {
    const { plugin, finished } = await setup();

    await plugin.trial(display(), {
      ...defaults,
      push_data: { ready: true },
      wait_for: (group: GroupSessionData) => Object.keys(group).length >= 1,
    } as never);

    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      group: { p1: { ready: true } },
      timed_out: false,
      partner_left: false,
      left_participant: null,
      connection_lost: false,
      wait_error: null,
    });
    expect(typeof finished[0].wait_time).toBe("number");
  });

  it("fires the on_load callback once the waiting screen is rendered", async () => {
    const { plugin } = await setup();
    const on_load = jest.fn();
    await plugin.trial(display(), { ...defaults, wait_for: () => true } as never, on_load);
    expect(on_load).toHaveBeenCalledTimes(1);
  });

  it("propagates a push failure instead of masking it as a timeout", async () => {
    const { plugin, finished, me } = await setup();
    me.connection.pushImpl = async () => {
      throw new Error("write rejected");
    };
    const on_timeout = jest.fn();

    await expect(
      plugin.trial(display(), {
        ...defaults,
        push_data: { ready: true },
        wait_for: () => true,
        on_timeout,
      } as never),
    ).rejects.toThrow(/write rejected/);
    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
  });

  it("holds until a second participant satisfies the condition", async () => {
    const { plugin, finished, hub } = await setup();
    const el = display();

    const done = plugin.trial(el, {
      ...defaults,
      push_data: { role: "a" },
      wait_for: (group: GroupSessionData) => Object.keys(group).length >= 2,
      message: "<p>Waiting for another player…</p>",
    } as never);
    await sleep(0);
    expect(finished).toHaveLength(0);
    expect(el.innerHTML).toContain("Waiting for another player");

    const peer = await hub.join("p2");
    await peer.jsPsych.multiplayer.push({ role: "b" });
    await done;

    expect(finished[0].group).toEqual({ p1: { role: "a" }, p2: { role: "b" } });
    expect(finished[0].timed_out).toBe(false);
  });

  it("passes presence to wait_for", async () => {
    const { plugin, finished, hub } = await setup();
    const done = plugin.trial(display(), {
      ...defaults,
      wait_for: (_group: GroupSessionData, presence: PresenceData) => presence.p2 === "connected",
    } as never);
    await hub.join("p2");
    await done;
    expect(finished).toHaveLength(1);
  });

  it("waits without pushing when push_data is null", async () => {
    const { plugin, finished, hub, multiplayer } = await setup();
    hub.seed("p2", { ready: true });

    await plugin.trial(display(), {
      ...defaults,
      wait_for: (group: GroupSessionData) => "p2" in group,
    } as never);

    expect(multiplayer.getAll()).toEqual({ p2: { ready: true } });
    expect(finished[0].group).toEqual({ p2: { ready: true } });
  });

  it("ends with timed_out and calls on_timeout when the timeout elapses", async () => {
    const { plugin, finished, multiplayer } = await setup();
    const on_timeout = jest.fn();

    await plugin.trial(display(), {
      ...defaults,
      push_data: { ready: true },
      wait_for: () => false,
      timeout: 40,
      on_timeout,
    } as never);

    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].wait_error).toMatch(/timed out/);
    expect(finished[0].group).toEqual(multiplayer.getAll());
  });

  it("ends with partner_left when a participant the barrier depends on leaves", async () => {
    const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
    const peer = await hub.join("p2");

    const done = plugin.trial(display(), { ...defaults, wait_for: () => false } as never);
    await sleep(0);
    await peer.jsPsych.multiplayer.disconnect();
    await done;

    expect(finished[0]).toMatchObject({
      partner_left: true,
      left_participant: "p2",
      timed_out: false,
      connection_lost: false,
    });
    expect(finished[0].wait_error).toMatch(/left/);
  });

  it("doesn't depend on leftover slots from members who left before this one joined", async () => {
    // Leftover slots start out `away` and become `left` after the dropout timeout
    const { plugin, finished, multiplayer } = await setup(
      { dropoutTimeout: 10 },
      { ghost: { ready: true } },
    );
    expect(multiplayer.presence().ghost).toBe("away");

    await plugin.trial(display(), { ...defaults, wait_for: () => false, timeout: 60 } as never);

    expect(multiplayer.presence().ghost).toBe("left");
    expect(finished[0]).toMatchObject({ partner_left: false, timed_out: true });
  });

  it("in a sealed group, participants: null depends on the roster, including members who are away", async () => {
    const { plugin, finished, hub, multiplayer } = await setup({ dropoutTimeout: 20 });
    hub.seal(["p1", "p2"]);
    // p2 has a place but isn't connected: they start out away and are still waited on
    expect(multiplayer.presence().p2).toBe("away");

    await plugin.trial(display(), { ...defaults, wait_for: () => false } as never);

    expect(finished[0]).toMatchObject({ partner_left: true, left_participant: "p2" });
  });

  it("ignores departures when participants is []", async () => {
    const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
    const peer = await hub.join("p2");

    const done = plugin.trial(display(), {
      ...defaults,
      wait_for: () => false,
      participants: [],
      timeout: 60,
    } as never);
    await peer.jsPsych.multiplayer.disconnect();
    await done;

    expect(finished[0].partner_left).toBe(false);
    expect(finished[0].timed_out).toBe(true);
  });

  it("ends with connection_lost when this participant's connection closes", async () => {
    const { plugin, finished, me } = await setup();

    const done = plugin.trial(display(), { ...defaults, wait_for: () => false } as never);
    await sleep(0);
    me.connection.options.onStatus("closed");
    await done;

    expect(finished[0]).toMatchObject({ connection_lost: true, partner_left: false });
  });

  it("propagates a throwing wait_for instead of mislabeling it", async () => {
    const { plugin, finished } = await setup();
    await expect(
      plugin.trial(display(), {
        ...defaults,
        wait_for: () => {
          throw new Error("bad predicate");
        },
      } as never),
    ).rejects.toThrow(/bad predicate/);
    expect(finished).toHaveLength(0);
  });

  it("hands wait_for frozen data", async () => {
    const { plugin } = await setup();
    await expect(
      plugin.trial(display(), {
        ...defaults,
        push_data: { list: [1] },
        wait_for: (group: GroupSessionData) => {
          (group.p1.list as number[]).push(2);
          return true;
        },
      } as never),
    ).rejects.toThrow(TypeError);
  });

  it("holds the message for minimum_wait even when the timeout elapses first", async () => {
    const { plugin, finished } = await setup();
    const t0 = performance.now();
    await plugin.trial(display(), {
      ...defaults,
      wait_for: () => false,
      timeout: 20,
      minimum_wait: 60,
    } as never);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(50);
    expect(finished[0].timed_out).toBe(true);
  });

  it("keeps the message on screen for at least minimum_wait when the condition is already met", async () => {
    const { plugin, finished } = await setup();
    const t0 = performance.now();
    await plugin.trial(display(), {
      ...defaults,
      wait_for: () => true,
      minimum_wait: 60,
    } as never);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(50);
    expect(finished[0].timed_out).toBe(false);
  });

  it("does not extend a wait that is already longer than minimum_wait", async () => {
    const { plugin, finished, hub } = await setup();
    const done = plugin.trial(display(), {
      ...defaults,
      push_data: { role: "a" },
      wait_for: (g: GroupSessionData) => Object.keys(g).length >= 2,
      minimum_wait: 30,
    } as never);
    setTimeout(() => hub.seed("p2", { role: "b" }), 80);
    await done;
    expect(finished[0].wait_time).toBeGreaterThanOrEqual(70);
    expect(finished[0].wait_time).toBeLessThan(80 + 30);
  });

  it("stops quietly when the wait is cancelled (abort / end of run)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { plugin, finished, multiplayer } = await setup();
    const on_timeout = jest.fn();

    const done = plugin.trial(display(), {
      ...defaults,
      push_data: { ready: true },
      wait_for: () => false,
      on_timeout,
    } as never);
    await sleep(0);
    multiplayer.cancelAllSubscriptions();
    await expect(done).resolves.toBeUndefined();

    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("ignores departures by default, so a lobby keeps waiting", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1", { connect: { dropoutTimeout: 10 } });
    const peer = await hub.join("p2");

    const { getData, expectFinished } = await startTimeline(
      [{ type: MultiplayerSyncPlugin, wait_for: () => false, timeout: 60 }],
      jsPsych,
    );
    await peer.jsPsych.multiplayer.disconnect();
    await sleep(100);
    await expectFinished();

    expect(jsPsych.multiplayer.presence().p2).toBe("left");
    expect(getData().values()[0]).toMatchObject({ partner_left: false, timed_out: true });
  });

  it("runs through the real jsPsych pipeline (startTimeline smoke test)", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");

    const { getData, expectFinished } = await startTimeline(
      [
        {
          type: MultiplayerSyncPlugin,
          push_data: { ready: true },
          wait_for: (group: GroupSessionData) => Object.keys(group).length >= 1,
        },
      ],
      jsPsych,
    );
    await expectFinished();

    const data = getData().values()[0];
    expect(data.group).toEqual({ p1: { ready: true } });
    expect(data.timed_out).toBe(false);
    expect(data.partner_left).toBe(false);
    expect(data.wait_error).toBeNull();
  });

  it("throws a clear error on a jsPsych without the multiplayer API", async () => {
    const plugin = new MultiplayerSyncPlugin({} as never);
    await expect(
      plugin.trial(display(), { ...defaults, wait_for: () => true } as never),
    ).rejects.toThrow(/multiplayer API/);
  });
});
