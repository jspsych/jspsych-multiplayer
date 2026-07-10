/**
 * Pure, jsPsych-independent core for the anonymous group-vote trial.
 *
 * Turns a group-session snapshot into an aggregate tally and a plurality winner. Like the choice and
 * scoreboard cores it is deterministic and jsPsych-free so it can be unit-tested and reused without a
 * live group session: every client reading the same snapshot agrees on the same tally and winner.
 *
 * The vote is **anonymous by construction**: the tally counts votes per option, and nothing here maps
 * a participant back to how they voted. Each participant stores their pick under the trial's
 * `data_key` as `{ index, label }`; a slot may exist without a vote (the participant pushed *other*
 * keys), so a valid, in-range integer `index` is what counts as "has voted", never mere presence of
 * the slot. Option labels for the tally come from the trial's own `choices` (experimenter-authored),
 * not from peer pushes — so the aggregate never carries untrusted per-voter data.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** One participant's ballot as stored under the trial's `data_key`. */
export interface Vote {
  /** Zero-based index into the trial's `choices` array. */
  index: number;
  /** The option's display label, as the voting client saw it. */
  label: string;
}

/** The vote count for one option, keyed to its position in the trial's `choices` array. */
export interface OptionTally {
  /** Zero-based index of the option. */
  index: number;
  /** The option's display label (from the trial's `choices`). */
  label: string;
  /** How many participants voted for this option. */
  count: number;
}

/** The outcome of applying the plurality rule to a tally. */
export interface WinnerResult {
  /** The single option with the most votes, or `null` on a tie or when no votes were cast. */
  winner: OptionTally | null;
  /** `true` when two or more options share the top count (so there is no single winner). */
  isTie: boolean;
  /** The options sharing the top count when `isTie` is true (option-index order); empty otherwise. */
  tied: OptionTally[];
  /** Total number of valid votes across all options in the snapshot. */
  totalVotes: number;
}

/**
 * Read one participant's slot and pull out a valid `Vote`, or `null` if they have not recorded a
 * usable ballot under `dataKey`. `index` must be a non-negative integer (a real selection); a
 * non-integer, negative, or missing index is treated as "has not voted".
 */
export function readVote(slot: Record<string, unknown> | undefined, dataKey: string): Vote | null {
  if (!slot) return null;
  const raw = slot[dataKey];
  if (raw == null || typeof raw !== "object") return null;
  const { index, label } = raw as Record<string, unknown>;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  return { index, label: typeof label === "string" ? label : String(index) };
}

/**
 * How many participants in the snapshot have recorded a valid vote under `dataKey`. Pass
 * `optionCount` (the trial's number of `choices`) to count only votes that fall within the option
 * range — the same votes `tally` will actually count. Keeping the barrier's count and the tally in
 * agreement matters when a slot can hold an out-of-range index (e.g. a stale vote left under a reused
 * `data_key` from an earlier trial that had more options); without the bound the barrier could lift on
 * a vote the tally then drops, so `n_votes` would under-report. Omitting `optionCount` counts every
 * valid-integer-index vote (no upper bound).
 */
export function countVoted(group: GroupSessionData, dataKey: string, optionCount?: number): number {
  let n = 0;
  for (const slot of Object.values(group)) {
    const vote = readVote(slot, dataKey);
    if (vote && (optionCount === undefined || vote.index < optionCount)) n++;
  }
  return n;
}

/**
 * Aggregate the snapshot into a per-option tally, one `OptionTally` per entry in `labels` (in the
 * same order, including options that received zero votes). Votes whose `index` falls outside
 * `labels` are dropped — they can't be attributed to a known option. This is the anonymous heart of
 * the plugin: it returns counts only, never who voted for what.
 */
export function tally(group: GroupSessionData, dataKey: string, labels: string[]): OptionTally[] {
  const counts: OptionTally[] = labels.map((label, index) => ({ index, label, count: 0 }));
  for (const slot of Object.values(group)) {
    const vote = readVote(slot, dataKey);
    if (vote && vote.index < labels.length) counts[vote.index].count++;
  }
  return counts;
}

/**
 * Apply the plurality rule to a tally: the option with the most votes wins. If two or more options
 * share the top count it is a tie (`winner: null`, `isTie: true`, `tied` lists them). If no votes
 * were cast there is no winner and it is not a tie (`winner: null`, `isTie: false`). Deterministic:
 * every client scoring the same tally gets the same result.
 */
export function plurality(counts: OptionTally[]): WinnerResult {
  let totalVotes = 0;
  let max = 0;
  for (const option of counts) {
    totalVotes += option.count;
    if (option.count > max) max = option.count;
  }
  // No votes at all: no winner, and not a tie (a tie means multiple options SHARE a positive top count).
  if (max === 0) return { winner: null, isTie: false, tied: [], totalVotes };
  const top = counts.filter((option) => option.count === max);
  if (top.length === 1) return { winner: top[0], isTie: false, tied: [], totalVotes };
  return { winner: null, isTie: true, tied: top, totalVotes };
}
