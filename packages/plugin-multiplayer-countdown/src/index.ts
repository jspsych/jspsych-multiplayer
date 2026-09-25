import { GroupSessionData, JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";
import { MultiplayerOutcome, getMultiplayer, isMultiplayerError } from "@jspsych-multiplayer/utils";

import { version } from "../package.json";
import {
  STARTED_AT_KEY,
  computeElapsed,
  computeRemaining,
  formatTime,
  resolveStartedAt,
  startedAtKey,
} from "./countdown-core";

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
     * Store the trial's snapshot of the group's data at trial end in the `group` data field. Off by
     * default: the snapshot is mostly timestamps and low-value here, so it is opt-in.
     */
    save_group: {
      type: ParameterType.BOOL,
      default: false,
    },
  },
  data: {
    /** The resolved canonical (minimum-across-participants) start timestamp the display was derived from. */
    started_at: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** This client's own start timestamp; its gap vs. `started_at` estimates entry skew. */
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
    /**
     * `"completed"`, or `"connection_lost"` if this participant's connection was lost for good by
     * the end of the countdown. The countdown still runs to the end locally, from the start time it
     * had already agreed on.
     */
    multiplayer_outcome: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /** Always null: the countdown doesn't depend on any other participant. */
    left_participant: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /** The trial's snapshot of the group's data at trial end. Only stored when `save_group` is true. */
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
 * A synchronized group timer for multiplayer experiments. Every participant writes its own start
 * timestamp into the trial's scope on trial start, and each client derives the displayed time from
 * the **minimum** timestamp across participants — a coordination-free consensus (no elected anchor,
 * no single point of failure) in the same spirit as `plugin-multiplayer-role`'s ordering. The trial's
 * scope keeps each countdown's timestamps apart, so every countdown starts fresh. The write is
 * keep-if-present, so trials that share a scope through `multiplayer_scope` share one clock.
 *
 * The trial re-resolves the consensus start on every group update (via `subscribe`) and re-renders
 * the clock on a ~100 ms tick, ending when its own derived time reaches `duration`. It is NOT a
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
  // against `finishTrial()`, so an async `trial` that resolves after wiring up subscribe/tick
  // would end the trial immediately. A sync `trial` makes jsPsych fire `on_load` itself and wait for
  // `finishTrial()`. (Same footgun the chat/sync plugins fixed — see chat/src/index.ts:131.)
  trial(display_element: HTMLElement, trial: TrialType<Info>) {
    const multiplayer = getMultiplayer(this.jsPsych, "multiplayer-countdown");
    const me = multiplayer.participantId;

    // --- Validate required params (the pure core deliberately does not) -----------------------
    const duration = trial.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      throw new Error(
        "multiplayer-countdown: the `duration` parameter is required and must be a positive number " +
          "of milliseconds.",
      );
    }
    const mode: Mode = trial.mode === "countup" ? "countup" : "countdown";
    const key = STARTED_AT_KEY;

    // --- Register this client's start timestamp (update, keep-if-present) ---------------------
    // Reads and writes use the trial's own scope, so each countdown starts fresh. If we already
    // carry a timestamp there, KEEP it instead of writing a fresh Date.now(): that happens when the
    // researcher gives several trials the same `multiplayer_scope` to run one clock across them.
    // The write is a one-key `update()`, which merges, so other keys in the scope survive.
    const existing = multiplayer.get(me)?.[key];
    const alreadyRegistered = typeof existing === "number" && Number.isFinite(existing);
    const ownStartedAt = alreadyRegistered ? (existing as number) : Date.now();

    if (!alreadyRegistered) {
      // Fire-and-forget: a sync subscribe-trial has no trial-promise to reject. A write only
      // rejects when the session closes (the core retries failed pushes itself), and a closed
      // session throws at once; either way the display continues from this client's own
      // timestamp, and the outcome is recorded at the end.
      try {
        multiplayer.update({ [key]: ownStartedAt }).catch((err) => {
          if (!isMultiplayerError(err)) {
            console.error(
              "multiplayer-countdown: failed to write this participant's start timestamp; this " +
                "client will not contribute to the shared consensus start time.",
              err,
            );
          }
        });
      } catch (err) {
        if (!isMultiplayerError(err)) throw err;
      }
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
      ".jspsych-multiplayer-countdown-time",
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
    // Aborted when the trial ends, which removes the subscription
    const controller = new AbortController();
    // `number`, not ReturnType<typeof setTimeout>: pluginAPI.setTimeout returns a numeric handle.
    let tickTimer: number | null = null;

    const resolve = (group: GroupSessionData) => {
      currentStartedAt = resolveStartedAt(group, key) ?? ownStartedAt;
    };
    const displayMs = (now: number) =>
      mode === "countup"
        ? computeElapsed(currentStartedAt, duration, now)
        : computeRemaining(currentStartedAt, duration, now);
    // Both modes end at `duration`: elapsed ≥ duration ⇔ remaining ≤ 0.
    const isExpired = (now: number) => computeRemaining(currentStartedAt, duration, now) <= 0;
    // Announce the final ANNOUNCE_FROM_MS window, once per whole second (tracked so the 100 ms
    // tick doesn't re-announce the same second). Uses remaining time in BOTH modes — count-up
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
      if (ended) return; // guard against a tick racing a subscribe-driven end
      ended = true;
      if (tickTimer != null) clearTimeout(tickTimer);
      controller.abort();
      // The countdown never waits on anyone, so the only way it can fail is losing the connection
      const outcome: MultiplayerOutcome =
        multiplayer.status === "closed" ? "connection_lost" : "completed";
      this.jsPsych.finishTrial({
        started_at: currentStartedAt,
        own_started_at: ownStartedAt,
        displayed_duration: Math.round(performance.now() - start),
        mode,
        multiplayer_outcome: outcome,
        left_participant: null,
        // Reads keep answering from the last state after the connection closes
        ...(trial.save_group ? { group: multiplayer.getAll() } : {}),
      });
    };

    // Resolve from the current snapshot first, so an already-expired countdown is caught (and
    // warned about) before subscribing.
    resolve(multiplayer.getAll());
    renderTime();

    // Already expired at start ⇒ this participant reached the trial after the group's countdown
    // ended, or an earlier trial with the same `multiplayer_scope` already ran this clock out. Warn
    // (dev diagnostic) and end at once.
    if (isExpired(Date.now())) {
      console.warn(
        "multiplayer-countdown: the countdown had already expired when this trial started. This " +
          "usually means this participant reached the trial after the group's countdown had " +
          "ended, or an earlier trial with the same `multiplayer_scope` already ran the clock out.",
      );
      end();
      return;
    }

    // subscribe re-resolves the consensus min on every group change; a newly-arrived lower timestamp
    // can move `currentStartedAt` earlier (converging down) and may itself push us past expiry.
    // The session keeps running the countdown locally if the connection is lost: the consensus
    // start time is already known, so the display and the end time stay correct. The subscription
    // uses the trial's scope, so jsPsych also removes it when the trial ends.
    multiplayer.subscribe(
      (group) => {
        if (ended) return;
        try {
          resolve(group);
          renderTime();
        } catch {
          // A bad frame must not tear down the subscription or the trial.
        }
        if (isExpired(Date.now())) end();
      },
      { signal: controller.signal },
    );

    // The tick ONLY re-renders from Date.now() against the currently-resolved start — it never
    // touches the API (that's subscribe's job). Every tick recomputes from Date.now() rather than
    // accumulating, so background-tab timer throttling only coarsens the refresh, never the
    // underlying time or the moment the trial ends.
    //
    // A self-rescheduling `pluginAPI.setTimeout`, NOT a raw `setInterval`: jsPsych clears the
    // timers it registered when a trial is ended from the outside (abortExperiment /
    // endCurrentTimeline / a forced finishTrial), and it cancels the trial's multiplayer
    // subscriptions there too. A raw interval would survive all of that and keep firing after the run is over — up to
    // calling `end()` → `finishTrial()` on a finished experiment. Rescheduling from inside the tick
    // (rather than one registration up front) keeps every future tick inside that registry.
    const scheduleTick = () => {
      tickTimer = this.jsPsych.pluginAPI.setTimeout(() => {
        if (ended) return;
        renderTime();
        if (isExpired(Date.now())) {
          end();
          return;
        }
        scheduleTick();
      }, 100);
    };
    scheduleTick();
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
