import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import {
  GroupSessionData,
  MultiplayerApiLike,
  isMultiplayerTimeoutError,
  resolveMultiplayerApi,
} from "./multiplayer-api";

const info = <const>{
  name: "multiplayer-sync",
  version: version,
  parameters: {
    /**
     * Predicate evaluated against the full group session on every update. The trial ends as soon
     * as it returns true. Receives the group session data (keyed by participantId). This is the
     * same condition you would pass to `jsPsych.multiplayer.wait()`.
     */
    wait_for: {
      type: ParameterType.FUNCTION,
      default: undefined,
    },
    /**
     * Data to push into the shared group session when the trial starts, before waiting. Leave
     * null to wait without pushing. As with any jsPsych parameter, you may supply a function that
     * returns the object — useful for reading state set by earlier trials, e.g. `() => ({ offer })`.
     */
    push_data: {
      type: ParameterType.OBJECT,
      default: null,
    },
    /** HTML shown while waiting for the condition to be met. */
    message: {
      type: ParameterType.HTML_STRING,
      default: "<p>Waiting for other players…</p>",
    },
    /**
     * Maximum time to wait, in milliseconds, before giving up. When the timeout elapses the trial
     * ends with `timed_out: true` and `on_timeout` is called. Null (or a non-positive value) waits
     * indefinitely.
     */
    timeout: {
      type: ParameterType.INT,
      default: null,
    },
    /** Called if `timeout` elapses before `wait_for` is satisfied. */
    on_timeout: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /**
     * Minimum time, in milliseconds, to keep the waiting message on screen. Prevents the screen
     * from flashing by when the condition is already satisfied. Does not extend a wait that takes
     * longer than this on its own.
     */
    minimum_wait: {
      type: ParameterType.INT,
      default: 0,
    },
  },
  data: {
    /** The full group session snapshot at the moment the condition was met (or the timeout fired). */
    group: {
      type: ParameterType.OBJECT,
      default: undefined,
    },
    /** Time spent waiting, in milliseconds, from trial start until the trial ended. */
    wait_time: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** True if the trial ended because `timeout` elapsed rather than because `wait_for` was met. */
    timed_out: {
      type: ParameterType.BOOL,
      default: false,
    },
    /**
     * The `MultiplayerTimeoutError` message when `timeout` elapsed; null when the condition was
     * satisfied. A non-timeout `wait()` rejection (a throwing `wait_for`, an adapter failure) is
     * NOT captured here — it propagates and fails the trial instead of being recorded as a timeout.
     */
    wait_error: {
      type: ParameterType.STRING,
      default: null,
    },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/**
 * **multiplayer-sync**
 *
 * A synchronization barrier for multiplayer experiments. Optionally pushes this participant's data
 * into the shared group session, displays a waiting message, and ends the trial once a condition
 * over the group session is met (or an optional timeout elapses). It packages the common
 * push → wait pattern as a single declarative trial so experiments don't have to shoehorn waiting
 * into `call-function` or a `NO_KEYS` keyboard-response trial.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`. The resolved group session is stored in the trial's `group` data so peer reads
 * and role assignment can happen in a normal `on_finish`.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-sync multiplayer-sync plugin documentation}
 */
class MultiplayerSyncPlugin implements JsPsychPlugin<Info> {
  static info = info;

  constructor(private jsPsych: JsPsych) {}

  async trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const api = resolveMultiplayerApi(this.jsPsych);

    if (typeof trial.wait_for !== "function") {
      throw new Error(
        "multiplayer-sync: the `wait_for` parameter is required and must be a function " +
          "(a predicate over the group session)."
      );
    }

    display_element.innerHTML = `<div class="jspsych-multiplayer-sync">${trial.message}</div>`;
    // jsPsych only auto-fires on_load for trials whose `trial()` returns synchronously; this one
    // returns a Promise, so we must invoke the callback ourselves once the screen is rendered.
    on_load?.();

    const start = performance.now();

    const finish = (group: GroupSessionData, timed_out: boolean, wait_error: string | null) => {
      this.jsPsych.finishTrial({
        group,
        wait_time: Math.round(performance.now() - start),
        timed_out,
        wait_error,
      });
    };

    /** Keep the waiting message on screen until at least `minimum_wait` ms have elapsed. */
    const holdMinimumWait = async () => {
      const elapsed = performance.now() - start;
      if (elapsed < trial.minimum_wait) {
        await new Promise((resolve) =>
          this.jsPsych.pluginAPI.setTimeout(resolve, trial.minimum_wait - elapsed)
        );
      }
    };

    /**
     * Read the latest group snapshot without letting a failure mask the outcome. On the timeout
     * path the adapter may already be torn down, so a throwing getAll() must not escape and prevent
     * the trial from finishing — fall back to an empty snapshot instead.
     */
    const safeGetAll = (): GroupSessionData => {
      try {
        return api.getAll();
      } catch {
        return {};
      }
    };

    // Push BEFORE the wait try/catch: a push failure is an infrastructure error, not a timeout, and
    // must surface loudly (rejecting the trial) rather than being relabeled as `timed_out: true`.
    if (trial.push_data != null) {
      await api.push(trial.push_data as Record<string, unknown>);
    }

    // Only a positive timeout bounds the wait; null/0/negative means wait indefinitely.
    const timeout =
      typeof trial.timeout === "number" && trial.timeout > 0 ? trial.timeout : undefined;

    try {
      const group = await api.wait(trial.wait_for as (data: GroupSessionData) => boolean, timeout);

      await holdMinimumWait();

      finish(group, false, null);
    } catch (e) {
      // #3694 exports a typed MultiplayerTimeoutError so a genuine timeout can be told apart from a
      // throwing `wait_for` predicate or another wait() failure. The name-based match lives in
      // isMultiplayerTimeoutError (multiplayer-api.ts) — the class itself isn't importable here.
      if (!isMultiplayerTimeoutError(e)) {
        // Not a timeout — a bug in `wait_for` or an adapter/backend failure. Surface it loudly
        // instead of mislabeling it `timed_out: true`, matching the push-failure handling above.
        throw e;
      }
      if (typeof trial.on_timeout === "function") {
        trial.on_timeout(e);
      }
      // Honour minimum_wait here too, so a short timeout can't flash the waiting message.
      await holdMinimumWait();
      finish(safeGetAll(), true, e.message);
    }
  }
}

export default MultiplayerSyncPlugin;
