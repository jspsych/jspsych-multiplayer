import {
  GroupSessionData,
  JsPsych,
  JsPsychPlugin,
  ParameterType,
  PresenceData,
  TrialType,
} from "jspsych";
import {
  MultiplayerOutcome,
  getMultiplayer,
  isMultiplayerError,
  outcomeOf,
  pluginTimeout,
  remainingParticipants,
  sealedGroupSize,
  withoutLeft,
} from "@jspsych-multiplayer/utils";

import { version } from "../package.json";
import { MatchOptions, Snapshot, buildMatches } from "./match-core";
import {
  getMatchMap,
  getMyGroup,
  getMyMatch,
  getMyPartners,
  getMyPosition,
  rememberJsPsych,
} from "./store";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention. The pure core + accessors are exposed as statics on the plugin class below.
export type { Snapshot, MatchAssignment, MatchMap, MatchOptions } from "./match-core";

const info = <const>{
  name: "multiplayer-match",
  version: version,
  parameters: {
    /** Members per matched group. Default 2 (dyads); 3 for triads, etc. Must be an integer >= 2. */
    group_size: { type: ParameterType.INT, default: 2 },
    /**
     * Wait for EXACTLY this many participants to reach this trial before partitioning (fail-loud: an
     * overshoot stalls to a timeout rather than partitioning a subset). Participants who have left
     * the session don't count and aren't partitioned. `null` (the default) means the members of a
     * sealed group (see `jsPsych.multiplayer.group()`) who haven't left; with a group that isn't
     * sealed, `null` trusts an upstream barrier and partitions whoever has arrived as soon as this
     * client has (a warning fires).
     */
    expected_players: { type: ParameterType.INT, default: null },
    /**
     * How participants are ordered before being chunked into groups: `"ordered"` (by id, the default),
     * `"join_order"` (by `joinedAt` in the session data), or `"random"` (a shuffle seeded by the session — unpredictable-by-id
     * yet identical on every client, and per-round via `round`). Prefer `"random"` for real experiments to
     * avoid pairings that track participant-id order.
     */
    strategy: { type: ParameterType.STRING, default: "ordered" },
    /**
     * Picks a different random grouping within the session. Randomness is seeded by the session ID
     * (or the `randomSeed` connect option), so each group of participants gets its own grouping.
     */
    seed: { type: ParameterType.STRING, default: null },
    /** Round index, for `"random"` re-pairing. Increment each re-run to shuffle partners anew. */
    round: { type: ParameterType.INT, default: 0 },
    /**
     * What to do when the participant count is not a multiple of `group_size`: `"error"` (default —
     * throw), `"spectator"` (leave the trailing extras unmatched), or `"smaller_group"` (put the
     * extras in one undersized group).
     */
    leftover: { type: ParameterType.STRING, default: "error" },
    /**
     * `(snapshot, presence) => boolean` overriding the readiness gate. `snapshot` holds the
     * participants who have reached this trial and haven't left, each with their session data merged
     * under their `write_data`; both arguments are frozen, so don't modify them. A predicate that
     * throws counts as "not ready"; if the group never becomes ready, the last error is logged.
     * FUNCTION is deliberate — it stops jsPsych's dynamic-parameter machinery from CALLING the
     * value. Null derives readiness from `expected_players` (and, for `join_order`, that every
     * participant has a `joinedAt`).
     */
    ready: { type: ParameterType.FUNCTION, default: null },
    /**
     * Data this client contributes to this trial's snapshot, e.g. for a custom `ready`. Merged into
     * this participant's data in the trial's own scope, so it never reaches another trial. Must be
     * JSON-safe: the session deep-copies every value with `JSON.stringify`, so a `Date` arrives as a
     * string and `undefined`/`Map`/`Set`/`NaN` values do not survive the round trip.
     */
    write_data: { type: ParameterType.OBJECT, default: {} },
    /** Include the full group snapshot in the trial data. Off by default to avoid bloat. */
    save_group: { type: ParameterType.BOOL, default: false },
    /** Milliseconds to wait for readiness before giving up. `null`, `0`, or a negative value waits forever. */
    timeout: { type: ParameterType.INT, default: 30000 },
    /** Hook run on timeout. The trial always ends with `matched_self: false, multiplayer_outcome: "timeout"` regardless. */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
    /**
     * Participants the match depends on. If one of them leaves the session before the group is
     * ready, the trial ends unmatched with `multiplayer_outcome: "participant_left"`. Null (the
     * default) means the rest of a sealed group, or else every other participant who is connected
     * when this participant arrives. Pass `[]` to ignore departures.
     */
    participants: { type: ParameterType.COMPLEX, default: null },
    /** Shown while waiting for the group. */
    message: { type: ParameterType.HTML_STRING, default: "<p>Finding your match…</p>" },
  },
  data: {
    /** This participant's group index (`null` if a spectator or unmatched). */
    match_group: { type: ParameterType.INT },
    /** The other members of this participant's group (`null` if unmatched, `[]` if a spectator). */
    partners: { type: ParameterType.OBJECT },
    /** All members of this participant's group, including self, in consensus order (`null` if unmatched). */
    members: { type: ParameterType.OBJECT },
    /** This participant's seat within its group, 0-based (`null` if a spectator or unmatched). */
    position: { type: ParameterType.INT },
    /** The full `participantId -> assignment` map every client agreed on (`null` if unmatched). */
    match_map: { type: ParameterType.OBJECT },
    /** Whether this participant was placed in a group — distinguishes a spectator from an unmatched outcome. */
    matched_self: { type: ParameterType.BOOL },
    /**
     * How the trial ended: `"completed"`, `"timeout"` (the group wasn't ready before `timeout`),
     * `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this
     * participant's connection was lost for good).
     */
    multiplayer_outcome: { type: ParameterType.STRING },
    /** The ID of the participant who left, when the outcome is `participant_left`; otherwise null. */
    left_participant: { type: ParameterType.STRING },
    /** The full snapshot partitioned over — only present when `save_group: true`. */
    group: { type: ParameterType.OBJECT },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/**
 * The snapshot this trial partitions: every participant who has written in this trial's scope
 * (i.e. reached the trial) and hasn't left, each with their session data (e.g. `joinedAt`) merged
 * under their data from this trial. Frozen, like the core's snapshots.
 */
function trialSnapshot(
  trialData: GroupSessionData,
  sessionData: GroupSessionData,
  presence: PresenceData,
): Snapshot {
  const snapshot: Snapshot = {};
  for (const id of withoutLeft(Object.keys(trialData), presence)) {
    snapshot[id] = Object.freeze({ ...sessionData[id], ...trialData[id] });
  }
  return Object.freeze(snapshot);
}

/**
 * **plugin-multiplayer-match**
 *
 * Partitions a multiplayer group into matched sub-groups (pairs by default, or triads/larger) by
 * deterministic consensus — every client independently computes the same partition from the shared
 * group-session snapshot, with no coordinator and no extra round-trip. It is the foundational
 * primitive under every pairwise/small-group paradigm (trust game, ultimatum, dyadic negotiation),
 * and composes with `plugin-multiplayer-role` (assign roles *within* each group via `position`).
 *
 * The trial runs as a short barrier: it writes this client's data into the trial's own scope (and
 * `joinedAt` into the session scope, once), then `wait`s until the group is ready, partitions the
 * resolved snapshot, and saves the assignment to the data record, where the match accessors read it
 * for downstream trials. If the group never becomes ready it fails loud (`matched_self: false` with
 * a `multiplayer_outcome`) rather than hanging.
 *
 * The pure partition core and the match accessors are also reachable as static members
 * (`MultiplayerMatchPlugin.buildMatches`, `.getMyMatch`, `.getMyPartners`, `.getMyGroup`,
 * `.getMyPosition`, `.getMatchMap`) — usable standalone, today.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-match}
 */
class MultiplayerMatchPlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent partition core. Usable standalone, today. */
  static buildMatches = buildMatches;

  // Match accessors for downstream trials. These read the last match trial's data, so they return
  // undefined/empty until a match has run.
  static getMyMatch = getMyMatch;
  static getMyPartners = getMyPartners;
  static getMyGroup = getMyGroup;
  static getMyPosition = getMyPosition;
  static getMatchMap = getMatchMap;

  constructor(private jsPsych: JsPsych) {}

  trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const multiplayer = getMultiplayer(this.jsPsych, "plugin-multiplayer-match");

    const me = multiplayer.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-match: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.multiplayer.connect(adapter)) before this trial runs.",
      );
    }

    // The accessors read this jsPsych's data when called without one
    rememberJsPsych(this.jsPsych);

    // Without an exact `expected_players` (and without a custom `ready`), readiness quantifies only
    // over participants PRESENT in the snapshot, so it can resolve the instant THIS client arrives —
    // partitioning a partial group. Warn unless an upstream barrier is trusted to have admitted every
    // peer first.
    const expectedPlayers = trial.expected_players ?? sealedGroupSize(multiplayer);
    if (expectedPlayers == null && trial.ready == null) {
      console.warn(
        "plugin-multiplayer-match: no `expected_players` and no custom `ready` — the group can be " +
          "partitioned as soon as this client has arrived, over a partial group. Set `expected_players` " +
          "(the exact count), seal the group first (jsPsych.multiplayer.waitForGroup()), or supply a " +
          "`ready` predicate unless an upstream barrier guarantees all peers reach this trial together.",
      );
    }

    display_element.innerHTML = trial.message;
    // We render synchronously above; jsPsych only auto-fires on_load for non-promise trials, and we
    // return a promise below, so signal load ourselves.
    on_load?.();

    let lastReadyError: unknown;
    const isReady = this.makeReadiness(trial, expectedPlayers, (e) => (lastReadyError = e));
    // The snapshot the group was ready over, so the partition covers exactly who was counted
    let readySnapshot: Snapshot = {};
    const ready = (group: GroupSessionData, presence: PresenceData) => {
      // Session data is read fresh on every check: a trial-scope wait is re-checked after every
      // change, including changes to the session scope
      const snapshot = trialSnapshot(group, multiplayer.getAll({ scope: "session" }), presence);
      // Each participant computes the result on its own, so wait until everyone counted is
      // connected: then every view agrees on the group, and a leftover slot that is only `away`
      // can't be included before it turns `left`.
      if (!Object.keys(snapshot).every((id) => presence[id] === "connected")) return false;
      const met = isReady(snapshot, presence);
      if (met) readySnapshot = snapshot;
      return met;
    };

    // Write, then wait for readiness. `joinedAt` goes in the SESSION scope, written once (first-seen,
    // never re-stamped) so join-order stays the same in every later match or role trial; the page
    // may also have written it at connect time. `write_data` goes in this trial's own scope, which is
    // also what marks this participant as having reached the trial. `update` merges, so nothing
    // written earlier is replaced.
    //
    // The trailing `.catch` sorts the ways this chain can reject: a cancelled wait (jsPsych ending
    // the trial or the experiment) stops quietly; a timeout, a departure, or a lost connection ends
    // the trial unmatched; and any OTHER rejection (e.g. a buildMatches throw from a config error
    // such as a non-divisible group with leftover "error") rethrows so jsPsych halts loudly. We partition the RESOLVED snapshot, never a fresh getAll(), which would reopen
    // the time-of-check gap.
    return Promise.resolve()
      .then(() => {
        // Reads show our own writes at once, so the wait needn't wait for the backend to confirm
        // them, and its timeout also covers a write the backend keeps refusing (the core retries
        // it). A write only rejects when the session closes, which the wait reports too.
        const writes = [multiplayer.update(trial.write_data as Record<string, unknown>)];
        if (multiplayer.get(me, { scope: "session" })?.joinedAt == null) {
          writes.push(multiplayer.update({ joinedAt: Date.now() }, { scope: "session" }));
        }
        for (const write of writes) write.catch(() => {});
        const participants =
          (trial.participants as string[] | null) ?? remainingParticipants(multiplayer);
        return multiplayer.wait(ready, { timeout: pluginTimeout(trial.timeout), participants });
      })
      .then(() => {
        const matchMap = buildMatches(readySnapshot, {
          groupSize: trial.group_size,
          strategy: trial.strategy as MatchOptions["strategy"],
          seed: trial.seed ?? undefined,
          round: trial.round,
          // Session-seeded, so every participant in this group computes the same shuffle
          shuffle: (key, ids) => multiplayer.shuffle(key, ids),
          leftover: trial.leftover as MatchOptions["leftover"],
        });
        const mine = matchMap[me];
        this.jsPsych.finishTrial({
          match_group: mine?.group ?? null,
          // A spectator has zero partners, not "unknown": emit [] (matching getMyPartners() and the
          // documented contract) so `data.partners.length`/iteration is safe. `null` is reserved for
          // the unmatched outcomes, where the partition never ran.
          partners: mine ? mine.partners : [],
          members: mine?.members ?? null,
          position: mine?.position ?? null,
          match_map: matchMap,
          // matched_self is false only when a partition ran but this participant is absent — i.e. a
          // spectator (leftover). It distinguishes that from the unmatched outcomes.
          matched_self: mine != null,
          multiplayer_outcome: "completed",
          left_participant: null,
          ...(trial.save_group ? { group: readySnapshot } : {}),
        });
      })
      .catch((err) => {
        const outcome = outcomeOf(err);
        if (outcome === null) throw err;
        // A cancelled wait means jsPsych is ending the trial or the experiment: return quietly,
        // since finishing here would record a bogus trial on every abort.
        if (outcome === "cancelled") return;
        // A `ready` predicate may throw routinely while data is still arriving, so its errors are
        // only worth reporting when the group never became ready — one may be the reason why.
        if (lastReadyError !== undefined) {
          console.error(
            "plugin-multiplayer-match: the group never became ready; the `ready` predicate last threw",
            lastReadyError,
          );
        }
        const left = isMultiplayerError(err, "participant_left")
          ? (err.participantId ?? null)
          : null;
        return this.endUnmatched(trial, outcome, left);
      });
  }

  /**
   * Build the readiness predicate for the `wait` barrier. It receives the trial's snapshot, without
   * participants who have left.
   */
  private makeReadiness(
    trial: TrialType<Info>,
    expectedPlayers: number | null,
    onError: (e: unknown) => void,
  ): (s: Snapshot, presence: PresenceData) => boolean {
    // Exact count converts a contract violation (overshoot) into a loud stall->timeout rather than a
    // silent subset partition. `null` resolves as soon as anyone is present (an upstream barrier trust).
    const enough = (s: Snapshot) =>
      expectedPlayers == null || Object.keys(s).length === expectedPlayers;

    if (typeof trial.ready === "function") {
      const ready = trial.ready as (s: Snapshot, presence: PresenceData) => boolean;
      return (s, presence) => {
        if (!enough(s)) return false;
        try {
          return !!ready(s, presence);
        } catch (err) {
          // A throw (e.g. reading data a peer hasn't written yet) means "not ready"
          onError(err);
          return false;
        }
      };
    }
    if (trial.strategy === "join_order") {
      return (s) => enough(s) && Object.keys(s).every((id) => (s[id] as any)?.joinedAt != null);
    }
    return enough;
  }

  /**
   * The group couldn't be matched: readiness wasn't reached within `timeout`, a participant left, or
   * the connection was lost. Fail loud, don't hang. A cancelled wait returns quietly instead.
   */
  private endUnmatched(
    trial: TrialType<Info>,
    outcome: Exclude<MultiplayerOutcome, "completed" | "cancelled">,
    leftParticipant: string | null,
  ) {
    try {
      if (outcome === "timeout" && trial.on_timeout) trial.on_timeout(this.jsPsych);
    } catch (err) {
      // A throwing hook must NOT skip finishTrial below — that would reintroduce the exact hang the
      // timeout exists to prevent. Swallow it (after logging) so the trial still ends.
      console.error("plugin-multiplayer-match: on_timeout hook threw", err);
    }
    // `match_map: null` also clears the accessors, so getMyMatch() reads as undefined rather than a
    // stale earlier match.
    this.jsPsych.finishTrial({
      match_group: null,
      partners: null,
      members: null,
      position: null,
      match_map: null,
      matched_self: false,
      multiplayer_outcome: outcome,
      left_participant: leftParticipant,
    });
  }
}

export default MultiplayerMatchPlugin;
