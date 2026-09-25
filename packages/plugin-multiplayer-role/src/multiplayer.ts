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
      "plugin-multiplayer-role: this plugin needs a version of jsPsych with the multiplayer API " +
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

/**
 * The other participants this participant waits on. In a sealed group
 * (see `jsPsych.multiplayer.group()`), that is the rest of the roster, except
 * members who have already left: a member who is only `away` may come back,
 * so the gate still waits for them. Otherwise it is the others who are
 * connected right now. Participants who are only `away` are left out then:
 * leftover slots from members who left earlier start out `away` and become
 * `left` a few seconds later, which would otherwise end a gate that starts
 * right after joining.
 */
export function remainingParticipants(multiplayer: Multiplayer): string[] {
  const presence = multiplayer.presence();
  const isOther = (id: string) => id !== multiplayer.participantId;
  // Older jsPsych builds have no group()
  const group = typeof multiplayer.group === "function" ? multiplayer.group() : null;
  if (group?.sealed) {
    return group.members.filter((id) => isOther(id) && presence[id] !== "left");
  }
  return Object.keys(presence).filter((id) => isOther(id) && presence[id] === "connected");
}

/**
 * How many members of a sealed group haven't left, counting this participant,
 * or null when the group isn't sealed (or the jsPsych build has no group()).
 * Plugins use it as the default group size.
 */
export function sealedGroupSize(multiplayer: Multiplayer): number | null {
  if (typeof multiplayer.group !== "function") return null;
  const group = multiplayer.group();
  if (!group.sealed) return null;
  const presence = multiplayer.presence();
  return group.members.filter((id) => presence[id] !== "left").length;
}
