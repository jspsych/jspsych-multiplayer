import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { GroupSessionData, MultiplayerApiLike } from "./multiplayer-api";
import MultiplayerScoreboardPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the plugin codes against, mirroring the
// reference adapter's overwrite-per-participant semantics (a later push for `me` replaces my whole
// slot). `wait` honours the fast-path and re-checks on every later push; if still unmet when
// `timeout` ms elapse it rejects — driven by Jest fake timers in the timeout test.
// ---------------------------------------------------------------------------------------------------
class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  private waiters: Array<() => void> = [];

  constructor(public participantId: string | null) {}

  /** Seed another participant's slot directly (simulating their push), notifying any waiter. */
  seed(id: string, data: Record<string, unknown>) {
    this.session[id] = data;
    this.waiters.forEach((notify) => notify());
  }

  async push(data: Record<string, unknown>) {
    this.session[this.participantId as string] = data; // overwrite-per-participant, like the real adapter
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        if (!settled && condition(this.session)) {
          settled = true;
          if (timer) clearTimeout(timer); // like a real adapter, tear down our own timeout on resolve
          resolve(this.session);
        }
      };
      this.waiters.push(check);
      if (timeout !== undefined) {
        timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`wait timed out after ${timeout}ms`));
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
/** Resolve any pending microtasks so the plugin's promise chain settles before assertions. */
const flush = () => new Promise((r) => setTimeout(r, 0));
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
      { dataKey: "score" }
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
    const api = new MockApi(null);
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerScoreboardPlugin(jsPsych as never);
    expect(() => plugin.trial(display(), { ...base, score: 1, group_size: 1 } as never)).toThrow(
      /participantId/i
    );
  });

  it("happy path: gathers scores, ranks them, and finishes on the continue button", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 30, label: "Bea" } });
    api.seed("p3", { score: { score: 10 } });
    const { jsPsych, finished } = makeJsPsych(api);
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

  it("preserves other keys already in this client's slot (push REPLACES the slot)", async () => {
    const api = new MockApi("p1");
    api.seed("p1", { role: "proposer" }); // an earlier trial pushed a role
    api.seed("p2", { score: { score: 5 } });
    const { jsPsych } = makeJsPsych(api);

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(display(), {
      ...base,
      score: 7,
      group_size: 2,
    } as never);
    await flush();

    const mine = api.get("p1") as any;
    expect(mine.role).toBe("proposer"); // survived the scoreboard's own push
    expect(mine.score).toEqual({ score: 7 }); // score added alongside
  });

  it("barrier: stalls at N-1 reporters, reveals when the Nth arrives", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
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
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 8 } });
    api.seed("p3", { score: { score: 3 } });
    const { jsPsych, finished } = makeJsPsych(api);
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
    jest.useFakeTimers();
    const api = new MockApi("p1"); // alone; group_size 3 never satisfied
    api.seed("p2", { score: { score: 4 } });
    const waitSpy = jest.spyOn(api, "wait");
    const { jsPsych, finished } = makeJsPsych(api);
    const onTimeout = jest.fn();
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 3,
      on_timeout: onTimeout,
    } as never);

    await Promise.resolve(); // let the push settle so gather reaches the api.wait call and our timer registers

    // The adapter backstop is strictly longer than our own timer, so firing OUR timer at 30000 (below)
    // is an unambiguous timeout — the adapter's 60000 deadline never fires to compete.
    expect(waitSpy).toHaveBeenCalledWith(expect.any(Function), 60000);

    jest.advanceTimersByTime(30000); // fire OUR timer (below the adapter's 60000 backstop)
    jest.useRealTimers();
    await flush(); // let the rejection route to the partial-board path

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
    jest.useFakeTimers();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1"); // p1 + p2 = 2 reporters, but group_size 3 never satisfied
    api.seed("p2", { score: { score: 4 } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 3,
      on_timeout: () => {
        throw new Error("hook boom");
      },
    } as never);

    await Promise.resolve(); // let the push settle and the timeout timer register
    jest.advanceTimersByTime(30000);
    jest.useRealTimers();
    await flush();

    expect(errSpy).toHaveBeenCalled(); // the throw was caught and logged
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull(); // board still rendered
    clickContinue(el);
    expect(finished[0].timed_out).toBe(true);
    errSpy.mockRestore();
  });

  it("warns when group_size is omitted (board may be partial)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);

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
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
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
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 2, label: "ignored-pushed-label" } });
    const { jsPsych } = makeJsPsych(api);
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
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 5, label: "<img src=x onerror=alert(1)>" } });
    const { jsPsych } = makeJsPsych(api);
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
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 5, label: "Bea" } });
    const { jsPsych, finished } = makeJsPsych(api);
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
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 5 } });
    const { jsPsych, finished } = makeJsPsych(api);
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

  it("push failure: records `error`, is NOT a timeout, does not fire on_timeout, still shows the board", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 7 } });
    api.push = jest.fn().mockRejectedValue(new Error("network down")); // the score push fails
    const onTimeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      group_size: 2,
      on_timeout: onTimeout,
    } as never);
    await flush();

    expect(onTimeout).not.toHaveBeenCalled(); // a push failure is not a timeout
    expect(el.querySelector(".jspsych-multiplayer-scoreboard-table")).not.toBeNull(); // board still shown
    clickContinue(el);
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(false); // NOT mislabeled as a timeout
    expect(finished[0].error).toMatch(/network down/); // the error is preserved separately
    errSpy.mockRestore();
  });

  it("wait/backend failure: records `error`, is NOT a timeout, does not fire on_timeout", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 7 } });
    api.wait = jest.fn().mockRejectedValue(new Error("socket closed")); // backend drops mid-wait
    const onTimeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
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

  it("wait that throws synchronously: caught as `error`, no unhandled rejection or soft-lock", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.seed("p2", { score: { score: 7 } });
    api.wait = jest.fn(() => {
      throw new Error("wait sync boom"); // adapter throws synchronously (e.g. called while disconnected)
    });
    const onTimeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
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
    expect(finished[0].error).toMatch(/wait sync boom/);
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-scoreboard — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type, and saves the standing", async () => {
    const jsPsych = initJsPsych();
    const api = new MockApi("p1");
    // This trial uses the DEFAULT data_key ("scoreboard"), so peers must be seeded under that key.
    api.seed("p2", { scoreboard: { score: 30 } });
    api.seed("p3", { scoreboard: { score: 5 } });
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

    const { getData, expectFinished, finished, displayElement } = await startTimeline(
      [{ type: MultiplayerScoreboardPlugin, score: 20, group_size: 3 }],
      jsPsych
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
