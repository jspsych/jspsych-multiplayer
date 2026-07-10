import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import { activeIndex, collectMoves, resolveTurnOrder } from "./turn-core";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention. The pure core is exposed as statics on the plugin class below.
export type { Move, MoveRecord } from "./turn-core";

const info = <const>{
  name: "multiplayer-turn",
  version: version,
  parameters: {
    /**
     * `(jsPsych) => value` producing THIS client's move, called when it commits its turn (on the
     * submit button, or immediately if `submit_label` is null). FUNCTION is deliberate — it stops
     * jsPsych's dynamic-parameter machinery from CALLING the value at trial start; the move is instead
     * computed at commit time, e.g. reading a decision made in an earlier trial:
     * `(jsPsych) => jsPsych.data.get().last(1).values()[0].response`. Null commits a `null` move.
     */
    get_move: { type: ParameterType.FUNCTION, default: null },
    /**
     * The turn order. An explicit array of participantIds (used as-is — the stable choice, e.g.
     * `jsPsychMultiplayerMatch.getMyMatch().members`), a function `(sortedIds) => ids` returning the
     * order, or null (default: participantIds sorted). FUNCTION: see `get_move`. Must resolve to the
     * SAME order on every client for the turn pointer to agree.
     */
    turn_order: { type: ParameterType.FUNCTION, default: null },
    /**
     * Session field moves are stored under. Namespace it PER GAME (e.g. per matched pair) so two
     * concurrent turn sequences don't count each other's moves — e.g. `data_key: "ultimatum"` or a
     * per-pair key derived from the match.
     */
    data_key: { type: ParameterType.STRING, default: "turn" },
    /** HTML shown to the active player above the submit button (experimenter-authored). */
    prompt: { type: ParameterType.HTML_STRING, default: null },
    /** Label of the active player's commit button. `null` auto-commits the move the instant it's their turn (no button). */
    submit_label: { type: ParameterType.STRING, default: "Submit" },
    /** `(participantId) => string` display name shown in the status/history. FUNCTION: see `get_move`. Null shows the raw id. */
    player_label: { type: ParameterType.FUNCTION, default: null },
    /** `(move, participantId) => string` rendering a move in the history. FUNCTION: see `get_move`. Null uses `String(move)`. */
    format_move: { type: ParameterType.FUNCTION, default: null },
    /** `(activePlayerId, group) => html` overriding the "waiting for X" status shown to non-active players. FUNCTION: see `get_move`. */
    waiting_message: { type: ParameterType.FUNCTION, default: null },
    /** Show the running list of moves taken so far. */
    show_history: { type: ParameterType.BOOL, default: true },
    /**
     * Freeze the turn order only once this many participants are present (so it isn't computed over a
     * partial group). `null` freezes as soon as this client is present — safe only behind an upstream
     * barrier, or when `turn_order` is an explicit array (which is stable regardless). A warning fires
     * otherwise.
     */
    expected_players: { type: ParameterType.INT, default: null },
    /** Milliseconds before giving up if the sequence stalls (a player abandoned). `null` waits forever. */
    timeout: { type: ParameterType.INT, default: null },
    /** Hook run if `timeout` elapses before the sequence completes. The trial ends `timed_out: true` regardless. */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
  },
  data: {
    /** The ordered move sequence: `[{ participantId, move, position }]`. */
    moves: { type: ParameterType.OBJECT, array: true },
    /** This client's own move; `null` if it never took a turn. */
    my_move: { type: ParameterType.OBJECT },
    /** This client's index in the turn order; `null` if it was not in the order (a spectator). */
    my_position: { type: ParameterType.INT },
    /**
     * This client's response time in milliseconds — from when it became this client's turn to when
     * it committed its move. `null` if this client never took a turn (a spectator, or it timed out
     * before its turn came up).
     */
    rt: { type: ParameterType.INT },
    /** Total number of turns in the sequence (the turn order's length). */
    num_turns: { type: ParameterType.INT },
    /** What ended the trial: `"complete"` (every turn taken) or `"timeout"`. */
    ended_by: { type: ParameterType.STRING },
    /** `true` if the trial ended because `timeout` elapsed before the sequence completed. */
    timed_out: { type: ParameterType.BOOL },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;
type EndReason = "complete" | "timeout";

/**
 * **multiplayer-turn**
 *
 * A sequential turn-taking coordinator for multiplayer experiments. Every participant runs this one
 * trial; it derives whose turn it is from the shared session (the active player is the first in the
 * turn order that has not yet moved), shows the active player a prompt + a commit button, and shows
 * everyone else a live "waiting for X" status plus the moves so far. When the active player commits,
 * their move (supplied by `get_move`) is pushed, the turn advances, and the trial ends for EVERYONE
 * once the whole sequence is complete (or `timeout` elapses).
 *
 * It is a *coordinator*, not a decision UI: the move VALUE is yours to supply (via `get_move`, often
 * reading a choice made in an earlier trial), so it composes with `plugin-multiplayer-match` (pair up,
 * then `turn_order: () => match.getMyMatch().members`) and `plugin-multiplayer-choice` for the actual
 * decision. Built on the multiplayer API's real-time `subscribe` primitive, like
 * `plugin-multiplayer-chat`.
 *
 * The pure core (`resolveTurnOrder`, `activeIndex`, `collectMoves`) is reachable as static members.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.pluginAPI.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-turn}
 */
class MultiplayerTurnPlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent turn helpers. Usable standalone, today. */
  static resolveTurnOrder = resolveTurnOrder;
  static activeIndex = activeIndex;
  static collectMoves = collectMoves;

  constructor(private jsPsych: JsPsych) {}

  // Deliberately synchronous (returns undefined, NOT a Promise): jsPsych races a returned promise
  // against `finishTrial()`, so a sync `trial` makes jsPsych fire `on_load` itself and wait for the
  // `finishTrial()` we call when the sequence completes or times out (like plugin-multiplayer-chat).
  trial(display_element: HTMLElement, trial: TrialType<Info>) {
    // The multiplayer API is flattened onto pluginAPI by jsPsych core (jsPsych#3694). The published
    // `jspsych` types don't carry it yet, so reach it through the local interface with one cast.
    const api = this.jsPsych.pluginAPI as unknown as MultiplayerApiLike;
    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-turn: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.pluginAPI.connect(adapter)) before this trial runs."
      );
    }

    const dataKey = trial.data_key;
    const explicitOrder = Array.isArray(trial.turn_order)
      ? (trial.turn_order as string[])
      : undefined;

    if (trial.expected_players == null && explicitOrder == null) {
      console.warn(
        "plugin-multiplayer-turn: no `expected_players` and no explicit `turn_order` array — the turn " +
          "order freezes as soon as this client is present, possibly over a partial group. Set " +
          "`expected_players` (the exact count) or pass an explicit `turn_order` unless an upstream " +
          "barrier guarantees every peer has already joined this session."
      );
    }

    // --- Render the shell ONCE ----------------------------------------------------------------
    display_element.innerHTML = `
      ${TURN_STYLE}
      <div class="jspsych-multiplayer-turn">
        <div class="jspsych-multiplayer-turn-status" aria-live="polite"></div>
        <div class="jspsych-multiplayer-turn-body"></div>
        <div class="jspsych-multiplayer-turn-history"></div>
      </div>`;
    const status = display_element.querySelector(".jspsych-multiplayer-turn-status") as HTMLElement;
    const body = display_element.querySelector(".jspsych-multiplayer-turn-body") as HTMLElement;
    const historyEl = display_element.querySelector(
      ".jspsych-multiplayer-turn-history"
    ) as HTMLElement;

    let order: string[] | null = null; // frozen once the group has settled
    let ended = false;
    let mySubmitted = false;
    let unsubscribe: Unsubscribe | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // `myTurnStartedAt` is stamped the first time it becomes this client's turn; `myRt` is measured
    // from it at commit — this client's own response time, saved even though the trial ends later
    // (when the whole sequence completes).
    let myTurnStartedAt: number | null = null;
    let myRt: number | null = null;

    const nameOf = (id: string): string => {
      if (typeof trial.player_label === "function") {
        try {
          return String(trial.player_label(id));
        } catch (err) {
          console.error("plugin-multiplayer-turn: `player_label` threw; using the id instead", err);
        }
      }
      return id;
    };
    const formatMove = (move: unknown, id: string): string => {
      if (typeof trial.format_move === "function") {
        try {
          return String(trial.format_move(move, id));
        } catch (err) {
          console.error("plugin-multiplayer-turn: `format_move` threw; using String(move)", err);
        }
      }
      return String(move);
    };

    const renderHistory = (group: GroupSessionData) => {
      if (!trial.show_history || !order) {
        historyEl.innerHTML = "";
        return;
      }
      const moves = collectMoves(group, dataKey, order);
      historyEl.innerHTML = moves.length
        ? `<div class="jspsych-multiplayer-turn-history-title">Moves so far</div>` +
          `<ul class="jspsych-multiplayer-turn-history-list">${moves
            .map(
              (m) =>
                `<li>${escapeHtml(nameOf(m.participantId))}: ${escapeHtml(
                  formatMove(m.move, m.participantId)
                )}</li>`
            )
            .join("")}</ul>`
        : "";
    };

    const end = (reason: EndReason) => {
      if (ended) return; // guard double-fire (timer racing completion)
      ended = true;
      unsubscribe?.();
      if (timer != null) clearTimeout(timer);
      if (reason === "timeout") {
        try {
          if (typeof trial.on_timeout === "function") trial.on_timeout(this.jsPsych);
        } catch (err) {
          console.error("plugin-multiplayer-turn: on_timeout hook threw", err);
        }
      }
      const group = api.getAll();
      const moves = order ? collectMoves(group, dataKey, order) : [];
      const mine = moves.find((m) => m.participantId === me);
      this.jsPsych.finishTrial({
        moves,
        my_move: mine ? mine.move : null,
        my_position: order && order.indexOf(me) >= 0 ? order.indexOf(me) : null,
        rt: myRt,
        num_turns: order ? order.length : 0,
        ended_by: reason,
        timed_out: reason === "timeout",
      });
    };

    const showSubmitError = () => {
      let note = body.querySelector(".jspsych-multiplayer-turn-error") as HTMLElement | null;
      if (!note) {
        note = document.createElement("div");
        note.className = "jspsych-multiplayer-turn-error";
        body.appendChild(note);
      }
      note.textContent = "Couldn't submit — please try again.";
    };

    const submit = () => {
      if (ended || mySubmitted) return; // committed once; the button/auto-advance can't double-fire
      mySubmitted = true;
      // Response time from when it became our turn to this commit (auto-commit reads ~0). Recomputed
      // on a retry after a failed push, so the final value reflects the successful commit.
      myRt = myTurnStartedAt != null ? Math.round(performance.now() - myTurnStartedAt) : null;
      let moveValue: unknown = null;
      try {
        if (typeof trial.get_move === "function") moveValue = trial.get_move(this.jsPsych);
      } catch (err) {
        // A throwing get_move must not stall the whole group — commit a null move and log, so the
        // sequence advances rather than hanging on this player forever.
        console.error("plugin-multiplayer-turn: `get_move` threw; committing a null move", err);
        moveValue = null;
      }
      const prev = api.get(me) ?? {};
      const payload: Record<string, unknown> = { ...prev, [dataKey]: { move: moveValue } };
      // Optimistically show the waiting view immediately (mySubmitted flips the render below), rather
      // than waiting for the adapter to echo our push back through subscribe.
      render(api.getAll());
      api.push(payload).catch((err) => {
        // A failed commit is recoverable: reset so the player can retry, and restore the active view.
        console.error("plugin-multiplayer-turn: failed to submit this client's move", err);
        mySubmitted = false;
        render(api.getAll());
        showSubmitError();
      });
    };

    const render = (group: GroupSessionData) => {
      if (ended) return;

      // --- Start gate: freeze the turn order once the group has settled ---
      if (order === null) {
        const ids = Object.keys(group);
        if (explicitOrder) {
          order = [...explicitOrder]; // an explicit order is stable — freeze immediately
        } else {
          // EXACT count, not >=: the whole plugin rests on every client freezing the order over the
          // SAME participant set. `>=` would let two clients freeze at different counts on a
          // simultaneous-join race and compute divergent turn orders. Like plugin-multiplayer-role /
          // -match, an overshoot instead stalls to a timeout (fail-loud) rather than diverging.
          const settled =
            trial.expected_players != null
              ? ids.length === trial.expected_players
              : ids.includes(me);
          if (!settled) {
            const of = trial.expected_players != null ? ` of ${trial.expected_players}` : "";
            status.textContent = `Waiting for players… (${ids.length}${of})`;
            body.innerHTML = "";
            historyEl.innerHTML = "";
            return;
          }
          order = resolveTurnOrder(ids, trial.turn_order as (ids: string[]) => string[]);
        }
      }

      renderHistory(group);

      const ai = activeIndex(group, dataKey, order); // first player yet to move; order.length = done
      if (ai >= order.length) {
        end("complete");
        return;
      }

      const active = order[ai];
      if (active === me && !mySubmitted) {
        // --- This client's turn ---
        // Stamp the moment it FIRST becomes our turn, so `rt` measures from here to the commit.
        if (myTurnStartedAt === null) myTurnStartedAt = performance.now();
        status.textContent = "It's your turn.";
        body.innerHTML =
          (trial.prompt
            ? `<div class="jspsych-multiplayer-turn-prompt">${trial.prompt}</div>`
            : "") +
          (trial.submit_label != null
            ? `<button type="button" class="jspsych-btn jspsych-multiplayer-turn-submit">${escapeHtml(
                trial.submit_label
              )}</button>`
            : "");
        const button = body.querySelector(
          ".jspsych-multiplayer-turn-submit"
        ) as HTMLButtonElement | null;
        button?.addEventListener("click", submit, { once: true });
        // No button → auto-commit the moment it's this client's turn (guarded by mySubmitted).
        if (trial.submit_label == null) submit();
      } else {
        // --- Someone else's turn (or we've already moved) ---
        body.innerHTML = "";
        status.innerHTML =
          typeof trial.waiting_message === "function"
            ? String(trial.waiting_message(active, group))
            : `Waiting for <b>${escapeHtml(nameOf(active))}</b> to take their turn…`;
      }
    };

    // Announce our presence so this client is in the turn order (a slot with no `move` key reads as
    // "present but not yet moved"). Best-effort; the subscribe replay + peers' pushes drive the rest.
    const prev = api.get(me) ?? {};
    api
      .push({ ...prev, joinedAt: (prev.joinedAt as number | undefined) ?? Date.now() })
      .catch((err) => console.error("plugin-multiplayer-turn: failed to announce presence", err));

    render(api.getAll()); // seed from the current snapshot
    unsubscribe = api.subscribe((group) => {
      if (ended) return;
      try {
        render(group);
      } catch {
        // A bad render frame must not tear down the subscription or the trial.
      }
    });

    if (typeof trial.timeout === "number" && trial.timeout > 0) {
      timer = setTimeout(() => end("timeout"), trial.timeout);
    }
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

// A small scoped stylesheet so the status/history aren't unstyled out of the box. jsPsych replaces the
// display element each trial, so this never accumulates.
const TURN_STYLE = `<style id="jspsych-multiplayer-turn-style">
  .jspsych-multiplayer-turn-status { font-size: 1.1em; margin: 1em 0; }
  .jspsych-multiplayer-turn-history-title { font-weight: 700; margin-top: 1.2em; }
  .jspsych-multiplayer-turn-history-list { list-style: none; padding: 0; margin: 0.4em auto; max-width: 22em; text-align: left; }
  .jspsych-multiplayer-turn-history-list li { padding: 0.25em 0.6em; border-bottom: 1px solid #eee; }
  .jspsych-multiplayer-turn-error { color: #b06a00; margin-top: 0.6em; }
</style>`;

export default MultiplayerTurnPlugin;
