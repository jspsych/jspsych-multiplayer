import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { MatchOptions, Snapshot, buildMatches } from "./match-core";
import { GroupSessionData, MultiplayerApiLike } from "./multiplayer-api";
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
     * overshoot stalls to a timeout rather than partitioning a subset). `null` trusts an upstream
     * barrier and partitions whoever is present as soon as this client has pushed (a warning fires).
     */
    expected_players: { type: ParameterType.INT, default: null },
    /**
     * How participants are ordered before being chunked into groups: `"ordered"` (by id, the default),
     * `"join_order"` (by pushed `joinedAt`), or `"random"` (a seeded shuffle — unpredictable-by-id yet
     * identical on every client, and per-round via `round`). Prefer `"random"` for real experiments to
     * avoid pairings that track participant-id order.
     */
    strategy: { type: ParameterType.STRING, default: "ordered" },
    /** Shared seed for `"random"`. Defaults to a hash of the sorted ids + `round`. */
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
     * `(snapshot) => boolean` overriding the readiness gate. FUNCTION is deliberate — it stops
     * jsPsych's dynamic-parameter machinery from CALLING the value. Null derives readiness from
     * `expected_players` (and, for `join_order`, that every present participant has pushed `joinedAt`).
     */
    ready: { type: ParameterType.FUNCTION, default: null },
    /** Extra data this client contributes into the shared session (merged alongside `joinedAt`). */
    push_data: { type: ParameterType.OBJECT, default: {} },
    /** Include the full group snapshot in the trial data. Off by default to avoid bloat. */
    save_group: { type: ParameterType.BOOL, default: false },
    /** Milliseconds to wait for readiness before giving up; `wait()` REJECTS on expiry. `null` waits forever. */
    timeout: { type: ParameterType.INT, default: 30000 },
    /** Hook run on timeout. The trial always ends with `matched_self: false, timed_out: true` regardless. */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
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
    /** The full snapshot partitioned over — only present when `save_group: true`. */
    group: { type: ParameterType.OBJECT },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/** Run a predicate; a thrown error (e.g. reading not-yet-present data) means "not ready". */
const tryBool = (fn: () => boolean): boolean => {
  try {
    return !!fn();
  } catch {
    return false;
  }
};

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
 * Requires a connected multiplayer adapter — call `await jsPsych.pluginAPI.connect(adapter)` before
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
    // The multiplayer API is flattened onto pluginAPI by jsPsych core (jsPsych#3694). The published
    // `jspsych` types don't carry it yet, so reach it through the local interface with one cast.
    const api = this.jsPsych.pluginAPI as unknown as MultiplayerApiLike;

    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-match: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.pluginAPI.connect(adapter)) before this trial runs."
      );
    }

    // Without an exact `expected_players` (and without a custom `ready`), readiness quantifies only
    // over participants PRESENT in the snapshot, so it can resolve the instant THIS client has pushed —
    // partitioning a partial group. Warn unless an upstream barrier is trusted to have admitted every
    // peer first.
    if (trial.expected_players == null && trial.ready == null) {
      console.warn(
        "plugin-multiplayer-match: no `expected_players` and no custom `ready` — the group can be " +
          "partitioned as soon as this client has pushed, over a partial group. Set `expected_players` " +
          "(the exact count) or supply a `ready` predicate unless an upstream barrier guarantees all " +
          "peers have already pushed into this session."
      );
    }

    // Read this client's own prior entry first, then merge: the push REPLACES this client's whole
    // entry (overwrite-per-participant adapter semantics), so `prev` is spread first — every key pushed
    // by earlier trials survives. `joinedAt` is written ONCE (first-seen, never re-stamped) so
    // join-order stays stable across rounds.
    const prev = api.get(me) ?? {};
    const payload: Record<string, unknown> = {
      ...prev,
      ...(trial.push_data as Record<string, unknown>),
      joinedAt: (prev.joinedAt as number | undefined) ?? Date.now(),
    };

    display_element.innerHTML = trial.message;
    // We render synchronously above; jsPsych only auto-fires on_load for non-promise trials, and we
    // return a promise below, so signal load ourselves.
    on_load?.();

    const isReady = this.makeReadiness(trial);

    // Push our payload, then wait for readiness. (`communicate` was removed from the multiplayer API
    // in jsPsych#3694; a push-then-wait chain is the replacement.) The two-argument `.then` is
    // deliberate: the rejection handler catches only the push/wait rejection. It routes a genuine
    // readiness timeout (`MultiplayerTimeoutError`) to the graceful timeout path, but rethrows any
    // OTHER rejection (a backend/push failure) so it is never masqueraded as a timeout. A throw from
    // buildMatches is a different animal again — readiness already certified the group, so a throw
    // there means the CONFIG is wrong (a non-divisible group with leftover "error"); because it
    // happens inside the resolve handler it propagates out of the returned promise and jsPsych halts
    // loudly. We partition the RESOLVED snapshot, never a fresh getAll(), which would reopen the
    // time-of-check gap.
    return api
      .push(payload)
      .then(() => api.wait(isReady, trial.timeout ?? undefined))
      .then((group) => {
        const matchMap = buildMatches(group, {
          groupSize: trial.group_size,
          strategy: trial.strategy as MatchOptions["strategy"],
          seed: trial.seed ?? undefined,
          round: trial.round,
          leftover: trial.leftover as MatchOptions["leftover"],
        });
        const mine = matchMap[me];
        setMyMatch(mine, matchMap); // update accessor store for downstream trials
        this.jsPsych.finishTrial({
          match_group: mine?.group ?? null,
          // A spectator has zero partners, not "unknown": emit [] (matching getMyPartners() and the
          // documented contract) so `data.partners.length`/iteration is safe. `null` is reserved for
          // the timeout path, where the partition never ran.
          partners: mine ? mine.partners : [],
          members: mine?.members ?? null,
          position: mine?.position ?? null,
          match_map: matchMap,
          // matched_self is false only when a partition ran but this participant is absent — i.e. a
          // spectator (leftover). It distinguishes that from a timeout, where match_map is null too.
          matched_self: mine != null,
          timed_out: false,
          ...(trial.save_group ? { group } : {}),
        });
      })
      .catch((err) => {
        // A genuine readiness timeout ends the trial gracefully (timed_out: true). Match on the error
        // NAME, not `instanceof` — that survives two loaded copies of jspsych. Any other rejection (a
        // backend/push failure) is a real fault: rethrow so jsPsych halts loudly instead of it being
        // mislabelled a timeout. Note this .catch runs AFTER the resolve handler, so a buildMatches
        // throw would also land here — but such a throw is a config bug that likewise must propagate,
        // and it is not a MultiplayerTimeoutError, so it rethrows too.
        if ((err as { name?: string })?.name === "MultiplayerTimeoutError") {
          return this.handleTimeout(trial);
        }
        throw err;
      });
  }

  /** Build the readiness predicate for the `wait` barrier. */
  private makeReadiness(trial: TrialType<Info>): (s: GroupSessionData) => boolean {
    // Exact count converts a contract violation (overshoot) into a loud stall->timeout rather than a
    // silent subset partition. `null` resolves as soon as anyone is present (an upstream barrier trust).
    const enough = (s: GroupSessionData) =>
      trial.expected_players == null || Object.keys(s).length === trial.expected_players;

    if (typeof trial.ready === "function") {
      const ready = trial.ready as (s: Snapshot) => boolean;
      return (s) => enough(s) && tryBool(() => ready(s));
    }
    if (trial.strategy === "join_order") {
      return (s) => enough(s) && Object.keys(s).every((id) => (s[id] as any)?.joinedAt != null);
    }
    return enough;
  }

  /** Readiness never reached within `timeout` (or a backend/push error). Fail loud, don't hang. */
  private handleTimeout(trial: TrialType<Info>) {
    setMyMatch(undefined); // clear any stale assignment so getMyMatch() reads as undefined
    try {
      if (trial.on_timeout) trial.on_timeout(this.jsPsych);
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
      timed_out: true,
    });
  }
}

export default MultiplayerMatchPlugin;
