import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import MultiplayerLiveScoreboardPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the plugin codes against, with the
// real-time `subscribe` primitive. Semantics mirror the reference adapter:
//   - `push` REPLACES this participant's slot (it does NOT merge — see the JATOS adapter's
//     `groupSession.set`), then fires every subscriber. A merge mock would hide the exact bug the
//     "preserves unrelated keys" test guards against.
//   - `subscribe` registers a callback, immediately replays the current snapshot (as core does), and
//     returns an unsubscribe function.
//   - `pushAs(id, data)` simulates a peer's push (also replace), firing subscribers.
// The published `jspsych` here has no multiplayer API, so this mock + a direct trial() call exercises
// the plugin without a live group session.
// ---------------------------------------------------------------------------------------------------
class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  /** When true, the next `push` rejects (report failure) without touching the session. */
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

  /** Number of live subscriptions — 0 after a clean teardown. */
  subCount() {
    return this.subs.size;
  }

  private fire() {
    for (const cb of [...this.subs]) cb(this.getAll());
  }
}

/** Minimal jsPsych double exposing `pluginAPI` (the mock) and capturing `finishTrial` data. */
function makeJsPsych(api: MockApi) {
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    pluginAPI: api,
    finishTrial: (data: Record<string, any>) => finished.push(data),
  };
  return { jsPsych, finished };
}

const display = () => document.createElement("div");
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Rendered board rows, as `{ name, score, isSelf }`. */
function boardRows(el: HTMLElement) {
  return [...el.querySelectorAll(".jspsych-multiplayer-live-scoreboard-row")].map((row) => ({
    name: (row.querySelector(".jspsych-multiplayer-live-scoreboard-name") as HTMLElement)
      .textContent,
    score: (row.querySelector(".jspsych-multiplayer-live-scoreboard-score") as HTMLElement)
      .textContent,
    isSelf: row.classList.contains("is-self"),
  }));
}

/** The caption text ("N reported" / "N of M reported"). */
function captionOf(el: HTMLElement) {
  return (el.querySelector(".jspsych-multiplayer-live-scoreboard-caption") as HTMLElement)
    .textContent;
}

/** Click the end button. */
function clickEnd(el: HTMLElement) {
  (
    el.querySelector(".jspsych-multiplayer-live-scoreboard-end") as HTMLButtonElement | null
  )?.click();
}

/** Default params so each test only overrides what it cares about. */
const base = {
  score: null,
  label: null,
  data_key: "scoreboard",
  sort: "desc",
  tie_method: "standard",
  title: "<h2>Live scores</h2>",
  show_rank: true,
  highlight_self: true,
  display_label: null,
  score_format: null,
  duration: null,
  end_button_label: null,
  end_when: null,
  expected_players: null,
};

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-live-scoreboard — package surface", () => {
  it("exposes the pure ranking core and the standing accessors as statics", () => {
    expect(typeof MultiplayerLiveScoreboardPlugin.buildLeaderboard).toBe("function");
    expect(typeof MultiplayerLiveScoreboardPlugin.getMyRank).toBe("function");
    expect(typeof MultiplayerLiveScoreboardPlugin.getMyScore).toBe("function");
    expect(typeof MultiplayerLiveScoreboardPlugin.getLeaderboard).toBe("function");
  });

  it("the static buildLeaderboard actually works (sanity check of the public path)", () => {
    const rows = MultiplayerLiveScoreboardPlugin.buildLeaderboard(
      { a: { score: { score: 5 } }, b: { score: { score: 9 } } },
      { dataKey: "score" }
    );
    expect(rows.map((r) => r.participantId)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-live-scoreboard — trial wrapper", () => {
  it("guards: throws if the adapter is not connected (no participantId)", () => {
    const api = new MockApi(null);
    const { jsPsych } = makeJsPsych(api);
    const plugin = new MultiplayerLiveScoreboardPlugin(jsPsych as never);
    expect(() =>
      plugin.trial(display(), { ...base, score: 1, end_button_label: "Done" } as never)
    ).toThrow(/participantId/i);
  });

  it("trial() is synchronous (returns undefined) so jsPsych waits for finishTrial", () => {
    // jsPsych 8 races a Promise returned from trial() against finishTrial(); an async trial() that
    // resolves after setup would end the trial instantly with no data. Guard the sync-ness.
    const api = new MockApi("me");
    const { jsPsych } = makeJsPsych(api);

    const returned = new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(display(), {
      ...base,
      score: 1,
      end_button_label: "Done",
    } as never);

    expect(returned).toBeUndefined();
  });

  it("renders an initial board from seeded scores and highlights this client's own row", async () => {
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 30, label: "Bea" } });
    api.pushAs("p3", { scoreboard: { score: 10 } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 20,
      label: "Me",
      end_button_label: "Done",
    } as never);
    await flush();

    // p2 (30) > p1/self (20) > p3 (10).
    expect(boardRows(el)).toEqual([
      { name: "Bea", score: "30", isSelf: false },
      { name: "Me", score: "20", isSelf: true },
      { name: "p3", score: "10", isSelf: false },
    ]);
    // Standing is published live for downstream conditional_functions.
    expect(MultiplayerLiveScoreboardPlugin.getMyRank()).toBe(2);
    expect(MultiplayerLiveScoreboardPlugin.getMyScore()).toBe(20);
  });

  it("re-renders when a peer reports (the subscription works), re-ranking live", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 15,
      end_button_label: "Done",
    } as never);
    await flush();

    // Only self so far.
    expect(boardRows(el).map((r) => r.score)).toEqual(["15"]);

    // A peer with a higher score arrives → a new row appears and ranks update, no new trial.
    api.pushAs("p2", { scoreboard: { score: 40 } });
    expect(boardRows(el).map((r) => r.score)).toEqual(["40", "15"]);

    // A lower peer slots in below.
    api.pushAs("p3", { scoreboard: { score: 5 } });
    expect(boardRows(el).map((r) => r.score)).toEqual(["40", "15", "5"]);
  });

  it("caption shows 'N reported', or 'N of M reported' when expected_players is set", async () => {
    const withExpected = new MockApi("p1");
    withExpected.pushAs("p2", { scoreboard: { score: 3 } });
    const el1 = display();
    new MultiplayerLiveScoreboardPlugin(makeJsPsych(withExpected).jsPsych as never).trial(el1, {
      ...base,
      score: 1,
      expected_players: 4,
      end_button_label: "Done",
    } as never);
    await flush();
    expect(captionOf(el1)).toBe("2 of 4 reported"); // self + p2

    const noExpected = new MockApi("p1");
    const el2 = display();
    new MultiplayerLiveScoreboardPlugin(makeJsPsych(noExpected).jsPsych as never).trial(el2, {
      ...base,
      score: 1,
      end_button_label: "Done",
    } as never);
    await flush();
    expect(captionOf(el2)).toBe("1 reported"); // just self, no "of M"
  });

  it("ends on the end button with ended_by 'button' and a correct final snapshot", async () => {
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 30 } });
    api.pushAs("p3", { scoreboard: { score: 10 } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 20,
      end_button_label: "Done",
    } as never);
    await flush();

    expect(finished).toHaveLength(0); // still open until the button is clicked
    clickEnd(el);

    expect(finished).toHaveLength(1);
    const data = finished[0];
    expect(data.ended_by).toBe("button");
    expect(data.num_players).toBe(3);
    expect(data.my_rank).toBe(2); // 30 > 20 > 10
    expect(data.my_score).toBe(20);
    expect(data.error).toBeNull();
    expect(data.leaderboard.map((r: any) => [r.participantId, r.rank])).toEqual([
      ["p2", 1],
      ["p1", 2],
      ["p3", 3],
    ]);
  });

  it("ends on the duration timeout with ended_by 'duration'", async () => {
    jest.useFakeTimers();
    try {
      const api = new MockApi("p1");
      const { jsPsych, finished } = makeJsPsych(api);

      new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(display(), {
        ...base,
        score: 5,
        duration: 40,
      } as never);
      expect(finished).toHaveLength(0); // still open right after setup

      jest.advanceTimersByTime(39);
      expect(finished).toHaveLength(0); // not a millisecond early
      jest.advanceTimersByTime(1);

      expect(finished).toHaveLength(1);
      expect(finished[0].ended_by).toBe("duration");
    } finally {
      jest.useRealTimers();
    }
  });

  it("ends when end_when becomes true, with ended_by 'condition'", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(display(), {
      ...base,
      score: 1,
      end_when: (g: GroupSessionData) => Object.keys(g).length >= 3,
    } as never);
    expect(finished).toHaveLength(0);

    api.pushAs("p2", { scoreboard: { score: 2 } });
    expect(finished).toHaveLength(0); // only 2 present
    api.pushAs("p3", { scoreboard: { score: 3 } });

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("condition");
    expect(finished[0].num_players).toBe(3);
  });

  it("ends immediately if end_when is already true at load", () => {
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 9 } }); // group already big enough
    const { jsPsych, finished } = makeJsPsych(api);

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(display(), {
      ...base,
      score: 5,
      end_when: (g: GroupSessionData) => Object.keys(g).length >= 2,
    } as never);

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("condition");
  });

  it("a throwing end_when at load (non-empty session) does not propagate or soft-lock the trial", () => {
    // The session is already populated when this client reaches the trial (peers reported first).
    // A predicate that throws on a non-empty group must be caught at the load-time check just like
    // in the subscribe callback — otherwise the throw escapes trial() and the board never renders.
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 9 } }); // pre-populated at load
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    expect(() =>
      new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
        ...base,
        score: 5,
        end_button_label: "Done",
        end_when: (g: GroupSessionData) => {
          if (Object.keys(g).length > 0) throw new Error("boom");
          return false;
        },
      } as never)
    ).not.toThrow();

    // The board still rendered and the trial is still open (not finished by the throw).
    expect(finished).toHaveLength(0);
    expect(boardRows(el).map((r) => r.score)).toEqual(["9", "5"]);
    // ...and it remains finishable via another end condition.
    clickEnd(el);
    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("button");
  });

  it("initial push failure: records `error`, still renders the board, and keeps watching", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.failNextPush = true; // this client's score report fails
    api.pushAs("p2", { scoreboard: { score: 7 } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      end_button_label: "Done",
    } as never);
    await flush(); // let the push rejection route to the .catch

    // The board still shows (only the peer, since our push never landed) and an inline note appears.
    expect(el.querySelector(".jspsych-multiplayer-live-scoreboard-error")).not.toBeNull();
    expect(boardRows(el).map((r) => r.score)).toEqual(["7"]);

    // Still watching: a later peer report re-renders.
    api.pushAs("p3", { scoreboard: { score: 3 } });
    expect(boardRows(el).map((r) => r.score)).toEqual(["7", "3"]);

    clickEnd(el);
    expect(finished[0].error).toMatch(/network down/);
    expect(finished[0].my_rank).toBeNull(); // our row never landed
    errSpy.mockRestore();
  });

  it("reporting preserves unrelated keys in this client's slot (push REPLACES the slot)", async () => {
    const api = new MockApi("p1");
    api.pushAs("p1", { role: "proposer" }); // an earlier trial pushed a role
    const { jsPsych } = makeJsPsych(api);

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(display(), {
      ...base,
      score: 7,
      end_button_label: "Done",
    } as never);
    await flush();

    const mine = api.get("p1") as any;
    expect(mine.role).toBe("proposer"); // survived the scoreboard's own push
    expect(mine.scoreboard).toEqual({ score: 7 }); // score added alongside
  });

  it("unsubscribes on finish and does not render or finish again (no leak, no double-finish)", async () => {
    jest.useFakeTimers();
    try {
      const api = new MockApi("p1");
      const { jsPsych, finished } = makeJsPsych(api);
      const el = display();

      new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
        ...base,
        score: 5,
        end_button_label: "Done",
        duration: 30,
      } as never);
      clickEnd(el);

      expect(api.subCount()).toBe(0); // subscription torn down
      // A peer report after end must not re-render or re-finish; the duration timer must not fire.
      api.pushAs("p2", { scoreboard: { score: 99 } });
      jest.advanceTimersByTime(60); // well past the duration — the cleared timer must not fire

      expect(finished).toHaveLength(1);
      expect(boardRows(el).map((r) => r.score)).toEqual(["5"]); // no render after teardown
    } finally {
      jest.useRealTimers();
    }
  });

  it("warns when no end condition is set (the board can never close)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(display(), {
      ...base,
      score: 1,
    } as never);
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no way to close|end condition/i));
    warn.mockRestore();
  });

  it("warns when `score` does not resolve to a finite number (unranked, still watches)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 8 } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: null, // e.g. this client had no scored trials to sum
      end_button_label: "Done",
    } as never);
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not resolve to a finite number/));
    clickEnd(el);
    expect(finished[0].num_players).toBe(1); // only the peer is ranked
    expect(finished[0].my_rank).toBeNull(); // this client is not on the board
    warn.mockRestore();
  });

  it("rendering: honours display_label override and score_format", async () => {
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 2, label: "ignored-pushed-label" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 1,
      end_button_label: "Done",
      display_label: (id: string) => (id === "p1" ? "You" : "Rival"),
      score_format: (s: number) => `${s} pts`,
    } as never);
    await flush();

    expect(el.textContent).toContain("You");
    expect(el.textContent).toContain("Rival"); // display_label overrode the pushed label
    expect(el.textContent).not.toContain("ignored-pushed-label");
    expect(el.textContent).toContain("2 pts"); // score_format applied
  });

  it("escapes untrusted labels rather than parsing them as HTML", async () => {
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 5, label: "<img src=x onerror=alert(1)>" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 1,
      end_button_label: "Done",
    } as never);
    await flush();

    expect(el.querySelector("img")).toBeNull(); // not parsed as markup
    expect(el.innerHTML).toContain("&lt;img");
  });

  it("a throwing display_label falls back to the pushed label and keeps rendering", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 5, label: "Bea" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      label: "Me",
      end_button_label: "Done",
      display_label: () => {
        throw new Error("bad label fn");
      },
    } as never);
    await flush();

    expect(errSpy).toHaveBeenCalled(); // the throw was caught and logged
    expect(el.textContent).toContain("Me"); // fell back to p1's pushed label
    expect(el.textContent).toContain("Bea"); // fell back to p2's pushed label
    errSpy.mockRestore();
  });

  it("a throwing score_format falls back to the raw score", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 9,
      end_button_label: "Done",
      score_format: () => {
        throw new Error("bad format fn");
      },
    } as never);
    await flush();

    expect(errSpy).toHaveBeenCalled();
    expect(el.textContent).toContain("9"); // raw score shown as fallback
    errSpy.mockRestore();
  });

  it("a throwing end_when does not propagate into the notify loop or kill the trial", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    new MultiplayerLiveScoreboardPlugin(jsPsych as never).trial(el, {
      ...base,
      score: 1,
      end_button_label: "Done",
      end_when: (g: GroupSessionData) => {
        if (Object.keys(g).length > 1) throw new Error("boom");
        return false;
      },
    } as never);

    // The peer's report drives the subscribe callback; the predicate's throw must not escape into
    // the notify loop (here: pushAs) or finish the trial.
    expect(() => api.pushAs("p2", { scoreboard: { score: 5 } })).not.toThrow();
    expect(finished).toHaveLength(0);

    // ...and the subscription is still alive: later updates keep rendering.
    api.pushAs("p3", { scoreboard: { score: 3 } });
    expect(boardRows(el).map((r) => r.score)).toEqual(["5", "3", "1"]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-live-scoreboard — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type, and saves the standing", async () => {
    const jsPsych = initJsPsych();
    const api = new MockApi("p1");
    api.pushAs("p2", { scoreboard: { score: 30 } });
    api.pushAs("p3", { scoreboard: { score: 5 } });
    // Graft the multiplayer API seam onto pluginAPI, exactly where connect() puts it (jsPsych#3694),
    // so the plugin's single cast finds it on a REAL jsPsych instance.
    Object.assign(jsPsych.pluginAPI, {
      participantId: api.participantId,
      get: api.get.bind(api),
      push: api.push.bind(api),
      getAll: api.getAll.bind(api),
      subscribe: api.subscribe.bind(api),
    });

    const { displayElement, expectFinished, getData } = await startTimeline(
      [{ type: MultiplayerLiveScoreboardPlugin, score: 20, end_button_label: "Done" }],
      jsPsych
    );

    await flush();
    expect(boardRows(displayElement).map((r) => r.score)).toEqual(["30", "20", "5"]);

    clickEnd(displayElement);
    await expectFinished();

    const data = getData().values()[0];
    expect(data.trial_type).toBe("multiplayer-live-scoreboard"); // jsPsych records info.name
    expect(data.ended_by).toBe("button");
    expect(data.my_rank).toBe(2); // 30 > 20 > 5
    expect(data.num_players).toBe(3);
    expect(MultiplayerLiveScoreboardPlugin.getMyRank()).toBe(2);
  });
});
