/**
 * Module-level accessor store for "my role", read by downstream trials' conditional_functions.
 *
 * Scoped to one experiment per page (always true for jsPsych). Volatile like the data record — lost
 * on reload; the source of truth is the deterministic computation over the session snapshot, so a
 * reconnect should recompute via assignRoles (see plan §8).
 */
import { RoleAssignment, RoleMap } from "./roles";

let _assignment: RoleAssignment | undefined;
let _roleMap: RoleMap | undefined;

/** Called by the plugin on finish. `map` is omitted on timeout to clear any stale assignment. */
export function setMyAssignment(assignment: RoleAssignment | undefined, map?: RoleMap): void {
  _assignment = assignment;
  _roleMap = map;
}

/** This participant's role, e.g. for `conditional_function: () => getMyRole() === "proposer"`. */
export function getMyRole(): string | undefined {
  return _assignment?.role;
}

/** This participant's full assignment (exposes `.group` once matching lands). */
export function getMyAssignment(): RoleAssignment | undefined {
  return _assignment;
}

/** The full id -> assignment map from the last assignment. */
export function getRoleMap(): RoleMap | undefined {
  return _roleMap;
}

/**
 * Invert the role map to role -> participantIds, for game logic that needs the *identity* of the
 * player in a role (e.g. the proposer waiting on `group[responderId].decision`), not just its own.
 */
export function participantsByRole(map: RoleMap | undefined = _roleMap): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!map) return out;
  for (const [id, assignment] of Object.entries(map)) {
    (out[assignment.role] ??= []).push(id);
  }
  return out;
}
