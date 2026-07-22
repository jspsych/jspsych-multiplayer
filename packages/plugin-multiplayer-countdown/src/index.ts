import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import {
  computeElapsed,
  computeRemaining,
  formatTime,
  resolveStartedAt,
  startedAtKey,
} from "./countdown-core";
import {
  GroupSessionData,
  MultiplayerApiLike,
  Unsubscribe,
  resolveMultiplayerApi,
} from "./multiplayer-api";

const info = <const>{
  name: "multiplayer-countdown",
  version: version,
  parameters: {
    /** Total length of the timer in milliseconds. Required; must be positive. Both modes end here. */
    duration: {
      type: ParameterType.INT,
      default: undefined,
    },
    /**
     * `"countdown"` (default) displays time remaining and ticks toward `0:00`; `"countup"` displays
     * time elapsed since the group start and ticks up toward `duration`. Same consensus start time
     * either way — only the displayed value (and default rounding) differ.
     */
    mode: {
      type: ParameterType.STRING,
      default: "countdown",
    },
    /**
     * Names the group-session slot key this countdown stores its start timestamp under
     * (`countdown_<name>_startedAt`). REQUIRED and must be unique per countdown in a timeline: the
     * key must be identical across clients (so they resolve the same consensus start) yet distinct
     * from any other countdown (or a later countdown silently reuses this one's timestamp and ends
     * instantly). No default can satisfy both, so a missing/empty name throws.
     *
     * Declared `STRING` (not `FUNCTION`) so jsPsych auto-evaluates a function passed for it — e.g.
     * ``name: () => `round_${round}` `` or `jsPsych.timelineVariable(...)` — which is how a loop
     * generates a fresh name per iteration.
     */
    name: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /** HTML content shown above the timer (e.g. "Time left to draw:"). Null shows nothing. */
    stimulus: {
      type: ParameterType.HTML_STRING,
      default: null,
    },
    /** Optional secondary HTML hint shown below the timer (jsPsych convention). Null shows nothing. */
    prompt: {
      type: ParameterType.HTML_STRING,
      default: null,
    },
    /**
     * Formats the millisecond value into the displayed string: `(ms) => string`. Null uses the
     * built-in `M:SS` formatter, whose rounding follows `mode` (`ceil` for countdown so the final
     * partial second still reads `0:01`; `floor` for count-up, the stopwatch convention).
     */
    format: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /**
     * Store the full group-session snapshot at trial end in the `group` data field. Off by default:
     * the snapshot is mostly timestamps and low-value here, so it is opt-in (role-plugin precedent).
     */
    save_group: {
      type: ParameterType.BOOL,
      default: false,
    },
  },
  data: {
    /** The resolved canonical (minimum-across-slots) start timestamp the display was derived from. */
    started_at: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** This client's own pushed start timestamp; its gap vs. `started_at` estimates entry skew. */
    own_started_at: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** How long the timer was actually on screen for this client, in ms (≤ `duration` for late joiners). */
    displayed_duration: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** Which mode ran: `"countdown"` or `"countup"`. */
    mode: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /** Full group-session snapshot at trial end. Only stored when `save_group` is true. */
    group: {
      type: ParameterType.OBJECT,
      default: undefined,
    },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;
type Mode = "countdown" | "countup";

/**
 * **multiplayer-countdown**
 *
 * A synchronized group timer for multiplayer experiments. Every participant pushes its own start
 * timestamp into its own slot on trial start, and each client derives the displayed time from the
 * **minimum** timestamp across all slots — a coordination-free consensus (no elected anchor, no
 * single point of failure) in the same spirit as `plugin-multiplayer-role`'s ordering. Because `push`
 * replaces a whole slot, the timestamp is merged into this participant's existing slot (read-own →
 * spread → push) so it never clobbers role/`joinedAt` metadata, and the push is idempotent on
 * refresh (keep-if-present), so a reload resumes at the group's actual remaining time.
 *
 * The trial re-resolves the consensus start on every group update (via `subscribe`) and re-renders
 * the clock on a ~100 ms interval, ending when its own derived time reaches `duration`. It is NOT a
 * barrier: ends are synchronized only within skew + latency — compose with `plugin-multiplayer-sync`
 * or `plugin-multiplayer-ready` afterwards if you need a hard barrier.
 *
 * The pure consensus core is exposed as statics on the default export
 * (`startedAtKey` / `resolveStartedAt` / `computeRemaining` / `computeElapsed` / `formatTime`), so a
 * demo can render its own synced display during another trial (e.g. `draw-room.html`).
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-countdown multiplayer-countdown plugin documentation}
 */
class MultiplayerCountdownPlugin implements JsPsychPlugin<Info> {
  static info = info;

  // The pure consensus core, re-exported as statics so demo-side code can render its own synced
  // display from the same logic (role-plugin pattern). A named module re-export would break the
  // contrib rollup config (output.exports: "default"), so these MUST hang off the default export.
  static startedAtKey = startedAtKey;
  static resolveStartedAt = resolveStartedAt;
  static computeRemaining = computeRemaining;
  static computeElapsed = computeElapsed;
  static formatTime = formatTime;

  constructor(private jsPsych: JsPsych) {}

  // Deliberately synchronous (returns undefined, NOT a Promise): jsPsych races a returned promise
  // against `finishTrial()`, so an async `trial` that resolves after wiring up subscribe/interval
  // would end the trial immediately. A sync `trial` makes jsPsych fire `on_load` itself and wait for
  // `finishTrial()`. (Same footgun the chat/sync plugins fixed — see chat/src/index.ts:131.)
  trial(display_element: HTMLElement, trial: TrialType<Info>) {
    const api = resolveMultiplayerApi(this.jsPsych);
    const me = api.participantId;

    // --- Validate required params (the pure core deliberately does not) -----------------------
    const name = trial.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(
        "multiplayer-countdown: the `name` parameter is required and must be a non-empty string. " +
          "It namespaces this countdown's start timestamp and must be unique per countdown in a " +
          "timeline (identical across clients, distinct from other countdowns)."
      );
    }
    const duration = trial.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      throw new Error(
        "multiplayer-countdown: the `duration` parameter is required and must be a positive number " +
          "of milliseconds."
      );
    }
    const mode: Mode = trial.mode === "countup" ? "countup" : "countdown";
    const key = startedAtKey(name);

    // --- Register this client's start timestamp (read-own → spread → push, keep-if-present) ----
    // `push` REPLACES the whole slot, so read our own slot and spread it to preserve other keys
    // (role, joinedAt, …). Keep-if-present: if we already carry a timestamp for this key (a reload,
    // or a reused name), KEEP it instead of writing a fresh Date.now() — that makes refreshes resume
    // at the true remaining time without depending on peers, and makes a reused name fail
    // deterministically (the started-expired warning below catches it).
    const mine = api.get(me) ?? {};
    const existing = mine[key];
    const alreadyRegistered = typeof existing === "number" && Number.isFinite(existing);
    const ownStartedAt = alreadyRegistered ? (existing as number) : Date.now();

    if (!alreadyRegistered) {
      // Fire-and-forget: a sync subscribe-trial has no trial-promise to reject (unlike ready's
      // `await api.push`), so a failed one-shot registration is surfaced loudly and un-relabeled via
      // console.error rather than being silently swallowed. The display still continues from whatever
      // timestamps remain readable (this client's own local fallback at minimum).
      api.push({ ...mine, [key]: ownStartedAt }).catch((err) => {
        console.error(
          "multiplayer-countdown: failed to push this participant's start timestamp; this client " +
            "will not contribute to the shared consensus start time.",
          err
        );
      });
    }

    // --- Render shell -------------------------------------------------------------------------
    injectStyles();
    display_element.innerHTML =
      `<div class="jspsych-multiplayer-countdown">` +
      (trial.stimulus == null
        ? ""
        : `<div class="jspsych-multiplayer-countdown-stimulus">${trial.stimulus}</div>`) +
      `<div class="jspsych-multiplayer-countdown-time"></div>` +
      (trial.prompt == null
        ? ""
        : `<div class="jspsych-multiplayer-countdown-prompt">${trial.prompt}</div>`) +
      // Screen-reader-only live region. The visible time updates ~10x/s and its M:SS text changes
      // every second, so making IT the live region spams SR users with the whole countdown. Instead
      // this stays silent until the final few seconds — the point a participant needs to know the
      // group deadline is about to auto-end the trial — then announces once per remaining second.
      `<div class="jspsych-multiplayer-countdown-sr" aria-live="assertive"></div>` +
      `</div>`;
    const timeEl = display_element.querySelector(
      ".jspsych-multiplayer-countdown-time"
    ) as HTMLElement;
    const srEl = display_element.querySelector(".jspsych-multiplayer-countdown-sr") as HTMLElement;

    const fmt: (ms: number) => string =
      typeof trial.format === "function"
        ? (ms) => String(trial.format(ms))
        : (ms) => formatTime(ms, mode === "countup" ? "floor" : "ceil");

    // --- Consensus + display state ------------------------------------------------------------
    const start = performance.now();
    // Never null: fall back to our own timestamp until peers' (possibly lower) timestamps arrive.
    let currentStartedAt = ownStartedAt;
    let ended = false;
    let unsubscribe: Unsubscribe | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const resolve = (group: GroupSessionData) => {
      currentStartedAt = resolveStartedAt(group, key) ?? ownStartedAt;
    };
    const displayMs = (now: number) =>
      mode === "countup"
        ? computeElapsed(currentStartedAt, duration, now)
        : computeRemaining(currentStartedAt, duration, now);
    // Both modes end at `duration`: elapsed ≥ duration ⇔ remaining ≤ 0.
    const isExpired = (now: number) => computeRemaining(currentStartedAt, duration, now) <= 0;
    // Announce the final ANNOUNCE_FROM_MS window, once per whole second (tracked so the 100ms
    // interval doesn't re-announce the same second). Uses remaining time in BOTH modes — count-up
    // still ends at `duration`, so the group deadline is what matters to an SR user either way.
    const ANNOUNCE_FROM_MS = 5000;
    let lastAnnouncedSecond = -1;
    const renderTime = () => {
      const now = Date.now();
      timeEl.textContent = fmt(displayMs(now));
      const remaining = computeRemaining(currentStartedAt, duration, now);
      if (remaining > 0 && remaining <= ANNOUNCE_FROM_MS) {
        const secondsLeft = Math.ceil(remaining / 1000);
        if (secondsLeft !== lastAnnouncedSecond) {
          lastAnnouncedSecond = secondsLeft;
          srEl.textContent = `${secondsLeft} second${secondsLeft === 1 ? "" : "s"} remaining`;
        }
      }
    };

    const end = () => {
      if (ended) return; // guard against interval racing a subscribe-driven end
      ended = true;
      if (interval != null) clearInterval(interval);
      unsubscribe?.();
      this.jsPsych.finishTrial({
        started_at: currentStartedAt,
        own_started_at: ownStartedAt,
        displayed_duration: Math.round(performance.now() - start),
        mode,
        ...(trial.save_group ? { group: api.getAll() } : {}),
      });
    };

    // Seed from the current snapshot, then subscribe (which replays it — the seed is
    // belt-and-suspenders, kept because replay lives on the un-landed #3694 side of the API seam).
    resolve(api.getAll());
    renderTime();

    // Already expired at start ⇒ a reused `name` (its timestamp is still in the session) or this
    // participant joined after the group's countdown ended. Warn (dev diagnostic) and end at once.
    if (isExpired(Date.now())) {
      console.warn(
        `multiplayer-countdown: the countdown named "${name}" had already expired when this trial ` +
          "started. This usually means the `name` was reused by an earlier countdown in the " +
          "timeline (its start timestamp persists in the group session), or this participant joined " +
          "after the group's countdown had already ended."
      );
      end();
      return;
    }

    // subscribe re-resolves the consensus min on every group change; a newly-arrived lower timestamp
    // can move `currentStartedAt` earlier (converging down) and may itself push us past expiry.
    unsubscribe = api.subscribe((group) => {
      if (ended) return;
      try {
        resolve(group);
        renderTime();
      } catch {
        // A bad frame must not tear down the subscription or the trial.
      }
      if (isExpired(Date.now())) end();
    });

    // The interval ONLY re-renders from Date.now() against the currently-resolved start — it never
    // touches the API (that's subscribe's job). Every tick recomputes from Date.now() rather than
    // accumulating, so background-tab setInterval throttling only coarsens the refresh, never the
    // underlying time or the moment the trial ends.
    interval = setInterval(() => {
      if (ended) return;
      renderTime();
      if (isExpired(Date.now())) end();
    }, 100);
  }
}

const STYLE_ID = "jspsych-multiplayer-countdown-styles";
/** Inject the timer's base styling once (the plugin ships no separate CSS asset, matching the repo). */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .jspsych-multiplayer-countdown {
      text-align: center;
    }
    .jspsych-multiplayer-countdown-time {
      font-size: 3em;
      font-variant-numeric: tabular-nums;
      margin: 0.3em 0;
    }
    .jspsych-multiplayer-countdown-prompt {
      color: #666;
      font-size: 0.9em;
    }
    .jspsych-multiplayer-countdown-sr {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  `;
  document.head.appendChild(style);
}

export default MultiplayerCountdownPlugin;
