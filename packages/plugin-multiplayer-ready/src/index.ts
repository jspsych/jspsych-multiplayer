import {
  GroupSessionData,
  JsPsych,
  JsPsychPlugin,
  ParameterType,
  PresenceData,
  TrialType,
} from "jspsych";

import { version } from "../package.json";
import {
  getMultiplayer,
  isMultiplayerError,
  nextGateKey,
  remainingParticipants,
} from "./multiplayer";

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
     * Extra fields written to this participant's slot along with the ready flags (for example a
     * display name). May be a function returning the object. The fields are merged into the slot,
     * so data from earlier trials is kept. Leave null to write only the ready flags.
     */
    push_data: {
      type: ParameterType.OBJECT,
      default: null,
    },
    /**
     * The key that marks this participant as ready at THIS gate. Each gate needs its own key, so
     * that flags left over from an earlier gate can't make a later one pass. Null (the default)
     * generates `ready-1`, `ready-2`, … in the order this participant reaches ready gates, which
     * matches across participants as long as everyone passes the same gates. A gate that only some
     * participants reach (e.g. inside a `conditional_function`) needs an explicit key. The count
     * starts over if the page reloads.
     */
    data_key: {
      type: ParameterType.STRING,
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
     * Participants the gate depends on. If one of them leaves the session before the group is
     * ready, the trial ends with `partner_left: true`. Null (the default) means every other
     * participant who is connected when this participant clicks ready. Pass `[]` to ignore
     * departures.
     */
    participants: {
      // An array of participant IDs, or null; COMPLEX because array parameters can't default to null
      type: ParameterType.COMPLEX,
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
    /**
     * Number of group members ready at this gate, and still in the session, at the moment the
     * trial ended.
     */
    n_ready: {
      type: ParameterType.INT,
    },
    /** The key that marked readiness at this gate (`data_key`, or the generated `ready-N`). */
    data_key: {
      type: ParameterType.STRING,
    },
    /** The full group session snapshot at the moment the trial ended. Frozen. */
    group: {
      type: ParameterType.OBJECT,
    },
    /** True if the trial ended because `timeout` elapsed rather than because everyone was ready. */
    timed_out: {
      type: ParameterType.BOOL,
    },
    /** True if the trial ended because a participant in `participants` left the session. */
    partner_left: {
      type: ParameterType.BOOL,
    },
    /** The ID of the participant who left, when `partner_left` is true; otherwise null. */
    left_participant: {
      type: ParameterType.STRING,
    },
    /** True if the trial ended because this participant's connection was lost for good. */
    connection_lost: {
      type: ParameterType.BOOL,
    },
    /**
     * The message of the error that ended the wait early (a timeout, a participant leaving, or a
     * lost connection); null when everyone was ready. Other failures (an adapter/backend error)
     * fail the trial instead. A wait CANCELLED by the experiment ending or aborting produces no
     * record at all: the trial stops quietly.
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
 * ready button; when this participant clicks it, the plugin marks them ready at this gate in the
 * shared group session, swaps to a waiting message, and ends the trial once `expected_players`
 * members are ready at this gate, a timeout elapses, a participant the gate depends on leaves, or
 * the connection is lost.
 *
 * It differs from `plugin-multiplayer-sync` by owning the check-in UI and the explicit "everyone is
 * ready" condition, rather than taking an arbitrary `wait_for` predicate. Each gate has its own key
 * (`data_key`), so readiness at one gate never carries over to the next. The plugin also sets
 * `ready: true` for experiments that only need to know a participant has checked in at least once.
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
    const multiplayer = getMultiplayer(this.jsPsych);

    const expected = trial.expected_players;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      throw new Error(
        "multiplayer-ready: the `expected_players` parameter is required and must be a positive " +
          "integer (the total group size, including this participant).",
      );
    }

    // Take the key now, at the gate, so it doesn't depend on how long the click takes
    const key = trial.data_key ?? nextGateKey(this.jsPsych);

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
        "#jspsych-multiplayer-ready-btn",
      );
      button?.addEventListener("click", () => resolve(Math.round(performance.now() - start)), {
        once: true,
      });
    });

    // Swap to the waiting screen; from here on we are waiting for the rest of the group.
    display_element.innerHTML = `<div class="jspsych-multiplayer-ready">${trial.waiting_message}</div>`;
    const waitStart = performance.now();

    /** Keep the waiting message on screen for at least `minimum_wait` ms (measured from the click). */
    const holdMinimumWait = async () => {
      const min = typeof trial.minimum_wait === "number" ? trial.minimum_wait : 0;
      const elapsed = performance.now() - waitStart;
      if (elapsed < min) {
        await new Promise<void>((resolve) =>
          this.jsPsych.pluginAPI.setTimeout(resolve, min - elapsed),
        );
      }
    };

    /**
     * Read the latest group snapshot and presence without letting a failure mask the outcome.
     * After a disconnect() there is no session, so the reads throw; fall back to empty snapshots.
     */
    const safeRead = (): [GroupSessionData, PresenceData] => {
      try {
        return [multiplayer.getAll(), multiplayer.presence()];
      } catch {
        return [{}, {}];
      }
    };

    const finish = async (
      [group, presence]: [GroupSessionData, PresenceData],
      outcome: {
        timed_out?: boolean;
        partner_left?: boolean;
        left_participant?: string | null;
        connection_lost?: boolean;
        wait_error?: string | null;
      } = {},
    ) => {
      await holdMinimumWait();
      this.jsPsych.finishTrial({
        rt,
        wait_time: Math.round(performance.now() - waitStart),
        n_ready: countReady(group, presence, key),
        data_key: key,
        group,
        timed_out: outcome.timed_out ?? false,
        partner_left: outcome.partner_left ?? false,
        left_participant: outcome.left_participant ?? null,
        connection_lost: outcome.connection_lost ?? false,
        wait_error: outcome.wait_error ?? null,
      });
    };

    // Core reads null, negative and non-finite timeouts as "no timeout", but times out
    // IMMEDIATELY at 0, and this plugin documents any non-positive value as "wait indefinitely".
    const timeout =
      typeof trial.timeout === "number" && trial.timeout > 0 ? trial.timeout : undefined;

    const everyoneReady = (group: GroupSessionData, presence: PresenceData) =>
      countReady(group, presence, key) >= expected;

    try {
      // Merge rather than replace, so this gate's flag never removes an earlier gate's flag that a
      // slower participant may still be counting. A write failure is an infrastructure error, not
      // a timeout: it fails the trial below unless it's a lost connection.
      await multiplayer.update({
        ...(trial.push_data as Record<string, unknown> | null),
        ready: true,
        [key]: true,
      });
      const participants =
        (trial.participants as string[] | null) ?? remainingParticipants(multiplayer);
      const group = await multiplayer.wait(everyoneReady, { timeout, participants });
      await finish([group, multiplayer.presence()]);
    } catch (e) {
      // A cancelled wait is neither a timeout nor a failure: jsPsych cancels pending waits when the
      // experiment ends or is aborted, so the trial is already being torn down. Return quietly.
      if (isMultiplayerError(e, "MultiplayerCancelledError")) return;

      if (isMultiplayerError(e, "MultiplayerTimeoutError")) {
        if (typeof trial.on_timeout === "function") {
          trial.on_timeout(e);
        }
        await finish(safeRead(), { timed_out: true, wait_error: e.message });
      } else if (isMultiplayerError(e, "MultiplayerParticipantLeftError")) {
        await finish(safeRead(), {
          partner_left: true,
          left_participant: e.participantId ?? null,
          wait_error: e.message,
        });
      } else if (isMultiplayerError(e, "MultiplayerConnectionClosedError")) {
        await finish(safeRead(), { connection_lost: true, wait_error: e.message });
      } else {
        // An adapter/backend failure. Surface it loudly instead of recording it as an outcome.
        throw e;
      }
    }
  }
}

/** Count group members who are ready at this gate and haven't left the session. */
function countReady(group: GroupSessionData, presence: PresenceData, key: string): number {
  return Object.entries(group).filter(
    ([id, entry]) => entry?.[key] === true && presence[id] !== "left",
  ).length;
}

export default MultiplayerReadyPlugin;
