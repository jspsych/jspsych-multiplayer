import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions } from "jspsych";

import { MemoryHub, scopeData } from "../../../test-utils/memory-backend";
import MultiplayerReadyPlugin from ".";

/**
 * A jsPsych stand-in whose `multiplayer` is a real session on an in-memory hub, so the plugin runs
 * against the actual core (frozen snapshots, presence, errors) while `finishTrial` is captured.
 * No trial is running in the core, so the plugin's reads and writes use the session scope here;
 * the startTimeline tests cover the trial scope.
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
  write_data: null,
  timeout: null,
  on_timeout: null,
  participants: null,
  minimum_wait: 0,
  save_group: false,
};

describe("multiplayer-ready plugin", () => {
  it("marks this participant ready and ends once the group is ready (solo)", async () => {
    const { plugin, finished, multiplayer } = await setup();
    const el = display();

    const done = plugin.trial(el, { ...defaults } as never);
    clickReady(el);
    await done;

    expect(finished).toHaveLength(1);
    expect(finished[0]).toEqual({
      rt: expect.any(Number),
      wait_time: expect.any(Number),
      n_ready: 1,
      multiplayer_outcome: "completed",
      left_participant: null,
    });
    expect(multiplayer.get("p1")).toEqual({ ready: true });
  });

  it("saves the group only when save_group is true", async () => {
    const { plugin, finished } = await setup();
    const el = display();

    const done = plugin.trial(el, { ...defaults, save_group: true } as never);
    clickReady(el);
    await done;

    expect(finished[0].group).toEqual({ p1: { ready: true } });
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

  it("merges write_data and the ready flag into this participant's data, keeping what is there", async () => {
    const { plugin, multiplayer } = await setup();
    await multiplayer.update({ score: 3 });
    const el = display();

    const done = plugin.trial(el, { ...defaults, write_data: { name: "Ana" } } as never);
    clickReady(el);
    await done;

    expect(multiplayer.get("p1")).toEqual({ score: 3, name: "Ana", ready: true });
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

    await peer.jsPsych.multiplayer.update({ ready: true });
    await done;
    expect(finished[0].n_ready).toBe(2);
  });

  it("does not count members who are present but not ready", async () => {
    const { plugin, finished, hub } = await setup();
    hub.addPeer("p2", { name: "not ready" });
    const el = display();

    const done = plugin.trial(el, { ...defaults, expected_players: 2, timeout: 40 } as never);
    clickReady(el);
    await done;
    expect(finished[0]).toMatchObject({ multiplayer_outcome: "timeout", n_ready: 1 });
  });

  it("ignores participants who have left when counting", async () => {
    const { plugin, finished, hub } = await setup({ dropoutTimeout: 1 });
    const peer = await hub.join("p2");
    await peer.jsPsych.multiplayer.update({ ready: true });
    await peer.jsPsych.multiplayer.disconnect();
    await sleep(5);

    const el = display();
    const done = plugin.trial(el, { ...defaults, expected_players: 2, timeout: 40 } as never);
    clickReady(el);
    await done;
    expect(finished[0]).toMatchObject({ multiplayer_outcome: "timeout", n_ready: 1 });
  });

  it("ends with participant_left when a participant leaves while waiting", async () => {
    const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
    const peer = await hub.join("p2");
    const el = display();

    const done = plugin.trial(el, { ...defaults, expected_players: 2 } as never);
    clickReady(el);
    await sleep(0);
    await peer.jsPsych.multiplayer.disconnect();
    await done;

    expect(finished[0]).toMatchObject({
      multiplayer_outcome: "participant_left",
      left_participant: "p2",
    });
  });

  it("ignores departures when participants is []", async () => {
    const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
    const peer = await hub.join("p2");
    const el = display();

    const done = plugin.trial(el, {
      ...defaults,
      expected_players: 2,
      participants: [],
      timeout: 60,
    } as never);
    clickReady(el);
    await sleep(0);
    await peer.jsPsych.multiplayer.disconnect();
    await done;

    expect(finished[0]).toMatchObject({ multiplayer_outcome: "timeout", left_participant: null });
  });

  it("ends with connection_lost when this participant's connection closes", async () => {
    const { plugin, finished, me } = await setup();
    const el = display();

    const done = plugin.trial(el, { ...defaults, expected_players: 2, save_group: true } as never);
    clickReady(el);
    await sleep(0);
    me.connection.options.onStatus("closed");
    await done;

    expect(finished[0]).toMatchObject({ multiplayer_outcome: "connection_lost" });
    // Reads keep working after the connection is lost
    expect(finished[0].group).toEqual({ p1: { ready: true } });
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
      await peer.jsPsych.multiplayer.update({ ready: true });
      await done;
      expect(finished[0]).toMatchObject({ multiplayer_outcome: "timeout", n_ready: 2 });
    });

    it("members who already left don't count toward the default", async () => {
      const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
      const peer = await hub.join("p2");
      hub.seal(["p1", "p2", "p3"]);
      await sleep(20);
      const el = display();

      const done = plugin.trial(el, { ...defaults, expected_players: null } as never);
      clickReady(el);
      await peer.jsPsych.multiplayer.update({ ready: true });
      await done;
      expect(finished[0]).toMatchObject({ multiplayer_outcome: "completed", n_ready: 2 });
    });

    it("ends with participant_left when a roster member leaves while waiting", async () => {
      const { plugin, finished, hub } = await setup({ dropoutTimeout: 10 });
      const peer = await hub.join("p2");
      hub.seal(["p1", "p2"]);
      const el = display();

      const done = plugin.trial(el, { ...defaults, expected_players: null } as never);
      clickReady(el);
      await sleep(0);
      await peer.jsPsych.multiplayer.disconnect();
      await done;
      expect(finished[0]).toMatchObject({
        multiplayer_outcome: "participant_left",
        left_participant: "p2",
      });
    });
  });

  it("without a sealed group, a missing expected_players says how to fix it", async () => {
    const { plugin } = await setup();
    await expect(
      plugin.trial(display(), { ...defaults, expected_players: null } as never),
    ).rejects.toThrow(/sealed/);
  });

  it("doesn't hold the wait or its timeout for a write the backend hasn't confirmed", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { plugin, finished, me } = await setup();
    me.connection.pushImpl = async () => {
      throw new Error("write rejected");
    };
    const on_timeout = jest.fn();
    const el = display();

    const done = plugin.trial(el, {
      ...defaults,
      expected_players: 2,
      on_timeout,
      timeout: 40,
    } as never);
    clickReady(el);
    await done;
    // The core keeps retrying the write; the trial still ends when its timeout elapses
    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished[0]).toMatchObject({ multiplayer_outcome: "timeout", n_ready: 1 });
    await me.jsPsych.multiplayer.disconnect();
    warn.mockRestore();
  });

  it("ends with a timeout outcome and calls on_timeout when the group isn't ready in time", async () => {
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
    expect(finished[0]).toMatchObject({ multiplayer_outcome: "timeout", n_ready: 1 });
  });

  it("treats a timeout of 0 as no limit", async () => {
    const { plugin, finished, hub } = await setup();
    const el = display();
    const done = plugin.trial(el, {
      ...defaults,
      expected_players: 2,
      timeout: 0,
      participants: [],
    } as never);
    clickReady(el);
    await sleep(30);
    expect(finished).toHaveLength(0);
    hub.addPeer("p2", { ready: true });
    await done;
    expect(finished[0].multiplayer_outcome).toBe("completed");
  });

  it("returns quietly when the wait is cancelled", async () => {
    const { plugin, finished, multiplayer } = await setup();
    const on_timeout = jest.fn();
    const el = display();

    const done = plugin.trial(el, { ...defaults, expected_players: 2, on_timeout } as never);
    clickReady(el);
    await sleep(0);
    await multiplayer.disconnect();
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
    const done = plugin.trial(el, {
      ...defaults,
      expected_players: 2,
      minimum_wait: 30,
      participants: [],
    } as never);
    clickReady(el);
    setTimeout(() => hub.addPeer("p2", { ready: true }), 80);
    await done;
    expect(finished[0].wait_time).toBeGreaterThanOrEqual(70);
    expect(finished[0].wait_time).toBeLessThan(80 + 30);
  });

  it("measures rt (time to click) and wait_time (time waiting for the group) separately", async () => {
    const { plugin, finished, hub } = await setup();
    const el = display();
    const done = plugin.trial(el, { ...defaults, expected_players: 2, participants: [] } as never);
    await sleep(60);
    clickReady(el);
    setTimeout(() => hub.addPeer("p2", { ready: true }), 40);
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
    expect(data).toMatchObject({ n_ready: 1, multiplayer_outcome: "completed" });
    for (const removed of [
      "data_key",
      "group",
      "timed_out",
      "partner_left",
      "connection_lost",
      "wait_error",
    ]) {
      expect(data).not.toHaveProperty(removed);
    }
    // The flag went to the trial's own shared data, not the session's
    expect(scopeData(hub.data.p1)).toBeUndefined();
  });

  it("a second gate doesn't pass on flags left over from the first", async () => {
    const hub = new MemoryHub();
    const elements = [document.createElement("div"), document.createElement("div")];
    elements.forEach((el) => document.body.appendChild(el));
    const a = await hub.join("p1", { jsPsych: { display_element: elements[0] } });
    const b = await hub.join("p2", { jsPsych: { display_element: elements[1] } });
    const gate = { type: MultiplayerReadyPlugin, expected_players: 2, stimulus: "<p>Ready?</p>" };

    const runA = await startTimeline([gate, gate], a.jsPsych);
    const runB = await startTimeline([gate, gate], b.jsPsych);

    // Gate 1: both ready
    clickReady(elements[0]);
    clickReady(elements[1]);
    await sleep(10);
    expect(runA.getData().values()).toHaveLength(1);

    // Gate 2: p2's gate-1 flag must not count
    clickReady(elements[0]);
    await sleep(20);
    expect(runA.getData().values()).toHaveLength(1);

    clickReady(elements[1]);
    await sleep(10);
    await runA.expectFinished();
    await runB.expectFinished();
    expect(runA.getData().values()[1]).toMatchObject({
      multiplayer_outcome: "completed",
      n_ready: 2,
    });
    elements.forEach((el) => el.remove());
  });

  it("throws a clear error on a jsPsych without the multiplayer API", async () => {
    const plugin = new MultiplayerReadyPlugin({} as never);
    await expect(plugin.trial(display(), { ...defaults } as never)).rejects.toThrow(
      /multiplayer API/,
    );
  });
});
