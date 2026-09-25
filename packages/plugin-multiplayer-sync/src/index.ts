import {
  getMultiplayer,
  isMultiplayerError,
  MultiplayerOutcome,
  outcomeOf,
  pluginTimeout,
  remainingParticipants,
} from "@jspsych-multiplayer/utils";
import {
  GroupSessionData,
  JsPsych,
  JsPsychPlugin,
  ParameterType,
  PresenceData,
  TrialType,
} from "jspsych";

import { version } from "../package.json";

const info = <const>{
  name: "multiplayer-sync",
  version: version,
  parameters: {
    /**
     * Predicate evaluated against this trial's shared data on every update. The trial ends as soon
     * as it returns true. Receives `(group, presence)`: the data participants wrote during this
     * trial (keyed by participantId) and each participant's presence status. Both are frozen; don't
     * modify them. This is the same condition you would pass to `jsPsych.multiplayer.wait()`.
     */
    wait_for: {
      type: ParameterType.FUNCTION,
      default: undefined,
    },
    /**
     * Data to write to this participant's part of the trial's shared data when the trial starts,
     * before waiting. It is merged in with `jsPsych.multiplayer.update()`, never replacing what is
     * there. Leave null to wait without writing. As with any jsPsych parameter, you may supply a
     * function that returns the object, e.g. `() => ({ offer })`.
     */
    write_data: {
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
     * ends with `multiplayer_outcome: "timeout"` and `on_timeout` is called. Null (or a
     * non-positive value) waits indefinitely.
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
     * satisfied, the trial ends with `multiplayer_outcome: "participant_left"`. Null (the default)
     * means the other members of a sealed group who haven't left, or else every other participant
     * who is connected when the wait starts. Pass `[]` to ignore departures, e.g. for a lobby that
     * keeps waiting for others to join.
     */
    participants: {
      // An array of participant IDs, or null; COMPLEX because array parameters can't be null
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
    /** Save the trial's shared data, as it was when the trial ended, in the `group` data field. */
    save_group: {
      type: ParameterType.BOOL,
      default: false,
    },
  },
  data: {
    /**
     * The trial's shared data (keyed by participantId) at the moment the trial ended. Only saved
     * when `save_group` is true.
     */
    group: {
      type: ParameterType.OBJECT,
      default: undefined,
    },
    /** Time spent waiting, in milliseconds, from trial start until the trial ended. */
    wait_time: {
      type: ParameterType.INT,
      default: undefined,
    },
    /**
     * How the trial ended: `"completed"` when `wait_for` was met, `"timeout"`,
     * `"participant_left"` (a participant in `participants` left), or `"connection_lost"`.
     */
    multiplayer_outcome: {
      type: ParameterType.STRING,
      default: "completed",
    },
    /** The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`. */
    left_participant: {
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
 * A synchronization barrier for multiplayer experiments. Optionally writes this participant's data
 * to the trial's shared data, displays a waiting message, and ends the trial once a condition over
 * that data is met, a timeout elapses, a participant the barrier depends on leaves, or the
 * connection is lost. It packages the common write → wait pattern as a single declarative trial so
 * experiments don't have to shoehorn waiting into `call-function` or a `NO_KEYS` keyboard-response
 * trial.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`. Each trial has its own part of the shared data, so values written in an earlier
 * trial never satisfy this one. If the experiment ends or aborts while the barrier is holding, the
 * wait is cancelled and the trial stops quietly, recording nothing.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-sync multiplayer-sync plugin documentation}
 */
class MultiplayerSyncPlugin implements JsPsychPlugin<Info> {
  static info = info;

  constructor(private jsPsych: JsPsych) {}

  async trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const multiplayer = getMultiplayer(this.jsPsych, "multiplayer-sync");

    if (typeof trial.wait_for !== "function") {
      throw new Error(
        "multiplayer-sync: the `wait_for` parameter is required and must be a function " +
          "(a predicate over the trial's shared data).",
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

    const finish = async (
      group: GroupSessionData,
      outcome: MultiplayerOutcome,
      leftParticipant: string | null = null,
    ) => {
      await holdMinimumWait();
      this.jsPsych.finishTrial({
        ...(trial.save_group ? { group } : {}),
        wait_time: Math.round(performance.now() - start),
        multiplayer_outcome: outcome,
        left_participant: leftParticipant,
      });
    };

    try {
      if (trial.write_data != null) {
        // The write shows up in this participant's own reads at once, and the core keeps retrying
        // it until the backend has it, so don't hold the wait (and its timeout) for the
        // confirmation. It only fails if the session closes, which the wait reports too.
        multiplayer.update(trial.write_data as Record<string, unknown>).catch(() => {});
      }
      const participants =
        (trial.participants as string[] | null) ?? remainingParticipants(multiplayer);
      const group = await multiplayer.wait(waitFor, {
        timeout: pluginTimeout(trial.timeout),
        participants,
      });
      await finish(group, "completed");
    } catch (e) {
      const outcome = outcomeOf(e);
      // A bug in `wait_for` or an adapter/backend failure. Surface it loudly instead of recording
      // it as an outcome.
      if (outcome === null) throw e;
      // A cancelled wait (abortExperiment, or the end of the trial or of jsPsych.run) means the
      // trial is being torn down: jsPsych has already moved on, so stop quietly — no on_timeout,
      // no finishTrial into a trial that no longer exists, and nothing recorded as a failure.
      if (outcome === "cancelled") return;

      if (outcome === "timeout" && typeof trial.on_timeout === "function") {
        trial.on_timeout(e);
      }
      const left = isMultiplayerError(e, "participant_left") ? (e.participantId ?? null) : null;
      // Reads keep working after the connection is lost; they return the last state seen.
      await finish(multiplayer.getAll(), outcome, left);
    }
  }
}

export default MultiplayerSyncPlugin;
