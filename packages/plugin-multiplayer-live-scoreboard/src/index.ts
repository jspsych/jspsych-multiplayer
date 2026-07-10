import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import { LeaderboardRow, buildLeaderboard } from "./scoreboard";
import { getLeaderboard, getMyRank, getMyScore, setMyStanding } from "./store";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`). The runtime helpers (the pure core + the standing
// accessors) are exposed as statics on the plugin class below, so everything is reachable through
// that one default export without deviating from the convention.
export type { LeaderboardRow, ScoreEntry, BuildOptions } from "./scoreboard";

const info = <const>{
  name: "multiplayer-live-scoreboard",
  version: version,
  parameters: {
    /**
     * This client's score, **auto-computed from its own prior data** — a number or (typically) a
     * function jsPsych evaluates at trial start, e.g. `() => jsPsych.data.get().select("points").sum()`.
     * It is NOT entered by the participant. It is pushed ONCE, at trial start: the live-ness of this
     * board is about watching OTHER players' rows arrive, not about changing your own score. If it
     * doesn't resolve to a finite number the client isn't ranked (a console warning fires) but still
     * sees the board.
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
    /** `"desc"` ranks highest score first (points); `"asc"` ranks lowest first (e.g. reaction time). */
    sort: { type: ParameterType.STRING, default: "desc" },
    /** How ties rank: `"standard"` competition ranking (1,2,2,4) or `"dense"` (1,2,2,3). */
    tie_method: { type: ParameterType.STRING, default: "standard" },
    /** Heading rendered above the board (experimenter-authored, so HTML is allowed). */
    title: { type: ParameterType.HTML_STRING, default: "<h2>Live scores</h2>" },
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
    /**
     * Auto-end the trial after this many milliseconds. Null (or non-positive) means no time limit —
     * in which case you must provide `end_button_label` and/or `end_when`, or the board never closes.
     */
    duration: { type: ParameterType.INT, default: null },
    /** If set, show a button with this label that ends the trial when clicked. Null hides it. */
    end_button_label: { type: ParameterType.STRING, default: null },
    /**
     * Predicate `(group) => boolean` evaluated against the full group session on every update; the
     * trial ends as soon as it returns true. Useful for "close when everyone has reported" — e.g.
     * `(g) => Object.keys(g).length >= 4`.
     */
    end_when: { type: ParameterType.FUNCTION, default: null },
    /**
     * Total number of players expected to report, used ONLY to render a "N of M reported" caption so
     * viewers know how many rows are still to come. It does NOT gate rendering — there is no barrier,
     * the board shows whoever has reported so far. Null → the caption shows just "N reported".
     */
    expected_players: { type: ParameterType.INT, default: null },
  },
  data: {
    /** The full ranked board as this client saw it at trial end: `[{ participantId, score, rank, label, isSelf }]`. */
    leaderboard: { type: ParameterType.OBJECT, array: true },
    /** This client's rank (1 = best) at trial end; `null` if it did not report a score. */
    my_rank: { type: ParameterType.INT },
    /** This client's score; `null` if it did not report. */
    my_score: { type: ParameterType.FLOAT },
    /** Number of participants ranked on the board at trial end. */
    num_players: { type: ParameterType.INT },
    /** What ended the trial: `"duration"`, `"button"`, or `"condition"`. */
    ended_by: { type: ParameterType.STRING },
    /** A failure message if this client's initial score push failed; `null` otherwise. */
    error: { type: ParameterType.STRING, default: null },
  },
  // When you run build on your plugin, citations will be generated here based on the CITATION.cff.
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;
type EndReason = "duration" | "button" | "condition";

/**
 * **plugin-multiplayer-live-scoreboard**
 *
 * A live-updating scoreboard for multiplayer experiments. Unlike the barrier-based end-of-game
 * `plugin-multiplayer-scoreboard`, this trial stays open and re-renders on every group-session
 * update: it pushes this client's own score once, subscribes to the shared session, and re-ranks the
 * board from the snapshot every time a peer reports — so participants watch the standings fill in and
 * climb in real time. A "N reported" caption tracks how many players have arrived.
 *
 * It is a **standalone trial screen** that owns the display while open — NOT a persistent overlay
 * across other trials (that overlay form would need jsPsych *extension* infrastructure this repo does
 * not yet have). Ideal for a lobby, an intermission, or a shared "watch the scores climb" screen.
 *
 * The trial ends on any configured condition: a `duration` timeout, an `end_button_label` click, or
 * an `end_when` predicate over the group session becoming true. This client's own score is FIXED at
 * trial start (pushed once) — the live-ness is about watching OTHER players' rows arrive, not about
 * changing your own score.
 *
 * The pure ranking core and the standing accessors are also reachable as static members
 * (`MultiplayerLiveScoreboardPlugin.buildLeaderboard`, `.getMyRank`, `.getMyScore`,
 * `.getLeaderboard`) — usable standalone, today.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.pluginAPI.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-live-scoreboard}
 */
class MultiplayerLiveScoreboardPlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent ranking core. Usable standalone, today. */
  static buildLeaderboard = buildLeaderboard;

  // Standing accessors for downstream trials. These read the store this plugin populates (on each
  // live render and at finish), so they return undefined until a scoreboard trial has rendered.
  static getMyRank = () => getMyStanding().myRank;
  static getMyScore = () => getMyStanding().myScore;
  static getLeaderboard = () => getMyStanding().leaderboard;

  constructor(private jsPsych: JsPsych) {}

  // Deliberately synchronous (returns undefined, NOT a Promise): jsPsych races a returned promise
  // against `finishTrial()`, so an async `trial` that resolves after setup would end the trial
  // immediately. A sync `trial` makes jsPsych fire `on_load` itself and wait for the `finishTrial()`
  // we call on an end condition (button / duration / end_when).
  trial(display_element: HTMLElement, trial: TrialType<Info>) {
    // The multiplayer API is flattened onto pluginAPI by jsPsych core (jsPsych#3694). The published
    // `jspsych` types don't carry it yet, so reach it through the local interface with one cast.
    const api = this.jsPsych.pluginAPI as unknown as MultiplayerApiLike;
    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-live-scoreboard: no participantId — the multiplayer adapter must be " +
          "connected (await jsPsych.pluginAPI.connect(adapter)) before this trial runs."
      );
    }

    const dataKey = trial.data_key;

    const hasDuration = typeof trial.duration === "number" && trial.duration > 0;
    if (!hasDuration && trial.end_button_label == null && typeof trial.end_when !== "function") {
      console.warn(
        "plugin-multiplayer-live-scoreboard: no `duration`, `end_button_label`, or `end_when` set — " +
          "the board has no way to close. Provide at least one end condition."
      );
    }
    // `score` is meant to be auto-computed from this client's own prior data (a dynamic `score`
    // function), never typed in. If it didn't resolve to a finite number this client can't be ranked —
    // warn, but still let it watch the board (it simply won't appear as a row).
    if (typeof trial.score !== "number" || !Number.isFinite(trial.score)) {
      console.warn(
        "plugin-multiplayer-live-scoreboard: `score` did not resolve to a finite number, so this " +
          "client won't be ranked on the board. `score` should be a number or a function returning " +
          "one, e.g. () => jsPsych.data.get().select('points').sum()."
      );
    }

    // --- Render the shell ONCE ----------------------------------------------------------------
    // Only the inner board container is rebuilt on each update, so the end-button listener attached
    // to the shell below survives every re-render.
    display_element.innerHTML = `
      ${SCOREBOARD_STYLE}
      <div class="jspsych-multiplayer-live-scoreboard">
        ${trial.title}
        <div class="jspsych-multiplayer-live-scoreboard-board"></div>
        <div class="jspsych-multiplayer-live-scoreboard-caption" aria-live="polite"></div>
        ${
          trial.end_button_label != null
            ? `<button type="button" class="jspsych-multiplayer-live-scoreboard-end"></button>`
            : ""
        }
      </div>`;

    const root = display_element.querySelector(
      ".jspsych-multiplayer-live-scoreboard"
    ) as HTMLElement;
    const board = display_element.querySelector(
      ".jspsych-multiplayer-live-scoreboard-board"
    ) as HTMLElement;
    const caption = display_element.querySelector(
      ".jspsych-multiplayer-live-scoreboard-caption"
    ) as HTMLElement;
    const endButton = display_element.querySelector(
      ".jspsych-multiplayer-live-scoreboard-end"
    ) as HTMLButtonElement | null;
    if (endButton && trial.end_button_label != null) endButton.textContent = trial.end_button_label;

    let ended = false;
    let error: string | null = null;
    let unsubscribe: Unsubscribe | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const buildRows = (group: GroupSessionData): LeaderboardRow[] =>
      buildLeaderboard(group, {
        dataKey,
        self: me,
        sort: trial.sort === "asc" ? "asc" : "desc",
        tieMethod: trial.tie_method === "dense" ? "dense" : "standard",
      });

    // --- Rendering ----------------------------------------------------------------------------
    // Rebuild ONLY the board container's innerHTML each update, and update the caption text, so the
    // end-button listener on the shell persists. Publish this client's live standing every render so
    // a downstream conditional_function reads the latest ranking, not just the final one.
    const render = (group: GroupSessionData) => {
      const rows = buildRows(group);
      const mine = rows.find((r) => r.isSelf);
      setMyStanding(rows, mine?.rank, mine?.score);
      board.innerHTML = renderTable(trial, group, rows);
      // rows.length IS the reporter count: buildLeaderboard emits exactly one row per participant
      // with a valid score, the same set countReported would tally — so reuse it, no second scan.
      caption.textContent = captionText(rows.length, trial.expected_players);
    };

    // --- Ending -------------------------------------------------------------------------------
    const end = (reason: EndReason) => {
      if (ended) return; // guard against a second trigger (e.g. timer racing a button)
      ended = true;
      unsubscribe?.();
      if (timer != null) clearTimeout(timer);
      endButton?.removeEventListener("click", onEndClick);

      const group = api.getAll();
      const rows = buildRows(group);
      const mine = rows.find((r) => r.isSelf);
      this.jsPsych.finishTrial({
        leaderboard: rows,
        my_rank: mine?.rank ?? null,
        my_score: mine?.score ?? null,
        num_players: rows.length,
        ended_by: reason,
        error,
      });
    };

    const onEndClick = () => end("button");

    const showPushError = () => {
      let note = root.querySelector(
        ".jspsych-multiplayer-live-scoreboard-error"
      ) as HTMLElement | null;
      if (!note) {
        note = document.createElement("div");
        note.className = "jspsych-multiplayer-live-scoreboard-error";
        root.appendChild(note);
      }
      note.textContent = "Couldn't report your score — others' scores still update.";
    };

    // --- Wire up --------------------------------------------------------------------------------
    endButton?.addEventListener("click", onEndClick);

    // Contribute this client's row ONCE. Read our own slot first and push the whole thing back with
    // only the score key changed: `push` REPLACES the slot, so spreading preserves any other data we
    // pushed earlier (a role, a chat log). Best-effort — a failed push shows an inline note, records
    // `error`, and keeps watching (this client just won't have a row), rather than tearing the trial
    // down. A non-finite score is pushed as-is and simply won't be ranked.
    const prev = api.get(me) ?? {};
    const payload: Record<string, unknown> = {
      ...prev,
      [dataKey]: {
        score: trial.score,
        ...(trial.label != null ? { label: String(trial.label) } : {}),
      },
    };
    api.push(payload).catch((err) => {
      console.error("plugin-multiplayer-live-scoreboard: failed to push this client's score", err);
      error = errorMessage(err);
      showPushError();
    });

    // Seed from the current snapshot, then subscribe. `subscribe` replays the current snapshot on
    // registration, so the seed is belt-and-suspenders — harmless because render is idempotent.
    render(api.getAll());
    // Evaluate end_when once against the seed snapshot. Guard the call exactly like the subscribe
    // callback below: the session is often already populated at load (peers reported first), so a
    // predicate that throws on a non-empty group must not propagate out of trial() and soft-lock it.
    let endAtLoad = false;
    try {
      endAtLoad = typeof trial.end_when === "function" && Boolean(trial.end_when(api.getAll()));
    } catch {
      // A throwing end_when at load must not tear down the trial before it renders.
    }
    if (endAtLoad) {
      end("condition");
      return;
    }

    unsubscribe = api.subscribe((group) => {
      if (ended) return;
      try {
        render(group);
      } catch {
        // A bad render frame must not tear down the subscription or the trial.
      }
      let shouldEnd = false;
      try {
        shouldEnd = typeof trial.end_when === "function" && Boolean(trial.end_when(group));
      } catch {
        // A throwing end_when predicate must not propagate into the adapter's notify loop.
      }
      if (shouldEnd) end("condition");
    });

    if (hasDuration) {
      timer = setTimeout(() => end("duration"), trial.duration as number);
    }
  }
}

/**
 * Build the HTML for the board region (the table, or an empty-state note). Factored out of the shell
 * so it can be re-injected into the board container on every update without touching the surrounding
 * shell (which carries the persistent end-button listener).
 */
function renderTable(
  trial: TrialType<Info>,
  group: GroupSessionData,
  rows: LeaderboardRow[]
): string {
  // A throwing experimenter callback must fall back to the raw label/score, never propagate — an
  // uncaught throw here would abort the render frame.
  const nameOf = (row: LeaderboardRow): string => {
    if (typeof trial.display_label === "function") {
      try {
        return String(trial.display_label(row.participantId, group));
      } catch (err) {
        console.error(
          "plugin-multiplayer-live-scoreboard: `display_label` threw; using the pushed label instead",
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
          "plugin-multiplayer-live-scoreboard: `score_format` threw; using the raw score instead",
          err
        );
      }
    }
    return String(row.score);
  };

  if (!rows.length) {
    return `<p class="jspsych-multiplayer-live-scoreboard-empty">No scores to show.</p>`;
  }

  const body = rows
    .map((row) => {
      const cls =
        "jspsych-multiplayer-live-scoreboard-row" +
        (trial.highlight_self && row.isSelf ? " is-self" : "");
      const rankCell = trial.show_rank
        ? `<td class="jspsych-multiplayer-live-scoreboard-rank">${row.rank}</td>`
        : "";
      return (
        `<tr class="${cls}">${rankCell}` +
        `<td class="jspsych-multiplayer-live-scoreboard-name">${escapeHtml(nameOf(row))}</td>` +
        `<td class="jspsych-multiplayer-live-scoreboard-score">${escapeHtml(
          scoreOf(row)
        )}</td></tr>`
      );
    })
    .join("");

  const header = `<tr>${trial.show_rank ? "<th>#</th>" : ""}<th>Player</th><th>Score</th></tr>`;

  return (
    `<table class="jspsych-multiplayer-live-scoreboard-table">` +
    `<thead>${header}</thead><tbody>${body}</tbody></table>`
  );
}

/** The "N reported" (or "N of M reported") caption text. */
function captionText(reported: number, expected: number | null): string {
  const of = typeof expected === "number" && Number.isFinite(expected) ? ` of ${expected}` : "";
  return `${reported}${of} reported`;
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

// The board is inherently visual, so — unlike the text-first chat/role trials — ship a minimal scoped
// stylesheet inlined with the board markup so an unstyled table doesn't look broken out of the box.
// jsPsych replaces the display element's content each trial, so this never accumulates; the `id` is
// only a handle experimenters can target. They can still override every rule via the class names.
const SCOREBOARD_STYLE = `<style id="jspsych-multiplayer-live-scoreboard-style">
  .jspsych-multiplayer-live-scoreboard-table { border-collapse: collapse; margin: 1em auto; min-width: 18em; }
  .jspsych-multiplayer-live-scoreboard-table th,
  .jspsych-multiplayer-live-scoreboard-table td { padding: 0.4em 0.9em; text-align: left; }
  .jspsych-multiplayer-live-scoreboard-table thead th { border-bottom: 2px solid #888; }
  .jspsych-multiplayer-live-scoreboard-rank,
  .jspsych-multiplayer-live-scoreboard-score { text-align: right; font-variant-numeric: tabular-nums; }
  .jspsych-multiplayer-live-scoreboard-row.is-self { font-weight: 700; background: #fff3bf; }
  .jspsych-multiplayer-live-scoreboard-caption { text-align: center; color: #666; font-size: 0.9em; }
  .jspsych-multiplayer-live-scoreboard-error { text-align: center; color: #b06a00; }
</style>`;

// One call site reads all three standing fields together, for the static accessors above.
function getMyStanding() {
  return { myRank: getMyRank(), myScore: getMyScore(), leaderboard: getLeaderboard() };
}

export default MultiplayerLiveScoreboardPlugin;
