import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions, GroupSessionData, PresenceData } from "jspsych";

import { MemoryHub, scopeData } from "../../../test-utils/memory-backend";
import MultiplayerChoicePlugin from ".";

/**
 * A jsPsych stand-in whose `multiplayer` is a real session on an in-memory hub, so the plugin runs
 * against the actual core (frozen snapshots, presence, errors) while `finishTrial` is captured.
 * `api.seed(id, data)` writes a participant's data, as if they had written it; another participant
 * is added as a connected peer. No trial is running in the core, so the plugin's reads and writes
 * use the session scope here; the startTimeline tests cover the trial scope.
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
      id === participantId
        ? void multiplayer.update(data)
        : hub.peers.has(id)
          ? hub.seed(id, data)
          : hub.addPeer(id, data),
    get: (id: string) => multiplayer.get(id),
  };
  return { hub, me, multiplayer, jsPsych, finished, api };
}

const display = () => document.createElement("div");
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Click the i-th option button on the choice screen. */
function clickOption(el: HTMLElement, i: number) {
  const buttons = el.querySelectorAll<HTMLButtonElement>(
    ".jspsych-multiplayer-choice-option button",
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
    const jsPsych = { multiplayer: { participantId: null } };
    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), { ...base } as never),
    ).rejects.toThrow(/participantId/i);
  });

  it("throws if `choices` is empty", async () => {
    const { api, jsPsych } = await setup("p1");

    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), {
        ...base,
        choices: [],
      } as never),
    ).rejects.toThrow(/choices/i);
  });

  it("throws if `expected_players` is not a positive integer", async () => {
    const { api, jsPsych } = await setup("p1");

    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), {
        ...base,
        expected_players: 0,
      } as never),
    ).rejects.toThrow(/expected_players/i);
  });

  it("without a sealed group, a missing `expected_players` says how to fix it", async () => {
    const { jsPsych } = await setup("p1");
    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), {
        ...base,
        expected_players: null,
      } as never),
    ).rejects.toThrow(/sealed/);
  });

  it("in a sealed group, `expected_players` defaults to the roster", async () => {
    const { hub, jsPsych, finished } = await setup("p1");
    hub.seal(["p1", "p2"]);
    const el = display();
    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: null,
      reveal: false,
    } as never);
    clickOption(el, 0);
    await flush();
    expect(finished).toHaveLength(0);

    const p2 = await hub.join("p2");
    await p2.jsPsych.multiplayer.update({ choice: { choice: "Defect", index: 1 } });
    await done;
    expect(finished).toHaveLength(1);
  });

  it("throws on an invalid `reveal_mode` rather than silently coercing it", async () => {
    // A typo'd mode would silently flip the reveal's anonymity semantics — fail loud instead.
    const { api, jsPsych } = await setup("p1");

    await expect(
      new MultiplayerChoicePlugin(jsPsych as never).trial(display(), {
        ...base,
        reveal_mode: "anonymous",
      } as never),
    ).rejects.toThrow(/reveal_mode/i);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — happy path", () => {
  it("collects a choice, barriers on the group, reveals all choices, and finishes on continue", async () => {
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 1, label: "Defect" } }); // peer already chose

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
    expect(data.multiplayer_outcome).toBe("completed");
    expect(data.left_participant).toBeNull();
    expect(data.my_payoff).toBeNull(); // no payoff hook
    expect(data.choices_by_player).toEqual({
      p1: { index: 0, label: "Cooperate" },
      p2: { index: 1, label: "Defect" },
    });
  });

  it("holds the waiting message until the rest of the group has chosen", async () => {
    const { api, jsPsych, finished } = await setup("p1");

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
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });

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

  it("times out waiting for the group: proceeds partial, records the timeout, calls on_timeout", async () => {
    const { jsPsych, finished } = await setup("p1");
    const on_timeout = jest.fn();
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
    expect(finished[0].multiplayer_outcome).toBe("timeout");
    expect(finished[0].n_players).toBe(1); // only p1 chose
  });

  it("computes and displays my_payoff via the payoff hook", async () => {
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 1, label: "Defect" } });

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
      "0",
    );
    clickContinue(el);
    await done;
    expect(finished[0].my_payoff).toBe(0);
  });

  it("a throwing payoff hook records my_payoff null and still finishes", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });

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

  it("doesn't hold the barrier or its timeout for a write the backend hasn't confirmed", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { jsPsych, finished, me } = await setup("p1");
    me.connection.pushImpl = async () => {
      throw new Error("write rejected");
    };
    const on_timeout = jest.fn();
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      timeout: 40,
      on_timeout,
      reveal: false,
    } as never);
    await flush();
    clickOption(el, 0);
    await done;

    // The core keeps retrying the write; the trial still ends when its timeout elapses
    expect(on_timeout).toHaveBeenCalledTimes(1);
    expect(finished[0]).toMatchObject({ multiplayer_outcome: "timeout", n_players: 1 });
    await me.jsPsych.multiplayer.disconnect();
    warn.mockRestore();
  });

  it("treats a timeout of 0 as no limit", async () => {
    const { api, jsPsych, finished } = await setup("p1");
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      timeout: 0,
      reveal: false,
    } as never);
    await flush();
    clickOption(el, 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(finished).toHaveLength(0);
    api.seed("p2", { choice: { index: 1, label: "Defect" } });
    await done;
    expect(finished[0].multiplayer_outcome).toBe("completed");
  });

  it("stops quietly when the wait is cancelled (experiment ending), without timing out", async () => {
    // jsPsych cancels pending waits when the trial or experiment ends. That is a teardown, not a
    // barrier expiry: the trial must not record a timeout, run on_timeout, render a reveal, finish,
    // or log — it just stops.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { jsPsych, finished, multiplayer } = await setup("p1");
    const on_timeout = jest.fn();
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...base,
      expected_players: 3, // never reached, so the barrier is still pending when the cancel lands
      timeout: 10000,
      on_timeout,
    } as never);
    await flush();
    clickOption(el, 0);
    await flush(); // the write has landed and the wait is pending

    await multiplayer.disconnect();
    await expect(done).resolves.toBeUndefined(); // returns, rather than rejecting

    expect(on_timeout).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
    expect(el.querySelector(".jspsych-multiplayer-choice-reveal")).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("propagates a non-timeout wait() rejection instead of masking it as a timeout", async () => {
    const { api, jsPsych, finished, multiplayer } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });
    // A wait() rejection that is NOT one of the named outcomes (e.g. a backend fault).
    jest.spyOn(multiplayer, "wait").mockRejectedValue(new Error("condition threw"));
    const on_timeout = jest.fn();
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

  it("preserves other keys already in this client's data (update MERGES the choice in)", async () => {
    const { api, jsPsych } = await setup("p1");
    api.seed("p1", { role: "proposer" }); // written earlier
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });

    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, { ...base } as never);
    await flush();
    clickOption(el, 1);
    await flush();

    const mine = api.get("p1") as any;
    expect(mine.role).toBe("proposer"); // survived the choice write
    expect(mine.choice).toEqual({ index: 1, label: "Defect" });
    clickContinue(el);
    await done;
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — rendering", () => {
  it("uses button_html to render custom option markup", async () => {
    const { api, jsPsych } = await setup("p1");

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
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });

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
    const { api, jsPsych } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "<img src=x onerror=alert(1)>" } });

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
    const { api, jsPsych } = await setup("p1");
    api.seed("p2", { choice: { index: 1, label: "Defect" } });

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
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });

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
    const { api, jsPsych } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "Cooperate" } });

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
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 2, label: "Blue" } }); // peers already chose
    api.seed("p3", { choice: { index: 2, label: "Blue" } });

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
      el.querySelector(".jspsych-multiplayer-choice-reveal")?.classList.contains("is-tally"),
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
    const { api, jsPsych, finished } = await setup("alice");
    api.seed("bob", { choice: { index: 0, label: "Red" } });
    api.seed("carol", { choice: { index: 1, label: "Green" } });

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
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 1, label: "Green" } });

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

  it("does not let an out-of-range choice lift the barrier or inflate n_players", async () => {
    // p3's data holds a pick for index 5 — e.g. written by a peer running a different version of
    // the trial. It is not a valid pick for THIS 3-option trial, so it must count toward neither
    // the barrier nor the tally (the barrier count and n_players stay in agreement).
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "Red" } });
    api.seed("p3", { choice: { index: 5, label: "stale" } }); // out of range for choices.length === 3
    const on_timeout = jest.fn();
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
    expect(finished[0].multiplayer_outcome).toBe("timeout");
    expect(finished[0].n_players).toBe(2); // p1 + p2 only; the out-of-range pick is excluded
    expect(finished[0].tally).toEqual([
      { index: 0, label: "Red", count: 2 },
      { index: 1, label: "Green", count: 0 },
      { index: 2, label: "Blue", count: 0 },
    ]);
  });

  it("shows the payoff line on the tally reveal too", async () => {
    const { api, jsPsych, finished } = await setup("p1");
    api.seed("p2", { choice: { index: 0, label: "Red" } });
    api.seed("p3", { choice: { index: 0, label: "Red" } });

    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...pollBase,
      payoff: () => 7,
    } as never);
    await flush();
    clickOption(el, 1);
    await flush();

    expect(el.querySelector(".jspsych-multiplayer-choice-reveal-payoff")?.textContent).toContain(
      "7",
    );
    clickContinue(el);
    await done;
    expect(finished[0].my_payoff).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — real jsPsych pipeline (startTimeline smoke test)", () => {
  it("runs through jsPsych's parameter pipeline, records trial_type and the decision", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    // p2 writes its choice to the trial's scope, which this trial names with multiplayer_scope
    hub.addPeer("p2");
    hub.seed("p2", { choice: { index: 1, label: "Defect" } }, { scope: "round" });

    const { displayElement, expectFinished, getData } = await startTimeline(
      [
        {
          type: MultiplayerChoicePlugin,
          choices: ["Cooperate", "Defect"],
          expected_players: 2,
          multiplayer_scope: "round",
        },
      ],
      jsPsych,
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
    expect(data.multiplayer_outcome).toBe("completed");
    for (const removed of [
      "data_key",
      "timed_out",
      "partner_left",
      "connection_lost",
      "wait_error",
    ]) {
      expect(data).not.toHaveProperty(removed);
    }
    // The choice went to the trial's own shared data, not the session's
    expect(scopeData(hub.data.p1, "round")).toEqual({ choice: { index: 0, label: "Cooperate" } });
    expect(scopeData(hub.data.p1)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("plugin-multiplayer-choice — trial scope and departures", () => {
  const gateBase = { ...base, reveal: false };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a later choice trial ignores choices made in an earlier one", async () => {
    const hub = new MemoryHub();
    const elements = [document.createElement("div"), document.createElement("div")];
    elements.forEach((el) => document.body.appendChild(el));
    const a = await hub.join("p1", { jsPsych: { display_element: elements[0] } });
    const b = await hub.join("p2", { jsPsych: { display_element: elements[1] } });
    const round = {
      type: MultiplayerChoicePlugin,
      choices: ["Cooperate", "Defect"],
      expected_players: 2,
      reveal: false,
    };

    const runA = await startTimeline([round, { ...round, timeout: 40 }], a.jsPsych);
    const runB = await startTimeline([round], b.jsPsych);

    // Round 1: both choose
    clickOption(elements[0], 0);
    clickOption(elements[1], 1);
    await sleep(10);
    await runB.expectFinished();

    // Round 2: only p1 chooses; p2's round-1 choice must not count
    clickOption(elements[0], 1);
    await sleep(80);
    await runA.expectFinished();
    const [first, second] = runA.getData().values();
    expect(first).toMatchObject({ multiplayer_outcome: "completed", n_players: 2 });
    expect(second).toMatchObject({ multiplayer_outcome: "timeout", n_players: 1 });
    elements.forEach((el) => el.remove());
  });

  it("proceeds partial with participant_left when a participant leaves", async () => {
    const { hub, jsPsych, finished } = await setup("p1", { dropoutTimeout: 10 });
    const peer = await hub.join("p2");
    const on_timeout = jest.fn();
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...gateBase,
      on_timeout,
    } as never);
    await flush();
    clickOption(el, 0);
    await sleep(0);
    await peer.jsPsych.multiplayer.disconnect();
    await done;

    expect(finished[0]).toMatchObject({
      multiplayer_outcome: "participant_left",
      left_participant: "p2",
      n_players: 1,
    });
    expect(on_timeout).not.toHaveBeenCalled();
  });

  it("does not count a participant who left toward the barrier", async () => {
    const { hub, jsPsych, finished } = await setup("p1", { dropoutTimeout: 1 });
    const peer = await hub.join("p2");
    await peer.jsPsych.multiplayer.update({ choice: { index: 0, label: "Cooperate" } });
    await peer.jsPsych.multiplayer.disconnect();
    await sleep(5);

    const el = display();
    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, {
      ...gateBase,
      timeout: 40,
    } as never);
    await flush();
    clickOption(el, 1);
    await done;
    // p2 left, so their choice counts toward neither the barrier nor the data
    expect(finished[0].multiplayer_outcome).toBe("timeout");
    expect(finished[0].n_players).toBe(1);
  });

  it("proceeds partial with connection_lost when this participant's connection closes", async () => {
    const { me, jsPsych, finished } = await setup("p1");
    const el = display();

    const done = new MultiplayerChoicePlugin(jsPsych as never).trial(el, { ...gateBase } as never);
    await flush();
    clickOption(el, 0);
    await sleep(0);
    me.connection.options.onStatus("closed");
    await done;

    expect(finished[0]).toMatchObject({ multiplayer_outcome: "connection_lost" });
    // Reads keep working after the connection is lost
    expect(finished[0].choices_by_player).toEqual({ p1: { index: 0, label: "Cooperate" } });
  });
});
