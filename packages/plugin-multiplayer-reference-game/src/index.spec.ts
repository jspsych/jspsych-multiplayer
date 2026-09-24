import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions, initJsPsych } from "jspsych";

import { MemoryHub } from "../../../test-utils/memory-backend";
import MultiplayerReferenceGamePlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Every test runs the real jsPsych multiplayer session over the in-memory backend in test-utils, so
// reads are frozen snapshots, own writes show up at once (and notify subscribers synchronously),
// and presence is real. `makeApi` wraps that session with a test convenience:
//   - `pushAs(id, data)` writes another participant's slot, as if that connected participant had
//     written it. For this participant's own id it writes through the session instead, since the
//     session owns its own slot.
// ---------------------------------------------------------------------------------------------------

async function makeApi(participantId: string, connect?: ConnectOptions) {
  const hub = new MemoryHub();
  const joined = await hub.join(participantId, { connect });
  const multiplayer = joined.jsPsych.multiplayer;
  return {
    hub,
    connection: joined.connection,
    multiplayer,
    participantId,
    get: (id: string) => multiplayer.get(id),
    getAll: () => multiplayer.getAll(),
    pushAs(id: string, data: Record<string, unknown>) {
      if (id === participantId) {
        void multiplayer.push(data);
        return;
      }
      if (![...hub.connections].some((c) => c.participantId === id)) {
        // A connected peer with no jsPsych instance of its own
        hub.connections.add({
          participantId: id,
          online: true,
          options: { onChange() {}, onStatus() {} },
        } as never);
      }
      hub.seed(id, data);
    },
  };
}

type Api = Awaited<ReturnType<typeof makeApi>>;

function makeJsPsych(api: Api) {
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    multiplayer: api.multiplayer,
    finishTrial: (data: Record<string, any>) => finished.push(data),
    // Passthrough double for the pluginAPI timer registry the plugin now schedules through.
    pluginAPI: {
      setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    },
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
  require_message_before_response: false,
  placeholder: "Type…",
  chat_persists: false,
  chat_position: "below",
  typing_indicator: false,
  typing_key: "typing_at",
  typing_ttl: 2500,
  typing_throttle: 800,
  typing_label: null,
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
  end_on_participant_left: true,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const P = "jspsych-multiplayer-reference-game";
const cell = (el: HTMLElement, id: string) =>
  el.querySelector(`.${P}-cell[data-object-id="${id}"]`) as HTMLElement;
const clickCell = (el: HTMLElement, id: string) =>
  cell(el, id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const clickSlot = (el: HTMLElement, n: number) =>
  (el.querySelector(`.${P}-slot[data-slot="${n}"]`) as HTMLButtonElement).dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
const submitBtn = (el: HTMLElement) => el.querySelector(`.${P}-submit`) as HTMLButtonElement;
const feedbackText = (el: HTMLElement) =>
  (el.querySelector(`.${P}-feedback`) as HTMLElement).textContent ?? "";
/** Fill the chat input and submit the chat form. */
const sendChat = (el: HTMLElement, text: string) => {
  (el.querySelector(`.${P}-chat-input`) as HTMLInputElement).value = text;
  (el.querySelector(`.${P}-chat-form`) as HTMLFormElement).dispatchEvent(
    new Event("submit", { cancelable: true }),
  );
};
const run = (jsPsych: any, el: HTMLElement, params: Record<string, unknown>) =>
  new MultiplayerReferenceGamePlugin(jsPsych).trial(el, params as never);

describe("multiplayer-reference-game: single-target (sequential) click task", () => {
  it("trial() is synchronous (returns undefined) so jsPsych waits for finishTrial", async () => {
    const { jsPsych } = makeJsPsych(await makeApi("matcher"));
    expect(run(jsPsych, display(), { ...base })).toBeUndefined();
  });

  it("the matcher clicking the target records a correct submission and ends", async () => {
    const api = await makeApi("matcher");
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

  it("require_message_before_response blocks the matcher until the DIRECTOR has messaged", async () => {
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      partner_id: "director",
      require_message_before_response: true,
      save_interaction_history: true,
    });

    // No director message yet: the click is ignored (no submission) and a hint is shown.
    clickCell(el, "b");
    expect(finished).toHaveLength(0);
    expect(el.querySelector(`.${P}-gate-hint`)).not.toBeNull();

    // The matcher's OWN message must not open the gate — only the director's counts.
    api.pushAs("matcher", {
      reference_game_chat_r0: [{ senderId: "matcher", seq: 0, text: "which one?", ts: 1 }],
    });
    clickCell(el, "b");
    expect(finished).toHaveLength(0);

    // Director speaks → gate opens, hint clears, and the next click submits normally.
    api.pushAs("director", {
      joinedAt: 1,
      reference_game_chat_r0: [{ senderId: "director", seq: 0, text: "the star shape", ts: 5 }],
    });
    expect(el.querySelector(`.${P}-gate-hint`)).toBeNull();
    clickCell(el, "b");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ correct: true, ended_by: "submit" });
    // The two blocked clicks are logged as gated_click events before the final assign.
    const actions = finished[0].interaction_history.map((e: any) => e.action);
    expect(actions).toEqual(["gated_click", "gated_click", "assign"]);
  });

  it("with chat_persists, a prior round's message does NOT pre-open the gate", async () => {
    const api = await makeApi("matcher");
    // chat_persists shares one log across rounds; seed it with the previous round's director message.
    api.pushAs("director", {
      joinedAt: 1,
      reference_game_chat: [
        { senderId: "director", seq: 0, text: "round-0 desc", ts: 1, round: 0 },
      ],
    });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      partner_id: "director",
      require_message_before_response: true,
      chat_persists: true,
      round: 1,
    });

    // The carried-over message must not count for this new round — the click is still gated.
    clickCell(el, "b");
    expect(finished).toHaveLength(0);

    // A fresh director message THIS round opens the gate.
    api.pushAs("director", {
      joinedAt: 1,
      reference_game_chat: [
        { senderId: "director", seq: 0, text: "round-0 desc", ts: 1, round: 0 },
        { senderId: "director", seq: 1, text: "this round's target", ts: 9, round: 1 },
      ],
    });
    clickCell(el, "b");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ended_by: "submit" });
  });

  it("with chat_persists, THIS round's message already in the log DOES open the gate", async () => {
    const api = await makeApi("matcher");
    // The two clients do not enter a round together (e.g. a Continue button advances each side
    // independently), so the director can describe round 1 before the matcher's round-1 trial is
    // even constructed. That message must still count — keying off "what was already in the log"
    // instead of the stamped round left the matcher gated until the director spoke a second time.
    api.pushAs("director", {
      joinedAt: 1,
      reference_game_chat: [
        { senderId: "director", seq: 0, text: "round-0 desc", ts: 1, round: 0 },
        { senderId: "director", seq: 1, text: "round-1 desc", ts: 9, round: 1 },
      ],
    });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      partner_id: "director",
      require_message_before_response: true,
      chat_persists: true,
      round: 1,
    });

    clickCell(el, "b");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ended_by: "submit" });
  });

  it("a NON-partner participant's message does not open the gate", async () => {
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      partner_id: "director",
      require_message_before_response: true,
    });

    // A third slot (spectator, or a leftover session) chatting must not count as the director's
    // referring expression.
    api.pushAs("spectator", {
      reference_game_chat_r0: [{ senderId: "spectator", seq: 0, text: "hello?", ts: 2 }],
    });
    clickCell(el, "b");
    expect(finished).toHaveLength(0);

    api.pushAs("director", {
      joinedAt: 1,
      reference_game_chat_r0: [{ senderId: "director", seq: 0, text: "the star shape", ts: 5 }],
    });
    clickCell(el, "b");
    expect(finished).toHaveLength(1);
  });

  it("require_message_before_response is inert when chat_enabled is false", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, {
      ...base,
      partner_id: "director",
      require_message_before_response: true,
      chat_enabled: false,
    });

    // Gating with no channel to message on would deadlock the matcher, so the flag is skipped.
    clickCell(el, "b");
    expect(finished).toHaveLength(1);
    expect(el.querySelector(`.${P}-gate-hint`)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("require_message_before_response"));
    warn.mockRestore();
  });

  it("clicking a distractor records an incorrect submission", async () => {
    const api = await makeApi("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    clickCell(el, "a");

    expect(finished[0]).toMatchObject({ correct: false, n_correct: 0, assignment: "a" });
  });

  it("only the director sees the target highlighted before feedback", async () => {
    const dirApi = await makeApi("director");
    const dirEl = display();
    run(makeJsPsych(dirApi).jsPsych, dirEl, { ...base, role: "director", partner_id: "matcher" });
    expect(cell(dirEl, "b").classList.contains("is-target")).toBe(true);

    const matApi = await makeApi("matcher");
    const matEl = display();
    run(makeJsPsych(matApi).jsPsych, matEl, { ...base, role: "matcher", partner_id: "director" });
    expect(cell(matEl, "b").classList.contains("is-target")).toBe(false);
  });

  it("the director reaches feedback when the matcher's submission arrives", async () => {
    const api = await makeApi("director");
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

  it("preserves unrelated keys in the matcher's own slot when submitting", async () => {
    const api = await makeApi("matcher");
    api.pushAs("matcher", { joinedAt: 42 }); // pre-existing data
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    clickCell(el, "b");

    expect(api.getAll().matcher.joinedAt).toBe(42);
    expect((api.getAll().matcher.reference_game as any)["0"].assignment).toEqual({ 1: "b" });
  });

  it("tears down the subscription on finish (no leak)", async () => {
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    clickCell(el, "b");
    const rendered = el.innerHTML;

    // Nothing reacts to later updates: no re-render, and no second finish
    api.pushAs("director", {
      reference_game_chat_r0: [{ senderId: "director", seq: 0, text: "late", ts: 5 }],
    });
    expect(el.innerHTML).toBe(rendered);
  });
});

describe("multiplayer-reference-game: multi-target (full-board) assign task", () => {
  const stim = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("shows numbered slots, enables Submit only when complete, and scores an ordered match", async () => {
    const api = await makeApi("matcher");
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

  it("scores a partial ordered match", async () => {
    const api = await makeApi("matcher");
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

  it("unordered scoring counts set membership regardless of slot order", async () => {
    const api = await makeApi("matcher");
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

  it("records the pre-submit interaction history when enabled", async () => {
    const api = await makeApi("matcher");
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
  it("renders and merges the partner's chat messages", async () => {
    const api = await makeApi("matcher");
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
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    const input = el.querySelector(`.${P}-chat-input`) as HTMLInputElement;
    input.value = "<img src=x onerror=alert(1)>";
    (el.querySelector(`.${P}-chat-form`) as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await flush();

    expect(el.querySelector(`.${P}-chat-log img`)).toBeNull();
  });

  it("does not lose a chat message when two sends happen back to back", async () => {
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    sendChat(el, "first");
    sendChat(el, "second");

    const mine = api.getAll().matcher.reference_game_chat_r0 as any[];
    expect(mine.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("submitting keeps a just-sent chat message (update merges, push would have replaced)", async () => {
    // Submitting writes only the rounds key with `update`, so the chat key written just before it
    // survives.
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    run(jsPsych, el, { ...base, partner_id: "director" });
    sendChat(el, "is it the star?");
    clickCell(el, "b"); // single target → submits immediately

    const slot = api.getAll().matcher;
    expect((slot.reference_game_chat_r0 as any[]).map((m) => m.text)).toEqual(["is it the star?"]);
    expect((slot.reference_game as any)["0"].assignment).toEqual({ 1: "b" });
  });

  it("throws a clear error when participantId is null (adapter not connected yet)", () => {
    expect(() => run(initJsPsych(), display(), { ...base })).toThrow(/participantId/);
  });

  it("throws a clear error on a jsPsych without the multiplayer module", () => {
    expect(() => run({}, display(), { ...base })).toThrow(/no multiplayer module/);
  });

  it("submits the current (partial) assignment on selection_timeout", async () => {
    jest.useFakeTimers();
    try {
      const api = await makeApi("matcher");
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

  it("throws a clear error when role is not director/matcher", async () => {
    const { jsPsych } = makeJsPsych(await makeApi("x"));
    expect(() => run(jsPsych, display(), { ...base, role: "spectator" })).toThrow(/role/i);
  });

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("me");

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
      jsPsych,
    );

    clickCell(displayElement, "c");
    await expectFinished();

    const data = getData().values()[0];
    expect(data).toMatchObject({ role: "matcher", assignment: "c", correct: true, n_targets: 1 });
  });
});

describe("multiplayer-reference-game: review-fix regressions", () => {
  it("throws a clear error for disjoint scramble mode with a single stimulus", async () => {
    const { jsPsych } = makeJsPsych(await makeApi("x"));
    expect(() =>
      run(jsPsych, display(), {
        ...base,
        stimuli: [{ id: "a" }],
        targets: ["a"],
        scramble_mode: "disjoint",
      }),
    ).toThrow(/disjoint.*at least 2 stimuli/i);
  });

  it("fails loudly when this round already holds a submitted assignment (stale-replay guard)", async () => {
    // A reused round index (or the old default of 0 across trials) leaves the previous submission in
    // data_key[round]; running again must throw rather than silently replay it into feedback.
    const api = await makeApi("matcher");
    api.pushAs("matcher", {
      reference_game: { 0: { assignment: { 1: "b" }, rt: 100, n_correct: 1, n_targets: 1 } },
    });
    const { jsPsych } = makeJsPsych(api);
    expect(() => run(jsPsych, display(), { ...base, partner_id: "director" })).toThrow(
      /round 0 already/i,
    );
  });

  it("throws when `round` is missing (round is required)", async () => {
    const { round, ...noRound } = base;
    const { jsPsych } = makeJsPsych(await makeApi("matcher"));
    expect(() => run(jsPsych, display(), { ...noRound, partner_id: "director" })).toThrow(/round/i);
  });

  it("warns when there is no bounded end path (no round_timeout or selection_timeout)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      run(makeJsPsych(await makeApi("director")).jsPsych, display(), {
        ...base,
        role: "director",
        partner_id: "matcher",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/round_timeout/));
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT warn about the end path once round_timeout is set", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      run(makeJsPsych(await makeApi("director")).jsPsych, display(), {
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

  it("throws instead of guessing when partner auto-detect is ambiguous (>1 other participant)", async () => {
    const api = await makeApi("director");
    api.pushAs("matcherA", { joinedAt: 1 });
    api.pushAs("matcherB", { joinedAt: 2 });
    const { jsPsych } = makeJsPsych(api);
    // base.partner_id is null → auto-detect, which must fail clearly rather than pick one.
    expect(() => run(jsPsych, display(), { ...base, role: "director" })).toThrow(/partner_id/i);
  });

  it("auto-detects the partner when exactly one other participant is present", async () => {
    const api = await makeApi("director");
    api.pushAs("matcher", { joinedAt: 1 });
    const { jsPsych } = makeJsPsych(api);
    // Exactly one other participant → no throw; the single peer is taken as the partner.
    expect(() => run(jsPsych, display(), { ...base, role: "director" })).not.toThrow();
  });

  it("preserves ended_by 'submit' when a Continue button only advances feedback", async () => {
    const api = await makeApi("matcher");
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
      new MouseEvent("click", { bubbles: true }),
    );
    expect(finished[0].ended_by).toBe("submit");
  });

  it("shows both the correct target order and the matcher's slot at feedback without clobbering", async () => {
    const api = await makeApi("director");
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

describe("multiplayer-reference-game: presence and the session closing", () => {
  it("ends with ended_by 'participant_left' when the partner leaves before feedback", async () => {
    const api = await makeApi("director", { dropoutTimeout: 0 });
    const matcher = await api.hub.join("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    run(jsPsych, display(), { ...base, role: "director" });

    await matcher.jsPsych.multiplayer.disconnect();
    await sleep(5);

    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      ended_by: "participant_left",
      partner_left: true,
      left_participant: "matcher",
      connection_lost: false,
      assignment: null,
    });
  });

  it("doesn't end when end_on_participant_left is false", async () => {
    const api = await makeApi("director", { dropoutTimeout: 0 });
    const matcher = await api.hub.join("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    run(jsPsych, display(), { ...base, role: "director", end_on_participant_left: false });

    await matcher.jsPsych.multiplayer.disconnect();
    await sleep(5);
    expect(finished).toHaveLength(0);
  });

  it("scores a submission that arrived before the partner left", async () => {
    const api = await makeApi("director", { dropoutTimeout: 0 });
    const matcher = await api.hub.join("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    run(jsPsych, display(), { ...base, role: "director", partner_id: "matcher" });

    await matcher.jsPsych.multiplayer.push({
      reference_game: { 0: { assignment: { 1: "b" }, rt: 10, n_correct: 1, n_targets: 1 } },
    });
    await matcher.jsPsych.multiplayer.disconnect();
    await sleep(5);

    expect(finished[0]).toMatchObject({ ended_by: "submit", correct: true, partner_left: false });
  });

  it("finishes feedback normally if the partner leaves during it", async () => {
    const api = await makeApi("matcher", { dropoutTimeout: 0 });
    const director = await api.hub.join("director");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, { ...base, feedback: true, feedback_duration: null });

    clickCell(el, "b");
    await director.jsPsych.multiplayer.disconnect();
    await sleep(5);
    expect(finished).toHaveLength(0);

    (el.querySelector(`.${P}-continue`) as HTMLButtonElement).click();
    expect(finished[0]).toMatchObject({ ended_by: "submit", partner_left: false });
  });

  it("auto-detect ignores participants who left and prefers connected ones", async () => {
    const api = await makeApi("matcher", { dropoutTimeout: 0 });
    const old = await api.hub.join("old-partner");
    await old.jsPsych.multiplayer.push({ joinedAt: 1 });
    await old.jsPsych.multiplayer.disconnect();
    await sleep(5);
    await api.hub.join("director");

    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, { ...base, feedback: false, save_orders: true });
    clickCell(el, "b");

    expect(finished[0].partner_order).not.toBeNull();
  });

  it("ends with ended_by 'connection_lost' when the session closes", async () => {
    const api = await makeApi("director");
    await api.hub.join("matcher");
    const { jsPsych, finished } = makeJsPsych(api);
    run(jsPsych, display(), { ...base, role: "director" });

    api.connection.options.onStatus("closed");

    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ended_by: "connection_lost", connection_lost: true });
  });

  it("also ends cleanly when the experiment calls disconnect() mid-trial", async () => {
    const api = await makeApi("director");
    const { jsPsych, finished } = makeJsPsych(api);
    run(jsPsych, display(), { ...base, role: "director", partner_id: "matcher" });
    await api.multiplayer.disconnect();
    expect(finished[0].ended_by).toBe("connection_lost");
  });

  it("saves a modifiable copy of the group with save_group", async () => {
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, { ...base, save_group: true });
    clickCell(el, "b");

    expect(finished[0].group.director).toEqual({ joinedAt: 1 });
    expect(Object.isFrozen(finished[0].group.director)).toBe(false);
  });
});

describe("multiplayer-reference-game: role-keyed feedback_content", () => {
  // The original tangrams experiment shows each role ONE thing at feedback: the director sees the
  // object the matcher clicked, the matcher sees the true target (game.client.js 's.feedback').
  const roleKeyed = {
    director: { reveal_target: false, show_score: false, show_partner_choice: true },
    matcher: { reveal_target: true, show_score: false, show_partner_choice: false },
  };
  // target is "b" in `base`; have the matcher click "c" so target and choice are different cells.
  const wrongSubmission = {
    reference_game: { 0: { assignment: { 1: "c" }, rt: 300, n_correct: 0, n_targets: 1 } },
  };

  it("shows the director the matcher's choice and NOT the target", async () => {
    const api = await makeApi("director");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      role: "director",
      partner_id: "matcher",
      reveal_target_to: "none", // isolate feedback from the pre-feedback director hint
      feedback: true,
      feedback_content: roleKeyed,
      feedback_duration: null,
    });
    api.pushAs("matcher", wrongSubmission);

    expect(cell(el, "c").classList.contains("is-wrong")).toBe(true); // the click
    expect(cell(el, "b").classList.contains("is-target")).toBe(false); // target stays hidden
    expect(feedbackText(el)).toBe(""); // no score line
  });

  it("shows the matcher the target and NOT their own choice", async () => {
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      partner_id: "director",
      feedback: true,
      feedback_content: roleKeyed,
      feedback_duration: null,
    });
    api.pushAs("director", {
      [`reference_game_chat_r0`]: [
        { id: "director#0", senderId: "director", seq: 0, text: "hi", ts: 1, round: 0 },
      ],
    });
    clickCell(el, "c");

    expect(cell(el, "b").classList.contains("is-target")).toBe(true); // the true target
    expect(cell(el, "c").classList.contains("is-wrong")).toBe(false); // own choice not marked
    expect(feedbackText(el)).toBe("");
  });

  it("a flat feedback_content still applies to both roles (backwards compatible)", async () => {
    const api = await makeApi("director");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      role: "director",
      partner_id: "matcher",
      reveal_target_to: "none",
      feedback: true,
      feedback_content: { reveal_target: true, show_score: true, show_partner_choice: true },
      feedback_duration: null,
    });
    api.pushAs("matcher", wrongSubmission);

    expect(cell(el, "b").classList.contains("is-target")).toBe(true);
    expect(cell(el, "c").classList.contains("is-wrong")).toBe(true);
    expect(feedbackText(el)).toMatch(/incorrect/i);
  });

  it("fills in defaults for keys a role's object omits", async () => {
    const api = await makeApi("director");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      role: "director",
      partner_id: "matcher",
      reveal_target_to: "none",
      feedback: true,
      feedback_content: { director: { show_score: false } }, // reveal_target/show_partner_choice default true
      feedback_duration: null,
    });
    api.pushAs("matcher", wrongSubmission);

    expect(cell(el, "b").classList.contains("is-target")).toBe(true);
    expect(cell(el, "c").classList.contains("is-wrong")).toBe(true);
    expect(feedbackText(el)).toBe("");
  });
});

describe("multiplayer-reference-game: typing indicator", () => {
  const chatInputOf = (el: HTMLElement) => el.querySelector(`.${P}-chat-input`) as HTMLInputElement;
  const type = (el: HTMLElement, text: string) => {
    const input = chatInputOf(el);
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  /** Pushes that reached the backend carrying a typing timestamp. */
  const typingPushes = (api: Api) => api.connection.pushes.filter((d) => "typing_at" in d);

  it("writes a typing timestamp on input without clobbering other slot keys", async () => {
    const api = await makeApi("matcher");
    api.pushAs("matcher", { joinedAt: 1, custom: { a: 1 } });
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      typing_indicator: true,
      typing_throttle: 0,
      partner_id: "director",
    });

    type(el, "the");
    await flush();

    const slot = api.get("matcher") as Record<string, unknown>;
    expect(typeof slot["typing_at"]).toBe("number");
    expect(slot["joinedAt"]).toBe(1);
    expect(slot["custom"]).toEqual({ a: 1 });
  });

  it("throttles continuous typing", async () => {
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, { ...base, typing_indicator: true, typing_throttle: 10000 });

    type(el, "a");
    type(el, "ab");
    await flush();

    expect(typingPushes(api)).toHaveLength(1);
  });

  it("falls back to the default typing key when given an empty string", async () => {
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      typing_indicator: true,
      typing_throttle: 0,
      typing_key: "",
    });

    type(el, "the");
    await flush();

    const slot = api.get("matcher") as Record<string, unknown>;
    expect(typeof slot["typing_at"]).toBe("number");
    expect("" in slot).toBe(false);
  });

  it("emptying the input withdraws the typing mark immediately", async () => {
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, { ...base, typing_indicator: true, typing_throttle: 0 });

    type(el, "the");
    await flush();
    expect(typeof (api.get("matcher") as Record<string, unknown>)["typing_at"]).toBe("number");
    type(el, "");
    await flush();
    expect((api.get("matcher") as Record<string, unknown>)["typing_at"]).toBeNull();
  });

  it("sending a message keeps the message and clears the mark", async () => {
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      typing_indicator: true,
      typing_throttle: 0,
      partner_id: "director",
    });

    // The timestamp and the message are written back to back; neither may overwrite the other.
    type(el, "the");
    const input = chatInputOf(el);
    input.value = "the star";
    (el.querySelector(`.${P}-chat-form`) as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await flush();

    const slot = api.get("matcher") as Record<string, unknown>;
    const messages = slot["reference_game_chat_r0"] as Array<{ text: string }>;
    expect(messages.some((m) => m.text === "the star")).toBe(true);
    expect(slot["typing_at"]).toBeNull();
  });

  it("shows the partner hint with the role label, then hides it after the TTL", async () => {
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      typing_indicator: true,
      typing_ttl: 60,
      partner_id: "director",
    });

    api.pushAs("director", { joinedAt: 1, typing_at: Date.now() });
    const hint = el.querySelector(`.${P}-typing-hint`) as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("Director is typing…");

    await sleep(150);
    expect(hint.hidden).toBe(true);
  });

  it("hides the hint while the partner is away", async () => {
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, { ...base, typing_indicator: true, partner_id: "director" });

    api.pushAs("director", { joinedAt: 1, typing_at: Date.now() });
    const hint = el.querySelector(`.${P}-typing-hint`) as HTMLElement;
    expect(hint.hidden).toBe(false);

    const director = [...api.hub.connections].find((c) => c.participantId === "director")!;
    director.online = false;
    api.hub.broadcast();
    expect(api.multiplayer.presence().director).toBe("away");
    expect(hint.hidden).toBe(true);
  });

  it("uses a custom typing label verbatim when provided", async () => {
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      typing_indicator: true,
      typing_label: "Partner is writing…",
      partner_id: "director",
    });

    api.pushAs("director", { joinedAt: 1, typing_at: Date.now() });
    expect((el.querySelector(`.${P}-typing-hint`) as HTMLElement).textContent).toBe(
      "Partner is writing…",
    );
  });

  it("does nothing when the indicator is off", async () => {
    const api = await makeApi("matcher");
    const { jsPsych } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, base);
    const before = api.connection.pushes.length;

    type(el, "the");
    await flush();

    expect(api.connection.pushes).toHaveLength(before);
    expect(el.querySelector(`.${P}-typing-hint`)).toBeNull();
  });

  it("trial end withdraws the mark and stops listening", async () => {
    const api = await makeApi("matcher");
    api.pushAs("director", { joinedAt: 1 });
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();
    run(jsPsych, el, {
      ...base,
      typing_indicator: true,
      typing_throttle: 0,
      partner_id: "director",
    });

    // Matcher clicks the target: auto-submit (k=1) with feedback off ends the trial synchronously.
    clickCell(el, "b");
    expect(finished).toHaveLength(1);
    await flush();

    // Round data landed, and the end-of-trial withdraw was sent.
    const slot = api.get("matcher") as Record<string, unknown>;
    expect(slot["typing_at"]).toBeNull();
    expect((slot["reference_game"] as any)["0"].assignment).toEqual({ 1: "b" });
    // Typing after the end sends nothing further.
    const after = api.connection.pushes.length;
    type(el, "late");
    await flush();
    expect(api.connection.pushes).toHaveLength(after);
  });
});
