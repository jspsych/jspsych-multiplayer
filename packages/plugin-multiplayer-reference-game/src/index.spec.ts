import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import MultiplayerReferenceGamePlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the plugin codes against — same
// semantics as the chat plugin's mock: `push` REPLACES the participant's slot then notifies;
// `subscribe` replays the snapshot on registration; `pushAs(id, data)` simulates a peer.
// ---------------------------------------------------------------------------------------------------
class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  failNextPush = false;
  private subs = new Set<(g: GroupSessionData) => void>();

  constructor(public participantId: string) {}

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
    this.session[this.participantId] = data; // REPLACE, like the real adapter
    this.fire();
  }
  subscribe(cb: (g: GroupSessionData) => void): Unsubscribe {
    this.subs.add(cb);
    cb(this.getAll()); // replay-on-registration, like core
    return () => this.subs.delete(cb);
  }
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
    multiplayer: api,
    finishTrial: (data: Record<string, any>) => finished.push(data),
  };
  return { jsPsych, finished };
}

const display = () => document.createElement("div");
const flush = () => new Promise((r) => setTimeout(r, 0));

const STIMULI4 = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

/** Full default params so each test overrides only what it cares about (no jsPsych pipeline here). */
const base = {
  stimuli: STIMULI4,
  targets: ["b"],
  columns: 6,
  rows: null,
  cell_size: null,
  scramble_mode: "independent",
  seed: null,
  show_labels: false,
  ordered: null,
  scoring: "per_slot",
  role: "matcher",
  role_labels: { director: "Director", matcher: "Matcher" },
  director_can_select: false,
  reveal_target_to: "director",
  chat_enabled: true,
  chat_role: "both",
  max_messages: null,
  max_length: null,
  placeholder: "Type…",
  chat_persists: false,
  chat_position: "below",
  response_mode: null,
  auto_submit: null,
  submit_label: "Submit",
  allow_change: true,
  selection_timeout: null,
  feedback: false,
  feedback_content: { reveal_target: true, show_score: true, show_partner_choice: true },
  feedback_to: "both",
  feedback_duration: 3000,
  show_running_score: false,
  prompt: "",
  round: 0,
  data_key: "reference_game",
  partner_id: null,
  save_orders: true,
  save_transcript: true,
  save_group: false,
  save_interaction_history: false,
  round_timeout: null,
};

const P = "jspsych-multiplayer-reference-game";
const cell = (el: HTMLElement, id: string) =>
  el.querySelector(`.${P}-cell[data-object-id="${id}"]`) as HTMLElement;
const clickCell = (el: HTMLElement, id: string) =>
  cell(el, id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const clickSlot = (el: HTMLElement, n: number) =>
  (el.querySelector(`.${P}-slot[data-slot="${n}"]`) as HTMLButtonElement).dispatchEvent(
    new MouseEvent("click", { bubbles: true })
  );
const submitBtn = (el: HTMLElement) => el.querySelector(`.${P}-submit`) as HTMLButtonElement;
const feedbackText = (el: HTMLElement) =>
  (el.querySelector(`.${P}-feedback`) as HTMLElement).textContent ?? "";
const run = (jsPsych: any, el: HTMLElement, params: Record<string, unknown>) =>
  new MultiplayerReferenceGamePlugin(jsPsych).trial(el, params as never);

describe("multiplayer-reference-game: single-target (sequential) click task", () => {
  it("trial() is synchronous (returns undefined) so jsPsych waits for finishTrial", () => {
    const { jsPsych } = makeJsPsych(new MockApi("matcher"));
    expect(run(jsPsych, display(), { ...base })).toBeUndefined();
  });

  it("the matcher clicking the target records a correct submission and ends", () => {
    const api = new MockApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    clickCell(el, "b"); // auto-submits (k=1)

    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      role: "matcher",
      assignment: "b",
      n_correct: 1,
      n_targets: 1,
      accuracy: 1,
      correct: true,
      ended_by: "submit",
    });
    expect(finished[0].rt).toEqual(expect.any(Number));
  });

  it("clicking a distractor records an incorrect submission", () => {
    const api = new MockApi("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    clickCell(el, "a");

    expect(finished[0]).toMatchObject({ correct: false, n_correct: 0, assignment: "a" });
  });

  it("only the director sees the target highlighted before feedback", () => {
    const dirApi = new MockApi("director");
    const dirEl = display();
    run(makeJsPsych(dirApi).jsPsych, dirEl, { ...base, role: "director", partner_id: "matcher" });
    expect(cell(dirEl, "b").classList.contains("is-target")).toBe(true);

    const matApi = new MockApi("matcher");
    const matEl = display();
    run(makeJsPsych(matApi).jsPsych, matEl, { ...base, role: "matcher", partner_id: "director" });
    expect(cell(matEl, "b").classList.contains("is-target")).toBe(false);
  });

  it("the director reaches feedback when the matcher's submission arrives", () => {
    const api = new MockApi("director");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      role: "director",
      partner_id: "matcher",
      feedback: true,
      feedback_duration: null, // Continue button, so it stays up for inspection
    });
    api.pushAs("matcher", {
      reference_game: { 0: { assignment: { 1: "b" }, rt: 300, n_correct: 1, n_targets: 1 } },
    });

    expect(feedbackText(el)).toMatch(/correct/i);
    expect(cell(el, "b").classList.contains("is-correct")).toBe(true);
  });

  it("preserves unrelated keys in the matcher's own slot when submitting", () => {
    const api = new MockApi("matcher");
    api.pushAs("matcher", { joinedAt: 42 }); // pre-existing data
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    clickCell(el, "b");

    expect(api.getAll().matcher.joinedAt).toBe(42);
    expect((api.getAll().matcher.reference_game as any)["0"].assignment).toEqual({ 1: "b" });
  });

  it("tears down the subscription on finish (no leak)", () => {
    const api = new MockApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    clickCell(el, "b");

    expect(api.subCount()).toBe(0);
  });
});

describe("multiplayer-reference-game: multi-target (full-board) assign task", () => {
  const stim = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("shows numbered slots, enables Submit only when complete, and scores an ordered match", () => {
    const api = new MockApi("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      stimuli: stim,
      targets: ["c", "a", "b"],
      partner_id: "director",
    });

    // Three slots exist; Submit starts disabled.
    expect(el.querySelectorAll(`.${P}-slot`)).toHaveLength(3);
    expect(submitBtn(el).disabled).toBe(true);

    clickCell(el, "c"); // slot 1 (active), auto-advances
    clickCell(el, "a"); // slot 2
    expect(submitBtn(el).disabled).toBe(true); // still one empty slot
    clickCell(el, "b"); // slot 3
    expect(submitBtn(el).disabled).toBe(false);

    submitBtn(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(finished[0]).toMatchObject({
      assignment: { 1: "c", 2: "a", 3: "b" },
      n_correct: 3,
      n_targets: 3,
      correct: true,
    });
  });

  it("scores a partial ordered match", () => {
    const api = new MockApi("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, stimuli: stim, targets: ["c", "a", "b"], partner_id: "director" });
    clickSlot(el, 1);
    clickCell(el, "c"); // slot 1 correct
    clickSlot(el, 2);
    clickCell(el, "b"); // slot 2 should be "a" — wrong
    clickSlot(el, 3);
    clickCell(el, "a"); // slot 3 should be "b" — wrong
    submitBtn(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(finished[0]).toMatchObject({ n_correct: 1, correct: false });
  });

  it("unordered scoring counts set membership regardless of slot order", () => {
    const api = new MockApi("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      stimuli: STIMULI4,
      targets: ["a", "b"],
      ordered: false,
      partner_id: "director",
    });
    clickCell(el, "b"); // slot 1
    clickCell(el, "a"); // slot 2
    submitBtn(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(finished[0]).toMatchObject({ n_correct: 2, correct: true });
  });

  it("records the pre-submit interaction history when enabled", () => {
    const api = new MockApi("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      stimuli: stim,
      targets: ["c", "a", "b"],
      partner_id: "director",
      save_interaction_history: true,
    });
    clickCell(el, "c");
    clickCell(el, "a");
    clickCell(el, "b");
    submitBtn(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const hist = finished[0].interaction_history as any[];
    expect(hist.length).toBeGreaterThanOrEqual(3);
    expect(hist[0]).toMatchObject({ action: "assign", slot: 1, object_id: "c" });
    expect(hist[0].t).toEqual(expect.any(Number));
  });
});

describe("multiplayer-reference-game: chat, timeout, and the real pipeline", () => {
  it("renders and merges the partner's chat messages", () => {
    const api = new MockApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    api.pushAs("director", {
      reference_game_chat_r0: [{ senderId: "director", seq: 0, text: "the star shape", ts: 5 }],
    });

    const rows = [...el.querySelectorAll(`.${P}-chat-message`)].map((r) => [
      (r.querySelector(`.${P}-chat-sender`) as HTMLElement).textContent,
      (r.querySelector(`.${P}-chat-text`) as HTMLElement).textContent,
    ]);
    expect(rows).toEqual([["Director", "the star shape"]]);
  });

  it("escapes chat text (never parses it as HTML)", async () => {
    const api = new MockApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    const input = el.querySelector(`.${P}-chat-input`) as HTMLInputElement;
    input.value = "<img src=x onerror=alert(1)>";
    (el.querySelector(`.${P}-chat-form`) as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true })
    );
    await flush();

    expect(el.querySelector(`.${P}-chat-log img`)).toBeNull();
  });

  it("submits the current (partial) assignment on selection_timeout", () => {
    jest.useFakeTimers();
    try {
      const api = new MockApi("matcher");
      const { jsPsych, finished } = makeJsPsych(api);
      const el = display();

      run(jsPsych, el, { ...base, partner_id: "director", selection_timeout: 40 });
      expect(finished).toHaveLength(0);
      jest.advanceTimersByTime(40);

      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ ended_by: "timeout", assignment: null, correct: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it("throws a clear error when role is not director/matcher", () => {
    const { jsPsych } = makeJsPsych(new MockApi("x"));
    expect(() => run(jsPsych, display(), { ...base, role: "spectator" })).toThrow(/role/i);
  });

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    const api = new MockApi("me");
    const jsPsych = initJsPsych();
    // A released jsPsych has no `multiplayer` module (jsPsych#3694 is unmerged), so create it here.
    const core = jsPsych as unknown as { multiplayer: Record<string, unknown> };
    core.multiplayer = {};
    Object.assign(core.multiplayer, {
      participantId: api.participantId,
      get: api.get.bind(api),
      push: api.push.bind(api),
      getAll: api.getAll.bind(api),
      subscribe: api.subscribe.bind(api),
    });

    const { displayElement, expectFinished, getData } = await startTimeline(
      [
        {
          type: MultiplayerReferenceGamePlugin,
          stimuli: STIMULI4,
          targets: ["c"],
          role: "matcher",
          round: 0,
          feedback: false,
        },
      ],
      jsPsych
    );

    clickCell(displayElement, "c");
    await expectFinished();

    const data = getData().values()[0];
    expect(data).toMatchObject({ role: "matcher", assignment: "c", correct: true, n_targets: 1 });
  });
});

describe("multiplayer-reference-game: review-fix regressions", () => {
  it("fails loudly when this round already holds a submitted assignment (stale-replay guard)", () => {
    // A reused round index (or the old default of 0 across trials) leaves the previous submission in
    // data_key[round]; running again must throw rather than silently replay it into feedback.
    const api = new MockApi("matcher");
    api.pushAs("matcher", {
      reference_game: { 0: { assignment: { 1: "b" }, rt: 100, n_correct: 1, n_targets: 1 } },
    });
    const { jsPsych } = makeJsPsych(api);
    expect(() => run(jsPsych, display(), { ...base, partner_id: "director" })).toThrow(
      /round 0 already/i
    );
  });

  it("throws when `round` is missing (round is required)", () => {
    const { round, ...noRound } = base;
    const { jsPsych } = makeJsPsych(new MockApi("matcher"));
    expect(() => run(jsPsych, display(), { ...noRound, partner_id: "director" })).toThrow(/round/i);
  });

  it("warns when there is no bounded end path (no round_timeout or selection_timeout)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      run(makeJsPsych(new MockApi("director")).jsPsych, display(), {
        ...base,
        role: "director",
        partner_id: "matcher",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/round_timeout/));
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT warn about the end path once round_timeout is set", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      run(makeJsPsych(new MockApi("director")).jsPsych, display(), {
        ...base,
        role: "director",
        partner_id: "matcher",
        round_timeout: 5000,
      });
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/no .round_timeout/));
    } finally {
      warn.mockRestore();
    }
  });

  it("throws instead of guessing when partner auto-detect is ambiguous (>1 other participant)", () => {
    const api = new MockApi("director");
    api.pushAs("matcherA", { joinedAt: 1 });
    api.pushAs("matcherB", { joinedAt: 2 });
    const { jsPsych } = makeJsPsych(api);
    // base.partner_id is null → auto-detect, which must fail clearly rather than pick one.
    expect(() => run(jsPsych, display(), { ...base, role: "director" })).toThrow(/partner_id/i);
  });

  it("auto-detects the partner when exactly one other participant is present", () => {
    const api = new MockApi("director");
    api.pushAs("matcher", { joinedAt: 1 });
    const { jsPsych } = makeJsPsych(api);
    // Exactly one other participant → no throw; the single peer is taken as the partner.
    expect(() => run(jsPsych, display(), { ...base, role: "director" })).not.toThrow();
  });

  it("preserves ended_by 'submit' when a Continue button only advances feedback", () => {
    const api = new MockApi("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      partner_id: "director",
      feedback: true,
      feedback_duration: null, // Continue button
    });
    clickCell(el, "b"); // submit
    (el.querySelector(`.${P}-continue`) as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    );
    expect(finished[0].ended_by).toBe("submit");
  });

  it("shows both the correct target order and the matcher's slot at feedback without clobbering", () => {
    const api = new MockApi("director");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    const stim = [{ id: "a" }, { id: "b" }, { id: "c" }];
    run(jsPsych, el, {
      ...base,
      stimuli: stim,
      targets: ["c", "a", "b"], // "c" belongs in order-slot 1
      role: "director",
      partner_id: "matcher",
      feedback: true,
      feedback_duration: null,
    });
    // Matcher mis-placed "c" into slot 2.
    api.pushAs("matcher", {
      reference_game: { 0: { assignment: { 2: "c" }, rt: 100, n_correct: 0, n_targets: 3 } },
    });
    const c = cell(el, "c");
    const badge = c.querySelector(`.${P}-badge`) as HTMLElement;
    const mark = c.querySelector(`.${P}-mark`) as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("1"); // correct target order still shown
    expect(mark.hidden).toBe(false);
    expect(mark.textContent).toBe("2"); // matcher's (wrong) slot also shown
    expect(mark.classList.contains("is-wrong")).toBe(true);
  });
});
