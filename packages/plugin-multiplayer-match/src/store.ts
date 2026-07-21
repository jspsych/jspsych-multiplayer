/**
 * Module-level accessor store for "my match", read by downstream trials.
 *
 * A trial after matching usually needs this client's partners — e.g. a proposer waits on
 * `group[partnerId].offer`, or a `conditional_function` branches on `getMyPosition() === 0`. Rather
 * than re-derive the partition, the plugin publishes this client's assignment and the full map here
 * on finish.
 *
 * Scoped to one experiment per page (always true for jsPsych). Volatile like the data record — lost
 * on reload; the source of truth is the deterministic computation over the session snapshot, so a
 * reconnect should recompute via buildMatches.
 */
import { MatchAssignment, MatchMap } from "./match-core";

let _assignment: MatchAssignment | undefined;
let _matchMap: MatchMap | undefined;

/** Called by the plugin on finish. `map` is omitted on timeout to clear any stale assignment. */
export function setMyMatch(assignment: MatchAssignment | undefined, map?: MatchMap): void {
  _assignment = assignment;
  _matchMap = map;
}

/** This participant's full match assignment (`group`/`members`/`partners`/`position`), or undefined. */
export function getMyMatch(): MatchAssignment | undefined {
  return _assignment;
}

/** This participant's partner ids (everyone in the group except this participant); `[]` if unmatched. */
export function getMyPartners(): string[] {
  return _assignment?.partners ?? [];
}

/** This participant's group index, e.g. for `conditional_function: () => getMyGroup() != null`. */
export function getMyGroup(): number | undefined {
  return _assignment?.group;
}

/** This participant's seat within its group (0-based), e.g. to derive a role-within-pair. */
export function getMyPosition(): number | undefined {
  return _assignment?.position;
}

/** The full id -> assignment map from the last match. */
export function getMatchMap(): MatchMap | undefined {
  return _matchMap;
}
