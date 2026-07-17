import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { GroupSessionData, MultiplayerApiLike } from "./multiplayer-api";
import MultiplayerVotePlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the local interface the plugin codes against. `push` overwrites
// this participant's slot (mirroring the reference adapter's overwrite-per-participant semantics) and
// notifies any waiter; `seed` simulates a peer's push. `wait` honours the fast-path and re-checks the
// condition whenever a push/seed lands, rejecting with a `MultiplayerTimeoutError`-named error (as
// the real API does) if `timeout` ms elapse first. Tests use real timers
// with short timeouts, so no fake-timer plumbing is needed (matching the choice plugin's spec).
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

  get(id: string) {
    return this.session[id];
  }

  async push(data: Record<string, unknown>) {
    this.session[this.participantId as string] = data; // overwrite-per-participant, like the real adapter
    this.waiters.forEach((notify) => notify());
  }

  getAll() {
    return this.session;
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
            const err = new Error(`wait timed out after ${timeout}ms`);
            err.name = "MultiplayerTimeoutError"; // mirror the real API's typed timeout rejection
            reject(err);
          }
        }, timeout);
      }
    });
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

/** Click the i-th option button on the vote screen. */
function clickOption(el: HTMLElement, i: number) {
  const buttons = el.querySelectorAll<HTMLButtonElement>(".jspsych-multiplayer-vote-option button");
  buttons[i].click();
}

/** Click the reveal-screen continue button. */
function clickContinue(el: HTMLElement) {
  (el.querySelector(".jspsych-multiplayer-vote-continue") as HTMLButtonElement | null)?.click();
}

/** Tally rows as `{ text, isWinner, isTied, isMine }`. */
function tallyRows(el: HTMLElement) {
  return [...el.querySelectorAll(".jspsych-multiplayer-vote-reveal-item")].map((li) => ({
    text: li.textContent?.replace(/\s+/g, " ").trim(),
    isWinner: li.classList.contains("is-winner"),
    isTied: li.classList.contains("is-tied"),
    isMine: li.classList.contains("is-mine"),
  }));
}

/** Default params so each test only overrides what it cares about. */
const base = {
  choices: ["Red", "Green", "Blue"],
  prompt: null,
  button_html: null,
  data_key: "vote",
  expected_players: 3,
  waiting_message: "<p>waiting…</p>",
  timeout: null,
  on_timeout: null,
  reveal: true,
  reveal_prompt: null,
  continue_label: "Continue",
  reveal_duration: null,
};

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-vote — package surface", () => {
  it("exposes the pure core helpers as statics", () => {
    expect(typeof MultiplayerVotePlugin.tally).toBe("function");
    expect(typeof MultiplayerVotePlugin.plurality).toBe("function");
    expect(typeof MultiplayerVotePlugin.countVoted).toBe("function");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-vote — guards", () => {
  it("throws if the adapter is not connected (no participantId)", async () => {
    const api = new MockApi(null);
    const { jsPsych } = makeJsPsych(api);
    await expect(
      new MultiplayerVotePlugin(jsPsych as never).trial(display(), { ...base } as never)
    ).rejects.toThrow(/participantId/i);
  });

  it("throws if `choices` is empty", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    await expect(
      new MultiplayerVotePlugin(jsPsych as never).trial(display(), {
        ...base,
        choices: [],
      } as never)
    ).rejects.toThrow(/choices/i);
  });

  it("throws if `expected_players` is not a positive integer", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    await expect(
      new MultiplayerVotePlugin(jsPsych as never).trial(display(), {
        ...base,
        expected_players: 0,
      } as never)
    ).rejects.toThrow(/expected_players/i);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-vote — happy path", () => {
  it("collects a vote, barriers on the group, reveals the tally + winner, finishes on continue", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 2, label: "Blue" } }); // peers already voted
    api.seed("p3", { vote: { index: 2, label: "Blue" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush(); // phase 1 rendered

    expect(el.querySelectorAll(".jspsych-multiplayer-vote-option")).toHaveLength(3);
    clickOption(el, 0); // vote "Red"
    await flush(); // push + barrier (fast path, 3 == 3) + reveal render

    // Reveal shows one row per option, Blue winning with 2, and flags my own row.
    const rows = tallyRows(el);
    expect(rows).toHaveLength(3);
    expect(rows[2].isWinner).toBe(true); // Blue
    expect(rows[0].isMine).toBe(true); // Red = my vote
    expect(el.textContent).toContain("Winner");
    expect(finished).toHaveLength(0); // not finished until continue

    clickContinue(el);
    await done;

    expect(finished).toHaveLength(1);
    const data = finished[0];
    expect(data.vote).toBe("Red");
    expect(data.vote_index).toBe(0);
    expect(typeof data.rt).toBe("number");
    expect(typeof data.wait_time).toBe("number");
    expect(data.n_votes).toBe(3);
    expect(data.is_tie).toBe(false);
    expect(data.timed_out).toBe(false);
    expect(data.wait_error).toBeNull();
    expect(data.winner).toEqual({ index: 2, label: "Blue", count: 2 });
    expect(data.tally).toEqual([
      { index: 0, label: "Red", count: 1 },
      { index: 1, label: "Green", count: 0 },
      { index: 2, label: "Blue", count: 2 },
    ]);
  });

  it("does not reveal who voted for what (anonymous ballot)", async () => {
    const api = new MockApi("alice");
    api.seed("bob", { vote: { index: 0, label: "Red" } });
    api.seed("carol", { vote: { index: 1, label: "Green" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush();
    clickOption(el, 0);
    await flush();

    // No participant id leaks into the reveal DOM or the recorded data.
    expect(el.innerHTML).not.toContain("bob");
    expect(el.innerHTML).not.toContain("carol");
    clickContinue(el);
    await done;
    expect(JSON.stringify(finished[0])).not.toContain("bob");
    expect(JSON.stringify(finished[0])).not.toContain("carol");
  });

  it("holds the waiting message until the rest of the group has voted", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush();
    clickOption(el, 1);
    await flush();

    // Only p1 has voted — the barrier holds, waiting message on screen, no reveal yet.
    expect(finished).toHaveLength(0);
    expect(el.innerHTML).toContain("waiting");
    expect(el.querySelector(".jspsych-multiplayer-vote-reveal")).toBeNull();

    api.seed("p2", { vote: { index: 1, label: "Green" } });
    api.seed("p3", { vote: { index: 0, label: "Red" } }); // the group is now complete
    await flush();

    expect(el.querySelector(".jspsych-multiplayer-vote-reveal")).not.toBeNull();
    clickContinue(el);
    await done;
    expect(finished[0].n_votes).toBe(3);
  });

  it("reports a tie in the data and reveal when the top options are level", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 1, label: "Green" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 2,
    } as never);
    await flush();
    clickOption(el, 0); // Red — now Red 1, Green 1 → tie
    await flush();

    expect(el.textContent).toContain("Tie");
    const tied = tallyRows(el).filter((r) => r.isTied);
    expect(tied).toHaveLength(2);
    clickContinue(el);
    await done;

    expect(finished[0].is_tie).toBe(true);
    expect(finished[0].winner).toBeNull();
    expect(finished[0].tied_options).toEqual([
      { index: 0, label: "Red", count: 1 },
      { index: 1, label: "Green", count: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-vote — reveal:false, timeout, and robustness", () => {
  it("with reveal:false, finishes as soon as the group has voted", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 0, label: "Red" } });
    api.seed("p3", { vote: { index: 0, label: "Red" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      reveal: false,
    } as never);
    await flush();
    clickOption(el, 2); // Blue
    await done;

    expect(finished).toHaveLength(1);
    expect(el.querySelector(".jspsych-multiplayer-vote-reveal")).toBeNull();
    expect(finished[0].vote).toBe("Blue");
    expect(finished[0].winner).toEqual({ index: 0, label: "Red", count: 2 });
    expect(finished[0].n_votes).toBe(3);
  });

  it("times out waiting for the group: proceeds partial, flags timed_out, calls on_timeout", async () => {
    const api = new MockApi("p1");
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 5, // never reached
      timeout: 40,
      on_timeout,
      reveal: false,
    } as never);
    await flush();
    clickOption(el, 0);
    await done;

    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished).toHaveLength(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].wait_error).toMatch(/timed out/);
    expect(finished[0].n_votes).toBe(1); // only p1 voted
    expect(finished[0].winner).toEqual({ index: 0, label: "Red", count: 1 });
  });

  it("does not let a stale, out-of-range vote lift the barrier or inflate n_votes", async () => {
    // p3's slot holds a leftover vote for index 5 — e.g. a previous vote trial with more options
    // reused the default data_key. It is not a valid vote for THIS 3-option trial, so it must count
    // toward neither the barrier nor the tally (the barrier count and n_votes stay in agreement).
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 0, label: "Red" } });
    api.seed("p3", { vote: { index: 5, label: "stale" } }); // out of range for choices.length === 3
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      timeout: 40,
      on_timeout,
      reveal: false,
    } as never);
    await flush();
    clickOption(el, 0); // p1 votes Red — only p1 and p2 are valid → 2 < expected 3, barrier holds
    await done; // resolves only when the 40ms barrier timeout fires (the group is never completed)

    // The stale index-5 vote did NOT complete the group: the barrier times out at 2 valid votes.
    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].n_votes).toBe(2); // p1 + p2 only; the out-of-range vote is excluded
    expect(finished[0].tally).toEqual([
      { index: 0, label: "Red", count: 2 },
      { index: 1, label: "Green", count: 0 },
      { index: 2, label: "Blue", count: 0 },
    ]);
  });

  it("propagates a push failure instead of masking it as a timeout", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 0, label: "Red" } });
    api.seed("p3", { vote: { index: 0, label: "Red" } });
    jest.spyOn(api, "push").mockRejectedValue(new Error("connection lost"));
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      on_timeout,
    } as never);
    await flush();
    clickOption(el, 0);

    await expect(done).rejects.toThrow(/connection lost/);
    expect(on_timeout).not.toHaveBeenCalled(); // a push failure is not a timeout
    expect(finished).toHaveLength(0); // trial never finished
  });

  it("propagates a non-timeout wait() rejection instead of masking it as a timeout", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 0, label: "Red" } });
    // A wait() rejection that is NOT a MultiplayerTimeoutError (e.g. a throwing condition/backend fault).
    jest.spyOn(api, "wait").mockRejectedValue(new Error("condition threw"));
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      timeout: 1000,
      on_timeout,
    } as never);
    await flush();
    clickOption(el, 0);

    await expect(done).rejects.toThrow(/condition threw/);
    expect(on_timeout).not.toHaveBeenCalled(); // not a timeout -> no soft path
    expect(finished).toHaveLength(0); // trial halts loudly
  });

  it("preserves other keys already in this client's slot (push REPLACES the slot)", async () => {
    const api = new MockApi("p1");
    api.seed("p1", { role: "proposer" }); // an earlier trial pushed a role
    api.seed("p2", { vote: { index: 0, label: "Red" } });
    api.seed("p3", { vote: { index: 0, label: "Red" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush();
    clickOption(el, 1);
    await flush();

    const mine = api.get("p1") as any;
    expect(mine.role).toBe("proposer"); // survived the vote push
    expect(mine.vote).toEqual({ index: 1, label: "Green" });
    clickContinue(el);
    await done;
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-vote — rendering", () => {
  it("uses button_html to render custom option markup", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      button_html: (choice: string) => `<button class="jspsych-btn custom-btn">${choice}</button>`,
    } as never);
    await flush();

    expect(el.querySelector("button.custom-btn")).not.toBeNull();
  });

  it("is selectable even when button_html renders no <button> (listener on the container)", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 0, label: "Red" } });
    api.seed("p3", { vote: { index: 0, label: "Red" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      button_html: (choice: string) => `<div class="tile">${choice}</div>`, // no <button>
    } as never);
    await flush();

    expect(el.querySelector("button")).toBeNull(); // confirm the custom markup has no button
    const options = el.querySelectorAll<HTMLElement>(".jspsych-multiplayer-vote-option");
    options[1].click(); // vote "Green" by clicking the container
    await flush();

    expect(el.querySelector(".jspsych-multiplayer-vote-reveal")).not.toBeNull();
    clickContinue(el);
    await done;
    expect(finished[0].vote).toBe("Green");
    expect(finished[0].vote_index).toBe(1);
  });

  it("auto-advances the reveal after reveal_duration when there is no continue button", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 0, label: "Red" } });
    api.seed("p3", { vote: { index: 0, label: "Red" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      continue_label: null,
      reveal_duration: 30,
    } as never);
    await flush();
    clickOption(el, 1);
    await done; // resolves via the reveal_duration timer, no continue click

    expect(finished).toHaveLength(1);
    expect(finished[0].vote).toBe("Green");
  });

  it("warns when reveal is on but neither continue_label nor reveal_duration is set", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 0, label: "Red" } });
    api.seed("p3", { vote: { index: 0, label: "Red" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerVotePlugin(jsPsych as never).trial(el, {
      ...base,
      continue_label: null,
      reveal_duration: null,
    } as never);
    await flush();
    clickOption(el, 0);
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no way to advance/));
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-vote — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type and the vote", async () => {
    const jsPsych = initJsPsych();
    const api = new MockApi("p1");
    api.seed("p2", { vote: { index: 1, label: "Green" } });
    api.seed("p3", { vote: { index: 1, label: "Green" } });
    Object.assign(jsPsych.pluginAPI, {
      participantId: api.participantId,
      get: api.get.bind(api),
      push: api.push.bind(api),
      getAll: api.getAll.bind(api),
      wait: api.wait.bind(api),
    });

    const { displayElement, expectFinished, getData } = await startTimeline(
      [{ type: MultiplayerVotePlugin, choices: ["Red", "Green", "Blue"], expected_players: 3 }],
      jsPsych
    );

    await flush();
    clickOption(displayElement, 0); // vote Red
    await flush();
    clickContinue(displayElement);
    await expectFinished();

    const data = getData().values()[0];
    expect(data.trial_type).toBe("multiplayer-vote");
    expect(data.vote).toBe("Red");
    expect(data.n_votes).toBe(3);
    expect(data.winner).toEqual({ index: 1, label: "Green", count: 2 });
  });
});
