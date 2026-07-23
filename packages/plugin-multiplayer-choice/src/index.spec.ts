import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { GroupSessionData, MultiplayerApiLike } from "./multiplayer-api";
import MultiplayerChoicePlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the local interface the plugin codes against. `push` overwrites
// this participant's slot (mirroring the reference adapter's overwrite-per-participant semantics) and
// notifies any waiter; `seed` simulates a peer's push. `wait` honours the fast-path and re-checks the
// condition whenever a push/seed lands, rejecting with a `MultiplayerTimeoutError`-named error (as
// the real API does) if `timeout` ms elapse first. Tests use real timers
// with short timeouts, so no fake-timer plumbing is needed (matching the sync plugin's spec).
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
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Click the i-th option button on the choice screen. */
function clickOption(el: HTMLElement, i: number) {
  const buttons = el.querySelectorAll<HTMLButtonElement>(
    ".jspsych-multiplayer-choice-option button"
  );
  buttons[i].click();
}

/** Click the reveal-screen continue button. */
function clickContinue(el: HTMLElement) {
  (el.querySelector(".jspsych-multiplayer-choice-continue") as HTMLButtonElement | null)?.click();
}

/** Reveal-list rows as `{ text, isSelf }`. */
function revealItems(el: HTMLElement) {
  return [...el.querySelectorAll(".jspsych-multiplayer-choice-reveal-item")].map((li) => ({
    text: li.textContent,
    isSelf: li.classList.contains("is-self"),
  }));
}

/** Default params so each test only overrides what it cares about. */
const base = {
  choices: ["Cooperate", "Defect"],
  prompt: null,
  button_html: null,
  data_key: "choice",
  expected_players: 2,
  waiting_message: "<p>waiting…</p>",
  timeout: null,
  on_timeout: null,
  reveal: true,
  reveal_mode: "players",
  reveal_prompt: null,
  continue_label: "Continue",
  reveal_duration: null,
  player_label: null,
  payoff: null,
  record_choices_by_player: true,
};

/** Tally-reveal rows as `{ text, isWinner, isTied, isMine }`. */
function tallyRows(el: HTMLElement) {
  return [...el.querySelectorAll(".jspsych-multiplayer-choice-tally-item")].map((li) => ({
    text: li.textContent?.replace(/\s+/g, " ").trim(),
    isWinner: li.classList.contains("is-winner"),
    isTied: li.classList.contains("is-tied"),
    isMine: li.classList.contains("is-mine"),
  }));
}

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — package surface", () => {
  it("exposes the pure core helpers as statics", () => {
    expect(typeof MultiplayerChoicePlugin.collectChoices).toBe("function");
    expect(typeof MultiplayerChoicePlugin.countChosen).toBe("function");
    expect(typeof MultiplayerChoicePlugin.tally).toBe("function");
    expect(typeof MultiplayerChoicePlugin.plurality).toBe("function");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — guards", () => {
  it("throws if the adapter is not connected (no participantId)", async () => {
    const api = new MockApi(null);
    const { jsPsych } = makeJsPsych(api);
    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), { ...base } as never)
    ).rejects.toThrow(/participantId/i);
  });

  it("throws if `choices` is empty", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), {
        ...base,
        choices: [],
      } as never)
    ).rejects.toThrow(/choices/i);
  });

  it("throws if `expected_players` is not a positive integer", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), {
        ...base,
        expected_players: 0,
      } as never)
    ).rejects.toThrow(/expected_players/i);
  });

  it("throws on an invalid `reveal_mode` rather than silently coercing it", async () => {
    // A typo'd mode would silently flip the reveal's anonymity semantics — fail loud instead.
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), {
        ...base,
        reveal_mode: "anonymous",
      } as never)
    ).rejects.toThrow(/reveal_mode/i);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — happy path", () => {
  it("collects a choice, barriers on the group, reveals all choices, and finishes on continue", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 1, label: "Defect" } }); // peer already chose
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush(); // phase 1 rendered

    expect(el.querySelectorAll(".jspsych-multiplayer-choice-option")).toHaveLength(2);
    clickOption(el, 0); // choose "Cooperate"
    await flush(); // push + barrier (fast path, p1+p2 == 2) + reveal render

    // Reveal shows both players; our own row is flagged.
    const items = revealItems(el);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.text?.includes("Cooperate"))?.isSelf).toBe(true);
    expect(items.some((i) => i.text?.includes("Defect"))).toBe(true);
    expect(finished).toHaveLength(0); // not finished until continue

    clickContinue(el);
    await done;

    expect(finished).toHaveLength(1);
    const data = finished[0];
    expect(data.choice).toBe("Cooperate");
    expect(data.choice_index).toBe(0);
    expect(typeof data.rt).toBe("number");
    expect(typeof data.wait_time).toBe("number");
    expect(data.n_players).toBe(2);
    expect(data.timed_out).toBe(false);
    expect(data.wait_error).toBeNull();
    expect(data.my_payoff).toBeNull(); // no payoff hook
    expect(data.choices_by_player).toEqual({
      p1: { index: 0, label: "Cooperate" },
      p2: { index: 1, label: "Defect" },
    });
  });

  it("holds the waiting message until the rest of the group has chosen", async () => {
    const api = new MockApi("p1");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush();
    clickOption(el, 1);
    await flush();

    // Only p1 has chosen — the barrier holds, waiting message on screen, no reveal yet.
    expect(finished).toHaveLength(0);
    expect(el.innerHTML).toContain("waiting");
    expect(el.querySelector(".jspsych-multiplayer-choice-reveal")).toBeNull();

    api.seed("p2", { choice: { index: 0, label: "Cooperate" } }); // the group is now complete
    await flush();

    expect(el.querySelector(".jspsych-multiplayer-choice-reveal")).not.toBeNull();
    clickContinue(el);
    await done;
    expect(finished[0].n_players).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — reveal:false, timeout, payoff, and robustness", () => {
  it("with reveal:false, finishes as soon as the group has chosen", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      reveal: false,
    } as never);
    await flush();
    clickOption(el, 1);
    await done;

    expect(finished).toHaveLength(1);
    expect(el.querySelector(".jspsych-multiplayer-choice-reveal")).toBeNull();
    expect(finished[0].choice).toBe("Defect");
    expect(finished[0].n_players).toBe(2);
  });

  it("times out waiting for the group: proceeds partial, flags timed_out, calls on_timeout", async () => {
    const api = new MockApi("p1");
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 3, // never reached
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
    expect(finished[0].n_players).toBe(1); // only p1 chose
  });

  it("computes and displays my_payoff via the payoff hook", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 1, label: "Defect" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    // Classic PD payoff: I cooperate (0) vs a defector → sucker's payoff 0; if I defected → 3, etc.
    const payoff = (choices: Record<string, { index: number }>, me: string) => {
      const mine = choices[me].index;
      const other = Object.entries(choices).find(([id]) => id !== me)?.[1].index ?? 0;
      const table = [
        [3, 0],
        [5, 1],
      ]; // [myChoice][otherChoice]
      return table[mine][other];
    };

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      payoff,
    } as never);
    await flush();
    clickOption(el, 0); // cooperate vs defector → 0
    await flush();

    expect(el.querySelector(".jspsych-multiplayer-choice-reveal-payoff")?.textContent).toContain(
      "0"
    );
    clickContinue(el);
    await done;
    expect(finished[0].my_payoff).toBe(0);
  });

  it("a throwing payoff hook records my_payoff null and still finishes", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      payoff: () => {
        throw new Error("bad payoff fn");
      },
    } as never);
    await flush();
    clickOption(el, 0);
    await flush();
    clickContinue(el);
    await done;

    expect(errSpy).toHaveBeenCalled();
    expect(finished[0].my_payoff).toBeNull();
    errSpy.mockRestore();
  });

  it("propagates a push failure instead of masking it as a timeout", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    jest.spyOn(api, "push").mockRejectedValue(new Error("connection lost"));
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
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
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    // A wait() rejection that is NOT a MultiplayerTimeoutError (e.g. a throwing condition/backend fault).
    jest.spyOn(api, "wait").mockRejectedValue(new Error("condition threw"));
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
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
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush();
    clickOption(el, 1);
    await flush();

    const mine = api.get("p1") as any;
    expect(mine.role).toBe("proposer"); // survived the choice push
    expect(mine.choice).toEqual({ index: 1, label: "Defect" });
    clickContinue(el);
    await done;
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — rendering", () => {
  it("uses button_html to render custom option markup", async () => {
    const api = new MockApi("p1");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      button_html: (choice: string) => `<button class="jspsych-btn custom-btn">${choice}</button>`,
    } as never);
    await flush();

    expect(el.querySelector("button.custom-btn")).not.toBeNull();
  });

  it("is selectable even when button_html renders no <button> (listener on the container)", async () => {
    // A tile/image `button_html` with no literal <button> must still be clickable — otherwise the
    // trial would hang with no way to choose. The listener is on the option container, not a button.
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      button_html: (choice: string) => `<div class="tile">${choice}</div>`, // no <button>
    } as never);
    await flush();

    expect(el.querySelector("button")).toBeNull(); // confirm the custom markup has no button
    // Click the container of the second option ("Defect") directly.
    const options = el.querySelectorAll<HTMLElement>(".jspsych-multiplayer-choice-option");
    options[1].click();
    await flush();

    // The choice registered and the barrier resolved to the reveal.
    expect(el.querySelector(".jspsych-multiplayer-choice-reveal")).not.toBeNull();
    clickContinue(el);
    await done;
    expect(finished[0].choice).toBe("Defect");
    expect(finished[0].choice_index).toBe(1);
  });

  it("escapes peer-pushed labels in the reveal rather than parsing them as HTML", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "<img src=x onerror=alert(1)>" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush();
    clickOption(el, 0);
    await flush();

    expect(el.querySelector("img")).toBeNull(); // not parsed as markup
    expect(el.innerHTML).toContain("&lt;img");
    clickContinue(el);
    await done;
  });

  it("maps ids to names via player_label, falling back on a throw", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 1, label: "Defect" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      player_label: (id: string) => (id === "p1" ? "You" : "Rival"),
    } as never);
    await flush();
    clickOption(el, 0);
    await flush();

    expect(el.textContent).toContain("You");
    expect(el.textContent).toContain("Rival");
    clickContinue(el);
    await done;
    errSpy.mockRestore();
  });

  it("auto-advances the reveal after reveal_duration when there is no continue button", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      continue_label: null,
      reveal_duration: 30,
    } as never);
    await flush();
    clickOption(el, 1);
    await done; // resolves via the reveal_duration timer, no continue click

    expect(finished).toHaveLength(1);
    expect(finished[0].choice).toBe("Defect");
  });

  it("warns when reveal is on but neither continue_label nor reveal_duration is set", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
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
describe("plugin-multiplayer-choice — tally mode (anonymous poll)", () => {
  const pollBase = {
    ...base,
    choices: ["Red", "Green", "Blue"],
    expected_players: 3,
    reveal_mode: "tally",
  };

  it("reveals the aggregate tally + winner (never the roster) and records the aggregate data", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 2, label: "Blue" } }); // peers already chose
    api.seed("p3", { choice: { index: 2, label: "Blue" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, { ...pollBase } as never);
    await flush();
    clickOption(el, 0); // pick "Red"
    await flush(); // push + barrier (fast path, 3 == 3) + reveal render

    // Tally reveal: one row per option, Blue winning with 2, my own row flagged — and NO roster.
    const rows = tallyRows(el);
    expect(rows).toHaveLength(3);
    expect(rows[2].isWinner).toBe(true); // Blue
    expect(rows[0].isMine).toBe(true); // Red = my pick
    expect(el.textContent).toContain("Winner");
    expect(el.querySelector(".jspsych-multiplayer-choice-reveal-item")).toBeNull(); // no attributed list
    expect(
      el.querySelector(".jspsych-multiplayer-choice-reveal")?.classList.contains("is-tally")
    ).toBe(true);

    clickContinue(el);
    await done;

    const data = finished[0];
    expect(data.choice).toBe("Red");
    expect(data.n_players).toBe(3);
    expect(data.is_tie).toBe(false);
    expect(data.winner).toEqual({ index: 2, label: "Blue", count: 2 });
    expect(data.tally).toEqual([
      { index: 0, label: "Red", count: 1 },
      { index: 1, label: "Green", count: 0 },
      { index: 2, label: "Blue", count: 2 },
    ]);
    // The attributed map is still recorded by default (output anonymity is opt-in).
    expect(data.choices_by_player).toEqual({
      p1: { index: 0, label: "Red" },
      p2: { index: 2, label: "Blue" },
      p3: { index: 2, label: "Blue" },
    });
  });

  it("with record_choices_by_player:false, no peer id reaches the reveal DOM or the recorded data", async () => {
    const api = new MockApi("alice");
    api.seed("bob", { choice: { index: 0, label: "Red" } });
    api.seed("carol", { choice: { index: 1, label: "Green" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...pollBase,
      record_choices_by_player: false,
    } as never);
    await flush();
    clickOption(el, 0);
    await flush();

    expect(el.innerHTML).not.toContain("bob");
    expect(el.innerHTML).not.toContain("carol");
    clickContinue(el);
    await done;
    expect(finished[0].choices_by_player).toBeNull();
    expect(JSON.stringify(finished[0])).not.toContain("bob");
    expect(JSON.stringify(finished[0])).not.toContain("carol");
  });

  it("reports a tie in the data and reveal when the top options are level", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 1, label: "Green" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...pollBase,
      expected_players: 2,
    } as never);
    await flush();
    clickOption(el, 0); // Red — now Red 1, Green 1 → tie
    await flush();

    expect(el.textContent).toContain("Tie");
    expect(tallyRows(el).filter((r) => r.isTied)).toHaveLength(2);
    clickContinue(el);
    await done;

    expect(finished[0].is_tie).toBe(true);
    expect(finished[0].winner).toBeNull();
    expect(finished[0].tied_options).toEqual([
      { index: 0, label: "Red", count: 1 },
      { index: 1, label: "Green", count: 1 },
    ]);
  });

  it("does not let a stale, out-of-range choice lift the barrier or inflate n_players", async () => {
    // p3's slot holds a leftover pick for index 5 — e.g. a previous choice trial with more options
    // reused the default data_key. It is not a valid pick for THIS 3-option trial, so it must count
    // toward neither the barrier nor the tally (the barrier count and n_players stay in agreement).
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "Red" } });
    api.seed("p3", { choice: { index: 5, label: "stale" } }); // out of range for choices.length === 3
    const on_timeout = jest.fn();
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...pollBase,
      timeout: 40,
      on_timeout,
      reveal: false,
    } as never);
    await flush();
    clickOption(el, 0); // p1 picks Red — only p1 and p2 are valid → 2 < expected 3, barrier holds
    await done; // resolves only when the 40ms barrier timeout fires (the group is never completed)

    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished[0].timed_out).toBe(true);
    expect(finished[0].n_players).toBe(2); // p1 + p2 only; the out-of-range pick is excluded
    expect(finished[0].tally).toEqual([
      { index: 0, label: "Red", count: 2 },
      { index: 1, label: "Green", count: 0 },
      { index: 2, label: "Blue", count: 0 },
    ]);
  });

  it("shows the payoff line on the tally reveal too", async () => {
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 0, label: "Red" } });
    api.seed("p3", { choice: { index: 0, label: "Red" } });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...pollBase,
      payoff: () => 7,
    } as never);
    await flush();
    clickOption(el, 1);
    await flush();

    expect(el.querySelector(".jspsych-multiplayer-choice-reveal-payoff")?.textContent).toContain(
      "7"
    );
    clickContinue(el);
    await done;
    expect(finished[0].my_payoff).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type and the decision", async () => {
    const jsPsych = initJsPsych();
    const api = new MockApi("p1");
    api.seed("p2", { choice: { index: 1, label: "Defect" } });
    // A released jsPsych has no `multiplayer` module (jsPsych#3694 is unmerged), so create it here.
    const core = jsPsych as unknown as { multiplayer: Record<string, unknown> };
    core.multiplayer = {
      participantId: api.participantId,
      get: api.get.bind(api),
      push: api.push.bind(api),
      getAll: api.getAll.bind(api),
      wait: api.wait.bind(api),
    };

    const { displayElement, expectFinished, getData } = await startTimeline(
      [{ type: MultiplayerChoicePlugin, choices: ["Cooperate", "Defect"], expected_players: 2 }],
      jsPsych
    );

    await flush();
    clickOption(displayElement, 0); // choose Cooperate
    await flush();
    clickContinue(displayElement);
    await expectFinished();

    const data = getData().values()[0];
    expect(data.trial_type).toBe("multiplayer-choice");
    expect(data.choice).toBe("Cooperate");
    expect(data.n_players).toBe(2);
  });
});
