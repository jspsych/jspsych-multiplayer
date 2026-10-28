import { JsPsych, JsPsychExtension, ParameterType } from "jspsych";

import { version } from "../package.json";
import {
  DismissedBy,
  PresenceMonitor,
  PresenceOutcome,
  PresenceSummary,
  createPresenceMonitor,
} from "./monitor";

// Types only: the build exports just the extension, which carries `createPresenceMonitor` as a static.
export type { DismissedBy, PresenceEvent, PresenceOutcome, PresenceSummary } from "./monitor";

/** The participant's inputs, as `activity_inputs` and `dismiss_inputs` name them. */
export type PresenceInput = Exclude<DismissedBy, "button">;
export type PresenceInputs = Record<PresenceInput, boolean>;

export interface PresenceCheckParams {
  prompt_after: number;
  respond_within: number;
  max_consecutive_misses: number | null;
  count_across_trials: boolean;
  activity_inputs: PresenceInputs;
  dismiss_inputs: PresenceInputs;
  paused: () => boolean;
  on_expire: (summary: PresenceSummary) => void;
  title: string;
  body: string;
  button_label: string;
  countdown_text: string;
}

const ALL_INPUTS: PresenceInputs = {
  mouse_move: true,
  pointer_down: true,
  keyboard: true,
  wheel: true,
  touch: true,
};

const DEFAULTS: PresenceCheckParams = {
  prompt_after: 30000,
  respond_within: 30000,
  max_consecutive_misses: 2,
  count_across_trials: true,
  activity_inputs: ALL_INPUTS,
  dismiss_inputs: ALL_INPUTS,
  paused: () => false,
  on_expire: () => {},
  title: "Are you still with us?",
  body: "Please click the button to let us know you're still here.",
  button_label: "I'm still here",
  countdown_text: "This message closes in {seconds}s.",
};

// User input only. There is no plain `scroll` listener: a `scroll` event also fires when the page
// scrolls itself (a chat plugin pinning its log to new messages), which shows nobody is there.
// `wheel` and `touchmove` stand in for scrolling. `pointerdown` covers mouse, pen and touch.
const DOM_EVENTS = [
  "mousemove",
  "pointerdown",
  "keydown",
  "input",
  "wheel",
  "touchstart",
  "touchmove",
] as const;

function inputOf(event: Event): PresenceInput | null {
  switch (event.type) {
    case "mousemove":
      return "mouse_move";
    case "pointerdown":
      return (event as PointerEvent).pointerType === "touch" ? "touch" : "pointer_down";
    case "keydown":
    case "input":
      return "keyboard";
    case "wheel":
      return "wheel";
    case "touchstart":
    case "touchmove":
      return "touch";
    default:
      return null;
  }
}

const TICK_MS = 250;
const P = "jspsych-extension-presence-check";

const STYLES = `
.${P} {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.${P}.is-passthrough {
  background: rgba(0, 0, 0, 0.2);
  pointer-events: none;
}
.${P}-card {
  max-width: 26em;
  margin: 1em;
  padding: 1.2em 1.6em;
  border-radius: 8px;
  background: #fff;
  color: #222;
  text-align: center;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
}
.${P}-button {
  padding: 0.5em 1.4em;
  font-size: 1.05em;
  cursor: pointer;
  pointer-events: auto;
}
.${P}-remaining {
  margin-bottom: 0;
  font-size: 0.9em;
}
`;

function mergeParams(...layers: Array<Partial<PresenceCheckParams> | undefined>) {
  const merged = {
    ...DEFAULTS,
    activity_inputs: { ...ALL_INPUTS },
    dismiss_inputs: { ...ALL_INPUTS },
  };
  for (const layer of layers) {
    if (!layer) continue;
    const { activity_inputs, dismiss_inputs, ...rest } = layer;
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (merged as any)[key] = value;
    }
    Object.assign(merged.activity_inputs, activity_inputs);
    Object.assign(merged.dismiss_inputs, dismiss_inputs);
  }
  for (const key of ["prompt_after", "respond_within"] as const) {
    if (!(typeof merged[key] === "number" && merged[key] > 0)) {
      throw new Error(`presence-check: \`${key}\` must be a positive number of ms.`);
    }
  }
  return merged;
}

const info = <const>{
  name: "presence-check",
  version,
  data: {
    /** Warnings shown this trial. */
    presence_prompts: { type: ParameterType.INT },
    /** Warnings dismissed by an input or the button. */
    presence_responded: { type: ParameterType.INT },
    /** Warnings left unanswered, including the one that expired. */
    presence_missed: { type: ParameterType.INT },
    /** Warnings closed by `paused()` or by the trial ending. */
    presence_interrupted: { type: ParameterType.INT },
    /** Clicks on the blocking backdrop, which only button-only and keyboard-only modes have. */
    presence_backdrop_clicks: { type: ParameterType.INT },
    /** The consecutive-miss count when the trial ended. */
    presence_consecutive_misses: { type: ParameterType.INT },
    /** Whether the check expired during this trial. */
    presence_expired: { type: ParameterType.BOOL },
    /** One entry per warning: `shown_at`, `outcome`, `rt`, `dismissed_by`, `backdrop_clicks`. */
    presence_events: { type: ParameterType.COMPLEX, array: true },
  },
};

interface TrialState {
  monitor: PresenceMonitor;
  interval: ReturnType<typeof setInterval>;
  teardown: () => void;
}

/**
 * **presence-check**
 *
 * An "Are you still with us?" check. After `prompt_after` ms with no counted activity a warning
 * appears; a counted input or its button dismisses it, and it closes as missed after
 * `respond_within` ms. When consecutive misses reach `max_consecutive_misses`, `on_expire` is called
 * once and the warning stops for the rest of the trial. Removing anyone is up to that callback.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/blob/main/packages/extension-presence-check/README.md}
 */
class PresenceCheckExtension implements JsPsychExtension {
  static info = info;
  static createPresenceMonitor = createPresenceMonitor;

  private defaults: Partial<PresenceCheckParams> = {};
  private misses = 0;
  private state: TrialState | null = null;

  constructor(private jsPsych: JsPsych) {}

  initialize(params: Partial<PresenceCheckParams> = {}) {
    // Validated now so a bad experiment-wide value fails at startup.
    mergeParams(params);
    this.defaults = params;
    return Promise.resolve();
  }

  /** Clears the consecutive-miss count, in the running trial too. */
  reset() {
    this.misses = 0;
    this.state?.monitor.resetMisses();
  }

  /** The consecutive-miss count carried between trials. */
  get consecutiveMisses() {
    return this.state?.monitor.consecutiveMisses ?? this.misses;
  }

  on_start() {}

  on_load(params: Partial<PresenceCheckParams> = {}) {
    if (this.state) this.finishTrial();
    const options = mergeParams(this.defaults, params);
    const { dismiss_inputs: dismiss, activity_inputs: activity } = options;
    const paused = () => {
      try {
        return Boolean(options.paused());
      } catch {
        return false;
      }
    };
    // Pointer dismissal needs the page to take the click as well, so the overlay lets it through.
    // With only the button, the warning is a modal that takes and traps focus. Keyboard dismissal
    // leaves focus where the participant was typing.
    const passThrough =
      dismiss.mouse_move || dismiss.pointer_down || dismiss.wheel || dismiss.touch;
    const modal = !passThrough && !dismiss.keyboard;

    if (!document.getElementById(`${P}-styles`)) {
      const style = document.createElement("style");
      style.id = `${P}-styles`;
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    let overlay: HTMLElement | null = null;
    let button: HTMLButtonElement | null = null;
    let remaining: HTMLElement | null = null;
    let shownAt: number | null = null;
    let previousFocus: Element | null = null;

    const updateRemaining = () => {
      if (shownAt == null || !remaining) return;
      const left = Math.max(
        0,
        Math.ceil((options.respond_within - (performance.now() - shownAt)) / 1000),
      );
      remaining.innerHTML = options.countdown_text.replace("{seconds}", String(left));
    };

    const show = () => {
      shownAt = performance.now();
      overlay = document.createElement("div");
      overlay.className = passThrough ? `${P} is-passthrough` : P;
      const card = document.createElement("div");
      card.className = `${P}-card`;
      // A modal takes focus, so it is an alertdialog. The others leave focus alone, so they are
      // announced as an alert instead, which fires on insertion.
      if (modal) {
        card.setAttribute("role", "alertdialog");
        card.setAttribute("aria-modal", "true");
        card.setAttribute("aria-labelledby", `${P}-title`);
        card.setAttribute("aria-describedby", `${P}-body`);
      } else {
        card.setAttribute("role", "alert");
      }
      card.innerHTML = `
        <p id="${P}-title" class="${P}-title"><strong>${options.title}</strong></p>
        <p id="${P}-body" class="${P}-body">${options.body}</p>
        <button type="button" class="${P}-button">${options.button_label}</button>
        <p class="${P}-remaining"></p>`;
      overlay.appendChild(card);
      button = card.querySelector(`.${P}-button`);
      remaining = card.querySelector(`.${P}-remaining`);
      button!.addEventListener("click", onButtonClick);
      if (!passThrough) overlay.addEventListener("click", onBackdropClick);
      updateRemaining();
      document.body.appendChild(overlay);
      if (modal) {
        previousFocus = document.activeElement;
        button!.focus({ preventScroll: true });
      }
    };

    const hide = (outcome: PresenceOutcome) => {
      overlay?.remove();
      overlay = button = remaining = null;
      shownAt = null;
      // Pausing (e.g. feedback) and the trial ending must not refocus controls from before.
      const target = previousFocus as HTMLElement | null;
      previousFocus = null;
      if (
        modal &&
        outcome !== "interrupted" &&
        !paused() &&
        target?.isConnected &&
        !target.matches(":disabled, [inert], [inert] *") &&
        target.getClientRects().length > 0
      ) {
        target.focus({ preventScroll: true });
      }
    };

    const monitor = createPresenceMonitor({
      promptAfter: options.prompt_after,
      respondWithin: options.respond_within,
      maxConsecutiveMisses: options.max_consecutive_misses,
      consecutiveMisses: options.count_across_trials ? this.misses : 0,
      now: () => performance.now(),
      onShow: show,
      onHide: hide,
      onExpire: (summary) => options.on_expire(summary),
    });

    // Never preventDefault or stopPropagation here: the input that dismisses the warning must still
    // reach the page (the keystroke goes into the focused field, the click lands where it was aimed).
    const onInput = (event: Event) => {
      if (!event.isTrusted) return;
      const input = inputOf(event);
      if (!input) return;
      if (monitor.isOpen) {
        // A press on the button is left to its click, which records "button".
        if (input === "pointer_down" && button?.contains(event.target as Node)) return;
        if (dismiss[input]) monitor.respond(input);
      } else if (activity[input]) {
        monitor.activity();
      }
    };
    const onButtonClick = () => monitor.respond("button");
    const onBackdropClick = (event: Event) => {
      if (event.isTrusted && event.target === overlay) monitor.backdropClick();
    };
    // The modal has one control. Both Tab directions stay on it, and focus cannot move into the
    // page underneath while it is open.
    const onKeydown = (event: KeyboardEvent) => {
      if (modal && monitor.isOpen && event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        button?.focus({ preventScroll: true });
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (modal && monitor.isOpen && !overlay?.contains(event.target as Node)) {
        button?.focus({ preventScroll: true });
      }
    };

    for (const type of DOM_EVENTS) {
      document.addEventListener(type, onInput, { capture: true, passive: true });
    }
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("focusin", onFocusIn, true);
    const interval = setInterval(() => {
      monitor.tick(paused());
      updateRemaining();
    }, TICK_MS);

    const teardown = () => {
      for (const type of DOM_EVENTS) {
        document.removeEventListener(type, onInput, { capture: true });
      }
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      overlay?.remove();
    };
    this.state = { monitor, interval, teardown };
  }

  on_finish() {
    return this.finishTrial();
  }

  private finishTrial(): Partial<PresenceSummary> {
    const state = this.state;
    if (!state) return {};
    this.state = null;
    clearInterval(state.interval);
    state.monitor.stop();
    state.teardown();
    this.misses = state.monitor.consecutiveMisses;
    return state.monitor.summary();
  }
}

export default PresenceCheckExtension;
