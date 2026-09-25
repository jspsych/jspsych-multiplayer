import {
  getMultiplayer,
  isMultiplayerError,
  MultiplayerOutcome,
  outcomeOf,
  sealedGroupSize,
  waitForAll,
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

/** The key that marks a participant as ready in the trial's shared data. */
const READY_KEY = "ready";

const info = <const>{
  name: "multiplayer-ready",
  version: version,
  parameters: {
    /**
     * How many group members must be ready (including this participant) before the trial ends.
     * May be a function returning a number, so the count can be read from earlier state, e.g.
     * `() => expectedGroupSize`. Null (the default) means everyone in the group: the members of a
     * sealed group (see `jsPsych.multiplayer.group()`) who haven't left. With a group that isn't
     * sealed when the trial starts, it is required.
     */
    expected_players: {
      type: ParameterType.INT,
      default: null,
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
     * Extra fields written to this participant's part of the trial's shared data along with
     * `ready: true`, when they click ready. May be a function returning the object. The fields are
     * merged in with `jsPsych.multiplayer.update()`. Leave null to write only the ready flag.
     */
    write_data: {
      type: ParameterType.OBJECT,
      default: null,
    },
    /**
     * Maximum time to wait for the rest of the group AFTER clicking ready, in milliseconds. When it
     * elapses the trial ends with `multiplayer_outcome: "timeout"` and `on_timeout` is called. Null
     * (or a non-positive value) waits indefinitely. Note: this bounds only the wait for others — it
     * does not bound how long this participant takes to click ready.
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
     * ready, the trial ends with `multiplayer_outcome: "participant_left"`. Null (the default)
     * means the other members of a sealed group who haven't left, or else every other participant
     * who is connected when this participant clicks ready. Pass `[]` to ignore departures.
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
    /** Save the trial's shared data, as it was when the trial ended, in the `group` data field. */
    save_group: {
      type: ParameterType.BOOL,
      default: false,
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
    /** Number of group members ready, and still in the session, at the moment the trial ended. */
    n_ready: {
      type: ParameterType.INT,
    },
    /**
     * How the trial ended: `"completed"` when everyone was ready, `"timeout"`,
     * `"participant_left"` (a participant in `participants` left), or `"connection_lost"`.
     */
    multiplayer_outcome: {
      type: ParameterType.STRING,
    },
    /** The ID of the participant who left, when `multiplayer_outcome` is `"participant_left"`. */
    left_participant: {
      type: ParameterType.STRING,
    },
    /**
     * The trial's shared data (keyed by participantId) at the moment the trial ended. Only saved
     * when `save_group` is true. Frozen.
     */
    group: {
      type: ParameterType.OBJECT,
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
 * ready button; when this participant clicks it, the plugin writes `ready: true` to the trial's
 * shared data, swaps to a waiting message, and ends the trial once `expected_players` members are
 * ready, a timeout elapses, a participant the gate depends on leaves, or the connection is lost.
 *
 * It differs from `plugin-multiplayer-sync` by owning the check-in UI and the explicit "everyone is
 * ready" condition, rather than taking an arbitrary `wait_for` predicate. Each trial has its own
 * part of the shared data, so readiness at one gate never carries over to the next.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`. With `save_group: true`, the trial's shared data is stored in the trial's `group`
 * data so peer reads can happen in a normal `on_finish`.
 *
 * @author Mandy Liao
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-ready multiplayer-ready plugin documentation}
 */
class MultiplayerReadyPlugin implements JsPsychPlugin<Info> {
  static info = info;

  constructor(private jsPsych: JsPsych) {}

  async trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const multiplayer = getMultiplayer(this.jsPsych, "multiplayer-ready");

    const expected = trial.expected_players ?? sealedGroupSize(multiplayer);
    if (expected === null) {
      throw new Error(
        "multiplayer-ready: set `expected_players` (the total group size, including this " +
          "participant). It can be left out only once the group is sealed, e.g. after " +
          "jsPsych.multiplayer.waitForGroup().",
      );
    }
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      throw new Error(
        "multiplayer-ready: `expected_players` must be a positive integer (the total group size, " +
          "including this participant).",
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

    const finish = async (
      group: GroupSessionData,
      outcome: MultiplayerOutcome,
      leftParticipant: string | null = null,
    ) => {
      const nReady = countReady(group, multiplayer.presence());
      await holdMinimumWait();
      this.jsPsych.finishTrial({
        rt,
        wait_time: Math.round(performance.now() - waitStart),
        n_ready: nReady,
        multiplayer_outcome: outcome,
        left_participant: leftParticipant,
        ...(trial.save_group ? { group } : {}),
      });
    };

    try {
      // Merge the flag into this participant's data. It shows up in their own reads at once, and
      // the core keeps retrying it until the backend has it, so don't hold the wait (and its
      // timeout) for the confirmation. It only fails if the session closes, which the wait reports.
      multiplayer
        .update({ ...(trial.write_data as Record<string, unknown> | null), [READY_KEY]: true })
        .catch(() => {});
      const group = await waitForAll(multiplayer, READY_KEY, {
        count: expected,
        participants: trial.participants as string[] | null,
        timeout: trial.timeout,
      });
      await finish(group, "completed");
    } catch (e) {
      const outcome = outcomeOf(e);
      // An adapter/backend failure. Surface it loudly instead of recording it as an outcome.
      if (outcome === null) throw e;
      // A cancelled wait is neither a timeout nor a failure: jsPsych cancels pending waits when the
      // trial or experiment ends or is aborted, so the trial is already being torn down. Return
      // quietly.
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

/** Count group members who are ready and haven't left the session. */
function countReady(group: GroupSessionData, presence: PresenceData): number {
  return Object.entries(group).filter(
    ([id, entry]) => entry?.[READY_KEY] === true && presence[id] !== "left",
  ).length;
}

export default MultiplayerReadyPlugin;
