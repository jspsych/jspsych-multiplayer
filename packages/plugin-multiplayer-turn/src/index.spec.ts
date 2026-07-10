import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import MultiplayerTurnPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API with the real-time `subscribe` primitive (mirrors the chat/live-scoreboard
// mocks). `push` REPLACES this participant's slot and fires every subscriber; `pushAs` simulates a
// peer's push; `subscribe` replays the current snapshot on registration and returns an unsubscribe.
// ---------------------------------------------------------------------------------------------------
class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  failNextPush = false;
  private subs = new Set<(g: GroupSessionData) => void>();

  constructor(public participantId: string | null) {}

  get(id: string) {
    return this.session[id];
  }

  getAll() {
    return this.session;
  }

  async push(data: Record<string, unknown>) {
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new Error("network down");
    }
    this.session[this.participantId as string] = data; // REPLACE, like the real adapter
    this.fire();
  }

  subscribe(cb: (g: GroupSessionData) => void): Unsubscribe {
    this.subs.add(cb);
    cb(this.getAll()); // replay-on-registration, like core
    return () => this.subs.delete(cb);
  }

  /** Simulate a peer pushing into their own slot. */
  pushAs(id: string, data: Record<string, unknown>) {
    this.session[id] = data;
    this.fire();
  }

  subCount() {
    return this.subs.size;
  }

  private fire() {
    for (const cb of [...this.subs]) cb(this.getAll());
  }
}

function makeJsPsych(api: MockApi) {
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    pluginAPI: api,
    finishTrial: (data: Record<string, any>) => finished.push(data),
    data: { get: () => ({ last: () => ({ values: () => [{}] }) }) },
  };
  return { jsPsych, finished };
}

const display = () => document.createElement("div");
const flush = () => new Promise((r) => setTimeout(r, 0));

const statusText = (el: HTMLElement) =>
  (el.querySelector(".jspsych-multiplayer-turn-status") as HTMLElement).textContent ?? "";
const hasSubmit = (el: HTMLElement) => !!el.querySelector(".jspsych-multiplayer-turn-submit");
const clickSubmit = (el: HTMLElement) =>
  (el.querySelector(".jspsych-multiplayer-turn-submit") as HTMLButtonElement | null)?.click();
const historyItems = (el: HTMLElement) =>
  [...el.querySelectorAll(".jspsych-multiplayer-turn-history-list li")].map((li) => li.textContent);

/** A peer that is present (joined) but has not moved. */
const present = (n = 1) => ({ joinedAt: n });
/** A peer that has moved. */
const moved = (move: unknown, n = 1) => ({ joinedAt: n, turn: { move } });

const base = {
  get_move: null,
  turn_order: null,
  data_key: "turn",
  prompt: null,
  submit_label: "Submit",
  player_label: null,
  format_move: null,
  waiting_message: null,
  show_history: true,
  expected_players: null,
  timeout: null,
  on_timeout: null,
};

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-turn — package surface", () => {
  it("exposes the pure turn helpers as statics", () => {
    expect(typeof MultiplayerTurnPlugin.resolveTurnOrder).toBe("function");
    expect(typeof MultiplayerTurnPlugin.activeIndex).toBe("function");
    expect(typeof MultiplayerTurnPlugin.collectMoves).toBe("function");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-turn — trial wrapper", () => {
  it("guards: throws if the adapter is not connected (no participantId)", () => {
    const api = new MockApi(null);
    const { jsPsych } = makeJsPsych(api);
    expect(() =>
      new MultiplayerTurnPlugin(jsPsych as never).trial(display(), {
        ...base,
        turn_order: ["a", "b"],
      } as never)
    ).toThrow(/participantId/i);
  });

  it("the first player acts, the turn advances, and everyone finishes when the sequence completes", async () => {
    const api = new MockApi("p1");
    api.pushAs("p2", present()); // p2 is here but hasn't moved
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 2,
      get_move: () => "offer:5",
    } as never);
    await flush();

    // p1 is first in id order → it's p1's turn.
    expect(statusText(el)).toBe("It's your turn.");
    expect(hasSubmit(el)).toBe(true);

    clickSubmit(el);
    await flush();

    // p1 has moved; now waiting on p2. Not finished yet.
    expect(finished).toHaveLength(0);
    expect(statusText(el)).toContain("Waiting for");
    expect(statusText(el)).toContain("p2");
    expect(hasSubmit(el)).toBe(false);
    expect(historyItems(el)).toEqual(["p1: offer:5"]);

    // p2 takes its turn → the sequence completes and the trial ends for p1.
    api.pushAs("p2", moved("accept"));

    expect(finished).toHaveLength(1);
    const data = finished[0];
    expect(data.ended_by).toBe("complete");
    expect(data.timed_out).toBe(false);
    expect(data.num_turns).toBe(2);
    expect(data.my_move).toBe("offer:5");
    expect(data.my_position).toBe(0);
    expect(typeof data.rt).toBe("number"); // response time of our own move was recorded
    expect(data.rt).toBeGreaterThanOrEqual(0);
    expect(data.moves).toEqual([
      { participantId: "p1", move: "offer:5", position: 0 },
      { participantId: "p2", move: "accept", position: 1 },
    ]);
  });

  it("a later player waits, then becomes active when the turn reaches them", async () => {
    const api = new MockApi("p2");
    api.pushAs("p1", present());
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 2,
      get_move: () => "reject",
    } as never);
    await flush();

    // p1 goes first → p2 waits and has no button.
    expect(statusText(el)).toContain("p1");
    expect(hasSubmit(el)).toBe(false);

    api.pushAs("p1", moved("offer:3")); // p1 moves → now it's p2's turn
    expect(statusText(el)).toBe("It's your turn.");
    expect(hasSubmit(el)).toBe(true);
    expect(historyItems(el)).toEqual(["p1: offer:3"]);

    clickSubmit(el);
    await flush();

    expect(finished).toHaveLength(1);
    expect(finished[0].my_move).toBe("reject");
    expect(finished[0].my_position).toBe(1);
  });

  it("uses an explicit turn_order array (freezes immediately, no expected_players needed)", async () => {
    const api = new MockApi("p1");
    api.pushAs("p2", present());
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      turn_order: ["p2", "p1"], // p2 goes first
      get_move: () => "x",
    } as never);
    await flush();

    // Order is [p2, p1] → p2 is active, so p1 waits despite being present first.
    expect(statusText(el)).toContain("p2");
    expect(hasSubmit(el)).toBe(false);
  });

  it("auto-commits with no button when submit_label is null", async () => {
    const api = new MockApi("p1");
    api.pushAs("p2", present());
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 2,
      submit_label: null, // auto-advance
      get_move: () => "auto-move",
    } as never);
    await flush();

    // p1's move was pushed automatically the instant it became their turn — no button, now waiting.
    expect(api.getAll().p1.turn).toEqual({ move: "auto-move" });
    expect(hasSubmit(el)).toBe(false);
    expect(statusText(el)).toContain("p2");
  });

  it("a spectator (not in the turn order) watches and finishes with a null move", async () => {
    const api = new MockApi("p3"); // p3 is not in the order
    api.pushAs("p1", present());
    api.pushAs("p2", present());
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      turn_order: ["p1", "p2"],
    } as never);
    await flush();

    expect(hasSubmit(el)).toBe(false); // never our turn
    api.pushAs("p1", moved("a"));
    api.pushAs("p2", moved("b"));

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("complete");
    expect(finished[0].my_move).toBeNull();
    expect(finished[0].my_position).toBeNull();
    expect(finished[0].rt).toBeNull(); // never our turn → no response time
    expect(finished[0].moves).toHaveLength(2);
  });

  it("shows a start-gate wait until expected_players are present", async () => {
    const api = new MockApi("p1"); // p1 alone so far
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 3,
      get_move: () => "m",
    } as never);
    await flush();

    expect(statusText(el)).toMatch(/Waiting for players/);
    expect(hasSubmit(el)).toBe(false);
    expect(finished).toHaveLength(0);

    api.pushAs("p2", present());
    api.pushAs("p3", present()); // now three present → order freezes, p1's turn

    expect(statusText(el)).toBe("It's your turn.");
    expect(hasSubmit(el)).toBe(true);
  });

  it("does NOT freeze the order on an overshoot — an exact count prevents divergent orders", async () => {
    // The whole plugin rests on every client freezing the SAME turn order. If the gate used `>=`,
    // one client could freeze over {p1,p2} (saw 2) while another freezes over {p1,p2,p3} (saw 3) and
    // they'd disagree on whose turn it is. With an exact count, an overshoot stalls in the gate.
    const api = new MockApi("p1");
    api.pushAs("p2", present());
    api.pushAs("p3", present()); // 3 present, but expected_players is 2 → overshoot
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 2,
      get_move: () => "m",
    } as never);
    await flush();

    expect(statusText(el)).toMatch(/Waiting for players/); // did NOT freeze / proceed
    expect(hasSubmit(el)).toBe(false);
    expect(finished).toHaveLength(0);
  });

  it("honours player_label and format_move in the status and history", async () => {
    const api = new MockApi("p2");
    api.pushAs("p1", moved(5));
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      turn_order: ["p1", "p2"],
      player_label: (id: string) => (id === "p1" ? "Alice" : "Bob"),
      format_move: (move: number) => `$${move}`,
    } as never);
    await flush();

    // p1 already moved → it's p2's turn; history shows Alice's formatted move.
    expect(hasSubmit(el)).toBe(true);
    expect(historyItems(el)).toEqual(["Alice: $5"]);
  });

  it("escapes untrusted move values in the history", async () => {
    const api = new MockApi("p2");
    api.pushAs("p1", moved("<img src=x onerror=alert(1)>"));
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      turn_order: ["p1", "p2"],
    } as never);
    await flush();

    expect(el.querySelector("img")).toBeNull();
    expect(el.innerHTML).toContain("&lt;img");
  });

  it("ends with timed_out and runs on_timeout when the sequence stalls", async () => {
    jest.useFakeTimers();
    try {
      const api = new MockApi("p1");
      api.pushAs("p2", present());
      const on_timeout = jest.fn();
      const { jsPsych, finished } = makeJsPsych(api);
      const el = display();

      new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
        ...base,
        expected_players: 2,
        get_move: () => "offer",
        timeout: 1000,
        on_timeout,
      } as never);

      clickSubmit(el); // p1 moves; now waiting on p2, who never moves
      jest.advanceTimersByTime(1000);

      expect(on_timeout).toHaveBeenCalledTimes(1);
      expect(finished).toHaveLength(1);
      expect(finished[0].ended_by).toBe("timeout");
      expect(finished[0].timed_out).toBe(true);
      expect(finished[0].moves).toEqual([{ participantId: "p1", move: "offer", position: 0 }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("recovers from a failed submit: resets, shows an error, and can retry", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.pushAs("p2", present());
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    // The presence announce push succeeds; only the SUBMIT push (armed below) fails.
    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 2,
      get_move: () => "offer",
    } as never);
    await flush();

    api.failNextPush = true; // next push (the submit) fails
    clickSubmit(el);
    await flush();

    expect(el.querySelector(".jspsych-multiplayer-turn-error")).not.toBeNull();
    expect(hasSubmit(el)).toBe(true); // restored for a retry
    expect(finished).toHaveLength(0);

    clickSubmit(el); // retry succeeds
    await flush();
    expect(api.getAll().p1.turn).toEqual({ move: "offer" });
    errSpy.mockRestore();
  });

  it("unsubscribes on finish and does not fire again", async () => {
    const api = new MockApi("p1");
    api.pushAs("p2", present());
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerTurnPlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 2,
      get_move: () => "a",
    } as never);
    await flush();
    clickSubmit(el);
    api.pushAs("p2", moved("b")); // completes → finish

    expect(finished).toHaveLength(1);
    expect(api.subCount()).toBe(0); // torn down
    api.pushAs("p2", moved("c")); // a late update must not re-finish
    expect(finished).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-turn — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type and the sequence", async () => {
    const jsPsych = initJsPsych();
    const api = new MockApi("p1");
    api.pushAs("p2", present());
    Object.assign(jsPsych.pluginAPI, {
      participantId: api.participantId,
      get: api.get.bind(api),
      push: api.push.bind(api),
      getAll: api.getAll.bind(api),
      subscribe: api.subscribe.bind(api),
    });

    const { displayElement, expectFinished, getData } = await startTimeline(
      [{ type: MultiplayerTurnPlugin, expected_players: 2, get_move: () => "go" }],
      jsPsych
    );

    await flush();
    clickSubmit(displayElement);
    api.pushAs("p2", moved("done"));
    await expectFinished();

    const data = getData().values()[0];
    expect(data.trial_type).toBe("multiplayer-turn");
    expect(data.ended_by).toBe("complete");
    expect(data.my_move).toBe("go");
    expect(data.moves).toHaveLength(2);
  });
});
