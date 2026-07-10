import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { Choice, GroupSessionData, collectChoices, countChosen } from "./choice-core";
import { MultiplayerApiLike } from "./multiplayer-api";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`). The pure-core helpers are exposed as statics on the
// plugin class below, so everything is reachable through that one default export.
export type { Choice } from "./choice-core";

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
    /** Reveal every player's choice after the barrier. `false` ends the trial as soon as the group has chosen. */
    reveal: { type: ParameterType.BOOL, default: true },
    /** Heading rendered above the reveal list (experimenter HTML), e.g. `"<h3>Everyone has chosen</h3>"`. */
    reveal_prompt: { type: ParameterType.HTML_STRING, default: null },
    /** Label of the button that ends the reveal. `null` hides it (then set `reveal_duration`, or the reveal can't advance). */
    continue_label: { type: ParameterType.STRING, default: "Continue" },
    /** If set, auto-advance the reveal after this many milliseconds instead of (or racing) the continue button. */
    reveal_duration: { type: ParameterType.INT, default: null },
    /**
     * `(participantId) => string` mapping an id to the name shown on the reveal list. FUNCTION is
     * deliberate — it stops jsPsych's dynamic-parameter machinery from CALLING the value. Null shows
     * the raw participantId. e.g. drive names from role output.
     */
    player_label: { type: ParameterType.FUNCTION, default: null },
    /**
     * Optional `(choices, me) => number` computing THIS client's payoff from the collected choices
     * (a `participantId -> { index, label }` map) plus this client's id. Return a finite number; it is
     * saved as `my_payoff` and shown on the reveal. Null (the default) skips payoffs entirely — the
     * plugin stays a pure decision primitive, and you can derive payoffs from `choices_by_player` in
     * `on_finish` instead. FUNCTION: see `player_label`.
     */
    payoff: { type: ParameterType.FUNCTION, default: null },
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
    /** Every player's choice at the barrier: `{ participantId: { index, label } }`. */
    choices_by_player: { type: ParameterType.OBJECT },
    /** Number of participants who had chosen when the barrier resolved (or the timeout fired). */
    n_players: { type: ParameterType.INT },
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
 * optionally reveals everyone's choices. It is the engine under simultaneous-move paradigms —
 * prisoner's dilemma, public-goods contributions, dictator/coordination games — and packages the
 * choose → push → wait → reveal flow as one declarative trial.
 *
 * The ranking-free pure core (`collectChoices`, `countChosen`) is reachable as static members, and an
 * optional `payoff` hook can score the round; with no hook the plugin stays a pure decision primitive
 * and you compute payoffs from `choices_by_player` in `on_finish`.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.pluginAPI.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-choice}
 */
class MultiplayerChoicePlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent helpers over a group snapshot. Usable standalone, today. */
  static collectChoices = collectChoices;
  static countChosen = countChosen;

  constructor(private jsPsych: JsPsych) {}

  // Async (returns a Promise): the trial has an interactive first phase and a barrier, so — like
  // plugin-multiplayer-sync — jsPsych does NOT auto-fire on_load; we invoke it once the choice
  // screen is rendered, and end the trial by calling finishTrial after the (optional) reveal.
  async trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    // The multiplayer API is flattened onto pluginAPI by jsPsych core (jsPsych#3694). The published
    // `jspsych` types don't carry it yet, so reach it through the local interface with one cast.
    const api = this.jsPsych.pluginAPI as unknown as MultiplayerApiLike;
    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-choice: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.pluginAPI.connect(adapter)) before this trial runs."
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

    const dataKey = trial.data_key;

    // --- Phase 1: this participant chooses ----------------------------------------------------
    const { index, rt } = await this.collectChoice(display_element, trial, on_load);
    const label = String(choices[index]);

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
      group = await api.wait((g) => countChosen(g, dataKey) >= expected, timeout);
    } catch (e) {
      // As with plugin-multiplayer-sync, wait() currently rejects only on timeout: proceed with a
      // partial snapshot rather than hanging, flag timed_out, preserve the message, run on_timeout.
      timedOut = true;
      waitError = e instanceof Error ? e.message : String(e);
      if (typeof trial.on_timeout === "function") trial.on_timeout(e);
      group = api.getAll();
    }
    const waitTime = Math.round(performance.now() - waitStart);

    const choicesByPlayer = collectChoices(group, dataKey);
    const myPayoff = this.computePayoff(trial, choicesByPlayer, me);

    const finish = () =>
      this.jsPsych.finishTrial({
        choice: label,
        choice_index: index,
        rt,
        wait_time: waitTime,
        choices_by_player: choicesByPlayer,
        n_players: Object.keys(choicesByPlayer).length,
        my_payoff: myPayoff,
        timed_out: timedOut,
        wait_error: waitError,
      });

    // --- Phase 3: reveal (optional) -----------------------------------------------------------
    if (!trial.reveal) {
      finish();
      return;
    }
    await this.showReveal(display_element, trial, me, choicesByPlayer, myPayoff);
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
          optionEls.forEach((el) => el.querySelector("button")?.setAttribute("disabled", "true"));
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

  /** Render everyone's choices and resolve when the participant continues (button or `reveal_duration`). */
  private showReveal(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    me: string,
    choices: Record<string, Choice>,
    myPayoff: number | null
  ): Promise<void> {
    return new Promise((resolve) => {
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

      const payoffLine =
        myPayoff != null
          ? `<p class="jspsych-multiplayer-choice-reveal-payoff">Your payoff: ${escapeHtml(
              String(myPayoff)
            )}</p>`
          : "";

      display_element.innerHTML = `
        ${REVEAL_STYLE}
        <div class="jspsych-multiplayer-choice-reveal">
          ${trial.reveal_prompt ?? ""}
          ${
            items
              ? `<ul class="jspsych-multiplayer-choice-reveal-list">${items}</ul>`
              : `<p class="jspsych-multiplayer-choice-reveal-empty">No choices to show.</p>`
          }
          ${payoffLine}
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
// the box. jsPsych replaces the display element's content each trial, so this never accumulates.
const REVEAL_STYLE = `<style id="jspsych-multiplayer-choice-style">
  .jspsych-multiplayer-choice-reveal-list { list-style: none; padding: 0; margin: 1em auto; max-width: 24em; }
  .jspsych-multiplayer-choice-reveal-item { padding: 0.3em 0.6em; }
  .jspsych-multiplayer-choice-reveal-item.is-self { font-weight: 700; background: #fff3bf; }
  .jspsych-multiplayer-choice-reveal-payoff { font-weight: 700; }
</style>`;

export default MultiplayerChoicePlugin;
