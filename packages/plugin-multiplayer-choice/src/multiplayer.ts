import { JsPsych } from "jspsych";

/** jsPsych's multiplayer module: `jsPsych.multiplayer`. */
export type Multiplayer = JsPsych["multiplayer"];

/**
 * Return `jsPsych.multiplayer`, or throw a clear error on a jsPsych build that
 * doesn't have the multiplayer API.
 */
export function getMultiplayer(jsPsych: JsPsych): Multiplayer {
  const multiplayer = (jsPsych as Partial<Pick<JsPsych, "multiplayer">>).multiplayer;
  if (!multiplayer) {
    throw new Error(
      "plugin-multiplayer-choice: this plugin needs a version of jsPsych with the multiplayer API " +
        "(jsPsych.multiplayer). See https://multiplayer.jspsych.org.",
    );
  }
  return multiplayer;
}

type MultiplayerErrorName =
  | "MultiplayerTimeoutError"
  | "MultiplayerCancelledError"
  | "MultiplayerParticipantLeftError"
  | "MultiplayerConnectionClosedError";

/**
 * True when `e` is the named multiplayer error. Matches on `error.name`, not
 * instanceof, which fails when a page loads two copies of jsPsych.
 */
export function isMultiplayerError(
  e: unknown,
  name: MultiplayerErrorName,
): e is Error & { participantId?: string } {
  return e instanceof Error && e.name === name;
}

/** The other participants who haven't left the session, as of now. */
export function remainingParticipants(multiplayer: Multiplayer): string[] {
  const presence = multiplayer.presence();
  return Object.keys(presence).filter(
    (id) => id !== multiplayer.participantId && presence[id] !== "left",
  );
}

const gateCounts = new WeakMap<JsPsych, number>();

/**
 * The default key for this participant's next choice gate: `choice-1`,
 * `choice-2`, and so on. Every participant passes gates in the same order,
 * so the Nth gate gets the same key for everyone, however many other trials
 * each participant saw. Only default keys advance the count.
 */
export function nextGateKey(jsPsych: JsPsych): string {
  const n = (gateCounts.get(jsPsych) ?? 0) + 1;
  gateCounts.set(jsPsych, n);
  return `choice-${n}`;
}
