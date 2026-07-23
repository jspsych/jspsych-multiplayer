import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import {
  GroupSessionData,
  MultiplayerApiLike,
  isMultiplayerTimeoutError,
  resolveMultiplayerApi,
} from "./multiplayer-api";

const info = <const>{
  name: "multiplayer-ready",
  version: version,
  parameters: {
    /**
     * How many group members must be ready (including this participant) before the trial ends.
     * Required. May be a function returning a number, so the count can be read from earlier state,
     * e.g. `() => expectedGroupSize`.
     */
    expected_players: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** The HTML content shown above the ready button (the instructions to the participant). */
    stimulus: {
      type: ParameterType.HTML_STRING,
      default: undefined,
    },
    /**
     * Optional HTML reminder shown below the button (e.g. "you'll be matched with one other
     * player"). Following the jsPsych convention, `prompt` is a secondary hint alongside the
     * primary `stimulus`; null shows nothing.
     */
    prompt: {
      type: ParameterType.HTML_STRING,
      default: null,
    },
    /** Label on the ready button. */
    button_label: {
      type: ParameterType.STRING,
      default: "I'm ready",
    },
    /** HTML shown after THIS participant clicks ready, while waiting for the rest of the group. */
    waiting_message: {
      type: ParameterType.HTML_STRING,
      default: "<p>Waiting for other players…</p>",
    },
    /**
     * Extra fields merged into the record this participant pushes alongside `ready: true` (for
     * example a display name). May be a function returning the object. Because pushes are
     * overwrite-per-participant, this record REPLACES anything this participant pushed earlier — so
     * anything that must survive the check-in belongs here. Leave null to push only `{ ready: true }`.
     */
    push_data: {
      type: ParameterType.OBJECT,
      default: null,
    },
    /**
     * Maximum time to wait for the rest of the group AFTER clicking ready, in milliseconds. When it
     * elapses the trial ends with `timed_out: true` and `on_timeout` is called. Null (or a
     * non-positive value) waits indefinitely. Note: this bounds only the wait for others — it does
     * not bound how long this participant takes to click ready.
     */
    timeout: {
      type: ParameterType.INT,
      default: null,
    },
    /** Called if `timeout` elapses before the whole group is ready. */
    on_timeout: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /**
     * Minimum time, in milliseconds, to keep the waiting message on screen after this participant
     * clicks ready. Prevents the message from flashing by when the group is already ready (e.g. this
     * participant is the last to check in, or the solo `expected_players: 1` case). Does not extend a
     * wait that already takes longer than this on its own.
     */
    minimum_wait: {
      type: ParameterType.INT,
      default: 0,
    },
  },
  data: {
    /** Time from the ready button appearing to this participant clicking it, in milliseconds. */
    rt: {
      type: ParameterType.INT,
    },
    /** Time spent waiting for the rest of the group, in ms, from the click until the trial ended. */
    wait_time: {
      type: ParameterType.INT,
    },
    /** Number of group members marked ready in the snapshot at the moment the trial ended. */
    n_ready: {
      type: ParameterType.INT,
    },
    /** The full group session snapshot at the moment the group was ready (or the timeout fired). */
    group: {
      type: ParameterType.OBJECT,
    },
    /** True if the trial ended because `timeout` elapsed rather than because everyone was ready. */
    timed_out: {
      type: ParameterType.BOOL,
    },
    /**
     * The `MultiplayerTimeoutError` message when `timeout` elapsed; null when everyone was ready.
     * A non-timeout `wait()` rejection (an adapter/backend failure) is NOT captured here — it
     * propagates and fails the trial instead of being recorded as a timeout.
     */
    wait_error: {
      type: ParameterType.STRING,
    },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/**
 * **multiplayer-ready**
 *
 * A participant-facing ready / check-in barrier for multiplayer experiments. Shows a stimulus and a
 * ready button; when this participant clicks it, the plugin pushes `{ ready: true }` into the shared
 * group session, swaps to a waiting message, and ends the trial once `expected_players` members are
 * ready (or an optional `timeout` elapses while waiting for the rest of the group).
 *
 * It differs from `plugin-multiplayer-sync` by owning the check-in UI and the explicit "everyone is
 * ready" condition, rather than taking an arbitrary `wait_for` predicate. Standardizing on the
 * `ready: true` flag lets other plugins and examples (chat rooms, ultimatum games, real-time tasks)
 * reliably gate on group readiness.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`. The resolved group session is stored in the trial's `group` data so peer reads
 * and role assignment can happen in a normal `on_finish`.
 *
 * @author Mandy Liao
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-ready multiplayer-ready plugin documentation}
 */
class MultiplayerReadyPlugin implements JsPsychPlugin<Info> {
  static info = info;

  constructor(private jsPsych: JsPsych) {}

  async trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const api = resolveMultiplayerApi(this.jsPsych);

    const expected = trial.expected_players;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      throw new Error(
        "multiplayer-ready: the `expected_players` parameter is required and must be a positive " +
          "integer (the total group size, including this participant)."
      );
    }

    const start = performance.now();

    // Render the stimulus, the ready button, and the optional secondary prompt below it.
    const promptHtml =
      trial.prompt == null
        ? ""
        : `<div class="jspsych-multiplayer-ready-prompt">${trial.prompt}</div>`;
    display_element.innerHTML =
      `<div class="jspsych-multiplayer-ready">` +
      `<div class="jspsych-multiplayer-ready-stimulus">${trial.stimulus}</div>` +
      `<button class="jspsych-btn" id="jspsych-multiplayer-ready-btn">${trial.button_label}</button>` +
      `${promptHtml}</div>`;
    // jsPsych only auto-fires on_load for trials whose `trial()` returns synchronously; this one
    // returns a Promise, so we must invoke the callback ourselves once the screen is rendered.
    on_load?.();

    // Wait for this participant to click ready. `rt` measures how long they took to decide; the
    // click is intentionally unbounded (the `timeout` param bounds only the later group wait).
    const rt = await new Promise<number>((resolve) => {
      const button = display_element.querySelector<HTMLButtonElement>(
        "#jspsych-multiplayer-ready-btn"
      );
      button?.addEventListener("click", () => resolve(Math.round(performance.now() - start)), {
        once: true,
      });
    });

    // Swap to the waiting screen; from here on we are waiting for the rest of the group.
    display_element.innerHTML = `<div class="jspsych-multiplayer-ready">${trial.waiting_message}</div>`;
    const waitStart = performance.now();

    const finish = (group: GroupSessionData, timed_out: boolean, wait_error: string | null) => {
      this.jsPsych.finishTrial({
        rt,
        wait_time: Math.round(performance.now() - waitStart),
        n_ready: countReady(group),
        group,
        timed_out,
        wait_error,
      });
    };

    /** Keep the waiting message on screen for at least `minimum_wait` ms (measured from the click). */
    const holdMinimumWait = async () => {
      const min = typeof trial.minimum_wait === "number" ? trial.minimum_wait : 0;
      const elapsed = performance.now() - waitStart;
      if (elapsed < min) {
        await new Promise((resolve) => setTimeout(resolve, min - elapsed));
      }
    };

    /**
     * Read the latest group snapshot without letting a failure mask the outcome. On the timeout /
     * rejection path the adapter may already be torn down, so a throwing getAll() must not escape
     * and prevent the trial from finishing — fall back to an empty snapshot instead.
     */
    const safeGetAll = (): GroupSessionData => {
      try {
        return api.getAll();
      } catch {
        return {};
      }
    };

    // A single record REPLACES this participant's group-session entry (overwrite-per-participant),
    // so push the ready flag together with any carry-forward `push_data` in one shot. Spreading a
    // null push_data is a no-op, leaving just `{ ready: true }`.
    const readyRecord = { ...(trial.push_data as Record<string, unknown> | null), ready: true };

    // Push BEFORE the wait try/catch: a push failure is an infrastructure error, not a timeout, and
    // must surface loudly (rejecting the trial) rather than being relabeled as `timed_out: true`.
    await api.push(readyRecord);

    // Only a positive timeout bounds the wait; null/0/negative means wait indefinitely.
    const timeout =
      typeof trial.timeout === "number" && trial.timeout > 0 ? trial.timeout : undefined;

    /** Ready once at least `expected` members carry `ready === true` (this participant included). */
    const everyoneReady = (group: GroupSessionData) => countReady(group) >= expected;

    try {
      const group = await api.wait(everyoneReady, timeout);
      await holdMinimumWait();
      finish(group, false, null);
    } catch (e) {
      // #3694 exports a typed MultiplayerTimeoutError so a genuine timeout can be told apart from
      // another wait() failure (e.g. an adapter/backend error). The name-based match lives in
      // isMultiplayerTimeoutError (multiplayer-api.ts) — the class itself isn't importable here.
      if (!isMultiplayerTimeoutError(e)) {
        // Not a timeout — an adapter/backend failure. Surface it loudly instead of mislabeling it
        // `timed_out: true`, matching the push-failure handling above.
        throw e;
      }
      if (typeof trial.on_timeout === "function") {
        trial.on_timeout(e);
      }
      // Honour minimum_wait here too, so a short timeout can't flash the waiting message by.
      await holdMinimumWait();
      finish(safeGetAll(), true, e.message);
    }
  }
}

/** Count group members whose entry is flagged `ready === true`. */
function countReady(group: GroupSessionData): number {
  return Object.values(group).filter((entry) => entry?.ready === true).length;
}

export default MultiplayerReadyPlugin;
