import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import {
  Choice,
  GroupSessionData,
  OptionTally,
  WinnerResult,
  collectChoices,
  countChosen,
  plurality,
  tally,
} from "./choice-core";
import { MultiplayerApiLike, resolveMultiplayerApi } from "./multiplayer-api";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`). The pure-core helpers are exposed as statics on the
// plugin class below, so everything is reachable through that one default export.
export type { Choice, OptionTally, WinnerResult } from "./choice-core";

const info = <const>{
  name: "multiplayer-choice",
  version: version,
  parameters: {
    /**
     * The options this participant can pick from. An array of button contents (HTML allowed, since
     * it is experimenter-authored) — the same shape as jsPsych's `html-button-response` `choices`.
     * The zero-based index of the clicked option is the canonical value shared with the group; its
     * label rides along for display. Required.
     */
    choices: { type: ParameterType.STRING, array: true, default: undefined },
    /** Question / instructions rendered above the option buttons (experimenter HTML). */
    prompt: { type: ParameterType.HTML_STRING, default: null },
    /**
     * `(choice, index) => htmlString` producing the markup for each option button, so experiments can
     * style the buttons (jsPsych `html-button-response` convention). Null uses a plain `jspsych-btn`.
     */
    button_html: { type: ParameterType.FUNCTION, default: null },
    /**
     * Session field this participant's choice is stored under. Namespacing keeps it from colliding
     * with other pushed data (a role, a chat log) and lets two choice trials keep separate decisions.
     */
    data_key: { type: ParameterType.STRING, default: "choice" },
    /**
     * The group size — including this participant — that must record a choice before the barrier
     * lifts and the reveal is shown. Set it to the exact expected count. Required.
     */
    expected_players: { type: ParameterType.INT, default: undefined },
    /** HTML shown after this participant has chosen, while waiting for the rest of the group. */
    waiting_message: {
      type: ParameterType.HTML_STRING,
      default: "<p>Waiting for the other players to choose…</p>",
    },
    /**
     * Milliseconds to wait for the group AFTER this participant chooses. On expiry the trial proceeds
     * with whoever chose so far, flagged `timed_out: true`, and `on_timeout` fires. Null (or a
     * non-positive value) waits indefinitely. Does not bound how long this participant takes to pick.
     */
    timeout: { type: ParameterType.INT, default: null },
    /** Called with the wait rejection if `timeout` elapses before the group has all chosen. */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
    /** Reveal the group's decision after the barrier. `false` ends the trial as soon as the group has chosen. */
    reveal: { type: ParameterType.BOOL, default: true },
    /**
     * What the reveal shows. `"players"` lists every player's choice, attributed
     * (`Alice: Cooperate`). `"tally"` shows the aggregate only — per-option counts, the plurality
     * winner, and a tie summary — never who chose what (an anonymous poll). Combine `"tally"` with
     * `record_choices_by_player: false` to keep the recorded data anonymous too.
     */
    reveal_mode: { type: ParameterType.STRING, default: "players" },
    /** Heading rendered above the reveal (experimenter HTML), e.g. `"<h3>Everyone has chosen</h3>"`. */
    reveal_prompt: { type: ParameterType.HTML_STRING, default: null },
    /** Label of the button that ends the reveal. `null` hides it (then set `reveal_duration`, or the reveal can't advance). */
    continue_label: { type: ParameterType.STRING, default: "Continue" },
    /** If set, auto-advance the reveal after this many milliseconds instead of (or racing) the continue button. */
    reveal_duration: { type: ParameterType.INT, default: null },
    /**
     * `(participantId) => string` mapping an id to the name shown on the reveal list. FUNCTION is
     * deliberate — it stops jsPsych's dynamic-parameter machinery from CALLING the value. Null shows
     * the raw participantId. e.g. drive names from role output. Only used by `reveal_mode: "players"`.
     */
    player_label: { type: ParameterType.FUNCTION, default: null },
    /**
     * Optional `(choices, me) => number` computing THIS client's payoff from the collected choices
     * (a `participantId -> { index, label }` map) plus this client's id. Return a finite number; it is
     * saved as `my_payoff` and shown on the reveal. Null (the default) skips payoffs entirely — the
     * plugin stays a pure decision primitive, and you can derive payoffs from `choices_by_player` in
     * `on_finish` instead. FUNCTION: see `player_label`. NOTE: the hook always receives the
     * participant-keyed map, even when `record_choices_by_player` is `false` — it runs locally and
     * records only the returned number.
     */
    payoff: { type: ParameterType.FUNCTION, default: null },
    /**
     * Whether to save the participant → choice map as `choices_by_player`. Set `false` for an
     * anonymous poll: the recorded data then carries only the aggregate (`tally`/`winner`/…) and this
     * client's own choice. NOTE this anonymizes the plugin's OUTPUT (data + reveal), not the shared
     * session state: every client's raw pick still sits in its own slot, readable by a participant
     * inspecting the session or network traffic. True unlinkability would need server-side
     * aggregation, which no client-side plugin can provide.
     */
    record_choices_by_player: { type: ParameterType.BOOL, default: true },
  },
  data: {
    /** This participant's chosen option label. */
    choice: { type: ParameterType.STRING },
    /** Zero-based index of this participant's chosen option. */
    choice_index: { type: ParameterType.INT },
    /** Time from the options appearing to this participant clicking one, in milliseconds. */
    rt: { type: ParameterType.INT },
    /** Time spent waiting for the rest of the group after choosing, in milliseconds. */
    wait_time: { type: ParameterType.INT },
    /** Every player's choice at the barrier: `{ participantId: { index, label } }`. `null` when `record_choices_by_player` is `false`. */
    choices_by_player: { type: ParameterType.OBJECT, default: null },
    /** Number of participants whose choice counted when the barrier resolved (or the timeout fired). */
    n_players: { type: ParameterType.INT },
    /** The aggregate count at the barrier: one `{ index, label, count }` per option, in `choices` order. */
    tally: { type: ParameterType.OBJECT },
    /** The plurality winner (`{ index, label, count }`), or `null` on a tie or when no one chose. */
    winner: { type: ParameterType.OBJECT, default: null },
    /** `true` when two or more options shared the top count, so there is no single winner. */
    is_tie: { type: ParameterType.BOOL, default: false },
    /** The options sharing the top count when `is_tie` is true (`choices` order); empty otherwise. */
    tied_options: { type: ParameterType.OBJECT },
    /** This client's payoff from the `payoff` hook; `null` if no hook was provided (or it threw/returned a non-number). */
    my_payoff: { type: ParameterType.FLOAT, default: null },
    /** `true` if the trial proceeded because `timeout` elapsed rather than because everyone had chosen. */
    timed_out: { type: ParameterType.BOOL, default: false },
    /** The `wait()` rejection message when the barrier ended without the full group; `null` otherwise. */
    wait_error: { type: ParameterType.STRING, default: null },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/**
 * **multiplayer-choice**
 *
 * A simultaneous group decision for multiplayer experiments. Every participant picks one of the same
 * options, the trial pushes that pick and waits (a barrier) until the whole group has chosen, then
 * optionally reveals the outcome. It is the engine under simultaneous-move paradigms —
 * prisoner's dilemma, public-goods contributions, dictator/coordination games — and packages the
 * choose → push → wait → reveal flow as one declarative trial.
 *
 * Two reveal modes cover the attributed and the anonymous cases: `reveal_mode: "players"` (default)
 * lists who chose what, and an optional `payoff` hook can score the round; `reveal_mode: "tally"`
 * shows only per-option counts and the plurality winner — an anonymous group poll (combine with
 * `record_choices_by_player: false` to keep the recorded data anonymous too). The pure core
 * (`collectChoices`, `countChosen`, `tally`, `plurality`) is reachable as static members.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-choice}
 */
class MultiplayerChoicePlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent helpers over a group snapshot. Usable standalone, today. */
  static collectChoices = collectChoices;
  static countChosen = countChosen;
  static tally = tally;
  static plurality = plurality;

  constructor(private jsPsych: JsPsych) {}

  // Async (returns a Promise): the trial has an interactive first phase and a barrier, so — like
  // plugin-multiplayer-sync — jsPsych does NOT auto-fire on_load; we invoke it once the choice
  // screen is rendered, and end the trial by calling finishTrial after the (optional) reveal.
  async trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const api = resolveMultiplayerApi(this.jsPsych);
    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-choice: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.multiplayer.connect(adapter)) before this trial runs."
      );
    }

    const choices = trial.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error(
        "plugin-multiplayer-choice: `choices` is required and must be a non-empty array of option labels."
      );
    }
    const expected = trial.expected_players;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      throw new Error(
        "plugin-multiplayer-choice: `expected_players` is required and must be a positive integer " +
          "(the group size, including this participant, that must choose before the barrier lifts)."
      );
    }
    const revealMode = trial.reveal_mode;
    if (revealMode !== "players" && revealMode !== "tally") {
      // Validate rather than silently coerce: a typo'd mode would otherwise flip the reveal's
      // anonymity semantics without warning.
      throw new Error(
        `plugin-multiplayer-choice: \`reveal_mode\` must be "players" or "tally" (got ${JSON.stringify(
          revealMode
        )}).`
      );
    }

    const dataKey = trial.data_key;
    const labels = choices.map(String);

    // --- Phase 1: this participant chooses ----------------------------------------------------
    const { index, rt } = await this.collectChoice(display_element, trial, on_load);
    const label = labels[index];

    // --- Phase 2: push the choice, then barrier on the whole group ----------------------------
    // Read our own slot first and push the whole thing back with only the choice key changed: `push`
    // REPLACES the slot, so spreading preserves any other data we pushed earlier (a role, a chat log).
    const prev = api.get(me) ?? {};
    const payload: Record<string, unknown> = { ...prev, [dataKey]: { index, label } };
    // Push BEFORE the wait try/catch: a push failure is an infrastructure error, not a barrier
    // timeout, and must surface loudly (rejecting the trial) rather than being relabeled `timed_out`.
    await api.push(payload);

    display_element.innerHTML = `<div class="jspsych-multiplayer-choice-waiting">${trial.waiting_message}</div>`;
    const waitStart = performance.now();
    const timeout =
      typeof trial.timeout === "number" && trial.timeout > 0 ? trial.timeout : undefined;

    let group: GroupSessionData;
    let timedOut = false;
    let waitError: string | null = null;
    try {
      // Bound the count by the option range (labels.length) so the barrier counts exactly the
      // choices `tally` will count — a stale/out-of-range index (e.g. under a reused data_key)
      // neither lifts the barrier early nor is silently dropped from the aggregate afterward.
      group = await api.wait((g) => countChosen(g, dataKey, labels.length) >= expected, timeout);
    } catch (e) {
      // Distinguish a genuine barrier timeout from any other wait() rejection. jsPsych#3694 rejects a
      // timeout with a `MultiplayerTimeoutError` (matched by name, which survives two loaded copies of
      // jspsych); a wait() can otherwise reject because the condition predicate threw or the backend
      // failed. ONLY a timeout should proceed with a partial snapshot (flag timed_out, preserve the
      // message, run on_timeout) — any other rejection is a real fault and rethrows so the trial halts
      // loudly rather than masquerading as a timeout.
      if ((e as { name?: string })?.name !== "MultiplayerTimeoutError") throw e;
      timedOut = true;
      waitError = e instanceof Error ? e.message : String(e);
      if (typeof trial.on_timeout === "function") trial.on_timeout(e);
      group = api.getAll();
    }
    const waitTime = Math.round(performance.now() - waitStart);

    const choicesByPlayer = collectChoices(group, dataKey);
    const tallyResult = tally(group, dataKey, labels);
    const winnerResult = plurality(tallyResult);
    const myPayoff = this.computePayoff(trial, choicesByPlayer, me);

    const finish = () =>
      this.jsPsych.finishTrial({
        choice: label,
        choice_index: index,
        rt,
        wait_time: waitTime,
        choices_by_player: trial.record_choices_by_player ? choicesByPlayer : null,
        // n_players counts what the barrier counted (in-range choices), so it always equals the
        // tally's total — the collected map can hold an out-of-range stale entry the tally drops.
        n_players: winnerResult.totalVotes,
        tally: tallyResult,
        winner: winnerResult.winner,
        is_tie: winnerResult.isTie,
        tied_options: winnerResult.tied,
        my_payoff: myPayoff,
        timed_out: timedOut,
        wait_error: waitError,
      });

    // --- Phase 3: reveal (optional) -----------------------------------------------------------
    if (!trial.reveal) {
      finish();
      return;
    }
    if (revealMode === "tally") {
      await this.showTallyReveal(
        display_element,
        trial,
        index,
        tallyResult,
        winnerResult,
        myPayoff
      );
    } else {
      await this.showPlayersReveal(display_element, trial, me, choicesByPlayer, myPayoff);
    }
    finish();
  }

  /** Render the option buttons and resolve with the clicked index + reaction time. */
  private collectChoice(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    on_load?: () => void
  ): Promise<{ index: number; rt: number }> {
    return new Promise((resolve) => {
      const optionsHtml = (trial.choices as string[])
        .map((choice, i) => {
          const markup =
            typeof trial.button_html === "function"
              ? String(trial.button_html(choice, i))
              : `<button class="jspsych-btn">${choice}</button>`;
          return `<div class="jspsych-multiplayer-choice-option">${markup}</div>`;
        })
        .join("");

      display_element.innerHTML = `
        <div class="jspsych-multiplayer-choice">
          ${
            trial.prompt
              ? `<div class="jspsych-multiplayer-choice-prompt">${trial.prompt}</div>`
              : ""
          }
          <div class="jspsych-multiplayer-choice-options">${optionsHtml}</div>
        </div>`;

      // jsPsych only auto-fires on_load for synchronous trials; this trial() returns a Promise, so
      // fire it ourselves now that the choice screen is on screen.
      on_load?.();

      const shownAt = performance.now();
      const optionEls = display_element.querySelectorAll<HTMLElement>(
        ".jspsych-multiplayer-choice-option"
      );
      let picked = false;
      // Listen on the CONTAINER (which always exists and is in `choices` order), not the inner
      // <button> — like jsPsych's html-button-response — so a custom `button_html` that renders
      // something other than a <button> (an image, a tile) is still selectable. The forEach index
      // is the option index, since querySelectorAll returns the options in insertion order.
      optionEls.forEach((optionEl, i) => {
        optionEl.addEventListener("click", () => {
          if (picked) return; // guard a double click while we tear down
          picked = true;
          // Disable every option so a second selection can't be made after the choice is committed.
          // Disable the CONTAINER (pointer-events + dimming), not just an inner <button> — a custom
          // `button_html` may render no button at all, and the container carries the listener.
          optionEls.forEach((el) => {
            el.style.pointerEvents = "none";
            el.style.opacity = "0.6";
            el.setAttribute("aria-disabled", "true");
            el.querySelector("button")?.setAttribute("disabled", "true");
          });
          resolve({ index: i, rt: Math.round(performance.now() - shownAt) });
        });
      });
    });
  }

  /** Run the `payoff` hook (guarded), returning a finite number or null. */
  private computePayoff(
    trial: TrialType<Info>,
    choices: Record<string, Choice>,
    me: string
  ): number | null {
    if (typeof trial.payoff !== "function") return null;
    try {
      const value = trial.payoff(choices, me);
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch (err) {
      console.error("plugin-multiplayer-choice: `payoff` threw; recording my_payoff as null", err);
      return null;
    }
  }

  /** The payoff line shown on either reveal mode, or an empty string. */
  private payoffLine(myPayoff: number | null): string {
    return myPayoff != null
      ? `<p class="jspsych-multiplayer-choice-reveal-payoff">Your payoff: ${escapeHtml(
          String(myPayoff)
        )}</p>`
      : "";
  }

  /** Render everyone's choices, attributed, and resolve when the participant continues. */
  private showPlayersReveal(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    me: string,
    choices: Record<string, Choice>,
    myPayoff: number | null
  ): Promise<void> {
    const nameOf = (id: string): string => {
      if (typeof trial.player_label === "function") {
        try {
          return String(trial.player_label(id));
        } catch (err) {
          console.error(
            "plugin-multiplayer-choice: `player_label` threw; using the participantId instead",
            err
          );
        }
      }
      return id;
    };

    const items = Object.entries(choices)
      .map(([id, choice]) => {
        const cls = "jspsych-multiplayer-choice-reveal-item" + (id === me ? " is-self" : "");
        // Labels come from the shared session (a peer could push anything) — escape as text.
        return `<li class="${cls}">${escapeHtml(nameOf(id))}: ${escapeHtml(choice.label)}</li>`;
      })
      .join("");

    const body = items
      ? `<ul class="jspsych-multiplayer-choice-reveal-list">${items}</ul>`
      : `<p class="jspsych-multiplayer-choice-reveal-empty">No choices to show.</p>`;

    return this.showReveal(display_element, trial, body + this.payoffLine(myPayoff), "");
  }

  /** Render the anonymous tally + plurality winner and resolve when the participant continues. */
  private showTallyReveal(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    myIndex: number,
    counts: OptionTally[],
    result: WinnerResult,
    myPayoff: number | null
  ): Promise<void> {
    const total = result.totalVotes;
    const tiedIndices = new Set(result.tied.map((option) => option.index));

    // Option labels come from the trial's own `choices` (experimenter-authored, HTML allowed —
    // rendered raw exactly as the option buttons are). The tally is aggregate-only, so no
    // peer-pushed text is ever rendered here; there is no untrusted string to escape.
    const items = counts
      .map((option) => {
        const classes = ["jspsych-multiplayer-choice-tally-item"];
        if (result.winner?.index === option.index) classes.push("is-winner");
        if (tiedIndices.has(option.index)) classes.push("is-tied");
        if (option.index === myIndex) classes.push("is-mine");
        const pct = total > 0 ? Math.round((option.count / total) * 100) : 0;
        const noun = option.count === 1 ? "pick" : "picks";
        return `<li class="${classes.join(" ")}">
            <span class="jspsych-multiplayer-choice-tally-label">${option.label}</span>
            <span class="jspsych-multiplayer-choice-tally-bar" style="width:${pct}%"></span>
            <span class="jspsych-multiplayer-choice-tally-count">${option.count} ${noun}</span>
          </li>`;
      })
      .join("");

    let summary: string;
    if (result.winner) {
      summary = `<p class="jspsych-multiplayer-choice-tally-outcome is-winner">Winner: <strong>${result.winner.label}</strong> (${result.winner.count} of ${total})</p>`;
    } else if (result.isTie) {
      const names = result.tied.map((option) => option.label).join(", ");
      summary = `<p class="jspsych-multiplayer-choice-tally-outcome is-tie">Tie between ${names} (${result.tied[0].count} each)</p>`;
    } else {
      summary = `<p class="jspsych-multiplayer-choice-tally-outcome is-empty">No choices were made.</p>`;
    }

    const body = `<ul class="jspsych-multiplayer-choice-tally-list">${items}</ul>${summary}${this.payoffLine(
      myPayoff
    )}`;
    return this.showReveal(display_element, trial, body, " is-tally");
  }

  /** Shared reveal scaffolding: prompt + mode-specific body + continue button / reveal_duration. */
  private showReveal(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    bodyHtml: string,
    modifierClass: string
  ): Promise<void> {
    return new Promise((resolve) => {
      display_element.innerHTML = `
        ${REVEAL_STYLE}
        <div class="jspsych-multiplayer-choice-reveal${modifierClass}">
          ${trial.reveal_prompt ?? ""}
          ${bodyHtml}
          ${
            trial.continue_label != null
              ? `<button type="button" class="jspsych-btn jspsych-multiplayer-choice-continue">${escapeHtml(
                  trial.continue_label
                )}</button>`
              : ""
          }
        </div>`;

      let done = false;
      const end = () => {
        if (done) return; // guard the button racing reveal_duration
        done = true;
        resolve();
      };

      const button = display_element.querySelector(
        ".jspsych-multiplayer-choice-continue"
      ) as HTMLButtonElement | null;
      button?.addEventListener("click", end, { once: true });

      const hasRevealDuration =
        typeof trial.reveal_duration === "number" && trial.reveal_duration > 0;
      if (hasRevealDuration) {
        setTimeout(end, trial.reveal_duration as number);
      }
      if (trial.continue_label == null && !hasRevealDuration) {
        console.warn(
          "plugin-multiplayer-choice: `reveal` is on but neither `continue_label` nor " +
            "`reveal_duration` is set — the reveal screen has no way to advance."
        );
      }
    });
  }
}

/** Escape a string for safe interpolation into HTML text content. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The reveal is a small list, so ship a minimal scoped stylesheet with it so it isn't unstyled out of
// the box. Both reveal modes' rules ride together (their class names are disjoint). jsPsych replaces
// the display element's content each trial, so this never accumulates.
const REVEAL_STYLE = `<style id="jspsych-multiplayer-choice-style">
  .jspsych-multiplayer-choice-reveal-list { list-style: none; padding: 0; margin: 1em auto; max-width: 24em; }
  .jspsych-multiplayer-choice-reveal-item { padding: 0.3em 0.6em; }
  .jspsych-multiplayer-choice-reveal-item.is-self { font-weight: 700; background: #fff3bf; }
  .jspsych-multiplayer-choice-reveal-payoff { font-weight: 700; }
  .jspsych-multiplayer-choice-tally-list { list-style: none; padding: 0; margin: 1em auto; max-width: 28em; }
  .jspsych-multiplayer-choice-tally-item { position: relative; display: flex; align-items: center; gap: 0.6em; padding: 0.35em 0.6em; }
  .jspsych-multiplayer-choice-tally-label { flex: 1; text-align: left; z-index: 1; }
  .jspsych-multiplayer-choice-tally-count { z-index: 1; font-variant-numeric: tabular-nums; }
  .jspsych-multiplayer-choice-tally-bar { position: absolute; left: 0; top: 0; bottom: 0; background: #e7f5ff; z-index: 0; }
  .jspsych-multiplayer-choice-tally-item.is-winner { font-weight: 700; }
  .jspsych-multiplayer-choice-tally-item.is-winner .jspsych-multiplayer-choice-tally-bar { background: #d3f9d8; }
  .jspsych-multiplayer-choice-tally-item.is-tied { font-weight: 700; }
  .jspsych-multiplayer-choice-tally-item.is-tied .jspsych-multiplayer-choice-tally-bar { background: #fff3bf; }
  .jspsych-multiplayer-choice-tally-item.is-mine .jspsych-multiplayer-choice-tally-label::after { content: " (you)"; opacity: 0.6; font-weight: 400; }
  .jspsych-multiplayer-choice-tally-outcome.is-winner { color: #2b8a3e; }
  .jspsych-multiplayer-choice-tally-outcome.is-tie { color: #e8590c; }
  .jspsych-multiplayer-choice-tally-outcome.is-empty { color: #868e96; }
</style>`;

export default MultiplayerChoicePlugin;
