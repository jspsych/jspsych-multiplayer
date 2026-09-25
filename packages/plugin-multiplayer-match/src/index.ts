import {
  GroupSessionData,
  JsPsych,
  JsPsychPlugin,
  ParameterType,
  PresenceData,
  TrialType,
} from "jspsych";

import { version } from "../package.json";
import { MatchOptions, Snapshot, buildMatches } from "./match-core";
import {
  getMultiplayer,
  isMultiplayerError,
  remainingParticipants,
  sealedGroupSize,
} from "./multiplayer";
import {
  getMatchMap,
  getMyGroup,
  getMyMatch,
  getMyPartners,
  getMyPosition,
  setMyMatch,
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
     * Wait for EXACTLY this many participants to be present before partitioning (fail-loud: an
     * overshoot stalls to a timeout rather than partitioning a subset). Participants who have left
     * the session don't count and aren't partitioned. `null` (the default) means the members of a
     * sealed group (see `jsPsych.multiplayer.group()`) who haven't left; with a group that isn't
     * sealed, `null` trusts an upstream barrier and partitions whoever is present as soon as this
     * client has pushed (a warning fires).
     */
    expected_players: { type: ParameterType.INT, default: null },
    /**
     * How participants are ordered before being chunked into groups: `"ordered"` (by id, the default),
     * `"join_order"` (by pushed `joinedAt`), or `"random"` (a shuffle seeded by the session — unpredictable-by-id
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
     * `(snapshot, presence) => boolean` overriding the readiness gate. `snapshot` excludes
     * participants who have left; both arguments are frozen, so don't modify them. A predicate that
     * throws counts as "not ready"; if the group never becomes ready, the last error is logged. FUNCTION is deliberate — it stops
     * jsPsych's dynamic-parameter machinery from CALLING the value. Null derives readiness from
     * `expected_players` (and, for `join_order`, that every present participant has pushed `joinedAt`).
     */
    ready: { type: ParameterType.FUNCTION, default: null },
    /**
     * Extra data this client contributes into the shared session (merged alongside `joinedAt`). Must
     * be JSON-safe: the session deep-copies every value with `JSON.stringify`, so a `Date` arrives as
     * a string and `undefined`/`Map`/`Set`/`NaN` values do not survive the round trip.
     */
    push_data: { type: ParameterType.OBJECT, default: {} },
    /** Include the full group snapshot in the trial data. Off by default to avoid bloat. */
    save_group: { type: ParameterType.BOOL, default: false },
    /** Milliseconds to wait for readiness before giving up; `wait()` REJECTS on expiry. `null` waits forever. */
    timeout: { type: ParameterType.INT, default: 30000 },
    /** Hook run on timeout. The trial always ends with `matched_self: false, timed_out: true` regardless. */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
    /**
     * Participants the match depends on. If one of them leaves the session before the group is
     * ready, the trial ends unmatched with `partner_left: true`. Null (the default) means every other
     * participant who is connected when this participant arrives. Pass `[]` to ignore
     * departures.
     */
    participants: { type: ParameterType.COMPLEX, default: null },
    /** Shown while waiting for the group. */
    message: { type: ParameterType.HTML_STRING, default: "<p>Finding your match…</p>" },
  },
  data: {
    /** This participant's group index (`null` if a spectator or on timeout). */
    match_group: { type: ParameterType.INT },
    /** The other members of this participant's group (`null` on timeout, `[]` if a spectator). */
    partners: { type: ParameterType.OBJECT },
    /** All members of this participant's group, including self, in consensus order (`null` on timeout). */
    members: { type: ParameterType.OBJECT },
    /** This participant's seat within its group, 0-based (`null` if a spectator or on timeout). */
    position: { type: ParameterType.INT },
    /** The full `participantId -> assignment` map every client agreed on (`null` on timeout). */
    match_map: { type: ParameterType.OBJECT },
    /** Whether this participant was placed in a group — distinguishes a spectator from a timeout. */
    matched_self: { type: ParameterType.BOOL },
    /** `true` if readiness was not reached before `timeout`. */
    timed_out: { type: ParameterType.BOOL },
    /** `true` if the trial ended unmatched because a participant in `participants` left the session. */
    partner_left: { type: ParameterType.BOOL },
    /** The ID of the participant who left, when `partner_left` is true; otherwise null. */
    left_participant: { type: ParameterType.STRING },
    /** `true` if the trial ended unmatched because this participant's connection was lost for good. */
    connection_lost: { type: ParameterType.BOOL },
    /** The full snapshot partitioned over — only present when `save_group: true`. */
    group: { type: ParameterType.OBJECT },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/** The group without participants who have left the session. */
function withoutLeft(group: GroupSessionData, presence: PresenceData): GroupSessionData {
  return Object.fromEntries(Object.entries(group).filter(([id]) => presence[id] !== "left"));
}

interface Unmatched {
  timed_out?: boolean;
  partner_left?: boolean;
  left_participant?: string | null;
  connection_lost?: boolean;
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
 * The trial runs as a short barrier: it pushes this client's `joinedAt`/data, then `wait`s until the
 * group is ready, partitions the resolved snapshot,
 * exposes this client's partners to downstream trials through the accessor store, and saves the
 * assignment to the data record. On timeout it fails loud (`matched_self: false, timed_out: true`)
 * rather than hanging.
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

  // Match accessors for downstream trials. These read the store this plugin populates, so they return
  // undefined/empty until a match has run.
  static getMyMatch = getMyMatch;
  static getMyPartners = getMyPartners;
  static getMyGroup = getMyGroup;
  static getMyPosition = getMyPosition;
  static getMatchMap = getMatchMap;

  constructor(private jsPsych: JsPsych) {}

  trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const multiplayer = getMultiplayer(this.jsPsych);

    const me = multiplayer.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-match: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.multiplayer.connect(adapter)) before this trial runs.",
      );
    }

    // Without an exact `expected_players` (and without a custom `ready`), readiness quantifies only
    // over participants PRESENT in the snapshot, so it can resolve the instant THIS client has pushed —
    // partitioning a partial group. Warn unless an upstream barrier is trusted to have admitted every
    // peer first.
    const expectedPlayers = trial.expected_players ?? sealedGroupSize(multiplayer);
    if (expectedPlayers == null && trial.ready == null) {
      console.warn(
        "plugin-multiplayer-match: no `expected_players` and no custom `ready` — the group can be " +
          "partitioned as soon as this client has pushed, over a partial group. Set `expected_players` " +
          "(the exact count), seal the group first (jsPsych.multiplayer.waitForGroup()), or supply a " +
          "`ready` predicate unless an upstream barrier guarantees all peers have already pushed into " +
          "this session.",
      );
    }

    // `update` MERGES this payload into our slot (unlike `push`, which replaces the whole slot), so
    // every key written by earlier trials survives without a read-modify-write here. This client's
    // own entry is still READ, for one reason: `joinedAt` is stamped ONCE (first-seen, never
    // re-stamped) so join-order stays stable across rounds.
    const payload: Record<string, unknown> = {
      ...(trial.push_data as Record<string, unknown>),
      joinedAt: (multiplayer.get(me)?.joinedAt as number | undefined) ?? Date.now(),
    };

    display_element.innerHTML = trial.message;
    // We render synchronously above; jsPsych only auto-fires on_load for non-promise trials, and we
    // return a promise below, so signal load ourselves.
    on_load?.();

    let lastReadyError: unknown;
    const isReady = this.makeReadiness(trial, expectedPlayers, (e) => (lastReadyError = e));
    // The presence the group was ready under, so the partition covers exactly who was counted
    let readyPresence: PresenceData = {};
    const ready = (group: GroupSessionData, presence: PresenceData) => {
      const members = withoutLeft(group, presence);
      // Each participant computes the result on its own, so wait until everyone counted is
      // connected: then every view agrees on the group, and a leftover slot that is only `away`
      // can't be included before it turns `left`.
      if (!Object.keys(members).every((id) => presence[id] === "connected")) return false;
      const met = isReady(members, presence);
      if (met) readyPresence = presence;
      return met;
    };

    // Write our payload, then wait for readiness. The trailing `.catch` sorts the ways this chain
    // can reject: a cancelled wait (jsPsych tearing the experiment down) stops quietly; a timeout, a
    // departure, or a lost connection ends the trial unmatched; and any OTHER rejection (a backend
    // write failure, or a buildMatches throw from a config error such as a non-divisible group with
    // leftover "error") rethrows so jsPsych halts loudly. We partition the RESOLVED snapshot, never a
    // fresh getAll(), which would reopen the time-of-check gap. `timeout` passes straight through:
    // core reads null, negative and non-finite as "wait forever".
    return multiplayer
      .update(payload)
      .then(() => {
        const participants =
          (trial.participants as string[] | null) ?? remainingParticipants(multiplayer);
        return multiplayer.wait(ready, { timeout: trial.timeout, participants });
      })
      .then((group) => {
        const matchMap = buildMatches(withoutLeft(group, readyPresence), {
          groupSize: trial.group_size,
          strategy: trial.strategy as MatchOptions["strategy"],
          seed: trial.seed ?? undefined,
          round: trial.round,
          // Session-seeded, so every participant in this group computes the same shuffle
          shuffle: (key, ids) => multiplayer.shuffle(key, ids),
          leftover: trial.leftover as MatchOptions["leftover"],
        });
        const mine = matchMap[me];
        setMyMatch(mine, matchMap); // update accessor store for downstream trials
        this.jsPsych.finishTrial({
          match_group: mine?.group ?? null,
          // A spectator has zero partners, not "unknown": emit [] (matching getMyPartners() and the
          // documented contract) so `data.partners.length`/iteration is safe. `null` is reserved for
          // the unmatched paths, where the partition never ran.
          partners: mine ? mine.partners : [],
          members: mine?.members ?? null,
          position: mine?.position ?? null,
          match_map: matchMap,
          // matched_self is false only when a partition ran but this participant is absent — i.e. a
          // spectator (leftover). It distinguishes that from the unmatched paths.
          matched_self: mine != null,
          timed_out: false,
          partner_left: false,
          left_participant: null,
          connection_lost: false,
          ...(trial.save_group ? { group } : {}),
        });
      })
      .catch((err) => {
        // Errors are matched on their NAME, not `instanceof`, which fails across two loaded copies
        // of jspsych. A cancelled wait means jsPsych is ending or aborting the experiment: return
        // quietly, since finishing here would record a bogus trial on every abort.
        if (isMultiplayerError(err, "MultiplayerCancelledError")) return;
        let outcome: Unmatched;
        if (isMultiplayerError(err, "MultiplayerTimeoutError")) {
          outcome = { timed_out: true };
        } else if (isMultiplayerError(err, "MultiplayerParticipantLeftError")) {
          outcome = { partner_left: true, left_participant: err.participantId ?? null };
        } else if (isMultiplayerError(err, "MultiplayerConnectionClosedError")) {
          outcome = { connection_lost: true };
        } else {
          throw err;
        }
        // A `ready` predicate may throw routinely while data is still arriving, so its errors are
        // only worth reporting when the group never became ready — one may be the reason why.
        if (lastReadyError !== undefined) {
          console.error(
            "plugin-multiplayer-match: the group never became ready; the `ready` predicate last threw",
            lastReadyError,
          );
        }
        return this.endUnmatched(trial, outcome);
      });
  }

  /**
   * Build the readiness predicate for the `wait` barrier. It receives the snapshot without
   * participants who have left.
   */
  private makeReadiness(
    trial: TrialType<Info>,
    expectedPlayers: number | null,
    onError: (e: unknown) => void,
  ): (s: GroupSessionData, presence: PresenceData) => boolean {
    // Exact count converts a contract violation (overshoot) into a loud stall->timeout rather than a
    // silent subset partition. `null` resolves as soon as anyone is present (an upstream barrier trust).
    const enough = (s: GroupSessionData) =>
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
   * the connection was lost. Fail loud, don't hang. A cancelled wait returns quietly instead, and a
   * backend/write failure rethrows.
   */
  private endUnmatched(trial: TrialType<Info>, outcome: Unmatched) {
    setMyMatch(undefined); // clear any stale assignment so getMyMatch() reads as undefined
    try {
      if (outcome.timed_out && trial.on_timeout) trial.on_timeout(this.jsPsych);
    } catch (err) {
      // A throwing hook must NOT skip finishTrial below — that would reintroduce the exact hang the
      // timeout exists to prevent. Swallow it (after logging) so the trial still ends.
      console.error("plugin-multiplayer-match: on_timeout hook threw", err);
    }
    this.jsPsych.finishTrial({
      match_group: null,
      partners: null,
      members: null,
      position: null,
      match_map: null,
      matched_self: false,
      timed_out: outcome.timed_out ?? false,
      partner_left: outcome.partner_left ?? false,
      left_participant: outcome.left_participant ?? null,
      connection_lost: outcome.connection_lost ?? false,
    });
  }
}

export default MultiplayerMatchPlugin;
