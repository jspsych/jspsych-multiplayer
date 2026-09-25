/**
 * Role accessors for downstream trials, e.g. `conditional_function: () => getMyRole() === "proposer"`.
 *
 * They read the data of the most recent `multiplayer-role` trial, which records the role and the
 * agreed map, so there is no separate state to keep in sync: each jsPsych instance answers from its
 * own data, and an unassigned trial (whose `role_map` is null) reads as no role. Called without a
 * `jsPsych`, they use the instance that most recently ran a role trial, which is the only one on a
 * normal experiment page; pass the instance explicitly when a page runs several.
 */
import { JsPsych } from "jspsych";

import { RoleAssignment, RoleMap } from "./roles";

let lastJsPsych: JsPsych | undefined;

/** Called by the plugin, so the accessors know which instance to read by default. */
export function rememberJsPsych(jsPsych: JsPsych): void {
  lastJsPsych = jsPsych;
}

/** The last role trial's data, or undefined before one has run. */
function lastRoleTrial(jsPsych: JsPsych | undefined): Record<string, any> | undefined {
  const rows = jsPsych?.data.get().filter({ trial_type: "multiplayer-role" }).values() ?? [];
  return rows[rows.length - 1];
}

/** This participant's role, e.g. for `conditional_function: () => getMyRole() === "proposer"`. */
export function getMyRole(jsPsych: JsPsych | undefined = lastJsPsych): string | undefined {
  return getMyAssignment(jsPsych)?.role;
}

/** This participant's full assignment from the last role trial. */
export function getMyAssignment(
  jsPsych: JsPsych | undefined = lastJsPsych,
): RoleAssignment | undefined {
  const me = jsPsych?.multiplayer.participantId;
  return me == null ? undefined : getRoleMap(jsPsych)?.[me];
}

/** The full id -> assignment map from the last role trial. */
export function getRoleMap(jsPsych: JsPsych | undefined = lastJsPsych): RoleMap | undefined {
  return lastRoleTrial(jsPsych)?.role_map ?? undefined;
}

/**
 * Invert a role map (by default the last role trial's) to role -> participantIds, for game logic
 * that needs the *identity* of the player in a role (e.g. the proposer waiting on the responder's
 * decision), not just its own.
 */
export function participantsByRole(
  map: RoleMap | undefined = getRoleMap(),
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!map) return out;
  for (const [id, assignment] of Object.entries(map)) {
    (out[assignment.role] ??= []).push(id);
  }
  return out;
}
