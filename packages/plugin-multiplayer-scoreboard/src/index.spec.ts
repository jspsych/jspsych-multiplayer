import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions } from "jspsych";

import { MemoryHub } from "../../../test-utils/memory-backend";
import MultiplayerScoreboardPlugin from ".";

/**
 * A jsPsych stand-in whose `multiplayer` is a real session on an in-memory hub, so the plugin runs
 * against the actual core (frozen snapshots, presence, errors) while `finishTrial` is captured.
 * `api.seed(id, data)` writes a participant's slot, as if they had written it.
 */
async function setup(participantId = "p1", connect?: ConnectOptions) {
  const hub = new MemoryHub();
  const me = await hub.join(participantId, { connect });
  const multiplayer = me.jsPsych.multiplayer;
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    multiplayer,
    finishTrial: (data: Record<string, any>) => finished.push(data),
    pluginAPI: {
      setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    },
  };
  const api = {
    seed: (id: string, data: Record<string, unknown>) =>
      id === participantId ? void multiplayer.update(data) : hub.seed(id, data),
    get: (id: string) => multiplayer.get(id),
  };
  return { hub, me, multiplayer, jsPsych, finished, api };
}

const display = () => document.createElement("div");
/** Resolve any pending microtasks so the plugin's promise chain settles before assertions. */
const flush = () => new Promise((r) => setTimeout(r, 0));
/**
 * Drain the microtask queue without touching timers — the fake-timer tests need the write to settle
 * (`update()` awaits an inner push, so it takes several ticks) before advancing to the timeout, and
 * `flush()` would hang there because its setTimeout is itself faked.
 */
const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
/** Click the continue button rendered on the board. */
const clickContinue = (el: HTMLElement) =>
  (el.querySelector(".jspsych-multiplayer-scoreboard-button") as HTMLButtonElement | null)?.click();

// The accessor store is module-level; each store-asserting test runs a trial that sets it first, so
// there is no cross-test leakage to reset here.

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-scoreboard — package surface", () => {
  it("exposes the pure ranking core and the standing accessors as statics", () => {
    expect(typeof MultiplayerScoreboardPlugin.buildLeaderboard).toBe("function");
    expect(typeof MultiplayerScoreboardPlugin.getMyRank).toBe("function");
    expect(typeof MultiplayerScoreboardPlugin.getMyScore).toBe("function");
    expect(typeof MultiplayerScoreboardPlugin.getLeaderboard).toBe("function");
  });

  it("the static buildLeaderboard actually works (sanity check of the public path)", () => {
    const rows = MultiplayerScoreboardPlugin.buildLeaderboard(
      { a: { score: { score: 5 } }, b: { score: { score: 9 } } },
      { dataKey: "score" },
    );
    expect(rows.map((r) => r.participantId)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-scoreboard — trial wrapper", () => {
  const base = {
    data_key: "score",
    sort: "desc",
    tie_method: "standard",
    title: "<h2>Final scores</h2>",
    show_rank: true,
    highlight_self: true,
    button_label: "Continue",
    message: "<p>waiting</p>",
    timeout: 30000,
  };

  it("guards: throws if the adapter is not connected (no participantId)", () => {
    const jsPsych = { multiplayer: { participantId: null } };
    const plugin = new MultiplayerScoreboardPlugin(jsPsych as never);
    expect(() => plugin.trial(display(), { ...base, score: 1, group_size: 1 } as never)).toThrow(
      /participantId/i,
    );
  });

  it("happy path: gathers scores, ranks them, and finishes on the continue button", async () => {
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { score: { score: 30, label: "Bea" } });
    api.seed("p3", { score: { score: 10 } });

    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 20,
      label: "Me",
      group_size: 3,
    } as never);
    await flush();

    // Board is rendered but the trial has NOT finished until the button is clicked.
    expect(finished).toHaveLength(0);
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull();
    // Store is published as soon as the board is revealed (for downstream conditional_functions).
    expect(MultiplayerScoreboardPlugin.getMyRank()).toBe(2); // 30 > 20 > 10
    expect(MultiplayerScoreboardPlugin.getMyScore()).toBe(20);

    clickContinue(el);
    expect(finished).toHaveLength(1);
    const data = finished[0];
    expect(data.timed_out).toBe(false);
    expect(data.num_players).toBe(3);
    expect(data.my_rank).toBe(2);
    expect(data.my_score).toBe(20);
    expect(data.leaderboard.map((r: any) => [r.participantId, r.rank])).toEqual([
      ["p2", 1],
      ["p1", 2],
      ["p3", 3],
    ]);
    expect(data.leaderboard.find((r: any) => r.participantId === "p1").isSelf).toBe(true);
  });

  it("preserves other keys already in this client's slot (update MERGES into it)", async () => {
    const { api, jsPsych } = await setup("p1");
    api.seed("p1", { role: "proposer" }); // an earlier trial pushed a role
    api.seed("p2", { score: { score: 5 } });

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(display(), {
      ...base,
      score: 7,
      group_size: 2,
    } as never);
    await flush();

    const mine = api.get("p1") as any;
    expect(mine.role).toBe("proposer"); // survived the scoreboard's own write
    expect(mine.score).toEqual({ score: 7 }); // score added alongside
  });

  it("barrier: stalls at N-1 reporters, reveals when the Nth arrives", async () => {
    const { api, jsPsych, finished } = await setup("p1");

    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 15,
      group_size: 2,
    } as never);
    await flush();
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).toBeNull(); // still waiting
    expect(el.innerHTML).toContain("waiting");

    api.seed("p2", { score: { score: 5 } }); // Nth reporter
    await flush();
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull();
    clickContinue(el);
    expect(finished[0].num_players).toBe(2);
  });

  it("no valid score: warns, stays unranked, but still views the board", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { score: { score: 8 } });
    api.seed("p3", { score: { score: 3 } });

    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: null, // e.g. this client had no scored trials to sum
      group_size: 2,
    } as never);
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not resolve to a finite number/));
    clickContinue(el);
    expect(finished[0].num_players).toBe(2); // only the two scorers are ranked
    expect(finished[0].my_rank).toBeNull(); // this client is not on the board
    expect(finished[0].my_score).toBeNull();
    warn.mockRestore();
  });

  it("timeout: fires on_timeout, degrades to a partial board flagged timed_out, still finishable", async () => {
    const { api, jsPsych, finished } = await setup("p1"); // group_size 3 never satisfied
    api.seed("p2", { score: { score: 4 } });
    const onTimeout = jest.fn();
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 3,
      timeout: 40,
      on_timeout: onTimeout,
    } as never);
    await new Promise((r) => setTimeout(r, 80)); // the 40 ms timeout fires

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-timeout")).not.toBeNull();
    clickContinue(el);
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].error).toBeNull(); // a timeout is not an error
    expect(finished[0].num_players).toBe(2); // p1 (self) + p2, the two who reported
    expect(finished[0].my_rank).toBe(1); // 9 > 4
  });

  it("a throwing on_timeout hook still renders the board (no hang)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1"); // 2 reporters, group_size 3 never satisfied
    api.seed("p2", { score: { score: 4 } });
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 3,
      timeout: 40,
      on_timeout: () => {
        throw new Error("hook boom");
      },
    } as never);
    await new Promise((r) => setTimeout(r, 80));

    expect(errSpy).toHaveBeenCalled(); // the throw was caught and logged
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull(); // board still rendered
    clickContinue(el);
    expect(finished[0].timed_out).toBe(true);
    errSpy.mockRestore();
  });

  it("in a sealed group, group_size defaults to the roster, without a warning", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { hub, jsPsych, finished } = await setup("p1");
    hub.seal(["p1", "p2"]);
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 15,
      group_size: null,
    } as never);
    await flush();
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/group_size/));
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).toBeNull(); // still waiting

    const p2 = await hub.join("p2");
    await p2.jsPsych.multiplayer.update({ score: { score: 5 } });
    await flush();
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull();
    clickContinue(el);
    expect(finished[0].num_players).toBe(2);
    warn.mockRestore();
  });

  it("warns when group_size is omitted (board may be partial)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { api, jsPsych } = await setup("p1");

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(display(), {
      ...base,
      score: 1,
      group_size: null,
    } as never);
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/group_size/));
    warn.mockRestore();
  });

  it("warns when button_label is null (the trial cannot end)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1");

    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 1,
      group_size: 1,
      button_label: null,
    } as never);
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/button_label/));
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-button")).toBeNull(); // no button rendered
    expect(finished).toHaveLength(0); // and so the trial cannot end
    warn.mockRestore();
  });

  it("rendering: highlights self, honours display_label override and score_format", async () => {
    const { api, jsPsych } = await setup("p1");
    api.seed("p2", { score: { score: 2, label: "ignored-pushed-label" } });

    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 1,
      group_size: 2,
      display_label: (id: string) => (id === "p1" ? "You" : "Rival"),
      score_format: (s: number) => `${s} pts`,
    } as never);
    await flush();

    const selfRow = el.querySelector(".jspsych-multiplayer-scoreboard-row.is-self");
    expect(selfRow).not.toBeNull();
    expect(el.textContent).toContain("You");
    expect(el.textContent).toContain("Rival"); // display_label overrode the pushed label
    expect(el.textContent).not.toContain("ignored-pushed-label");
    expect(el.textContent).toContain("2 pts"); // score_format applied
  });

  it("escapes untrusted labels rather than parsing them as HTML", async () => {
    const { api, jsPsych } = await setup("p1");
    api.seed("p2", { score: { score: 5, label: "<img src=x onerror=alert(1)>" } });

    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 1,
      group_size: 2,
    } as never);
    await flush();

    expect(el.querySelector("img")).toBeNull(); // not parsed as markup
    expect(el.innerHTML).toContain("&lt;img");
  });

  it("a throwing display_label falls back to the pushed label and still renders/finishes", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { score: { score: 5, label: "Bea" } });

    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      label: "Me",
      group_size: 2,
      display_label: () => {
        throw new Error("bad label fn");
      },
    } as never);
    await flush();

    expect(errSpy).toHaveBeenCalled(); // the throw was caught and logged
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull(); // rendered, not soft-locked
    expect(el.textContent).toContain("Me"); // fell back to p1's pushed label
    expect(el.textContent).toContain("Bea"); // fell back to p2's pushed label
    clickContinue(el);
    expect(finished).toHaveLength(1); // trial actually finished
    errSpy.mockRestore();
  });

  it("a throwing score_format falls back to the raw score", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { score: { score: 5 } });

    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 2,
      score_format: () => {
        throw new Error("bad format fn");
      },
    } as never);
    await flush();

    expect(errSpy).toHaveBeenCalled();
    expect(el.textContent).toContain("9"); // raw score shown as fallback
    clickContinue(el);
    expect(finished).toHaveLength(1);
    errSpy.mockRestore();
  });

  it("write failure: records `error`, is NOT a timeout, does not fire on_timeout, still shows the board", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished, me } = await setup("p1");
    api.seed("p2", { score: { score: 7 } });
    me.connection.pushImpl = () => Promise.reject(new Error("network down")); // the score write fails
    const onTimeout = jest.fn();
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 2,
      on_timeout: onTimeout,
    } as never);
    await flush();

    expect(onTimeout).not.toHaveBeenCalled(); // a write failure is not a timeout
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull(); // board still shown
    clickContinue(el);
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(false); // NOT mislabeled as a timeout
    expect(finished[0].error).toMatch(/network down/); // the error is preserved separately
    errSpy.mockRestore();
  });

  it("wait/backend failure: records `error`, is NOT a timeout, does not fire on_timeout", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished, multiplayer } = await setup("p1");
    api.seed("p2", { score: { score: 7 } });
    jest.spyOn(multiplayer, "wait").mockRejectedValue(new Error("socket closed")); // backend drops mid-wait
    const onTimeout = jest.fn();
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 2,
      on_timeout: onTimeout,
    } as never);
    await flush();

    // A wait rejection is a backend/disconnect error, distinct from our own timeout timer firing.
    expect(onTimeout).not.toHaveBeenCalled();
    clickContinue(el);
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(false); // NOT mislabeled as a timeout
    expect(finished[0].error).toMatch(/socket closed/);
    errSpy.mockRestore();
  });

  it("wait while not connected: the rejection is caught as `error`, no unhandled rejection or soft-lock", async () => {
    // Under jsPsych#3694 `wait()` REJECTS when the API isn't connected rather than throwing
    // synchronously, so the rejection is the only path this has to survive.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished, multiplayer } = await setup("p1");
    api.seed("p2", { score: { score: 7 } });
    jest
      .spyOn(multiplayer, "wait")
      .mockRejectedValue(new Error("connect() must be called before using multiplayer methods"));
    const onTimeout = jest.fn();
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 2,
      on_timeout: onTimeout,
    } as never);
    await flush();

    expect(onTimeout).not.toHaveBeenCalled();
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull(); // rendered, not soft-locked
    clickContinue(el);
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(false);
    expect(finished[0].error).toMatch(/connect\(\) must be called/);
    errSpy.mockRestore();
  });

  it("a cancelled wait stops quietly: no board, no error, no finishTrial", async () => {
    // A wait cancelled by abortExperiment / disconnect / the end of jsPsych.run means the trial is
    // being torn down and jsPsych has already cleared the display. Revealing here would paint a board
    // over a finished experiment, with a Continue button whose finishTrial() lands after the run ended.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const onTimeout = jest.fn();
    const { jsPsych, finished, multiplayer } = await setup("p1");
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 3, // never satisfied, so the wait is still pending when it is cancelled
      on_timeout: onTimeout,
    } as never);
    await flush();
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).toBeNull(); // still waiting

    multiplayer.cancelAllSubscriptions();
    await flush();

    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).toBeNull(); // no board drawn
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-button")).toBeNull(); // no live button
    expect(finished).toHaveLength(0); // and nothing finished the (already ended) trial
    expect(onTimeout).not.toHaveBeenCalled(); // a cancellation is not a timeout
    expect(errSpy).not.toHaveBeenCalled(); // nor a backend failure worth logging
    errSpy.mockRestore();
  });

  it("failure paths survive a disconnected getAll(): the board still renders and finishes", async () => {
    // `gather()` runs detached (`void`), so a throwing getAll() on a failure path would be an
    // unhandled rejection leaving the participant stuck on the waiting message. Both the write-failure
    // and wait-failure paths read through the same safe fallback instead.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const disconnected = () => {
      throw new Error("connect() must be called before using multiplayer methods");
    };

    for (const failing of ["update", "wait"] as const) {
      const { api, jsPsych, finished, multiplayer, me } = await setup("p1");
      api.seed("p2", { score: { score: 7 } });
      if (failing === "update") {
        me.connection.pushImpl = () => Promise.reject(new Error("adapter went away"));
      } else {
        jest.spyOn(multiplayer, "wait").mockRejectedValue(new Error("adapter went away"));
      }
      jest.spyOn(multiplayer, "getAll").mockImplementation(disconnected);
      const el = display();

      new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
        ...base,
        score: 9,
        group_size: 2,
      } as never);
      await flush();

      // Empty snapshot fallback: no rows to rank, but a board with a working button all the same.
      expect(el.querySelector(".jspsych-multiplayer-scoreboard-empty")).not.toBeNull();
      clickContinue(el);
      expect(finished).toHaveLength(1);
      expect(finished[0].num_players).toBe(0);
      expect(finished[0].timed_out).toBe(false);
      expect(finished[0].error).toMatch(/adapter went away/);
    }
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-scoreboard — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type, and saves the standing", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    // This trial uses the DEFAULT data_key, so it's the first scoreboard: "scoreboard-1".
    hub.seed("p2", { "scoreboard-1": { score: 30 } });
    hub.seed("p3", { "scoreboard-1": { score: 5 } });

    const { getData, expectFinished, finished, displayElement } = await startTimeline(
      [{ type: MultiplayerScoreboardPlugin, score: 20, group_size: 3 }],
      jsPsych,
    );

    await flush();
    clickContinue(displayElement); // the board waits on the continue button
    await finished;
    await expectFinished();

    const data = getData().values()[0];
    expect(data.trial_type).toBe("multiplayer-scoreboard"); // jsPsych records info.name (sans plugin- prefix)
    expect(data.my_rank).toBe(2); // 30 > 20 > 5
    expect(data.num_players).toBe(3);
    expect(MultiplayerScoreboardPlugin.getMyRank()).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-scoreboard — board keys and departures", () => {
  const base = {
    data_key: null,
    sort: "desc",
    tie_method: "standard",
    title: "<h2>Final scores</h2>",
    show_rank: true,
    highlight_self: true,
    button_label: "Continue",
    message: "<p>waiting</p>",
    timeout: 30000,
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("generates scoreboard-1, scoreboard-2, … and a later board ignores earlier scores", async () => {
    const { api, jsPsych, finished } = await setup("p1");
    const plugin = new MultiplayerScoreboardPlugin(jsPsych as never);
    api.seed("p2", { "scoreboard-1": { score: 3 } });

    const el1 = display();
    plugin.trial(el1, { ...base, score: 5, group_size: 2 } as never);
    await flush();
    clickContinue(el1);
    expect(finished[0]).toMatchObject({ data_key: "scoreboard-1", num_players: 2 });

    const el2 = display();
    plugin.trial(el2, { ...base, score: 6, group_size: 2, timeout: 40 } as never);
    await sleep(80);
    clickContinue(el2);
    expect(finished[1]).toMatchObject({
      data_key: "scoreboard-2",
      num_players: 1,
      timed_out: true,
    });
  });

  it("uses an explicit data_key as-is without advancing the default count", async () => {
    const { jsPsych, finished } = await setup("p1");
    const plugin = new MultiplayerScoreboardPlugin(jsPsych as never);
    for (const data_key of ["final", null]) {
      const el = display();
      plugin.trial(el, { ...base, data_key, score: 1, group_size: 1 } as never);
      await flush();
      clickContinue(el);
    }
    expect(finished.map((d) => d.data_key)).toEqual(["final", "scoreboard-1"]);
  });

  it("shows the partial board flagged partner_left when a participant leaves", async () => {
    const { hub, jsPsych, finished } = await setup("p1", { dropoutTimeout: 10 });
    const peer = await hub.join("p2");
    const onTimeout = jest.fn();
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 5,
      group_size: 2,
      on_timeout: onTimeout,
    } as never);
    await sleep(0);
    await peer.jsPsych.multiplayer.disconnect();
    await sleep(30);

    expect(el.textContent).toContain("A player left");
    clickContinue(el);
    expect(finished[0]).toMatchObject({
      partner_left: true,
      left_participant: "p2",
      timed_out: false,
      error: null,
      num_players: 1,
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("does not count a participant who left toward group_size", async () => {
    const { hub, jsPsych, finished } = await setup("p1", { dropoutTimeout: 0 });
    const gone = await hub.join("p2");
    await gone.jsPsych.multiplayer.update({ "scoreboard-1": { score: 9 } });
    await gone.jsPsych.multiplayer.disconnect();
    await sleep(5);
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 5,
      group_size: 2,
      timeout: 40,
    } as never);
    await sleep(80);
    clickContinue(el);
    expect(finished[0].timed_out).toBe(true);
  });

  it("shows the board flagged connection_lost when this participant's connection closes", async () => {
    const { me, jsPsych, finished } = await setup("p1");
    const el = display();
    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 5,
      group_size: 3,
    } as never);
    await sleep(0);
    me.connection.options.onStatus("closed");
    await flush();

    expect(el.textContent).toContain("connection was lost");
    clickContinue(el);
    expect(finished[0]).toMatchObject({ connection_lost: true, error: null });
  });
});
