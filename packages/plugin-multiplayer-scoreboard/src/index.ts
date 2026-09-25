import {
  getMultiplayer,
  isMultiplayerError,
  Multiplayer,
  MultiplayerOutcome,
  outcomeOf,
  pluginTimeout,
  remainingParticipants,
  sealedGroupSize,
} from "@jspsych-multiplayer/utils";
import {
  GroupSessionData,
  JsPsych,
  JsPsychPlugin,
  ParameterType,
  PresenceData,
  TrialType,
} from "jspsych";

import { version } from "../package.json";
import { LeaderboardRow, buildLeaderboard, countReported } from "./scoreboard";
import { getLeaderboard, getMyRank, getMyScore, setMyStanding } from "./store";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`). The runtime helpers (the pure core + the standing
// accessors) are exposed as statics on the plugin class below, so everything is reachable through
// that one default export without deviating from the convention.
export type { LeaderboardRow, ScoreEntry, BuildOptions } from "./scoreboard";

/** The key each participant's score entry is stored under in the trial's shared data. */
const SCORE_KEY = "scoreboard";

const info = <const>{
  name: "multiplayer-scoreboard",
  version: version,
  parameters: {
    /**
     * This client's final score, **auto-computed from its own prior data** — a number or (typically) a
     * function jsPsych evaluates at trial start, e.g. `() => jsPsych.data.get().select("points").sum()`.
     * It is NOT entered by the participant. If it doesn't resolve to a finite number the client isn't
     * ranked (a console warning fires) but still sees the board.
     */
    score: { type: ParameterType.FLOAT, default: null },
    /**
     * Display name this client writes for its own row. Dynamic (may be a function). Defaults to the
     * raw participantId. Peers see this name unless `display_label` overrides it at render time.
     */
    label: { type: ParameterType.STRING, default: null },
    /**
     * Wait until AT LEAST this many participants have reported a score before revealing the board (a
     * barrier, so no one sees a partial ranking). Set it to the total expected count. Participants
     * who have left the session don't count. `null` (the default) means the members of a sealed
     * group (see `jsPsych.multiplayer.group()`) who haven't left; with a group that isn't sealed,
     * `null` reveals immediately from whoever has reported so far — only sensible when an upstream
     * barrier already gathered everyone.
     */
    group_size: { type: ParameterType.INT, default: null },
    /**
     * Milliseconds to wait for `group_size` reporters before giving up. On expiry the board is still
     * shown (from whoever reported), with `multiplayer_outcome: "timeout"` — an end screen should
     * degrade to a partial board rather than hang or blank. `null`, `0`, or a negative value waits
     * forever (discouraged).
     */
    timeout: { type: ParameterType.INT, default: 30000 },
    /**
     * Hook run if `timeout` elapses before `group_size` reporters arrive, called with the jsPsych
     * instance just before the (partial) board is shown. Unlike the barrier siblings, the trial does
     * NOT end here — the board still renders, with `multiplayer_outcome: "timeout"`, and ends on the
     * button as usual. A throwing hook is caught so it can't stop the board from rendering.
     */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
    /**
     * Participants the board depends on. If one of them leaves the session before `group_size`
     * reporters arrive, the board is shown from whoever reported, with `multiplayer_outcome:
     * "participant_left"`. Null (the default) means the other members of a sealed group who haven't
     * left, or else every other participant who is connected when this participant reports. Pass
     * `[]` to ignore departures.
     */
    participants: { type: ParameterType.COMPLEX, default: null },
    /** `"desc"` ranks highest score first (points); `"asc"` ranks lowest first (e.g. reaction time). */
    sort: { type: ParameterType.STRING, default: "desc" },
    /** How ties rank: `"standard"` competition ranking (1,2,2,4) or `"dense"` (1,2,2,3). */
    tie_method: { type: ParameterType.STRING, default: "standard" },
    /** Heading rendered above the board (experimenter-authored, so HTML is allowed). */
    title: { type: ParameterType.HTML_STRING, default: "<h2>Final scores</h2>" },
    /** Show the rank column. */
    show_rank: { type: ParameterType.BOOL, default: true },
    /** Visually emphasise this client's own row. */
    highlight_self: { type: ParameterType.BOOL, default: true },
    /**
     * `(id, group) => string` mapping any participantId to the name shown on their row, overriding
     * written labels. `group` is the session's shared data (what participants wrote with
     * `{ scope: "session" }`, e.g. a display name chosen in an earlier trial), keyed by
     * participantId; it is frozen, so don't modify it. FUNCTION is deliberate — it stops jsPsych's
     * dynamic-parameter machinery from CALLING the value and substituting its return. e.g. drive
     * names from role output: `(id) => jsPsychMultiplayerRole.participantsByRole()[id] ?? id`.
     */
    display_label: { type: ParameterType.FUNCTION, default: null },
    /**
     * `(score) => string` formatting each displayed score (the raw number is still saved in the
     * data). FUNCTION: see `display_label`. e.g. `(s) => s.toFixed(0) + " pts"`.
     */
    score_format: { type: ParameterType.FUNCTION, default: null },
    /** Label of the button that ends the trial. `null` hides it (then the trial cannot end — a warning fires). */
    button_label: { type: ParameterType.STRING, default: "Continue" },
    /** HTML shown while waiting for the group. */
    message: {
      type: ParameterType.HTML_STRING,
      default: "<p>Waiting for all players to finish…</p>",
    },
  },
  data: {
    /** The full ranked board: `[{ participantId, score, rank, label, isSelf }]`. */
    leaderboard: { type: ParameterType.OBJECT, array: true },
    /** This client's rank (1 = best); `null` if it did not report a score. */
    my_rank: { type: ParameterType.INT },
    /** This client's score; `null` if it did not report. */
    my_score: { type: ParameterType.FLOAT },
    /** Number of participants ranked on the board. */
    num_players: { type: ParameterType.INT },
    /**
     * How waiting for the group ended: `"completed"` when `group_size` reporters arrived,
     * `"timeout"`, `"participant_left"` (a participant in `participants` left), or
     * `"connection_lost"`; the board may be partial on any but `"completed"`. `null` when reporting
     * to the group failed some other way (see `error`).
     */
    multiplayer_outcome: { type: ParameterType.STRING },
    /** The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`. */
    left_participant: { type: ParameterType.STRING },
    /**
     * The message of any other failure while reporting to the group (e.g. an adapter error), which
     * still shows the board; `null` otherwise.
     */
    error: { type: ParameterType.STRING, default: null },
  },
  // When you run build on your plugin, citations will be generated here based on the CITATION.cff.
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/**
 * **plugin-multiplayer-scoreboard**
 *
 * An end-of-game scoreboard for multiplayer experiments. Each client contributes its final `score`,
 * the trial waits (a barrier) until the group has reported, then every client independently computes
 * the SAME ranked leaderboard from the shared group-session snapshot — no coordinator, no extra
 * round-trip — and renders it locally with its own row highlighted. A continue button ends the trial;
 * this client's rank/score and the full board are saved to the data record and published to the
 * accessor store for downstream trials.
 *
 * On timeout the board still renders (from whoever reported), with `multiplayer_outcome: "timeout"`,
 * so an end screen degrades to a partial ranking rather than hanging or blanking.
 *
 * The pure ranking core and the standing accessors are also reachable as static members
 * (`MultiplayerScoreboardPlugin.buildLeaderboard`, `.getMyRank`, `.getMyScore`, `.getLeaderboard`) —
 * usable standalone, today.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-scoreboard}
 */
class MultiplayerScoreboardPlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent ranking core. Usable standalone, today. */
  static buildLeaderboard = buildLeaderboard;

  // Standing accessors for downstream trials. These read the store this plugin populates, so they
  // return undefined until a scoreboard trial has finished.
  static getMyRank = () => getMyStanding().myRank;
  static getMyScore = () => getMyStanding().myScore;
  static getLeaderboard = () => getMyStanding().leaderboard;

  constructor(private jsPsych: JsPsych) {}

  // Deliberately synchronous (returns undefined, NOT a Promise): jsPsych races a returned promise
  // against `finishTrial()`, so a promise that resolves when the BARRIER lifts would end the trial
  // before the participant ever saw the board. A sync `trial` makes jsPsych fire `on_load` itself and
  // wait for the `finishTrial()` we call on the continue button (or, with no button, never — hence
  // the warning). The barrier is awaited internally.
  trial(display_element: HTMLElement, trial: TrialType<Info>) {
    const multiplayer = getMultiplayer(this.jsPsych, "plugin-multiplayer-scoreboard");
    const me = multiplayer.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-scoreboard: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.multiplayer.connect(adapter)) before this trial runs.",
      );
    }

    if (trial.button_label == null) {
      console.warn(
        "plugin-multiplayer-scoreboard: `button_label` is null — the board has no button, so the " +
          "trial can never end. Provide a `button_label`.",
      );
    }
    const target = trial.group_size ?? sealedGroupSize(multiplayer);
    if (target == null) {
      console.warn(
        "plugin-multiplayer-scoreboard: no `group_size` — the board reveals as soon as this client " +
          "reports, so it may be partial. Set `group_size` (the exact count), or seal the group " +
          "first (jsPsych.multiplayer.waitForGroup()), unless an upstream barrier already gathered " +
          "every peer's score.",
      );
    }
    // `score` is meant to be auto-computed from this client's own prior data (a dynamic `score`
    // function), never typed in. If it didn't resolve to a finite number this client can't be ranked —
    // warn, but still let it view the board (it simply won't appear as a row).
    if (typeof trial.score !== "number" || !Number.isFinite(trial.score)) {
      console.warn(
        "plugin-multiplayer-scoreboard: `score` did not resolve to a finite number, so this client " +
          "won't be ranked on the board. `score` should be a number or a function returning one, e.g. " +
          "() => jsPsych.data.get().select('points').sum().",
      );
    }

    // Show the waiting message now; jsPsych fires on_load for this sync trial once trial() returns.
    display_element.innerHTML = trial.message;

    // Contribute this client's row to the trial's shared data. `update` shallow-merges just the score
    // key, so anything else this client wrote in the trial survives. A non-finite score is written
    // as-is but crosses the wire as JSON, so NaN/Infinity read back as null; either way it simply
    // isn't ranked (buildLeaderboard/countReported drop it) and never counts toward `group_size`.
    const payload: Record<string, unknown> = {
      [SCORE_KEY]: {
        score: trial.score,
        ...(trial.label != null ? { label: String(trial.label) } : {}),
      },
    };

    const isReady =
      typeof target === "number"
        ? (g: GroupSessionData, presence: PresenceData) =>
            countReported(inSession(g, presence), SCORE_KEY) >= target
        : () => true;

    // Fire-and-forget: the trial stays open (sync return) until the continue button calls finishTrial.
    void this.gather(display_element, trial, me, multiplayer, payload, isReady);
  }

  /**
   * Write this client's score, then wait for the barrier, and reveal the board however that ends. A
   * timeout, a departure, or a lost connection shows a partial board with the matching outcome; any
   * other failure (e.g. an adapter error) shows the board with `error` set, so the participant is
   * never left on the waiting message.
   */
  private async gather(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    me: string,
    multiplayer: Multiplayer,
    payload: Record<string, unknown>,
    isReady: (g: GroupSessionData, presence: PresenceData) => boolean,
  ) {
    // Reads keep working after the connection is lost; they return the last state seen.
    const reveal = (group: GroupSessionData, outcome: Outcome) =>
      this.reveal(display_element, trial, me, multiplayer, group, outcome);

    let group: GroupSessionData;
    try {
      // The score shows up in this client's own reads at once, and the core keeps retrying the
      // write until the backend has it, so don't hold the barrier (and its timeout) for the
      // confirmation. It only fails if the session closes, which the wait reports too.
      multiplayer.update(payload).catch(() => {});
      const participants =
        (trial.participants as string[] | null) ?? remainingParticipants(multiplayer);
      group = await multiplayer.wait(isReady, {
        timeout: pluginTimeout(trial.timeout),
        participants,
      });
    } catch (err) {
      const outcome = outcomeOf(err);
      // The wait was cancelled (the trial or experiment ended or was aborted), so the trial is being
      // torn down: jsPsych has already cleared the display. Rendering here would paint a board over
      // a finished experiment.
      if (outcome === "cancelled") return;
      if (outcome === null) {
        // An adapter error or a write to a closed session: NOT a timeout, so no on_timeout.
        console.error("plugin-multiplayer-scoreboard: reporting to the group failed", err);
        reveal(multiplayer.getAll(), { outcome: null, error: errorMessage(err) });
        return;
      }
      if (outcome === "timeout") this.safeTimeoutHook(trial);
      reveal(multiplayer.getAll(), {
        outcome,
        left_participant: isMultiplayerError(err, "participant_left")
          ? (err.participantId ?? null)
          : null,
      });
      return;
    }
    reveal(group, { outcome: "completed" });
  }

  /** Fire the `on_timeout` hook if provided. A throwing hook must not stop the board from rendering. */
  private safeTimeoutHook(trial: TrialType<Info>) {
    try {
      if (trial.on_timeout) trial.on_timeout(this.jsPsych);
    } catch (err) {
      console.error("plugin-multiplayer-scoreboard: on_timeout hook threw", err);
    }
  }

  /** Build, render, and wire the board. `finishTrial` fires on the continue button. */
  private reveal(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    me: string,
    multiplayer: Multiplayer,
    group: GroupSessionData,
    outcome: Outcome,
  ) {
    // Rank whoever the barrier counted: participants who left aren't on the board
    const rows = buildLeaderboard(inSession(group, multiplayer.presence(), me), {
      dataKey: SCORE_KEY,
      self: me,
      sort: trial.sort === "asc" ? "asc" : "desc",
      tieMethod: trial.tie_method === "dense" ? "dense" : "standard",
    });
    const mine = rows.find((r) => r.isSelf);

    // Publish this client's standing for downstream trials before the participant even clicks on —
    // a following trial's conditional_function reads it as soon as this trial finishes.
    setMyStanding(rows, mine?.rank, mine?.score);

    // Names chosen in earlier trials live in the session's shared data, not this trial's
    const sessionData = multiplayer.getAll({ scope: "session" });
    display_element.innerHTML = this.renderBoard(trial, sessionData, rows, outcome);

    const finish = () =>
      this.jsPsych.finishTrial({
        leaderboard: rows,
        my_rank: mine?.rank ?? null,
        my_score: mine?.score ?? null,
        num_players: rows.length,
        multiplayer_outcome: outcome.outcome,
        left_participant: outcome.left_participant ?? null,
        error: outcome.error ?? null,
      });

    const button = display_element.querySelector(
      ".jspsych-multiplayer-scoreboard-button",
    ) as HTMLButtonElement | null;
    // If there's no button the trial cannot end (already warned in trial()); leave it displayed.
    button?.addEventListener("click", finish, { once: true });
  }

  private renderBoard(
    trial: TrialType<Info>,
    sessionData: GroupSessionData,
    rows: LeaderboardRow[],
    outcome: Outcome,
  ): string {
    // A throwing experimenter callback must fall back to the raw label/score, never propagate — an
    // uncaught throw here would abort rendering and leave the participant soft-locked on the waiting
    // screen with no continue button.
    const nameOf = (row: LeaderboardRow): string => {
      if (typeof trial.display_label === "function") {
        try {
          return String(trial.display_label(row.participantId, sessionData));
        } catch (err) {
          console.error(
            "plugin-multiplayer-scoreboard: `display_label` threw; using the written label instead",
            err,
          );
        }
      }
      return row.label;
    };
    const scoreOf = (row: LeaderboardRow): string => {
      if (typeof trial.score_format === "function") {
        try {
          return String(trial.score_format(row.score));
        } catch (err) {
          console.error(
            "plugin-multiplayer-scoreboard: `score_format` threw; using the raw score instead",
            err,
          );
        }
      }
      return String(row.score);
    };

    const body = rows
      .map((row) => {
        const cls =
          "jspsych-multiplayer-scoreboard-row" +
          (trial.highlight_self && row.isSelf ? " is-self" : "");
        const rankCell = trial.show_rank
          ? `<td class="jspsych-multiplayer-scoreboard-rank">${row.rank}</td>`
          : "";
        return (
          `<tr class="${cls}">${rankCell}` +
          `<td class="jspsych-multiplayer-scoreboard-name">${escapeHtml(nameOf(row))}</td>` +
          `<td class="jspsych-multiplayer-scoreboard-score">${escapeHtml(scoreOf(row))}</td></tr>`
        );
      })
      .join("");

    const header =
      `<tr>${trial.show_rank ? "<th>#</th>" : ""}` + `<th>Player</th><th>Score</th></tr>`;

    return `
      ${SCOREBOARD_STYLE}
      <div class="jspsych-multiplayer-scoreboard">
        ${trial.title}
        ${notice(outcome)}
        ${
          rows.length
            ? `<table class="jspsych-multiplayer-scoreboard-table"><thead>${header}</thead><tbody>${body}</tbody></table>`
            : `<p class="jspsych-multiplayer-scoreboard-empty">No scores to show.</p>`
        }
        ${
          trial.button_label != null
            ? `<button type="button" class="jspsych-multiplayer-scoreboard-button">${escapeHtml(
                trial.button_label,
              )}</button>`
            : ""
        }
      </div>`;
  }
}

/** Escape a string for safe interpolation into HTML text/attribute content. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Best-effort string form of a thrown value, for the `error` data field. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How waiting for the group ended. */
interface Outcome {
  /** Null when reporting to the group failed with an error that isn't a wait outcome. */
  outcome: Exclude<MultiplayerOutcome, "cancelled"> | null;
  left_participant?: string | null;
  error?: string | null;
}

/** The note shown above a board that was revealed before everyone reported, or "". */
function notice({ outcome }: Outcome): string {
  if (outcome === "timeout") {
    return `<p class="jspsych-multiplayer-scoreboard-timeout">Not everyone reported in time — showing who did.</p>`;
  }
  if (outcome === "participant_left") {
    return `<p class="jspsych-multiplayer-scoreboard-timeout">A player left before everyone reported — showing who did.</p>`;
  }
  if (outcome === "connection_lost") {
    return `<p class="jspsych-multiplayer-scoreboard-timeout">The connection was lost — showing the scores received so far.</p>`;
  }
  return "";
}

/**
 * The data of participants who haven't left. `self` always stays, even after its own connection
 * closes.
 */
function inSession(
  group: GroupSessionData,
  presence: PresenceData,
  self?: string,
): GroupSessionData {
  return Object.fromEntries(
    Object.entries(group).filter(([id]) => id === self || presence[id] !== "left"),
  );
}

// The board is inherently visual, so — unlike the text-first chat/role trials — ship a minimal scoped
// stylesheet inlined with the board markup so an unstyled table doesn't look broken out of the box.
// jsPsych replaces the display element's content each trial, so this never accumulates; the `id` is
// only a handle experimenters can target. They can still override every rule via the class names.
const SCOREBOARD_STYLE = `<style id="jspsych-multiplayer-scoreboard-style">
  .jspsych-multiplayer-scoreboard-table { border-collapse: collapse; margin: 1em auto; min-width: 18em; }
  .jspsych-multiplayer-scoreboard-table th,
  .jspsych-multiplayer-scoreboard-table td { padding: 0.4em 0.9em; text-align: left; }
  .jspsych-multiplayer-scoreboard-table thead th { border-bottom: 2px solid #888; }
  .jspsych-multiplayer-scoreboard-rank,
  .jspsych-multiplayer-scoreboard-score { text-align: right; font-variant-numeric: tabular-nums; }
  .jspsych-multiplayer-scoreboard-row.is-self { font-weight: 700; background: #fff3bf; }
  .jspsych-multiplayer-scoreboard-timeout { color: #b06a00; }
</style>`;

// One call site reads all three standing fields together, for the static accessors above.
function getMyStanding() {
  return { myRank: getMyRank(), myScore: getMyScore(), leaderboard: getLeaderboard() };
}

export default MultiplayerScoreboardPlugin;
