import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { GroupSessionData, MultiplayerApiLike, resolveMultiplayerApi } from "./multiplayer-api";
import { LeaderboardRow, buildLeaderboard, countReported } from "./scoreboard";
import { getLeaderboard, getMyRank, getMyScore, setMyStanding } from "./store";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`). The runtime helpers (the pure core + the standing
// accessors) are exposed as statics on the plugin class below, so everything is reachable through
// that one default export without deviating from the convention.
export type { LeaderboardRow, ScoreEntry, BuildOptions } from "./scoreboard";

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
     * Display name this client pushes for its own row. Dynamic (may be a function). Defaults to the
     * raw participantId. Peers see this name unless `display_label` overrides it at render time.
     */
    label: { type: ParameterType.STRING, default: null },
    /**
     * Session field each participant's score entry is stored under. Namespacing keeps the score from
     * colliding with other data a participant has pushed (a role, a chat log), and lets two
     * scoreboard trials in one timeline keep separate boards.
     */
    data_key: { type: ParameterType.STRING, default: "scoreboard" },
    /**
     * Wait until AT LEAST this many participants have reported a score before revealing the board (a
     * barrier, so no one sees a partial ranking). Set it to the total expected count. `null` reveals
     * immediately from whoever has reported so far — only sensible when an upstream barrier already
     * gathered everyone.
     */
    group_size: { type: ParameterType.INT, default: null },
    /**
     * Milliseconds to wait for `group_size` reporters before giving up. On expiry the board is still
     * shown (from whoever reported), flagged `timed_out: true` — an end screen should degrade to a
     * partial board rather than hang or blank. `null` waits forever (discouraged).
     */
    timeout: { type: ParameterType.INT, default: 30000 },
    /**
     * Hook run if `timeout` elapses before `group_size` reporters arrive, called with the jsPsych
     * instance just before the (partial) board is shown. Unlike the barrier siblings, the trial does
     * NOT end here — the board still renders, flagged `timed_out: true`, and ends on the button as
     * usual. A throwing hook is caught so it can't stop the board from rendering.
     */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
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
     * pushed labels. FUNCTION is deliberate — it stops jsPsych's dynamic-parameter machinery from
     * CALLING the value and substituting its return. e.g. drive names from role output:
     * `(id) => jsPsychMultiplayerRole.participantsByRole()[id] ?? id`.
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
    /** `true` **only** if `group_size` reporters were not reached before `timeout` (board may be partial). */
    timed_out: { type: ParameterType.BOOL },
    /** A non-timeout failure message (e.g. this client's score push failed); `null` otherwise. */
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
 * On timeout the board still renders (from whoever reported), flagged `timed_out: true`, so an end
 * screen degrades to a partial ranking rather than hanging or blanking.
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
    const api = resolveMultiplayerApi(this.jsPsych);
    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-scoreboard: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.multiplayer.connect(adapter)) before this trial runs."
      );
    }

    const dataKey = trial.data_key;

    if (trial.button_label == null) {
      console.warn(
        "plugin-multiplayer-scoreboard: `button_label` is null — the board has no button, so the " +
          "trial can never end. Provide a `button_label`."
      );
    }
    if (trial.group_size == null) {
      console.warn(
        "plugin-multiplayer-scoreboard: no `group_size` — the board reveals as soon as this client " +
          "reports, so it may be partial. Set `group_size` (the exact count) unless an upstream " +
          "barrier already gathered every peer's score."
      );
    }
    // `score` is meant to be auto-computed from this client's own prior data (a dynamic `score`
    // function), never typed in. If it didn't resolve to a finite number this client can't be ranked —
    // warn, but still let it view the board (it simply won't appear as a row).
    if (typeof trial.score !== "number" || !Number.isFinite(trial.score)) {
      console.warn(
        "plugin-multiplayer-scoreboard: `score` did not resolve to a finite number, so this client " +
          "won't be ranked on the board. `score` should be a number or a function returning one, e.g. " +
          "() => jsPsych.data.get().select('points').sum()."
      );
    }

    // Show the waiting message now; jsPsych fires on_load for this sync trial once trial() returns.
    display_element.innerHTML = trial.message;

    // Contribute this client's row. Read our own slot first and push the whole thing back with only
    // the score key changed: `push` REPLACES the slot, so spreading preserves any other data we've
    // pushed earlier (a role, a chat log). A non-finite score is pushed as-is and simply won't be
    // ranked (buildLeaderboard/countReported drop it), so it never counts toward `group_size`.
    const prev = api.get(me) ?? {};
    const payload: Record<string, unknown> = {
      ...prev,
      [dataKey]: {
        score: trial.score,
        ...(trial.label != null ? { label: String(trial.label) } : {}),
      },
    };

    const target = trial.group_size;
    const isReady =
      typeof target === "number"
        ? (g: GroupSessionData) => countReported(g, dataKey) >= target
        : () => true;

    // Fire-and-forget: the trial stays open (sync return) until the continue button calls finishTrial.
    void this.gather(display_element, trial, me, api, payload, isReady);
  }

  /**
   * Push this client's score, then wait for the barrier. Push and wait are kept SEPARATE so a
   * push/backend failure is distinguishable from a genuine barrier timeout: only our own timer firing
   * is a timeout (`timed_out: true` + `on_timeout`); a push failure — or a `wait` rejection — surfaces
   * as `error` on an otherwise-normal board and never fires `on_timeout`.
   */
  private async gather(
    display_element: HTMLElement,
    trial: TrialType<Info>,
    me: string,
    api: MultiplayerApiLike,
    payload: Record<string, unknown>,
    isReady: (g: GroupSessionData) => boolean
  ) {
    try {
      await api.push(payload);
    } catch (err) {
      // A push failure is NOT a timeout: record it as `error`, don't fire on_timeout, and still show
      // the board (from what we can see) so the participant is never soft-locked.
      console.error("plugin-multiplayer-scoreboard: failed to push this client's score", err);
      this.reveal(display_element, trial, me, api.getAll(), false, errorMessage(err));
      return;
    }

    // Impose the timeout ourselves (racing an own timer) so the three outcomes stay unambiguous: OUR
    // timer firing is the only thing that means "timeout"; a rejection from api.wait is always a
    // backend/disconnect error, never relabelled as one. Each branch reveals exactly once and is NOT
    // inside a catch, so a throw from reveal propagates rather than being misread as a timeout; a
    // synchronous throw from api.wait is caught by the helper and surfaces as `error`, not an
    // unhandled rejection that would soft-lock the trial.
    const timeoutMs = trial.timeout ?? undefined;
    // Hand api.wait a STRICTLY LONGER deadline (2×) than our own timer, purely as a subscription-
    // teardown backstop: our timer always fires first, so it stays the source of truth for `timed_out`
    // and the adapter's later expiry can never flip a genuine timeout into an `error`. Clamp to the
    // 32-bit setTimeout max so a huge `timeout` can't overflow the doubled delay into a near-zero one
    // (which would fire the backstop immediately and reintroduce that misclassification).
    const backstopMs = timeoutMs === undefined ? undefined : Math.min(timeoutMs * 2, 2_147_483_647);
    const outcome = await raceWaitAgainstTimeout(() => api.wait(isReady, backstopMs), timeoutMs);

    if (outcome.kind === "ready") {
      this.reveal(display_element, trial, me, outcome.group, false);
    } else if (outcome.kind === "timeout") {
      // A real timeout: run the hook, then degrade to a partial board rather than hanging or blanking.
      this.safeTimeoutHook(trial);
      this.reveal(display_element, trial, me, api.getAll(), true);
    } else {
      // Backend/disconnect error while waiting — NOT a timeout: surface it as `error`, no on_timeout.
      console.error("plugin-multiplayer-scoreboard: waiting for the group failed", outcome.err);
      this.reveal(display_element, trial, me, api.getAll(), false, errorMessage(outcome.err));
    }
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
    group: GroupSessionData,
    timedOut: boolean,
    error: string | null = null
  ) {
    const rows = buildLeaderboard(group, {
      dataKey: trial.data_key,
      self: me,
      sort: trial.sort === "asc" ? "asc" : "desc",
      tieMethod: trial.tie_method === "dense" ? "dense" : "standard",
    });
    const mine = rows.find((r) => r.isSelf);

    // Publish this client's standing for downstream trials before the participant even clicks on —
    // a following trial's conditional_function reads it as soon as this trial finishes.
    setMyStanding(rows, mine?.rank, mine?.score);

    display_element.innerHTML = this.renderBoard(trial, group, rows, timedOut);

    const finish = () =>
      this.jsPsych.finishTrial({
        leaderboard: rows,
        my_rank: mine?.rank ?? null,
        my_score: mine?.score ?? null,
        num_players: rows.length,
        timed_out: timedOut,
        error,
      });

    const button = display_element.querySelector(
      ".jspsych-multiplayer-scoreboard-button"
    ) as HTMLButtonElement | null;
    // If there's no button the trial cannot end (already warned in trial()); leave it displayed.
    button?.addEventListener("click", finish, { once: true });
  }

  private renderBoard(
    trial: TrialType<Info>,
    group: GroupSessionData,
    rows: LeaderboardRow[],
    timedOut: boolean
  ): string {
    // A throwing experimenter callback must fall back to the raw label/score, never propagate — an
    // uncaught throw here would abort rendering and leave the participant soft-locked on the waiting
    // screen with no continue button.
    const nameOf = (row: LeaderboardRow): string => {
      if (typeof trial.display_label === "function") {
        try {
          return String(trial.display_label(row.participantId, group));
        } catch (err) {
          console.error(
            "plugin-multiplayer-scoreboard: `display_label` threw; using the pushed label instead",
            err
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
            err
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
        ${
          timedOut
            ? `<p class="jspsych-multiplayer-scoreboard-timeout">Not everyone reported in time — showing who did.</p>`
            : ""
        }
        ${
          rows.length
            ? `<table class="jspsych-multiplayer-scoreboard-table"><thead>${header}</thead><tbody>${body}</tbody></table>`
            : `<p class="jspsych-multiplayer-scoreboard-empty">No scores to show.</p>`
        }
        ${
          trial.button_label != null
            ? `<button type="button" class="jspsych-multiplayer-scoreboard-button">${escapeHtml(
                trial.button_label
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

/** The three unambiguous outcomes of waiting for the group. */
type WaitOutcome =
  | { kind: "ready"; group: GroupSessionData }
  | { kind: "timeout" }
  | { kind: "error"; err: unknown };

/**
 * Wait for the group snapshot with the timeout imposed HERE (racing an own timer), so the outcome is
 * unambiguous: our timer firing is the ONLY "timeout", while a rejection from the wait is always a
 * backend/disconnect error. `timeoutMs === undefined` waits forever.
 *
 * Two subtleties this encodes:
 *   - Our timer stays the source of truth for `timed_out`. The caller is expected to give the adapter
 *     a STRICTLY LONGER deadline than `timeoutMs` (or none) so our timer fires first; the adapter's
 *     later expiry is only a subscription-teardown backstop and can't flip the verdict from "timeout"
 *     to "error". As secondary safety, our timer is also registered before `startWaiting()` runs, so
 *     even at an equal deadline ours would still win (equal-delay timers fire in registration order).
 *   - `startWaiting()` is invoked inside an async wrapper, so a SYNCHRONOUS throw (e.g. an adapter
 *     that throws when disconnected) becomes a rejected promise / `error` outcome, never an unhandled
 *     rejection that would soft-lock the trial. Both handlers are attached up front, so a late
 *     rejection after a timeout can never surface unhandled.
 */
async function raceWaitAgainstTimeout(
  startWaiting: () => Promise<GroupSessionData>,
  timeoutMs: number | undefined
): Promise<WaitOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut =
    timeoutMs === undefined
      ? null
      : new Promise<WaitOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" as const }), timeoutMs);
        });

  const settled: Promise<WaitOutcome> = (async () => startWaiting())().then(
    (group) => ({ kind: "ready" as const, group }),
    (err) => ({ kind: "error" as const, err })
  );

  if (timedOut === null) return settled;
  const outcome = await Promise.race([settled, timedOut]);
  clearTimeout(timer);
  return outcome;
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
