import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { ChatMessage, appendOwnMessage, mergeMessages } from "./chat-core";
import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import {
  InteractionEvent,
  ScoreResult,
  ScoringSpec,
  ScrambleMode,
  SlotAssignment,
  StimulusSpec,
  Submission,
  assignObject,
  displayOrder,
  isComplete,
  mergeRoundData,
  nextUnfilledSlot,
  readSubmission,
  runningScore,
  scoreAssignment,
} from "./reference-core";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`).
export type {
  InteractionEvent,
  ScoreResult,
  ScoringSpec,
  ScrambleMode,
  SlotAssignment,
  StimulusSpec,
  Submission,
} from "./reference-core";
export type { ChatMessage } from "./chat-core";

const info = <const>{
  name: "multiplayer-reference-game",
  version: version,
  parameters: {
    // ── Stimuli & display ───────────────────────────────────────────────────────────────────────
    /**
     * The shared object set (required). Each entry is `{ id, src?, html?, label? }`: `src` renders
     * an image URL, `html` renders inline SVG/HTML/emoji (experimenter-authored, so HTML is
     * allowed), otherwise `label` (or the id) renders as text. Length = number of objects on
     * screen (any N).
     */
    stimuli: {
      type: ParameterType.OBJECT,
      array: true,
      default: undefined,
    },
    /** Number of grid columns. Ignored when `rows` is set (columns are then derived). */
    columns: {
      type: ParameterType.INT,
      default: 6,
    },
    /** Number of grid rows; null derives the shape from `columns`. */
    rows: {
      type: ParameterType.INT,
      default: null,
    },
    /** Object display size in px; null lets the grid size itself. */
    cell_size: {
      type: ParameterType.INT,
      default: null,
    },
    /**
     * How the two layouts relate: `"independent"` (director and matcher see different scrambles —
     * the classic "you can't point by position" design), `"shared"` (identical layouts), or
     * `"matcher_only"` (director sees the canonical `stimuli` order, matcher a scramble).
     */
    scramble_mode: {
      type: ParameterType.STRING,
      default: "independent",
    },
    /**
     * Base seed mixed into the deterministic scramble. Null derives the seed from the round and
     * participant id alone. (The round and — in per-participant modes — the participantId are
     * ALWAYS mixed in, so a fixed seed does not collapse "independent" into "shared".)
     */
    seed: {
      type: ParameterType.STRING,
      default: null,
    },
    /** Show each object's `label` as a caption under it. */
    show_labels: {
      type: ParameterType.BOOL,
      default: false,
    },
    // ── Targets & scoring ───────────────────────────────────────────────────────────────────────
    /**
     * ORDERED target object ids (required). Length 1 = the classic click task; length ===
     * stimuli.length = the full-board match; any k in between works (k numbered answer slots).
     */
    targets: {
      type: ParameterType.STRING,
      array: true,
      default: undefined,
    },
    /**
     * Must the matcher reproduce the target ORDER (slot i must hold targets[i]), or only the set?
     * Null derives the classic defaults: true when k > 1, false when k = 1.
     */
    ordered: {
      type: ParameterType.BOOL,
      default: null,
    },
    /**
     * `"per_slot"` (count correct slots out of k), `"all_or_nothing"`, or a custom
     * `(assignment, targets) => number`. FUNCTION type is deliberate — it stops jsPsych's
     * dynamic-parameter machinery from CALLING the value and substituting its return. A string
     * preset is still a valid default/value; do NOT "fix" this to STRING.
     */
    scoring: {
      type: ParameterType.FUNCTION,
      default: "per_slot",
    },
    // ── Roles ───────────────────────────────────────────────────────────────────────────────────
    /**
     * This participant's role: `"director"` or `"matcher"` (required). Typically supplied
     * dynamically from the role plugin: `role: () => jsPsychMultiplayerRole.getMyRole()`.
     */
    role: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /** Display names for the two roles. */
    role_labels: {
      type: ParameterType.OBJECT,
      default: { director: "Director", matcher: "Matcher" },
    },
    /** Let the director click objects too (a local, unscored highlight — e.g. to think aloud). */
    director_can_select: {
      type: ParameterType.BOOL,
      default: false,
    },
    /** Who sees the target highlights before feedback: `"director"`, `"matcher"`, `"both"`, or `"none"`. */
    reveal_target_to: {
      type: ParameterType.STRING,
      default: "director",
    },
    // ── Communication (chat) ────────────────────────────────────────────────────────────────────
    /** Show the integrated free-text chat panel. */
    chat_enabled: {
      type: ParameterType.BOOL,
      default: true,
    },
    /** Who may SEND messages: `"director"`, `"matcher"`, or `"both"` (everyone always reads). */
    chat_role: {
      type: ParameterType.STRING,
      default: "both",
    },
    /** Cap on messages this participant may send during this trial. Null means no cap. */
    max_messages: {
      type: ParameterType.INT,
      default: null,
    },
    /** Optional maximum length, in characters, of a single message. Null means no limit. */
    max_length: {
      type: ParameterType.INT,
      default: null,
    },
    /** Placeholder text shown in the empty message input. */
    placeholder: {
      type: ParameterType.STRING,
      default: "Type a message…",
    },
    /**
     * Carry the chat transcript across rounds (one shared log) instead of starting each round's
     * panel empty (per-round log, namespaced by round).
     */
    chat_persists: {
      type: ParameterType.BOOL,
      default: false,
    },
    /** Where the chat panel sits relative to the grid: `"below"` or `"beside"`. */
    chat_position: {
      type: ParameterType.STRING,
      default: "below",
    },
    // ── Response & interaction ──────────────────────────────────────────────────────────────────
    /** `"click"` or `"assign_slots"`; null derives it from k (click when k = 1, slots when k > 1). */
    response_mode: {
      type: ParameterType.STRING,
      default: null,
    },
    /**
     * Submit as soon as the assignment is complete, without a Submit button. Null derives the
     * classic defaults: true when k = 1 (a click IS the answer), false when k > 1.
     */
    auto_submit: {
      type: ParameterType.BOOL,
      default: null,
    },
    /** Label of the Submit button (shown whenever auto_submit is off). */
    submit_label: {
      type: ParameterType.STRING,
      default: "Submit",
    },
    /** May the matcher revise an assignment before submitting? */
    allow_change: {
      type: ParameterType.BOOL,
      default: true,
    },
    /**
     * Matcher response limit in ms. On expiry the matcher's CURRENT (possibly partial) assignment
     * is submitted with `timed_out: true`, so both clients still reach feedback and end together.
     */
    selection_timeout: {
      type: ParameterType.INT,
      default: null,
    },
    // ── Feedback ────────────────────────────────────────────────────────────────────────────────
    /** Show feedback after the matcher submits. When false the trial ends immediately on submission. */
    feedback: {
      type: ParameterType.BOOL,
      default: true,
    },
    /** Which feedback elements to show: `{ reveal_target, show_score, show_partner_choice }`. */
    feedback_content: {
      type: ParameterType.OBJECT,
      default: { reveal_target: true, show_score: true, show_partner_choice: true },
    },
    /** Who sees feedback: `"director"`, `"matcher"`, or `"both"`. */
    feedback_to: {
      type: ParameterType.STRING,
      default: "both",
    },
    /** How long feedback stays up before the trial ends, in ms. Null shows a Continue button instead. */
    feedback_duration: {
      type: ParameterType.INT,
      default: 3000,
    },
    /** Show the cumulative score across rounds (summed from the matcher's pushed round data). */
    show_running_score: {
      type: ParameterType.BOOL,
      default: false,
    },
    // ── Text, data & robustness ─────────────────────────────────────────────────────────────────
    /**
     * Role-aware instructions rendered above the board: an HTML string, or `(role) => html`.
     * FUNCTION type is deliberate (see `scoring`) so jsPsych does not call the function early with
     * no arguments; a plain HTML string is still a valid value.
     */
    prompt: {
      type: ParameterType.FUNCTION,
      default: "",
    },
    /**
     * Round index (**required**). Must be UNIQUE per round in a timeline: per-round data is
     * namespaced under `data_key[round]`, so reusing an index would replay an earlier round's
     * submission. The trial fails loudly if this round already holds a submitted assignment. Usually
     * `round: jsPsych.timelineVariable("round")`.
     */
    round: {
      type: ParameterType.INT,
      default: undefined,
    },
    /**
     * Group-session field this trial stores its round data under. Namespacing keeps it from
     * colliding with other data a participant has pushed (a role, chat from another trial, …).
     */
    data_key: {
      type: ParameterType.STRING,
      default: "reference_game",
    },
    /** The partner's participantId. Null auto-detects the single other participant in the session. */
    partner_id: {
      type: ParameterType.STRING,
      default: null,
    },
    /** Save `my_order` / `partner_order` (the scrambled layouts) in the trial data. */
    save_orders: {
      type: ParameterType.BOOL,
      default: true,
    },
    /** Save the chat transcript in the trial data. */
    save_transcript: {
      type: ParameterType.BOOL,
      default: true,
    },
    /** Include the full group snapshot in the trial data. Off by default to avoid bloat. */
    save_group: {
      type: ParameterType.BOOL,
      default: false,
    },
    /**
     * Record the ordered log of the matcher's PRE-SUBMIT actions (every assign / reassign / clear,
     * with timestamps relative to trial start) as `interaction_history`. The log stays LOCAL until
     * submit — only the final assignment is ever pushed. Off by default to avoid bloat.
     */
    save_interaction_history: {
      type: ParameterType.BOOL,
      default: false,
    },
    /**
     * Whole-round time limit, in ms: if the trial has not reached feedback after this many ms it
     * ends with `ended_by: "timeout"` (and no assignment). This is the ONLY end path that survives a
     * partner disconnecting — the director cannot otherwise end itself, and `selection_timeout` lives
     * in the (possibly gone) matcher's tab. Null waits forever (the plugin warns when neither this
     * nor `selection_timeout` is set).
     */
    round_timeout: {
      type: ParameterType.INT,
      default: null,
    },
  },
  data: {
    /** This participant's role this round: `"director"` or `"matcher"`. */
    role: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /** The round index this trial ran as. */
    round: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** The ordered target object ids. */
    targets: {
      type: ParameterType.STRING,
      array: true,
      default: undefined,
    },
    /**
     * The matcher's submitted `slot -> objectId` map (1-based slots); for k = 1 just the one
     * clicked objectId as a bare string. Null if the trial ended without a submission. COMPLEX
     * because the value's shape depends on k (string when k = 1, object when k > 1).
     */
    assignment: {
      type: ParameterType.COMPLEX,
      default: undefined,
    },
    /** Number of correct slots per the configured scoring. Null without a submission. */
    n_correct: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** Number of targets (k). */
    n_targets: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** n_correct / n_targets. Null without a submission. */
    accuracy: {
      type: ParameterType.FLOAT,
      default: undefined,
    },
    /** True iff every slot was right. Null without a submission. */
    correct: {
      type: ParameterType.BOOL,
      default: undefined,
    },
    /** Matcher only: ms from trial start to submission. Null for the director. */
    rt: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** The chat transcript as this client saw it at trial end — only when `save_transcript`. */
    chat_transcript: {
      type: ParameterType.OBJECT,
      array: true,
      default: undefined,
    },
    /** Total number of distinct messages in this trial's transcript at trial end. */
    message_count: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** How many of those messages this participant sent. */
    messages_sent: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** This client's scrambled display order (object ids) — only when `save_orders`. */
    my_order: {
      type: ParameterType.STRING,
      array: true,
      default: undefined,
    },
    /** The partner's display order (computable locally, both seeds are known) — only when `save_orders`. */
    partner_order: {
      type: ParameterType.STRING,
      array: true,
      default: undefined,
    },
    /** What ended the trial: `"submit"` (the matcher submitted) or `"timeout"` (`round_timeout`/`selection_timeout`). */
    ended_by: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /**
     * Ordered log of the matcher's pre-submit actions (`{ t, action, slot, object_id }`) — only
     * when `save_interaction_history` is true and this client is the matcher; undefined otherwise.
     */
    interaction_history: {
      type: ParameterType.OBJECT,
      array: true,
      default: undefined,
    },
    /** The full group snapshot at trial end — only when `save_group`. */
    group: {
      type: ParameterType.OBJECT,
      default: undefined,
    },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;
type EndReason = "submit" | "timeout";
type Role = "director" | "matcher";

/** Class-name prefix, matching this repo's `jspsych-multiplayer-<plugin>-*` convention. */
const P = "jspsych-multiplayer-reference-game";

/**
 * **multiplayer-reference-game**
 *
 * A repeated referential communication game ("tangrams"; Hawkins, Frank & Goodman 2020, Cognitive
 * Science 44, e12845) for two players in fixed roles. Both see the same object set, each in an
 * independently scrambled layout; only the director sees which objects are targets (and, for more
 * than one, in what order). The players talk over an integrated free-text chat, the matcher assigns
 * objects to the director's ordered target slots (a single click when there is one target), and
 * both then see feedback with the true answer revealed.
 *
 * The published "sequential" (1 target, click) and "unconstrained" (all N targets, full-board
 * match) conditions are the same task with two parameters turned differently — `stimuli` length and
 * `targets` length — so this one configurable plugin covers both, plus everything in between.
 *
 * Like `plugin-multiplayer-chat`, the trial stays open and re-renders on every group-session
 * update: it subscribes to the shared session, merges the chat transcript, and watches for the
 * matcher's submitted assignment — the shared trigger on which both clients score, show feedback,
 * and end. Requires a connected multiplayer adapter — call `await jsPsych.pluginAPI.connect(adapter)`
 * before `jsPsych.run()`.
 *
 * @author Mandy Liao
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-reference-game multiplayer-reference-game plugin documentation}
 */
class MultiplayerReferenceGamePlugin implements JsPsychPlugin<Info> {
  static info = info;

  constructor(private jsPsych: JsPsych) {}

  // Deliberately synchronous (returns undefined, NOT a Promise): jsPsych races a returned promise
  // against `finishTrial()`, so an async `trial` that resolves after setup would end the trial
  // immediately. A sync `trial` makes jsPsych fire `on_load` itself and wait for `finishTrial()`.
  trial(display_element: HTMLElement, trial: TrialType<Info>) {
    // The multiplayer API is flattened onto pluginAPI by jsPsych core (jsPsych#3694). The published
    // `jspsych` types don't carry it yet, so reach it through the local interface with one cast.
    const api = this.jsPsych.pluginAPI as unknown as MultiplayerApiLike;
    const me = api.participantId;

    // --- Resolve & validate configuration -------------------------------------------------------
    const stimuli = (trial.stimuli ?? []) as unknown as StimulusSpec[];
    const targets = [...((trial.targets ?? []) as unknown as string[])];
    const ids = stimuli.map((s) => s?.id);
    const role = trial.role as Role;
    const round = trial.round as unknown as number;
    const dataKey = trial.data_key;
    const k = targets.length;

    if (
      !Array.isArray(stimuli) ||
      stimuli.length === 0 ||
      ids.some((id) => typeof id !== "string")
    ) {
      throw new Error(
        "multiplayer-reference-game: `stimuli` is required and every entry needs a string `id`."
      );
    }
    if (k === 0) {
      throw new Error("multiplayer-reference-game: `targets` is required and must not be empty.");
    }
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) {
      throw new Error("multiplayer-reference-game: `stimuli` ids must be unique.");
    }
    for (const t of targets) {
      if (!idSet.has(t)) {
        throw new Error(
          `multiplayer-reference-game: target "${t}" does not match any stimulus id.`
        );
      }
    }
    if (new Set(targets).size !== targets.length) {
      throw new Error("multiplayer-reference-game: `targets` must not contain duplicates.");
    }
    if (role !== "director" && role !== "matcher") {
      throw new Error(
        `multiplayer-reference-game: \`role\` must be "director" or "matcher" (got ${JSON.stringify(
          trial.role
        )}). Typically: role: () => jsPsychMultiplayerRole.getMyRole().`
      );
    }
    if (typeof round !== "number" || !Number.isFinite(round)) {
      throw new Error(
        "multiplayer-reference-game: `round` is required and must be a number. Use a UNIQUE index " +
          "per round, e.g. round: jsPsych.timelineVariable('round')."
      );
    }
    // Fail loud on a reused round index: per-round data is keyed by `round`, so if this round already
    // holds a submitted assignment, a later trial would replay that stale submission (jumping straight
    // to feedback) instead of running the round. Only a submitter (matcher) ever writes an assignment,
    // so this catches the "forgot to increment round" / duplicate-index bug on the client that owns it.
    if (readSubmission(api.getAll(), me, dataKey, round)) {
      throw new Error(
        `multiplayer-reference-game: round ${round} already has a submitted assignment in this ` +
          "participant's slot — round indices must be unique across the timeline (did `round` default " +
          "or repeat?)."
      );
    }

    const scrambleMode = (trial.scramble_mode ?? "independent") as ScrambleMode;
    const ordered = (trial.ordered as boolean | null) ?? k > 1;
    const scoring = trial.scoring as unknown as ScoringSpec;
    const responseMode =
      (trial.response_mode as string | null) ?? (k === 1 ? "click" : "assign_slots");
    const autoSubmit = (trial.auto_submit as boolean | null) ?? k === 1;
    const roleLabels = {
      director: "Director",
      matcher: "Matcher",
      ...((trial.role_labels as Record<string, string>) ?? {}),
    };
    const revealToMe = trial.reveal_target_to === "both" || trial.reveal_target_to === role;
    const chatOn = Boolean(trial.chat_enabled);
    const canSend = chatOn && (trial.chat_role === "both" || trial.chat_role === role);
    const showFeedback =
      Boolean(trial.feedback) && (trial.feedback_to === "both" || trial.feedback_to === role);
    const feedbackContent = {
      reveal_target: true,
      show_score: true,
      show_partner_choice: true,
      ...((trial.feedback_content as Record<string, boolean>) ?? {}),
    };
    // Per-round chat namespacing: with `chat_persists` every round shares one log; without it each
    // round gets its own key so the panel starts empty (old rounds' arrays stay in the slot,
    // harmlessly, under their own keys).
    const chatKey = trial.chat_persists ? `${dataKey}_chat` : `${dataKey}_chat_r${round}`;
    const seedBase = (trial.seed as string | null) ?? null;
    const columns =
      trial.rows != null && trial.rows > 0
        ? Math.ceil(stimuli.length / trial.rows)
        : trial.columns ?? 6;

    // Warn when the trial has NO bounded end path: without `round_timeout` (or `selection_timeout`), a
    // partner who never responds — or disconnects — leaves the trial (especially the director, which
    // cannot self-end) waiting forever.
    const hasRoundTimeout = typeof trial.round_timeout === "number" && trial.round_timeout > 0;
    const hasSelectionTimeout =
      typeof trial.selection_timeout === "number" && trial.selection_timeout > 0;
    if (!hasRoundTimeout && !hasSelectionTimeout) {
      console.warn(
        "multiplayer-reference-game: no `round_timeout` or `selection_timeout` set — if the partner " +
          "never responds (or disconnects) this trial cannot end. Set `round_timeout` to bound the round."
      );
    }

    // The partner: explicit `partner_id`, or auto-detected as THE single other participant. Never
    // guess among several — with a spectator/leftover slot present, picking the wrong one makes the
    // director watch the wrong slot (→ hang) or mislabel data. `let` because a legitimate partner may
    // not have propagated yet (0 candidates → null now, re-resolved in subscribe once they appear).
    const explicitPartner = trial.partner_id as string | null;
    let partner: string | null;
    if (explicitPartner != null) {
      partner = explicitPartner;
    } else {
      const others = Object.keys(api.getAll()).filter((id) => id !== me);
      if (others.length > 1) {
        throw new Error(
          "multiplayer-reference-game: cannot auto-detect the partner — " +
            `${others.length} other participants are present. Set \`partner_id\` explicitly ` +
            "(e.g. from plugin-multiplayer-role) so the trial does not guess."
        );
      }
      partner = others.length === 1 ? others[0] : null;
    }

    // This client's display order is deterministic in (seed, round, participant ids), so it is stable
    // across re-renders — and the partner's order is computable locally the same way (both ids are
    // known), which is how `partner_order` lands in the data without an extra push. Passing `partner`
    // makes "independent" mode GUARANTEE the two layouts differ (N>1).
    const myOrder = displayOrder(ids, role, scrambleMode, round, me, seedBase, partner);

    // --- Base styling (injected once) ------------------------------------------------------------
    // The plugin ships no separate CSS asset (matching this repo's other plugins' convention).
    const STYLE_ID = `${P}-styles`;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        .${P} { max-width: 60em; margin: 0 auto; }
        .${P}-main { display: flex; flex-direction: column; gap: 1em; }
        .${P}.is-beside .${P}-main { flex-direction: row; align-items: flex-start; justify-content: center; }
        .${P}.is-beside .${P}-chat { width: 18em; flex: none; }
        .${P}-role { font-weight: bold; margin: 0.5em 0; }
        .${P}-grid {
          display: grid;
          gap: 8px;
          justify-content: center;
          margin: 0 auto;
        }
        .${P}-cell {
          position: relative;
          border: 2px solid #ccc;
          border-radius: 6px;
          padding: 4px;
          cursor: pointer;
          background: #fff;
          box-sizing: border-box;
          user-select: none;
        }
        .${P}-cell-content { pointer-events: none; }
        .${P}-cell-content img, .${P}-cell-content svg { max-width: 100%; max-height: 100%; display: block; margin: 0 auto; }
        .${P}-cell-label { font-size: 0.75em; color: #555; text-align: center; pointer-events: none; }
        .${P}-cell.is-target { border-color: #e8a417; box-shadow: 0 0 0 2px rgba(232, 164, 23, 0.35); }
        .${P}-cell.is-assigned { border-color: #1971c2; box-shadow: 0 0 0 2px rgba(25, 113, 194, 0.3); }
        .${P}-cell.is-selected { border-color: #7048e8; }
        .${P}-cell.is-correct { border-color: #2b8a3e; box-shadow: 0 0 0 2px rgba(43, 138, 62, 0.35); }
        .${P}-cell.is-wrong { border-color: #c92a2a; box-shadow: 0 0 0 2px rgba(201, 42, 42, 0.35); }
        .${P}-badge {
          position: absolute;
          top: -8px;
          right: -8px;
          min-width: 18px;
          height: 18px;
          line-height: 18px;
          padding: 0 3px;
          border-radius: 9px;
          background: #1971c2;
          color: #fff;
          font-size: 12px;
          font-weight: bold;
          text-align: center;
          pointer-events: none;
        }
        .${P}-cell.is-target > .${P}-badge { background: #e8a417; }
        .${P}-mark {
          position: absolute;
          top: -8px;
          left: -8px;
          min-width: 18px;
          height: 18px;
          line-height: 18px;
          padding: 0 3px;
          border-radius: 9px;
          background: #1971c2;
          color: #fff;
          font-size: 12px;
          font-weight: bold;
          text-align: center;
          pointer-events: none;
        }
        .${P}-mark.is-correct { background: #2b8a3e; }
        .${P}-mark.is-wrong { background: #c92a2a; }
        .${P}-slots { display: flex; gap: 6px; justify-content: center; margin: 0.75em 0; flex-wrap: wrap; }
        .${P}-slot {
          min-width: 2.2em;
          padding: 4px 8px;
          border: 2px solid #ccc;
          border-radius: 6px;
          background: #fff;
          cursor: pointer;
          font: inherit;
        }
        .${P}-slot.is-active { border-color: #1971c2; box-shadow: 0 0 0 2px rgba(25, 113, 194, 0.3); }
        .${P}-slot.is-filled { background: #e7f0fa; }
        .${P}-controls { margin: 0.5em 0; }
        .${P}-submit, .${P}-continue { padding: 6px 18px; font: inherit; cursor: pointer; }
        .${P}-submit:disabled { cursor: default; opacity: 0.6; }
        .${P}-status { color: #555; min-height: 1.2em; margin: 0.4em 0; }
        .${P}-feedback { font-weight: bold; min-height: 1.2em; margin: 0.4em 0; }
        .${P}-feedback.is-correct { color: #2b8a3e; }
        .${P}-feedback.is-wrong { color: #c92a2a; }
        .${P}-chat-log {
          max-height: 14em;
          min-height: 6em;
          margin: 0 auto 0.5em;
          padding: 0.5em 0.75em;
          overflow-y: auto;
          text-align: left;
          border: 1px solid #ccc;
          border-radius: 4px;
        }
        .${P}-chat-message { display: block; margin-bottom: 0.4em; }
        .${P}-chat-sender { font-weight: bold; margin-right: 0.4em; }
        .${P}-chat-sender::after { content: ":"; }
        .${P}-chat-message.is-self .${P}-chat-sender { color: #2a6; }
        .${P}-chat-form { display: flex; gap: 0.5em; }
        .${P}-chat-input { flex: 1; font: inherit; }
        .${P}-chat-error { color: #c00; font-size: 0.9em; margin-top: 0.3em; }
      `;
      document.head.appendChild(style);
    }

    // --- Render the shell ------------------------------------------------------------------------
    const promptParam = trial.prompt as unknown as string | ((role: Role) => string) | null;
    const promptHtml =
      typeof promptParam === "function" ? String(promptParam(role)) : String(promptParam ?? "");

    display_element.innerHTML = `
      <div class="${P}${trial.chat_position === "beside" ? " is-beside" : ""}">
        ${promptHtml ? `<div class="${P}-prompt">${promptHtml}</div>` : ""}
        <div class="${P}-role"></div>
        <div class="${P}-main">
          <div class="${P}-board">
            <div class="${P}-grid"></div>
            <div class="${P}-slots" hidden></div>
            <div class="${P}-controls" hidden>
              <button type="button" class="${P}-submit" disabled></button>
            </div>
            <div class="${P}-status" aria-live="polite"></div>
            <div class="${P}-feedback" aria-live="polite"></div>
          </div>
          ${
            chatOn
              ? `<div class="${P}-chat">
                   <div class="${P}-chat-log" aria-live="polite"></div>
                   <form class="${P}-chat-form">
                     <input type="text" class="${P}-chat-input"
                            placeholder="${escapeAttr(trial.placeholder)}" autocomplete="off" />
                     <button type="submit" class="${P}-chat-send">Send</button>
                   </form>
                 </div>`
              : ""
          }
        </div>
      </div>`;

    const roleLine = display_element.querySelector(`.${P}-role`) as HTMLElement;
    const grid = display_element.querySelector(`.${P}-grid`) as HTMLElement;
    const slotsRow = display_element.querySelector(`.${P}-slots`) as HTMLElement;
    const controls = display_element.querySelector(`.${P}-controls`) as HTMLElement;
    const submitButton = display_element.querySelector(`.${P}-submit`) as HTMLButtonElement;
    const status = display_element.querySelector(`.${P}-status`) as HTMLElement;
    const feedbackEl = display_element.querySelector(`.${P}-feedback`) as HTMLElement;
    const chatLog = display_element.querySelector(`.${P}-chat-log`) as HTMLElement | null;
    const chatForm = display_element.querySelector(`.${P}-chat-form`) as HTMLFormElement | null;
    const chatInput = display_element.querySelector(`.${P}-chat-input`) as HTMLInputElement | null;

    roleLine.textContent = `You are the ${roleLabels[role]}.`; // textContent — labels are data
    submitButton.textContent = trial.submit_label;
    grid.style.gridTemplateColumns = `repeat(${columns}, ${
      trial.cell_size != null ? `${trial.cell_size}px` : "minmax(3em, 6em)"
    })`;

    // Grid cells, in THIS participant's scrambled order.
    const cellById = new Map<string, HTMLElement>();
    for (const id of myOrder) {
      const stim = stimuli.find((s) => s.id === id)!;
      const cell = document.createElement("div");
      cell.className = `${P}-cell`;
      cell.dataset.objectId = id;
      cell.setAttribute("role", "button");
      cell.tabIndex = 0;

      const content = document.createElement("div");
      content.className = `${P}-cell-content`;
      if (typeof stim.src === "string" && stim.src !== "") {
        const img = document.createElement("img");
        img.src = stim.src;
        img.alt = stim.label ?? stim.id;
        content.appendChild(img);
      } else if (typeof stim.html === "string" && stim.html !== "") {
        content.innerHTML = stim.html; // experimenter-authored stimulus markup — HTML is allowed
      } else {
        content.textContent = stim.label ?? stim.id;
      }
      cell.appendChild(content);

      // Top-right badge: target order (director hint, and revealed to both at feedback).
      const badge = document.createElement("span");
      badge.className = `${P}-badge`;
      badge.hidden = true;
      cell.appendChild(badge);

      // Top-left mark: the matcher's assigned slot. A SEPARATE element from the badge so, at feedback,
      // the correct target order and the matcher's choice can both show without overwriting each other.
      const mark = document.createElement("span");
      mark.className = `${P}-mark`;
      mark.hidden = true;
      cell.appendChild(mark);

      if (trial.show_labels) {
        const caption = document.createElement("div");
        caption.className = `${P}-cell-label`;
        caption.textContent = stim.label ?? stim.id; // textContent — labels may carry participant data
        cell.appendChild(caption);
      }

      grid.appendChild(cell);
      cellById.set(id, cell);
    }

    const badgeOf = (cell: HTMLElement) => cell.querySelector(`.${P}-badge`) as HTMLElement;
    const markOf = (cell: HTMLElement) => cell.querySelector(`.${P}-mark`) as HTMLElement;

    // Director view: highlight targets, with slot-number badges when there is an order to describe.
    if (revealToMe) {
      targets.forEach((id, i) => {
        const cell = cellById.get(id)!;
        cell.classList.add("is-target");
        if (k > 1) {
          const badge = badgeOf(cell);
          badge.textContent = String(i + 1);
          badge.hidden = false;
        }
      });
    }

    // Matcher UI: k numbered answer slots when k > 1; plain click when k = 1.
    const isMatcher = role === "matcher";
    if (isMatcher && responseMode === "assign_slots") {
      slotsRow.hidden = false;
      for (let s = 1; s <= k; s++) {
        const slot = document.createElement("button");
        slot.type = "button";
        slot.className = `${P}-slot`;
        slot.dataset.slot = String(s);
        slot.textContent = String(s);
        slotsRow.appendChild(slot);
      }
    }
    if (isMatcher && !autoSubmit) controls.hidden = false;

    status.textContent =
      role === "director"
        ? "Describe the highlighted object" +
          (k > 1 ? "s, in badge order, " : " ") +
          "to your partner."
        : k > 1
        ? "Click a numbered slot, then the object your partner describes for it. Fill every slot, then submit."
        : "Click the object your partner describes.";

    // --- Trial state -----------------------------------------------------------------------------
    const start = performance.now();
    let ended = false;
    let feedbackShown = false;
    let submitted = false; // matcher only: our push happened
    let assignment: SlotAssignment = {};
    let activeSlot = 1;
    const history: InteractionEvent[] = [];
    let finalScore: ScoreResult | null = null;
    let finalAssignment: SlotAssignment | null = null;
    let finalRt: number | null = null;
    let finalReason: "submit" | "timeout" = "submit";
    let unsubscribe: Unsubscribe | null = null;
    let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let roundTimer: ReturnType<typeof setTimeout> | null = null;

    // This participant's own outgoing chat sequence counter, seeded past the HIGHEST seq already in
    // our slot (e.g. after a reload) so ids stay unique (max-based, not length-based — see the chat
    // plugin).
    const readOwnMessages = (): ChatMessage[] =>
      mergeMessages({ [me]: api.get(me) ?? {} }, chatKey).filter((m) => m.senderId === me);
    let nextSeq = readOwnMessages().reduce((max, m) => Math.max(max, m.seq), -1) + 1;

    // --- Chat ------------------------------------------------------------------------------------
    const senderLabel = (senderId: string): string => {
      if (senderId === me) return "You";
      // Uses the once-resolved `partner` (updated in subscribe if it was null) rather than
      // re-resolving per message on every chat re-render.
      if (partner != null && senderId === partner) {
        return roleLabels[role === "director" ? "matcher" : "director"];
      }
      return senderId;
    };

    // Rebuild the transcript from scratch on each update. Idempotent (keyed by message id via
    // mergeMessages), so a subscribe replay that re-delivers seen messages changes nothing.
    function renderChat(group: GroupSessionData) {
      if (!chatLog) return;
      const transcript = mergeMessages(group, chatKey);
      const pinnedToBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 4;

      chatLog.replaceChildren(
        ...transcript.map((m) => {
          const row = document.createElement("div");
          row.className = `${P}-chat-message`;
          if (m.senderId === me) row.classList.add("is-self");

          const who = document.createElement("span");
          who.className = `${P}-chat-sender`;
          who.textContent = senderLabel(m.senderId); // textContent — never innerHTML

          const body = document.createElement("span");
          body.className = `${P}-chat-text`;
          body.textContent = m.text; // textContent — untrusted input, must not be parsed as HTML

          row.append(who, body);
          return row;
        })
      );

      if (pinnedToBottom) chatLog.scrollTop = chatLog.scrollHeight;
    }

    const atMessageCap = () =>
      typeof trial.max_messages === "number" &&
      trial.max_messages > 0 &&
      readOwnMessages().length >= trial.max_messages;

    const updateChatAvailability = () => {
      if (!chatInput || !chatForm) return;
      const send = chatForm.querySelector(`.${P}-chat-send`) as HTMLButtonElement;
      const blocked = !canSend || feedbackShown || atMessageCap();
      chatInput.disabled = blocked;
      send.disabled = blocked;
      if (!canSend) chatInput.placeholder = "You can only read messages.";
      else if (atMessageCap()) chatInput.placeholder = "Message limit reached.";
    };

    const onChatSubmit = (e: Event) => {
      e.preventDefault();
      if (ended || !canSend || !chatInput || atMessageCap()) return;
      let text = chatInput.value.trim();
      if (text === "") return;
      if (typeof trial.max_length === "number" && trial.max_length > 0) {
        text = text.slice(0, trial.max_length);
      }
      chatInput.value = "";

      // Read our OWN slot and push the whole thing back with only the chat key changed: `push`
      // REPLACES the slot, so spreading preserves everything else (joinedAt, earlier rounds, …).
      const mine = api.get(me) ?? {};
      const own = mergeMessages({ [me]: mine }, chatKey).filter((m) => m.senderId === me);
      const nextMessages = appendOwnMessage(own, text, me, nextSeq++, Date.now());

      // Optimistic render: show our own message immediately instead of waiting for the adapter to
      // echo the push back through subscribe. The echo (or a replay) is harmless because renderChat
      // is idempotent — mergeMessages de-duplicates by message id.
      renderChat({ ...api.getAll(), [me]: { ...mine, [chatKey]: nextMessages } });
      updateChatAvailability();

      // Best-effort send: a failed push shows an inline note rather than crashing the trial. Do NOT
      // roll nextSeq back on failure — a reused seq would forge a duplicate id that mergeMessages'
      // dedup silently drops. A skipped seq is harmless; a reused one loses data.
      api
        .push({ ...mine, [chatKey]: nextMessages })
        .catch(() => showError("Couldn't send — please try again."));
    };

    function showError(message: string) {
      let note = display_element.querySelector(`.${P}-chat-error`) as HTMLElement | null;
      if (!note) {
        note = document.createElement("div");
        note.className = `${P}-chat-error`;
        (chatForm ?? status).after(note);
      }
      note.textContent = message;
    }

    // --- Matcher interaction ---------------------------------------------------------------------
    const updateMatcherUi = () => {
      for (const [id, cell] of cellById) {
        const slot = Object.entries(assignment).find(([, oid]) => oid === id)?.[0];
        cell.classList.toggle("is-assigned", slot != null);
        // The matcher's live slot number goes on the top-left MARK, keeping the top-right badge free
        // for the (later revealed) target order — so the two never overwrite each other.
        const mark = markOf(cell);
        if (slot != null && k > 1) {
          mark.textContent = slot;
          mark.hidden = false;
        } else {
          mark.hidden = true;
        }
      }
      slotsRow.querySelectorAll(`.${P}-slot`).forEach((el) => {
        const button = el as HTMLButtonElement;
        const s = Number(button.dataset.slot);
        button.classList.toggle("is-active", s === activeSlot);
        button.classList.toggle("is-filled", typeof assignment[s] === "string");
      });
      submitButton.disabled = !isComplete(assignment, k);
    };

    const now = () => Math.round(performance.now() - start);

    const applyChange = (slot: number, objectId: string | null) => {
      const { next, events } = assignObject(assignment, slot, objectId, now());
      assignment = next;
      history.push(...events);
    };

    const submit = (reason: "submit" | "timeout") => {
      if (submitted || ended || !isMatcher) return;
      submitted = true;
      const rt = now();
      const score = scoreAssignment(assignment, targets, { ordered, scoring });
      // Only the FINAL assignment is pushed — the pre-submit action log stays local (it lands in the
      // trial data via save_interaction_history, never on the network). n_correct rides along so
      // both clients can show a cheap running score across rounds without re-knowing past targets.
      const payload: Record<string, unknown> = {
        assignment,
        rt,
        n_correct: score.nCorrect,
        n_targets: k,
        ...(reason === "timeout" ? { timed_out: true } : {}),
      };
      const mine = api.get(me) ?? {};
      api
        .push(mergeRoundData(mine, dataKey, round, payload))
        .catch(() => showError("Couldn't submit — connection trouble."));
      // Optimistic: enter feedback immediately rather than waiting for the adapter to echo the push.
      enterFeedback({ assignment, rt, timed_out: reason === "timeout" });
    };

    const onGridClick = (e: Event) => {
      const cell = (e.target as HTMLElement).closest?.(`.${P}-cell`) as HTMLElement | null;
      if (!cell || !grid.contains(cell) || ended || feedbackShown) return;
      const objectId = cell.dataset.objectId!;

      if (!isMatcher) {
        // Director clicks are a no-op (or a local, unscored highlight when director_can_select).
        if (trial.director_can_select) cell.classList.toggle("is-selected");
        return;
      }
      if (submitted) return;

      if (responseMode === "click") {
        if (!trial.allow_change && assignment[1] != null) return;
        applyChange(1, assignment[1] === objectId ? null : objectId);
      } else {
        if (assignment[activeSlot] === objectId) {
          // Toggle: clicking the object already in the active slot clears it.
          if (!trial.allow_change) return;
          applyChange(activeSlot, null);
        } else {
          const occupied =
            assignment[activeSlot] != null || Object.values(assignment).includes(objectId);
          if (!trial.allow_change && occupied) return;
          applyChange(activeSlot, objectId);
          const next = nextUnfilledSlot(assignment, k, activeSlot);
          if (next != null) activeSlot = next;
        }
      }
      updateMatcherUi();
      if (autoSubmit && isComplete(assignment, k)) submit("submit");
    };

    const onGridKeydown = (e: Event) => {
      const key = (e as KeyboardEvent).key;
      if (key !== "Enter" && key !== " ") return;
      const cell = (e.target as HTMLElement).closest?.(`.${P}-cell`);
      if (!cell) return;
      e.preventDefault();
      onGridClick(e);
    };

    const onSlotsClick = (e: Event) => {
      const button = (e.target as HTMLElement).closest?.(`.${P}-slot`) as HTMLButtonElement | null;
      if (!button || ended || feedbackShown || submitted) return;
      activeSlot = Number(button.dataset.slot);
      updateMatcherUi();
    };

    const onSubmitClick = () => {
      if (!isComplete(assignment, k)) return;
      submit("submit");
    };

    // --- Feedback & ending -----------------------------------------------------------------------
    function renderFeedback(sub: Submission, score: ScoreResult) {
      // Clear any live assignment marks so the two feedback channels — the correct target ORDER
      // (top-right badge) and the matcher's CHOICE (top-left mark) — never overwrite each other.
      for (const cell of cellById.values()) {
        const badge = badgeOf(cell);
        badge.hidden = true;
        badge.textContent = "";
        const mark = markOf(cell);
        mark.hidden = true;
        mark.textContent = "";
        mark.classList.remove("is-correct", "is-wrong");
      }
      // Reveal the true answer: target highlights (now on BOTH sides), with the correct order on the
      // badge…
      if (feedbackContent.reveal_target) {
        targets.forEach((id, i) => {
          const cell = cellById.get(id)!;
          cell.classList.add("is-target");
          if (k > 1) {
            const badge = badgeOf(cell);
            badge.textContent = String(i + 1);
            badge.hidden = false;
          }
        });
      }
      // …and the matcher's choices on the mark (its slot number), correct slots green, wrong red — so
      // a cell that is both a target and a (mis)placed pick shows BOTH the correct order and where the
      // matcher put it.
      if (feedbackContent.show_partner_choice) {
        for (const [slotStr, id] of Object.entries(sub.assignment)) {
          const cell = cellById.get(id);
          if (!cell) continue;
          const slot = Number(slotStr);
          const right = ordered ? targets[slot - 1] === id : targets.includes(id);
          cell.classList.add(right ? "is-correct" : "is-wrong");
          if (k > 1) {
            const mark = markOf(cell);
            mark.textContent = String(slot);
            mark.classList.add(right ? "is-correct" : "is-wrong");
            mark.hidden = false;
          }
        }
      }
      if (feedbackContent.show_score) {
        const summary =
          k === 1
            ? score.correct
              ? "Correct!"
              : "Incorrect."
            : `Score: ${score.nCorrect} / ${score.nTargets}`;
        const timedOut = sub.timed_out ? " (time ran out)" : "";
        let running = "";
        if (trial.show_running_score) {
          const matcherId = isMatcher ? me : partner;
          const total = runningScore(matcherId ? api.getAll()[matcherId] : undefined, dataKey);
          running = ` — total so far: ${total}`;
        }
        feedbackEl.textContent = `${summary}${timedOut}${running}`;
        feedbackEl.classList.add(score.correct ? "is-correct" : "is-wrong");
      }
      status.textContent = "";
    }

    function enterFeedback(sub: Submission) {
      if (feedbackShown || ended) return;
      feedbackShown = true;
      finalAssignment = sub.assignment;
      finalScore = scoreAssignment(sub.assignment, targets, { ordered, scoring });
      finalReason = sub.timed_out ? "timeout" : "submit";
      if (isMatcher) finalRt = typeof sub.rt === "number" ? sub.rt : null;
      if (selectionTimer != null) clearTimeout(selectionTimer);
      if (roundTimer != null) clearTimeout(roundTimer);
      submitButton.disabled = true;
      updateChatAvailability();

      if (!showFeedback) {
        end(finalReason);
        return;
      }
      renderFeedback(sub, finalScore);
      const duration = trial.feedback_duration as number | null;
      if (typeof duration === "number" && duration > 0) {
        feedbackTimer = setTimeout(() => end(finalReason), duration);
      } else {
        const cont = document.createElement("button");
        cont.type = "button";
        cont.className = `${P}-continue`;
        cont.textContent = "Continue";
        // Continue only ADVANCES past feedback; it does not change WHY the round ended. Preserve the
        // underlying reason ("submit"/"timeout") so a played round is never mislabelled.
        cont.addEventListener("click", () => end(finalReason));
        feedbackEl.after(cont);
      }
    }

    const end = (reason: EndReason) => {
      if (ended) return; // guard against a second trigger (e.g. a timer racing the Continue button)
      ended = true;
      unsubscribe?.();
      if (feedbackTimer != null) clearTimeout(feedbackTimer);
      if (selectionTimer != null) clearTimeout(selectionTimer);
      if (roundTimer != null) clearTimeout(roundTimer);
      grid.removeEventListener("click", onGridClick);
      grid.removeEventListener("keydown", onGridKeydown);
      slotsRow.removeEventListener("click", onSlotsClick);
      submitButton.removeEventListener("click", onSubmitClick);
      chatForm?.removeEventListener("submit", onChatSubmit);

      const group = api.getAll();
      const transcript = mergeMessages(group, chatKey);
      const data: Record<string, unknown> = {
        role,
        round,
        targets: [...targets],
        assignment:
          finalAssignment == null ? null : k === 1 ? finalAssignment[1] ?? null : finalAssignment,
        n_correct: finalScore?.nCorrect ?? null,
        n_targets: k,
        accuracy: finalScore?.accuracy ?? null,
        correct: finalScore?.correct ?? null,
        rt: finalRt,
        message_count: transcript.length,
        messages_sent: transcript.filter((m) => m.senderId === me).length,
        ended_by: reason,
      };
      if (trial.save_transcript) data.chat_transcript = transcript;
      if (trial.save_orders) {
        data.my_order = myOrder;
        data.partner_order = partner
          ? displayOrder(
              ids,
              role === "director" ? "matcher" : "director",
              scrambleMode,
              round,
              partner,
              seedBase,
              me
            )
          : null;
      }
      if (trial.save_interaction_history && isMatcher) data.interaction_history = history;
      if (trial.save_group) data.group = group;
      this.jsPsych.finishTrial(data);
    };

    // --- Wire up ---------------------------------------------------------------------------------
    grid.addEventListener("click", onGridClick);
    grid.addEventListener("keydown", onGridKeydown);
    slotsRow.addEventListener("click", onSlotsClick);
    submitButton.addEventListener("click", onSubmitClick);
    chatForm?.addEventListener("submit", onChatSubmit);
    if (isMatcher) updateMatcherUi();
    updateChatAvailability();

    // Seed the chat from existing history, then subscribe. `subscribe` replays the current snapshot
    // on registration, so the seed is belt-and-suspenders — harmless because renderChat is
    // idempotent (and enterFeedback is guarded).
    renderChat(api.getAll());

    unsubscribe = api.subscribe((group) => {
      if (ended) return;
      // Resolve the partner once it propagates (only when auto-detecting and still unknown, and only
      // to the SINGLE other participant — never guess among several).
      if (partner == null && explicitPartner == null) {
        const others = Object.keys(group).filter((id) => id !== me);
        if (others.length === 1) partner = others[0];
      }
      try {
        renderChat(group);
      } catch {
        // A bad render frame must not tear down the subscription or the trial.
      }
      try {
        if (!feedbackShown) {
          const matcherId = isMatcher ? me : partner;
          const sub = matcherId ? readSubmission(group, matcherId, dataKey, round) : undefined;
          if (sub) enterFeedback(sub);
        }
      } catch {
        // A malformed frame must not propagate into the adapter's notify loop.
      }
    });

    if (isMatcher && typeof trial.selection_timeout === "number" && trial.selection_timeout > 0) {
      selectionTimer = setTimeout(() => {
        if (!submitted && !feedbackShown && !ended) submit("timeout");
      }, trial.selection_timeout);
    }
    if (hasRoundTimeout) {
      roundTimer = setTimeout(() => {
        if (!feedbackShown && !ended) end("timeout");
      }, trial.round_timeout as number);
    }
  }
}

/** Escape a string for safe interpolation into a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default MultiplayerReferenceGamePlugin;
