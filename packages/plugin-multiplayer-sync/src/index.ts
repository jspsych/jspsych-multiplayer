import {
  GroupSessionData,
  JsPsych,
  JsPsychPlugin,
  ParameterType,
  PresenceData,
  TrialType,
} from "jspsych";

import { version } from "../package.json";
import { getMultiplayer, isMultiplayerError, remainingParticipants } from "./multiplayer";

const info = <const>{
  name: "multiplayer-sync",
  version: version,
  parameters: {
    /**
     * Predicate evaluated against the group session on every update. The trial ends as soon as it
     * returns true. Receives `(group, presence)`: the group session data (keyed by participantId)
     * and each participant's presence status. Both are frozen; don't modify them. This is the same
     * condition you would pass to `jsPsych.multiplayer.wait()`.
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
     * Participants the barrier depends on. If one of them leaves the session before `wait_for` is
     * satisfied, the trial ends with `partner_left: true`. Null (the default) means every other
     * participant who is connected when the wait starts. Pass `[]` to ignore departures.
     */
    participants: {
      // An array of participant IDs, or null; COMPLEX because array parameters can't default to null
      type: ParameterType.COMPLEX,
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
    /** The full group session snapshot at the moment the trial ended. */
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
    /** True if the trial ended because a participant in `participants` left the session. */
    partner_left: {
      type: ParameterType.BOOL,
      default: false,
    },
    /** The ID of the participant who left, when `partner_left` is true; otherwise null. */
    left_participant: {
      type: ParameterType.STRING,
      default: null,
    },
    /** True if the trial ended because this participant's connection was lost for good. */
    connection_lost: {
      type: ParameterType.BOOL,
      default: false,
    },
    /**
     * The message of the error that ended the wait early (a timeout, a participant leaving, or a
     * lost connection); null when `wait_for` was satisfied. Other `wait()` failures, such as a
     * throwing `wait_for`, are not recorded here: they fail the trial instead.
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

interface Outcome {
  timed_out?: boolean;
  partner_left?: boolean;
  left_participant?: string | null;
  connection_lost?: boolean;
  wait_error?: string | null;
}

/**
 * **multiplayer-sync**
 *
 * A synchronization barrier for multiplayer experiments. Optionally pushes this participant's data
 * into the shared group session, displays a waiting message, and ends the trial once a condition
 * over the group session is met, a timeout elapses, a participant the barrier depends on leaves, or
 * the connection is lost. It packages the common push → wait pattern as a single declarative trial
 * so experiments don't have to shoehorn waiting into `call-function` or a `NO_KEYS`
 * keyboard-response trial.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`. The group session is stored in the trial's `group` data so peer reads and role
 * assignment can happen in a normal `on_finish`. If the experiment ends or aborts while the barrier
 * is holding, the wait is cancelled and the trial stops quietly, recording nothing.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-sync multiplayer-sync plugin documentation}
 */
class MultiplayerSyncPlugin implements JsPsychPlugin<Info> {
  static info = info;

  constructor(private jsPsych: JsPsych) {}

  async trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const multiplayer = getMultiplayer(this.jsPsych);

    if (typeof trial.wait_for !== "function") {
      throw new Error(
        "multiplayer-sync: the `wait_for` parameter is required and must be a function " +
          "(a predicate over the group session).",
      );
    }
    const waitFor = trial.wait_for as (group: GroupSessionData, presence: PresenceData) => boolean;

    display_element.innerHTML = `<div class="jspsych-multiplayer-sync">${trial.message}</div>`;
    // jsPsych only auto-fires on_load for trials whose `trial()` returns synchronously; this one
    // returns a Promise, so we must invoke the callback ourselves once the screen is rendered.
    on_load?.();

    const start = performance.now();

    /** Keep the waiting message on screen until at least `minimum_wait` ms have elapsed. */
    const holdMinimumWait = async () => {
      const elapsed = performance.now() - start;
      if (elapsed < trial.minimum_wait) {
        await new Promise<void>((resolve) =>
          this.jsPsych.pluginAPI.setTimeout(resolve, trial.minimum_wait - elapsed),
        );
      }
    };

    /**
     * Read the latest group snapshot without letting a failure mask the outcome. After a
     * disconnect() there is no session, so getAll() throws; fall back to an empty snapshot.
     */
    const safeGetAll = (): GroupSessionData => {
      try {
        return multiplayer.getAll();
      } catch {
        return {};
      }
    };

    const finish = async (group: GroupSessionData, outcome: Outcome = {}) => {
      await holdMinimumWait();
      this.jsPsych.finishTrial({
        group,
        wait_time: Math.round(performance.now() - start),
        timed_out: outcome.timed_out ?? false,
        partner_left: outcome.partner_left ?? false,
        left_participant: outcome.left_participant ?? null,
        connection_lost: outcome.connection_lost ?? false,
        wait_error: outcome.wait_error ?? null,
      });
    };

    // Only a positive timeout bounds the wait; null/0/negative means wait indefinitely. Core reads
    // null and negative values as "no timeout" itself, but treats 0 as "time out immediately".
    const timeout =
      typeof trial.timeout === "number" && trial.timeout > 0 ? trial.timeout : undefined;

    try {
      // A push failure is an infrastructure error, not a timeout: it fails the trial below unless
      // it's a lost connection, which ends the trial like any other lost connection.
      if (trial.push_data != null) {
        await multiplayer.push(trial.push_data as Record<string, unknown>);
      }
      const participants =
        (trial.participants as string[] | null) ?? remainingParticipants(multiplayer);
      const group = await multiplayer.wait(waitFor, { timeout, participants });
      await finish(group);
    } catch (e) {
      // A cancelled wait (abortExperiment, disconnect, or the end of jsPsych.run) means the trial is
      // being torn down: jsPsych has already moved on, so stop quietly — no on_timeout, no
      // finishTrial into a trial that no longer exists, and nothing recorded as a failure.
      if (isMultiplayerError(e, "MultiplayerCancelledError")) return;

      if (isMultiplayerError(e, "MultiplayerTimeoutError")) {
        if (typeof trial.on_timeout === "function") {
          trial.on_timeout(e);
        }
        await finish(safeGetAll(), { timed_out: true, wait_error: e.message });
      } else if (isMultiplayerError(e, "MultiplayerParticipantLeftError")) {
        await finish(safeGetAll(), {
          partner_left: true,
          left_participant: e.participantId ?? null,
          wait_error: e.message,
        });
      } else if (isMultiplayerError(e, "MultiplayerConnectionClosedError")) {
        await finish(safeGetAll(), { connection_lost: true, wait_error: e.message });
      } else {
        // A bug in `wait_for` or an adapter/backend failure. Surface it loudly instead of
        // recording it as one of the outcomes above.
        throw e;
      }
    }
  }
}

export default MultiplayerSyncPlugin;
