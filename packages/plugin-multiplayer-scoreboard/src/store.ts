/**
 * Module-level accessor store for "my standing", read by downstream trials.
 *
 * A branch after the scoreboard often wants to react to the outcome — e.g.
 * `conditional_function: () => getMyRank() === 1` to show a winner screen. Rather than make callers
 * re-derive the board, the plugin publishes this client's rank/score and the full leaderboard here
 * on finish.
 *
 * Scoped to one experiment per page (always true for jsPsych). Volatile like the data record — lost
 * on reload; the source of truth is the deterministic computation over the session snapshot, so a
 * reconnect should recompute via buildLeaderboard.
 */
import { LeaderboardRow } from "./scoreboard";

let _leaderboard: LeaderboardRow[] | undefined;
let _myRank: number | undefined;
let _myScore: number | undefined;

/** Called by the plugin on finish. All args omitted (undefined) clears any stale standing. */
export function setMyStanding(
  leaderboard?: LeaderboardRow[],
  myRank?: number,
  myScore?: number
): void {
  _leaderboard = leaderboard;
  _myRank = myRank;
  _myScore = myScore;
}

/** This client's final rank (1 = best), or undefined if it never reported / timed out. */
export function getMyRank(): number | undefined {
  return _myRank;
}

/** This client's final score, or undefined if it never reported. */
export function getMyScore(): number | undefined {
  return _myScore;
}

/** The full ranked leaderboard from the last scoreboard trial. */
export function getLeaderboard(): LeaderboardRow[] | undefined {
  return _leaderboard;
}
