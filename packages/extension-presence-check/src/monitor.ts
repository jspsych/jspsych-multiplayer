// The timing logic of the presence check, kept free of the DOM so tests can drive it with a fake
// clock. The extension in index.ts wires it to the page.

/** What ended a warning: a dismissal input, or the button. */
export type DismissedBy = "button" | "mouse_move" | "pointer_down" | "keyboard" | "wheel" | "touch";

/**
 * How a warning ended. `missed` and `expired` were both unanswered; `expired` is the one that
 * reached the consecutive-miss limit. `interrupted` means a pause or the end of the trial closed it.
 */
export type PresenceOutcome = "responded" | "missed" | "interrupted" | "expired";

export interface PresenceEvent {
  /** When the warning appeared, in ms from the monitor's creation (the trial's on_load). */
  shown_at: number;
  outcome: PresenceOutcome;
  /** ms from the warning appearing to its dismissal; null unless `outcome` is `responded`. */
  rt: number | null;
  dismissed_by: DismissedBy | null;
  /** Clicks on the blocking backdrop while this warning was open (button-only mode). */
  backdrop_clicks: number;
}

export interface PresenceSummary {
  presence_prompts: number;
  presence_responded: number;
  /** Unanswered warnings, including the one that expired. */
  presence_missed: number;
  presence_interrupted: number;
  presence_backdrop_clicks: number;
  presence_consecutive_misses: number;
  presence_expired: boolean;
  presence_events: PresenceEvent[];
}

export interface PresenceMonitorOptions {
  /** ms without counted activity before a warning appears. */
  promptAfter: number;
  /** ms a warning stays up before it counts as missed. */
  respondWithin: number;
  /** Consecutive misses that expire the check. `0` or `null` never expires. */
  maxConsecutiveMisses: number | null;
  /** Consecutive misses carried over from earlier trials. */
  consecutiveMisses?: number;
  now: () => number;
  onShow: () => void;
  onHide: (outcome: PresenceOutcome) => void;
  /** Called once, after the expiring warning has closed. */
  onExpire?: (summary: PresenceSummary) => void;
}

export interface PresenceMonitor {
  /** Counted activity while no warning is open: restarts the idle clock and clears misses. */
  activity(): void;
  /** Dismisses an open warning. */
  respond(by: DismissedBy): void;
  backdropClick(): void;
  /** Advances the clock. While `paused`, no warning shows and an open one is interrupted. */
  tick(paused?: boolean): void;
  /** Ends monitoring for the trial; an open warning is interrupted. */
  stop(): void;
  /** Clears the consecutive-miss count. */
  resetMisses(): void;
  readonly isOpen: boolean;
  readonly expired: boolean;
  readonly consecutiveMisses: number;
  summary(): PresenceSummary;
}

export function createPresenceMonitor(options: PresenceMonitorOptions): PresenceMonitor {
  const { promptAfter, respondWithin, maxConsecutiveMisses, now, onShow, onHide, onExpire } =
    options;
  const limit =
    typeof maxConsecutiveMisses === "number" && maxConsecutiveMisses > 0
      ? maxConsecutiveMisses
      : null;
  const startedAt = now();
  let lastActivity = startedAt;
  let misses = options.consecutiveMisses ?? 0;
  let expired = false;
  let stopped = false;
  let open: { shownAt: number; backdropClicks: number } | null = null;
  const events: PresenceEvent[] = [];

  function close(outcome: PresenceOutcome, dismissedBy: DismissedBy | null = null) {
    const t = now();
    events.push({
      shown_at: open!.shownAt - startedAt,
      outcome,
      rt: outcome === "responded" ? t - open!.shownAt : null,
      dismissed_by: dismissedBy,
      backdrop_clicks: open!.backdropClicks,
    });
    open = null;
    lastActivity = t;
    onHide(outcome);
  }

  const monitor: PresenceMonitor = {
    activity() {
      if (open || stopped) return;
      lastActivity = now();
      misses = 0;
    },
    respond(by) {
      if (!open) return;
      misses = 0;
      close("responded", by);
    },
    backdropClick() {
      if (open) open.backdropClicks += 1;
    },
    tick(paused = false) {
      if (expired || stopped) return;
      const t = now();
      if (paused) {
        // Neither a miss nor a response: the count is left as it was.
        if (open) close("interrupted");
        lastActivity = t;
      } else if (open) {
        if (t - open.shownAt < respondWithin) return;
        misses += 1;
        if (limit != null && misses >= limit) {
          expired = true;
          close("expired");
          onExpire?.(monitor.summary());
        } else {
          close("missed");
        }
      } else if (t - lastActivity >= promptAfter) {
        open = { shownAt: t, backdropClicks: 0 };
        onShow();
      }
    },
    stop() {
      if (stopped) return;
      if (open) close("interrupted");
      stopped = true;
    },
    resetMisses() {
      misses = 0;
    },
    get isOpen() {
      return open !== null;
    },
    get expired() {
      return expired;
    },
    get consecutiveMisses() {
      return misses;
    },
    summary() {
      const count = (...outcomes: PresenceOutcome[]) =>
        events.filter((e) => outcomes.includes(e.outcome)).length;
      return {
        presence_prompts: events.length + (open ? 1 : 0),
        presence_responded: count("responded"),
        presence_missed: count("missed", "expired"),
        presence_interrupted: count("interrupted"),
        presence_backdrop_clicks:
          events.reduce((n, e) => n + e.backdrop_clicks, 0) + (open?.backdropClicks ?? 0),
        presence_consecutive_misses: misses,
        presence_expired: expired,
        presence_events: events.map((e) => ({ ...e })),
      };
    },
  };
  return monitor;
}
