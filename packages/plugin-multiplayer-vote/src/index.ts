import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { MultiplayerApiLike } from "./multiplayer-api";
import {
  GroupSessionData,
  OptionTally,
  WinnerResult,
  countVoted,
  plurality,
  tally,
} from "./vote-core";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`). The pure-core helpers are exposed as statics on the
// plugin class below, so everything is reachable through that one default export.
export type { OptionTally, Vote, WinnerResult } from "./vote-core";

const info = <const>{
  name: "multiplayer-vote",
  version: version,
  parameters: {
    /**
     * The options every participant votes among. An array of button contents (HTML allowed, since it
     * is experimenter-authored) — the same shape as jsPsych's `html-button-response` `choices`. The
     * zero-based index of the clicked option is the canonical value shared with the group; its label
     * rides along for display. Required.
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
     * Session field this participant's vote is stored under. Namespacing keeps it from colliding with
     * other pushed data (a role, a chat log) and lets two vote trials keep separate ballots.
     */
    data_key: { type: ParameterType.STRING, default: "vote" },
    /**
     * The group size — including this participant — that must vote before the barrier lifts and the
     * tally is revealed. Set it to the exact expected count. Required.
     */
    expected_players: { type: ParameterType.INT, default: undefined },
    /** HTML shown after this participant has voted, while waiting for the rest of the group. */
    waiting_message: {
      type: ParameterType.HTML_STRING,
      default: "<p>Waiting for the other players to vote…</p>",
    },
    /**
     * Milliseconds to wait for the group AFTER this participant votes. On expiry the trial proceeds
     * with whoever voted so far, flagged `timed_out: true`, and `on_timeout` fires. Null (or a
     * non-positive value) waits indefinitely. Does not bound how long this participant takes to vote.
     */
    timeout: { type: ParameterType.INT, default: null },
    /** Called with the wait rejection if `timeout` elapses before the whole group has voted. */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
    /** Reveal the tally + winner after the barrier. `false` ends the trial as soon as the group has voted. */
    reveal: { type: ParameterType.BOOL, default: true },
    /** Heading rendered above the tally (experimenter HTML), e.g. `"<h3>The votes are in</h3>"`. */
    reveal_prompt: { type: ParameterType.HTML_STRING, default: null },
    /** Label of the button that ends the reveal. `null` hides it (then set `reveal_duration`, or the reveal can't advance). */
    continue_label: { type: ParameterType.STRING, default: "Continue" },
    /** If set, auto-advance the reveal after this many milliseconds instead of (or racing) the continue button. */
    reveal_duration: { type: ParameterType.INT, default: null },
  },
  data: {
    /** This participant's chosen option label. */
    vote: { type: ParameterType.STRING },
    /** Zero-based index of this participant's chosen option. */
    vote_index: { type: ParameterType.INT },
    /** Time from the options appearing to this participant clicking one, in milliseconds. */
    rt: { type: ParameterType.INT },
    /** Time spent waiting for the rest of the group after voting, in milliseconds. */
    wait_time: { type: ParameterType.INT },
    /** The anonymous tally at the barrier: one `{ index, label, count }` per option, in `choices` order. */
    tally: { type: ParameterType.OBJECT },
    /** The plurality winner (`{ index, label, count }`), or `null` on a tie or when no votes were cast. */
    winner: { type: ParameterType.OBJECT, default: null },
    /** `true` when two or more options shared the top count, so there is no single winner. */
    is_tie: { type: ParameterType.BOOL, default: false },
    /** The options sharing the top count when `is_tie` is true (`choices` order); empty otherwise. */
    tied_options: { type: ParameterType.OBJECT },
    /** Total number of valid votes counted when the barrier resolved (or the timeout fired). */
    n_votes: { type: ParameterType.INT },
    /** `true` if the trial proceeded because `timeout` elapsed rather than because everyone had voted. */
    timed_out: { type: ParameterType.BOOL, default: false },
    /** The `wait()` rejection message when the barrier ended without the full group; `null` otherwise. */
    wait_error: { type: ParameterType.STRING, default: null },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/**
 * **multiplayer-vote**
 *
 * An anonymous group poll for multiplayer experiments. Every participant votes for one of the same
 * options, the trial pushes that vote and waits (a barrier) until the whole group has voted, then
 * optionally reveals the aggregate tally and the plurality winner. It is the engine under group
 * decisions and consensus paradigms — majority-rule choices, "vote for the next round", opinion polls
 * — and packages the vote → push → wait → reveal-tally flow as one declarative trial.
 *
 * Unlike `plugin-multiplayer-choice`, the vote is **anonymous**: the data and reveal carry counts per
 * option and the winner, never a participant → vote mapping. The ranking-free pure core (`tally`,
 * `plurality`, `countVoted`) is reachable as static members and reusable standalone.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.pluginAPI.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-vote}
 */
class MultiplayerVotePlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent helpers over a group snapshot. Usable standalone, today. */
  static tally = tally;
  static plurality = plurality;
  static countVoted = countVoted;

  constructor(private jsPsych: JsPsych) {}

  // Async (returns a Promise): the trial has an interactive first phase and a barrier, so — like
  // plugin-multiplayer-choice — jsPsych does NOT auto-fire on_load; we invoke it once the vote
  // screen is rendered, and end the trial by calling finishTrial after the (optional) reveal.
  async trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    // The multiplayer API is flattened onto pluginAPI by jsPsych core (jsPsych#3694). The published
    // `jspsych` types don't carry it yet, so reach it through the local interface with one cast.
    const api = this.jsPsych.pluginAPI as unknown as MultiplayerApiLike;
    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-vote: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.pluginAPI.connect(adapter)) before this trial runs."
      );
    }

    const choices = trial.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error(
        "plugin-multiplayer-vote: `choices` is required and must be a non-empty array of option labels."
      );
    }
    const expected = trial.expected_players;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      throw new Error(
        "plugin-multiplayer-vote: `expected_players` is required and must be a positive integer " +
          "(the group size, including this participant, that must vote before the barrier lifts)."
      );
    }

    const dataKey = trial.data_key;
    const labels = choices.map(String);

    // --- Phase 1: this participant votes ------------------------------------------------------
    const { index, rt } = await this.collectVote(display_element, trial, on_load);
    const label = labels[index];

    // --- Phase 2: push the vote, then barrier on the whole group ------------------------------
    // Read our own slot first and push the whole thing back with only the vote key changed: `push`
    // REPLACES the slot, so spreading preserves any other data we pushed earlier (a role, a chat log).
    const prev = api.get(me) ?? {};
    const payload: Record<string, unknown> = { ...prev, [dataKey]: { index, label } };
    // Push BEFORE the wait try/catch: a push failure is an infrastructure error, not a barrier
    // timeout, and must surface loudly (rejecting the trial) rather than being relabeled `timed_out`.
    await api.push(payload);

    display_element.innerHTML = `<div class="jspsych-multiplayer-vote-waiting">${trial.waiting_message}</div>`;
    const waitStart = performance.now();
    const timeout =
      typeof trial.timeout === "number" && trial.timeout > 0 ? trial.timeout : undefined;

    let group: GroupSessionData;
    let timedOut = false;
    let waitError: string | null = null;
    try {
      // Bound the count by the option range (labels.length) so the barrier counts exactly the votes
      // `tally` will count — a stale/out-of-range index (e.g. under a reused data_key) neither lifts
      // the barrier early nor is silently dropped from n_votes afterward.
      group = await api.wait((g) => countVoted(g, dataKey, labels.length) >= expected, timeout);
    } catch (e) {
      // Distinguish a genuine barrier timeout from any other wait() rejection. jsPsych#3694 rejects a
      // timeout with a `MultiplayerTimeoutError` (matched by name, which survives two loaded copies of
      // jspsych); a wait() can otherwise reject because the condition predicate threw or the backend
      // failed. ONLY a timeout proceeds with a partial snapshot (flag timed_out, preserve the message,
      // run on_timeout) — any other rejection is a real fault and rethrows so the trial halts loudly
      // rather than masquerading as a timeout.
      if ((e as { name?: string })?.name !== "MultiplayerTimeoutError") throw e;
      timedOut = true;
      waitError = e instanceof Error ? e.message : String(e);
      if (typeof trial.on_timeout === "function") trial.on_timeout(e);
      group = api.getAll();
    }
    const waitTime = Math.round(performance.now() - waitStart);

    const tallyResult = tally(group, dataKey, labels);
    const winnerResult = plurality(tallyResult);

    const finish = () =>
      this.jsPsych.finishTrial({
        vote: label,
        vote_index: index,
        rt,
        wait_time: waitTime,
        tally: tallyResult,
        winner: winnerResult.winner,
        is_tie: winnerResult.isTie,
        tied_options: winnerResult.tied,
        n_votes: winnerResult.totalVotes,
        timed_out: timedOut,
        wait_error: waitError,
      });

    // --- Phase 3: reveal (optional) -----------------------------------------------------------
    if (!trial.reveal) {
      finish();
      return;
    }
    await this.showReveal(display_element, trial, index, tallyResult, winnerResult);
    finish();
  }

  /** Render the option buttons and resolve with the clicked index + reaction time. */
  private collectVote(
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
          return `<div class="jspsych-multiplayer-vote-option">${markup}</div>`;
        })
        .join("");

      display_element.innerHTML = `
        <div class="jspsych-multiplayer-vote">
          ${
            trial.prompt ? `<div class="jspsych-multiplayer-vote-prompt">${trial.prompt}</div>` : ""
          }
          <div class="jspsych-multiplayer-vote-options">${optionsHtml}</div>
        </div>`;

      // jsPsych only auto-fires on_load for synchronous trials; this trial() returns a Promise, so
      // fire it ourselves now that the vote screen is on screen.
      on_load?.();

      const shownAt = performance.now();
      const optionEls = display_element.querySelectorAll<HTMLElement>(
        ".jspsych-multiplayer-vote-option"
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
          // Disable every option so a second selection can't be made after the vote is committed.
          optionEls.forEach((el) => el.querySelector("button")?.setAttribute("disabled", "true"));
          resolve({ index: i, rt: Math.round(performance.now() - shownAt) });
        });
      });
    });
  }

  /** Render the anonymous tally + winner and resolve when the participant continues (button or `reveal_duration`). */
  private showReveal(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    myIndex: number,
    counts: OptionTally[],
    result: WinnerResult
  ): Promise<void> {
    return new Promise((resolve) => {
      const total = result.totalVotes;
      const tiedIndices = new Set(result.tied.map((option) => option.index));

      // Option labels come from the trial's own `choices` (experimenter-authored, HTML allowed —
      // rendered raw exactly as the vote buttons are). The vote is anonymous, so no peer-pushed text
      // is ever rendered here; there is no untrusted string to escape.
      const items = counts
        .map((option) => {
          const classes = ["jspsych-multiplayer-vote-reveal-item"];
          if (result.winner?.index === option.index) classes.push("is-winner");
          if (tiedIndices.has(option.index)) classes.push("is-tied");
          if (option.index === myIndex) classes.push("is-mine");
          const pct = total > 0 ? Math.round((option.count / total) * 100) : 0;
          const noun = option.count === 1 ? "vote" : "votes";
          return `<li class="${classes.join(" ")}">
            <span class="jspsych-multiplayer-vote-reveal-label">${option.label}</span>
            <span class="jspsych-multiplayer-vote-reveal-bar" style="width:${pct}%"></span>
            <span class="jspsych-multiplayer-vote-reveal-count">${option.count} ${noun}</span>
          </li>`;
        })
        .join("");

      let summary: string;
      if (result.winner) {
        summary = `<p class="jspsych-multiplayer-vote-reveal-outcome is-winner">Winner: <strong>${result.winner.label}</strong> (${result.winner.count} of ${total})</p>`;
      } else if (result.isTie) {
        const names = result.tied.map((option) => option.label).join(", ");
        summary = `<p class="jspsych-multiplayer-vote-reveal-outcome is-tie">Tie between ${names} (${result.tied[0].count} each)</p>`;
      } else {
        summary = `<p class="jspsych-multiplayer-vote-reveal-outcome is-empty">No votes were cast.</p>`;
      }

      display_element.innerHTML = `
        ${REVEAL_STYLE}
        <div class="jspsych-multiplayer-vote-reveal">
          ${trial.reveal_prompt ?? ""}
          <ul class="jspsych-multiplayer-vote-reveal-list">${items}</ul>
          ${summary}
          ${
            trial.continue_label != null
              ? `<button type="button" class="jspsych-btn jspsych-multiplayer-vote-continue">${escapeHtml(
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
        ".jspsych-multiplayer-vote-continue"
      ) as HTMLButtonElement | null;
      button?.addEventListener("click", end, { once: true });

      const hasRevealDuration =
        typeof trial.reveal_duration === "number" && trial.reveal_duration > 0;
      if (hasRevealDuration) {
        setTimeout(end, trial.reveal_duration as number);
      }
      if (trial.continue_label == null && !hasRevealDuration) {
        console.warn(
          "plugin-multiplayer-vote: `reveal` is on but neither `continue_label` nor " +
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

// The reveal is a small tally, so ship a minimal scoped stylesheet with it so it isn't unstyled out
// of the box. jsPsych replaces the display element's content each trial, so this never accumulates.
const REVEAL_STYLE = `<style id="jspsych-multiplayer-vote-style">
  .jspsych-multiplayer-vote-reveal-list { list-style: none; padding: 0; margin: 1em auto; max-width: 28em; }
  .jspsych-multiplayer-vote-reveal-item { position: relative; display: flex; align-items: center; gap: 0.6em; padding: 0.35em 0.6em; }
  .jspsych-multiplayer-vote-reveal-label { flex: 1; text-align: left; z-index: 1; }
  .jspsych-multiplayer-vote-reveal-count { z-index: 1; font-variant-numeric: tabular-nums; }
  .jspsych-multiplayer-vote-reveal-bar { position: absolute; left: 0; top: 0; bottom: 0; background: #e7f5ff; z-index: 0; }
  .jspsych-multiplayer-vote-reveal-item.is-winner { font-weight: 700; }
  .jspsych-multiplayer-vote-reveal-item.is-winner .jspsych-multiplayer-vote-reveal-bar { background: #d3f9d8; }
  .jspsych-multiplayer-vote-reveal-item.is-tied { font-weight: 700; }
  .jspsych-multiplayer-vote-reveal-item.is-tied .jspsych-multiplayer-vote-reveal-bar { background: #fff3bf; }
  .jspsych-multiplayer-vote-reveal-item.is-mine .jspsych-multiplayer-vote-reveal-label::after { content: " (you)"; opacity: 0.6; font-weight: 400; }
  .jspsych-multiplayer-vote-reveal-outcome.is-winner { color: #2b8a3e; }
  .jspsych-multiplayer-vote-reveal-outcome.is-tie { color: #e8590c; }
  .jspsych-multiplayer-vote-reveal-outcome.is-empty { color: #868e96; }
</style>`;

export default MultiplayerVotePlugin;
