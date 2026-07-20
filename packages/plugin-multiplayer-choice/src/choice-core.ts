/**
 * Pure, jsPsych-independent core for the simultaneous-choice trial.
 *
 * Turns a group-session snapshot into "who chose what" — and, for tally mode, into an aggregate
 * per-option count and a plurality winner. Like the scoreboard core, it is deterministic and
 * jsPsych-free so it can be unit-tested and reused without a live group session: every client
 * reading the same snapshot agrees on the same set of choices, the same tally, and the same winner.
 * Each participant stores their pick under the trial's `data_key` as `{ index, label }`; a slot may
 * exist without a choice (the participant pushed *other* keys), so a valid, in-range integer
 * `index` is what counts as "has chosen", never mere presence of the slot.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** One participant's decision as stored under the trial's `data_key`. */
export interface Choice {
  /** Zero-based index into the trial's `choices` array. */
  index: number;
  /** The option's display label, as the choosing client saw it. */
  label: string;
}

/** The count for one option, keyed to its position in the trial's `choices` array. */
export interface OptionTally {
  /** Zero-based index of the option. */
  index: number;
  /** The option's display label (from the trial's `choices`). */
  label: string;
  /** How many participants chose this option. */
  count: number;
}

/** The outcome of applying the plurality rule to a tally. */
export interface WinnerResult {
  /** The single option with the most picks, or `null` on a tie or when no one chose. */
  winner: OptionTally | null;
  /** `true` when two or more options share the top count (so there is no single winner). */
  isTie: boolean;
  /** The options sharing the top count when `isTie` is true (option-index order); empty otherwise. */
  tied: OptionTally[];
  /** Total number of valid choices across all options in the snapshot. */
  totalVotes: number;
}

/**
 * Read one participant's slot and pull out a valid `Choice`, or `null` if they have not recorded a
 * usable decision under `dataKey`. `index` must be a non-negative integer (a real selection); a
 * non-integer, negative, or missing index is treated as "has not chosen".
 */
export function readChoice(
  slot: Record<string, unknown> | undefined,
  dataKey: string
): Choice | null {
  if (!slot) return null;
  const raw = slot[dataKey];
  if (raw == null || typeof raw !== "object") return null;
  const { index, label } = raw as Record<string, unknown>;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  return { index, label: typeof label === "string" ? label : String(index) };
}

/**
 * How many participants in the snapshot have recorded a valid choice under `dataKey`. Pass
 * `optionCount` (the trial's number of `choices`) to count only choices that fall within the option
 * range — the same choices `tally` will actually count. Keeping the barrier's count and the tally in
 * agreement matters when a slot can hold an out-of-range index (e.g. a stale choice left under a
 * reused `data_key` from an earlier trial that had more options); without the bound the barrier
 * could lift on a choice the tally then drops, so `n_votes` would under-report. Omitting
 * `optionCount` counts every valid-integer-index choice (no upper bound).
 */
export function countChosen(
  group: GroupSessionData,
  dataKey: string,
  optionCount?: number
): number {
  let n = 0;
  for (const slot of Object.values(group)) {
    const choice = readChoice(slot, dataKey);
    if (choice && (optionCount === undefined || choice.index < optionCount)) n++;
  }
  return n;
}

/**
 * Collect every participant's valid choice into a `participantId -> Choice` map, dropping those who
 * have not chosen. This is the shape passed to the trial's `payoff` hook and saved as
 * `choices_by_player`, so downstream code reads decisions without re-parsing the raw session.
 */
export function collectChoices(group: GroupSessionData, dataKey: string): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const [participantId, slot] of Object.entries(group)) {
    const choice = readChoice(slot, dataKey);
    if (choice) out[participantId] = choice;
  }
  return out;
}

/**
 * Aggregate the snapshot into a per-option tally, one `OptionTally` per entry in `labels` (in the
 * same order, including options that received zero picks). Choices whose `index` falls outside
 * `labels` are dropped — they can't be attributed to a known option. This is the anonymous heart of
 * tally mode: it returns counts only, never who chose what, and it labels options from the trial's
 * own `labels` (experimenter-authored), never from peer-pushed strings.
 */
export function tally(group: GroupSessionData, dataKey: string, labels: string[]): OptionTally[] {
  const counts: OptionTally[] = labels.map((label, index) => ({ index, label, count: 0 }));
  for (const slot of Object.values(group)) {
    const choice = readChoice(slot, dataKey);
    if (choice && choice.index < labels.length) counts[choice.index].count++;
  }
  return counts;
}

/**
 * Apply the plurality rule to a tally: the option with the most picks wins. If two or more options
 * share the top count it is a tie (`winner: null`, `isTie: true`, `tied` lists them). If no one
 * chose there is no winner and it is not a tie (`winner: null`, `isTie: false`). Deterministic:
 * every client scoring the same tally gets the same result.
 */
export function plurality(counts: OptionTally[]): WinnerResult {
  let totalVotes = 0;
  let max = 0;
  for (const option of counts) {
    totalVotes += option.count;
    if (option.count > max) max = option.count;
  }
  // No picks at all: no winner, and not a tie (a tie means multiple options SHARE a positive top count).
  if (max === 0) return { winner: null, isTie: false, tied: [], totalVotes };
  const top = counts.filter((option) => option.count === max);
  if (top.length === 1) return { winner: top[0], isTie: false, tied: [], totalVotes };
  return { winner: null, isTie: true, tied: top, totalVotes };
}
