/**
 * Match accessors for downstream trials.
 *
 * A trial after matching usually needs this client's partners — e.g. a proposer waits on its
 * partner's offer, or a `conditional_function` branches on `getMyPosition() === 0`. Rather than
 * re-derive the partition, these read the data of the most recent `multiplayer-match` trial, which
 * records the agreed map. There is no separate state to keep in sync: each jsPsych instance answers
 * from its own data, and an unmatched trial (whose `match_map` is null) reads as no match. Called
 * without a `jsPsych`, they use the instance that most recently ran a match trial, which is the only
 * one on a normal experiment page; pass the instance explicitly when a page runs several.
 */
import { JsPsych } from "jspsych";

import { MatchAssignment, MatchMap } from "./match-core";

let lastJsPsych: JsPsych | undefined;

/** Called by the plugin, so the accessors know which instance to read by default. */
export function rememberJsPsych(jsPsych: JsPsych): void {
  lastJsPsych = jsPsych;
}

/** The full id -> assignment map from the last match trial. */
export function getMatchMap(jsPsych: JsPsych | undefined = lastJsPsych): MatchMap | undefined {
  const rows = jsPsych?.data.get().filter({ trial_type: "multiplayer-match" }).values() ?? [];
  return rows[rows.length - 1]?.match_map ?? undefined;
}

/** This participant's full match assignment (`group`/`members`/`partners`/`position`), or undefined. */
export function getMyMatch(
  jsPsych: JsPsych | undefined = lastJsPsych,
): MatchAssignment | undefined {
  const me = jsPsych?.multiplayer.participantId;
  return me == null ? undefined : getMatchMap(jsPsych)?.[me];
}

/** This participant's partner ids (everyone in the group except this participant); `[]` if unmatched. */
export function getMyPartners(jsPsych: JsPsych | undefined = lastJsPsych): string[] {
  return getMyMatch(jsPsych)?.partners ?? [];
}

/** This participant's group index, e.g. for `conditional_function: () => getMyGroup() != null`. */
export function getMyGroup(jsPsych: JsPsych | undefined = lastJsPsych): number | undefined {
  return getMyMatch(jsPsych)?.group;
}

/** This participant's seat within its group (0-based), e.g. to derive a role-within-pair. */
export function getMyPosition(jsPsych: JsPsych | undefined = lastJsPsych): number | undefined {
  return getMyMatch(jsPsych)?.position;
}
