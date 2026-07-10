/**
 * Pure, jsPsych-independent core for the simultaneous-choice trial.
 *
 * Turns a group-session snapshot into "who chose what". Like the scoreboard core, it is
 * deterministic and jsPsych-free so it can be unit-tested and reused without a live group session:
 * every client reading the same snapshot agrees on the same set of choices. Each participant stores
 * their pick under the trial's `data_key` as `{ index, label }`; a slot may exist without a choice
 * (the participant pushed *other* keys), so a valid, in-range integer `index` is what counts as
 * "has chosen", never mere presence of the slot.
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

/** How many participants in the snapshot have recorded a valid choice under `dataKey`. */
export function countChosen(group: GroupSessionData, dataKey: string): number {
  let n = 0;
  for (const slot of Object.values(group)) if (readChoice(slot, dataKey)) n++;
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
