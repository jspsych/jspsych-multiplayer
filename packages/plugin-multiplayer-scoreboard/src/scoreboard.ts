/**
 * Pure, jsPsych-independent scoreboard core.
 *
 * Turns a group-session snapshot into a ranked leaderboard. It is deterministic: given the same
 * snapshot and options, EVERY client computes the byte-identical board (same order, same ranks) —
 * which is what lets each participant render the end-of-game standings locally with no coordinator
 * and no extra round-trip, exactly like `plugin-multiplayer-role` derives the role map. Determinism
 * rests on the tie-break being a stable, snapshot-independent key (the participantId), never
 * iteration order (which varies by who pushed when).
 *
 * Exported standalone (as a static on the plugin) so scoring/ranking can be unit-tested and reused
 * without a live group session.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. Matches `GroupSessionData`. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** One participant's entry as stored under the trial's `data_key`. */
export interface ScoreEntry {
  /** The participant's final score. */
  score: number;
  /** Optional display name this participant pushed for themselves. */
  label?: string;
}

/** One ranked row of the computed leaderboard. */
export interface LeaderboardRow {
  /** The participant this row belongs to. */
  participantId: string;
  /** Their final score. */
  score: number;
  /** Their competition rank (1 = best). Ties share a rank; see `tieMethod`. */
  rank: number;
  /** Display name: the pushed `label`, else the participantId. */
  label: string;
  /** True for the viewing client's own row (drives self-highlighting). */
  isSelf: boolean;
}

export interface BuildOptions {
  /** Session field each participant's `ScoreEntry` is stored under. */
  dataKey: string;
  /** The viewing client's id, so its row can be flagged `isSelf`. Omit when there is no viewer (e.g. a test). */
  self?: string;
  /** `"desc"` ranks highest score first (games); `"asc"` ranks lowest first (e.g. reaction time). */
  sort?: "desc" | "asc";
  /**
   * How tied scores rank. `"standard"` is competition ranking — ties share the lower rank and the
   * next distinct score skips (1, 2, 2, 4). `"dense"` leaves no gaps (1, 2, 2, 3).
   */
  tieMethod?: "standard" | "dense";
}

/**
 * Read one participant's slot and pull out a valid `ScoreEntry`, or `null` if they have not reported
 * a usable numeric score under `dataKey`. A slot may exist (the participant pushed *other* keys)
 * without a score, so presence of the slot is not enough — the score itself must be a finite number.
 */
export function readScoreEntry(
  slot: Record<string, unknown> | undefined,
  dataKey: string
): ScoreEntry | null {
  if (!slot) return null;
  const raw = slot[dataKey];
  if (raw == null || typeof raw !== "object") return null;
  const { score, label } = raw as Record<string, unknown>;
  // NaN and Infinity are not rankable — treat them as "not reported" rather than sorting them to an
  // arbitrary end, which would differ between clients depending on comparator quirks.
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return { score, label: typeof label === "string" ? label : undefined };
}

/** How many participants in the snapshot have reported a valid score under `dataKey`. */
export function countReported(group: GroupSessionData, dataKey: string): number {
  let n = 0;
  for (const slot of Object.values(group)) if (readScoreEntry(slot, dataKey)) n++;
  return n;
}

/**
 * Build the ranked leaderboard from a group-session snapshot.
 *
 * Participants without a valid score under `dataKey` are dropped (not ranked last) — an absent score
 * is "did not report", not "scored nothing". Rows are ordered by score (per `sort`), then by
 * participantId ascending as a deterministic tie-break so every client agrees on the order of equal
 * scores. Ranks are assigned by the score sequence, so tied scores get the same rank regardless of
 * their id tie-break order.
 */
export function buildLeaderboard(group: GroupSessionData, opts: BuildOptions): LeaderboardRow[] {
  const { dataKey, self, sort = "desc", tieMethod = "standard" } = opts;

  const entries: Array<{ participantId: string; entry: ScoreEntry }> = [];
  for (const [participantId, slot] of Object.entries(group)) {
    const entry = readScoreEntry(slot, dataKey);
    if (entry) entries.push({ participantId, entry });
  }

  const dir = sort === "asc" ? 1 : -1;
  entries.sort((a, b) => {
    if (a.entry.score !== b.entry.score) return (a.entry.score - b.entry.score) * dir;
    // Deterministic, snapshot-independent tie-break: without this, two clients whose snapshots
    // enumerate participants in different orders would render tied players in different orders.
    return a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0;
  });

  const rows: LeaderboardRow[] = [];
  let rank = 0;
  let seen = 0; // total ranked so far — drives the "standard" gap after a tie group
  let prevScore: number | null = null;
  for (const { participantId, entry } of entries) {
    seen++;
    if (prevScore === null || entry.score !== prevScore) {
      // New distinct score: "standard" jumps to the ordinal position; "dense" is the next integer.
      rank = tieMethod === "dense" ? rank + 1 : seen;
      prevScore = entry.score;
    }
    rows.push({
      participantId,
      score: entry.score,
      rank,
      label: entry.label ?? participantId,
      isSelf: participantId === self,
    });
  }
  return rows;
}
