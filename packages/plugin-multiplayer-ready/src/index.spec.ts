import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions } from "jspsych";

import { MemoryHub } from "../../../test-utils/memory-backend";
import MultiplayerReadyPlugin from ".";

/**
 * A jsPsych stand-in whose `multiplayer` is a real session on an in-memory hub, so the plugin runs
 * against the actual core (frozen snapshots, presence, errors) while `finishTrial` is captured.
 */
async function setup(connect?: ConnectOptions) {
  const hub = new MemoryHub();
  const me = await hub.join("p1", { connect });
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    multiplayer: me.jsPsych.multiplayer,
    finishTrial: (data: Record<string, any>) => finished.push(data),
    pluginAPI: {
      setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    },
  };
  const plugin = new MultiplayerReadyPlugin(jsPsych as never);
  return { hub, me, multiplayer: me.jsPsych.multiplayer, finished, plugin };
}

const display = () => document.createElement("div");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clickReady = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>("#jspsych-multiplayer-ready-btn")!.click();

const defaults = {
  expected_players: 1,
  stimulus: "<p>Ready?</p>",
  prompt: null,
  button_label: "I'm ready",
  waiting_message: "<p>Waiting…</p>",
  push_data: null,
  data_key: null,
  timeout: null,
  on_timeout: null,
  participants: null,
  minimum_wait: 0,
};

describe("multiplayer-ready plugin", () => {
  it("marks this participant ready at the gate and ends once the group is ready (solo)", async () => {
    const { plugin, finished } = await setup();
    const el = display();

    const done = plugin.trial(el, { ...defaults } as never);
    clickReady(el);
    await done;

    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      group: { p1: { ready: true, "ready-1": true } },
      n_ready: 1,
      data_key: "ready-1",
      timed_out: false,
      partner_left: false,
      left_participant: null,
      connection_lost: false,
      wait_error: null,
    });
    expect(typeof finished[0].rt).toBe("number");
    expect(typeof finished[0].wait_time).toBe("number");
  });

  it("renders the stimulus and button, and fires on_load once the screen is rendered", async () => {
    const { plugin } = await setup();
    const on_load = jest.fn();
    const el = display();

    const done = plugin.trial(
      el,
      {
        ...defaults,
        stimulus: "<p>Are you ready to start?</p>",
        button_label: "Let's go",
      } as never,
      on_load,
    );
    expect(on_load).toHaveBeenCalledTimes(1);
    expect(el.innerHTML).toContain("Are you ready to start?");
    expect(el.querySelector("#jspsych-multiplayer-ready-btn")!.textContent).toBe("Let's go");
    clickReady(el);
    await done;
  });

  it("renders the optional secondary prompt below the button only when provided", async () => {
    const { plugin } = await setup();
    const el = display();
    const done = plugin.trial(el, {
      ...defaults,
      prompt: "<p>You'll be matched with one other player.</p>",
    } as never);
    expect(el.querySelector(".jspsych-multiplayer-ready-prompt")!.innerHTML).toContain(
      "matched with one other player",
    );
    clickReady(el);
    await done;

    const plain = display();
    const again = plugin.trial(plain, { ...defaults } as never);
    expect(plain.querySelector(".jspsych-multiplayer-ready-prompt")).toBeNull();
    clickReady(plain);
    await again;
  });

  it("merges push_data and the ready flags into the slot, keeping earlier data", async () => {
    const { plugin, finished, multiplayer } = await setup();
    await multiplayer.update({ score: 3 });
    const el = display();

    const done = plugin.trial(el, { ...defaults, push_data: { name: "Ana" } } as never);
    clickReady(el);
    await done;

    expect(finished[0].group.p1).toEqual({ score: 3, name: "Ana", ready: true, "ready-1": true });
  });

  it("shows the waiting message after the click and holds until the whole group is ready", async () => {
    const { plugin, finished, hub } = await setup();
    const peer = await hub.join("p2");
    const el = display();

    const done = plugin.trial(el, {
      ...defaults,
      expected_players: 2,
      waiting_message: "<p>Waiting for others…</p>",
    } as never);
    clickReady(el);
    await sleep(0);
    expect(el.innerHTML).toContain("Waiting for others");
    expect(finished).toHaveLength(0);

    await peer.jsPsych.multiplayer.update({ "ready-1": true });
    await done;
    expect(finished[0].n_ready).toBe(2);
  });

  it("does not count members who are present but not ready at this gate", async () => {
    const { plugin, finished, hub } = await setup();
    hub.seed("p2", { ready: true, name: "not at this gate" });
    const el = display();

    const done = plugin.trial(el, { ...defaults, expected_players: 2, timeout: 40 } as never);
    clickReady(el);
    await done;
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].n_ready).toBe(1);
  });

  it("a second gate doesn't pass on flags left over from the first", async () => {
    const { plugin, finished, hub } = await setup();
    const peer = await hub.join("p2");

    // Gate 1: both ready
    const el1 = display();
    const gate1 = plugin.trial(el1, { ...defaults, expected_players: 2 } as never);
    await peer.jsPsych.multiplayer.update({ "ready-1": true, ready: true });
    clickReady(el1);
    await gate1;
    expect(finished[0].data_key).toBe("ready-1");

    // Gate 2: p2's gate-1 flags must not count
    const el2 = display();
    const gate2 = plugin.trial(el2, { ...defaults, expected_players: 2 } as never);
    clickReady(el2);
    await sleep(20);
    expect(finished).toHaveLength(1);

    await peer.jsPsych.multiplayer.update({ "ready-2": true });
    await gate2;
    expect(finished[1]).toMatchObject({ data_key: "ready-2", n_ready: 2 });
  });

  it("uses an explicit data_key as-is without advancing the default count", async () => {
    const { plugin, finished } = await setup();

    const el1 = display();
    const lobby = plugin.trial(el1, { ...defaults, data_key: "lobby" } as never);
    clickReady(el1);
    await lobby;

    const el2 = display();
    const next = plugin.trial(el2, { ...defaults } as never);
    clickReady(el2);
    await next;

    expect(finished.map((d) => d.data_key)).toEqual(["lobby", "ready-1"]);
    expect(finished[1].group.p1).toMatchObject({ lobby: true, "ready-1": true });
  });

  it("ignores participants who have left when counting", async () => {
    const { plugin, finished, hub } = await setup({ dropoutTimeout: 0 });
    const peer = await hub.join("p2");
    await peer.jsPsych.multiplayer.update({ "ready-1": true });
    await peer.jsPsych.multiplayer.disconnect();
    await sleep(5);

    const el = display();
    const done = plugin.trial(el, { ...defaults, expected_players: 2, timeout: 40 } as never);
    clickReady(el);
    await done;
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].n_ready).toBe(1);
  });

  it("ends with partner_left when a participant leaves while waiting", async () => {
    const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
    const peer = await hub.join("p2");
    const el = display();

    const done = plugin.trial(el, { ...defaults, expected_players: 2 } as never);
    clickReady(el);
    await sleep(0);
    await peer.jsPsych.multiplayer.disconnect();
    await done;

    expect(finished[0]).toMatchObject({
      partner_left: true,
      left_participant: "p2",
      timed_out: false,
    });
  });

  it("ends with connection_lost when this participant's connection closes", async () => {
    const { plugin, finished, me } = await setup();
    const el = display();

    const done = plugin.trial(el, { ...defaults, expected_players: 2 } as never);
    clickReady(el);
    await sleep(0);
    me.connection.options.onStatus("closed");
    await done;

    expect(finished[0]).toMatchObject({ connection_lost: true, partner_left: false });
  });

  it("throws if expected_players is missing or not a positive integer", async () => {
    const { plugin } = await setup();
    for (const expected_players of [undefined, 0, -1, 1.5, "2"]) {
      await expect(
        plugin.trial(display(), { ...defaults, expected_players } as never),
      ).rejects.toThrow(/expected_players/);
    }
  });

  describe("in a sealed group", () => {
    it("expected_players defaults to the roster, and waits for a member who is only away", async () => {
      const { plugin, finished, hub, multiplayer } = await setup({ dropoutTimeout: null });
      const peer = await hub.join("p2");
      hub.seal(["p1", "p2", "p3"]);
      // p3 has a place but hasn't connected yet
      expect(multiplayer.presence().p3).toBe("away");
      const el = display();

      const done = plugin.trial(el, { ...defaults, expected_players: null, timeout: 40 } as never);
      clickReady(el);
      await peer.jsPsych.multiplayer.update({ "ready-1": true });
      await done;
      expect(finished[0]).toMatchObject({ timed_out: true, n_ready: 2 });
    });

    it("members who already left don't count toward the default", async () => {
      const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
      const peer = await hub.join("p2");
      hub.seal(["p1", "p2", "p3"]);
      await sleep(20);
      const el = display();

      const done = plugin.trial(el, { ...defaults, expected_players: null } as never);
      clickReady(el);
      await peer.jsPsych.multiplayer.update({ "ready-1": true });
      await done;
      expect(finished[0]).toMatchObject({ timed_out: false, partner_left: false, n_ready: 2 });
    });

    it("ends with partner_left when a roster member leaves while waiting", async () => {
      const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
      const peer = await hub.join("p2");
      hub.seal(["p1", "p2"]);
      const el = display();

      const done = plugin.trial(el, { ...defaults, expected_players: null } as never);
      clickReady(el);
      await sleep(0);
      await peer.jsPsych.multiplayer.disconnect();
      await done;
      expect(finished[0]).toMatchObject({ partner_left: true, left_participant: "p2" });
    });
  });

  it("without a sealed group, a missing expected_players says how to fix it", async () => {
    const { plugin } = await setup();
    await expect(
      plugin.trial(display(), { ...defaults, expected_players: null } as never),
    ).rejects.toThrow(/sealed/);
  });

  it("propagates a write failure instead of masking it as a timeout", async () => {
    const { plugin, finished, me } = await setup();
    me.connection.pushImpl = async () => {
      throw new Error("write rejected");
    };
    const on_timeout = jest.fn();
    const el = display();

    const done = plugin.trial(el, { ...defaults, on_timeout, timeout: 40 } as never);
    clickReady(el);
    await expect(done).rejects.toThrow(/write rejected/);
    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
  });

  it("ends with timed_out and calls on_timeout when the group isn't ready in time", async () => {
    const { plugin, finished } = await setup();
    const on_timeout = jest.fn();
    const el = display();

    const done = plugin.trial(el, {
      ...defaults,
      expected_players: 3,
      timeout: 40,
      on_timeout,
    } as never);
    clickReady(el);
    await done;

    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].wait_error).toMatch(/timed out/);
    expect(finished[0].n_ready).toBe(1);
  });

  it("returns quietly when the wait is cancelled (experiment ending or aborting)", async () => {
    const { plugin, finished, multiplayer } = await setup();
    const on_timeout = jest.fn();
    const el = display();

    const done = plugin.trial(el, { ...defaults, expected_players: 2, on_timeout } as never);
    clickReady(el);
    await sleep(0);
    multiplayer.cancelAllSubscriptions();
    await expect(done).resolves.toBeUndefined();
    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
  });

  it("holds the waiting message for at least minimum_wait when the group is already ready", async () => {
    const { plugin, finished } = await setup();
    const el = display();
    const done = plugin.trial(el, { ...defaults, minimum_wait: 60 } as never);
    clickReady(el);
    const t0 = performance.now();
    await done;
    expect(performance.now() - t0).toBeGreaterThanOrEqual(50);
    expect(finished[0].wait_time).toBeGreaterThanOrEqual(50);
  });

  it("does not extend a group wait that is already longer than minimum_wait", async () => {
    const { plugin, finished, hub } = await setup();
    const el = display();
    const done = plugin.trial(el, { ...defaults, expected_players: 2, minimum_wait: 30 } as never);
    clickReady(el);
    setTimeout(() => hub.seed("p2", { "ready-1": true }), 80);
    await done;
    expect(finished[0].wait_time).toBeGreaterThanOrEqual(70);
    expect(finished[0].wait_time).toBeLessThan(80 + 30);
  });

  it("measures rt (time to click) and wait_time (time waiting for the group) separately", async () => {
    const { plugin, finished, hub } = await setup();
    const el = display();
    const done = plugin.trial(el, { ...defaults, expected_players: 2 } as never);
    await sleep(60);
    clickReady(el);
    setTimeout(() => hub.seed("p2", { "ready-1": true }), 40);
    await done;
    expect(finished[0].rt).toBeGreaterThanOrEqual(50);
    expect(finished[0].wait_time).toBeGreaterThanOrEqual(30);
    expect(finished[0].wait_time).toBeLessThan(finished[0].rt + 40);
  });

  it("runs through the real jsPsych pipeline (startTimeline smoke test)", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");

    const { getData, expectFinished, displayElement } = await startTimeline(
      [{ type: MultiplayerReadyPlugin, expected_players: 1, stimulus: "<p>Ready?</p>" }],
      jsPsych,
    );
    clickReady(displayElement);
    await expectFinished();

    const data = getData().values()[0];
    expect(data.data_key).toBe("ready-1");
    expect(data.n_ready).toBe(1);
    expect(data.partner_left).toBe(false);
  });

  it("throws a clear error on a jsPsych without the multiplayer API", async () => {
    const plugin = new MultiplayerReadyPlugin({} as never);
    await expect(plugin.trial(display(), { ...defaults } as never)).rejects.toThrow(
      /multiplayer API/,
    );
  });
});
