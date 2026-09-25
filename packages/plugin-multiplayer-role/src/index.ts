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
import { makeReadiness } from "./readiness";
import { AssignOptions, Snapshot, assignRoles } from "./roles";
import {
  getMyAssignment,
  getMyRole,
  getRoleMap,
  participantsByRole,
  rememberJsPsych,
} from "./store";

// Public types are part of the API. They erase at build time, so exporting them does not add a
// runtime named export — the bundle stays a single default export, per the jsPsych plugin packaging
// convention (`output.exports: "default"`). The runtime helpers (the pure core + the role accessors)
// are exposed as statics on the plugin class below, so everything is reachable through that one
// default export without deviating from the convention.
export type { Snapshot, RoleAssignment, RoleMap, Ctx, AssignOptions } from "./roles";

const info = <const>{
  name: "multiplayer-role",
  version: version,
  parameters: {
    /** The roles to hand out: an array (one slot per entry) or an object of counts. */
    roles: { type: ParameterType.OBJECT, default: undefined },
    /**
     * How participants are ordered into slots: a string preset (`"join_order"`/`"random"`/`"rotate"`)
     * or a custom `(snapshot, ctx) => roleMap`. FUNCTION is deliberate — it stops jsPsych's
     * dynamic-parameter machinery from CALLING the value and substituting its return. A string preset
     * is still a valid default/value; do NOT "fix" this to OBJECT.
     */
    strategy: { type: ParameterType.FUNCTION, default: "join_order" },
    /**
     * Wait for EXACTLY this many participants to reach this trial before computing (fail-loud).
     * Participants who have left the session don't count and aren't assigned. `null` (the default)
     * means the members of a sealed group (see `jsPsych.multiplayer.group()`) who haven't left; with
     * a group that isn't sealed, `null` trusts an upstream barrier.
     */
    group_size: { type: ParameterType.INT, default: null },
    /** Round index, for `rotate` and per-round `random`. Increment each re-run. */
    round: { type: ParameterType.INT, default: 0 },
    /** For `rotate`: use the balanced (Williams) variant. */
    balanced: { type: ParameterType.BOOL, default: false },
    /**
     * For `random`: picks a different random assignment within the session. Randomness is seeded
     * by the session ID (or the `randomSeed` connect option), so each group gets its own assignment.
     */
    seed: { type: ParameterType.STRING, default: null },
    /** `(entry, id, ctx) => number`. Order by a numeric key, highest first. FUNCTION: see `strategy`. */
    rank_by: { type: ParameterType.FUNCTION, default: null },
    /** `(entry, id, ctx) => string`. The role IS a value each participant carries. FUNCTION: see `strategy`. */
    role_from: { type: ParameterType.FUNCTION, default: null },
    /**
     * `(snapshot, presence) => boolean`. Override the readiness gate; REQUIRED when `strategy` is a
     * custom function. `snapshot` holds the participants who have reached this trial and haven't
     * left. Both arguments are frozen, so don't modify them.
     */
    ready: { type: ParameterType.FUNCTION, default: null },
    /** Role for participants beyond the declared slots. Applies whenever the participant count exceeds the declared slots (capped or not); without it, overflow throws. */
    overflow_role: { type: ParameterType.STRING, default: null },
    /**
     * Data this client contributes to this trial's snapshot (e.g. the score `rank_by` ranks on).
     * Merged into this participant's data in the trial's own scope, so it never reaches another
     * trial.
     */
    write_data: { type: ParameterType.OBJECT, default: {} },
    /** Include the full group snapshot in the trial data. Off by default to avoid bloat. */
    save_group: { type: ParameterType.BOOL, default: false },
    /**
     * Milliseconds to wait for readiness before giving up. `null`, `0`, or a negative value waits
     * forever (discouraged). 30 s suits "compose after a sync lobby" (only data propagation remains);
     * if this trial self-gates arrivals (`group_size` set), raise it substantially or keep arrival
     * waiting in an upstream `plugin-multiplayer-sync` barrier.
     */
    timeout: { type: ParameterType.INT, default: 30000 },
    /** Hook run on timeout. The trial always ends with `role: null, multiplayer_outcome: "timeout"` regardless. */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
    /**
     * Participants the assignment depends on. If one of them leaves the session before the group is
     * ready, the trial ends with `role: null, multiplayer_outcome: "participant_left"`. Null (the
     * default) means the rest of a sealed group, or else every other participant who is connected
     * when this participant arrives. Pass `[]` to ignore departures.
     */
    participants: { type: ParameterType.COMPLEX, default: null },
    /** Shown while waiting. */
    message: { type: ParameterType.HTML_STRING, default: "<p>Assigning roles…</p>" },
  },
  data: {
    /** This participant's assigned role (`null` unless the outcome is `completed`, or for a spectator). */
    role: { type: ParameterType.STRING },
    /** The full `participantId -> { role }` map every client agreed on (`null` unless `completed`). */
    role_map: { type: ParameterType.OBJECT },
    /** Whether this participant appears in the map — distinguishes spectator/overflow from an unassigned outcome. */
    assigned_self: { type: ParameterType.BOOL },
    /**
     * How the trial ended: `"completed"`, `"timeout"` (the group wasn't ready before `timeout`),
     * `"participant_left"` (a participant in `participants` left), or `"connection_lost"` (this
     * participant's connection was lost for good).
     */
    multiplayer_outcome: { type: ParameterType.STRING },
    /** The ID of the participant who left, when the outcome is `participant_left`; otherwise null. */
    left_participant: { type: ParameterType.STRING },
    /** The full snapshot assigned over — only present when `save_group: true`. */
    group: { type: ParameterType.OBJECT },
  },
  // When you run build on your plugin, citations will be generated here based on the CITATION.cff.
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/**
 * The snapshot this trial assigns over: every participant who has written in this trial's scope
 * (i.e. reached the trial) and hasn't left, each with their session data (e.g. `joinedAt`, or a
 * condition written at connect time) merged under their data from this trial. Frozen, like the
 * core's snapshots.
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
 * **plugin-multiplayer-role**
 *
 * Assigns each participant in a multiplayer group a role by deterministic consensus — every client
 * independently computes the same role map from the shared snapshot, with no coordinator and no
 * extra round-trip.
 *
 * The trial runs as a short barrier: it writes this client's data into the trial's own scope, waits
 * (via the multiplayer API's `wait`) until the group is ready per the chosen strategy, computes the
 * map over the resolved snapshot, and saves the assignment to the data record, where the role
 * accessors read it for downstream trials. If the group never becomes ready it fails loud
 * (`role: null` with a `multiplayer_outcome`) rather than hanging.
 *
 * The pure assignment core and the role accessors are also reachable as static members
 * (`MultiplayerRolePlugin.assignRoles`, `.getMyRole`, `.getMyAssignment`, `.getRoleMap`,
 * `.participantsByRole`) — usable standalone, today.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-role}
 */
class MultiplayerRolePlugin implements JsPsychPlugin<Info> {
  static info = info;

  /** Pure, jsPsych-independent assignment core. Usable standalone, today. */
  static assignRoles = assignRoles;

  // Role accessors for downstream trials. These read the last role trial's data, so they return
  // undefined/empty until an assignment has run.
  static getMyRole = getMyRole;
  static getMyAssignment = getMyAssignment;
  static getRoleMap = getRoleMap;
  static participantsByRole = participantsByRole;

  constructor(private jsPsych: JsPsych) {}

  trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    const multiplayer = getMultiplayer(this.jsPsych, "plugin-multiplayer-role");

    const me = multiplayer.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-role: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.multiplayer.connect(adapter)) before this trial runs.",
      );
    }

    // A custom strategy function is opaque to the readiness derivation, so it cannot infer when the
    // group is safe to assign over. Require an explicit `ready` predicate rather than silently gating
    // on participant count alone.
    if (typeof trial.strategy === "function" && trial.ready == null) {
      throw new Error(
        "plugin-multiplayer-role: a custom `strategy` function requires an explicit `ready` " +
          "predicate (the readiness gate cannot be derived from an opaque strategy).",
      );
    }

    // The accessors read this jsPsych's data when called without one
    rememberJsPsych(this.jsPsych);

    // Without an exact `group_size` (and without a custom `ready`), the readiness gate quantifies only
    // over participants PRESENT in the snapshot, so it can resolve the instant THIS client has written —
    // assigning over a partial group. Warn unless an upstream barrier is trusted to have admitted
    // every peer first.
    const groupSize = trial.group_size ?? sealedGroupSize(multiplayer);
    if (groupSize == null && trial.ready == null) {
      console.warn(
        "plugin-multiplayer-role: no `group_size` and no custom `ready` — readiness can resolve as " +
          "soon as this client has written, assigning over a partial group. Set `group_size` (the exact " +
          "count), seal the group first (jsPsych.multiplayer.waitForGroup()), or supply a `ready` " +
          "predicate unless an upstream barrier guarantees all peers reach this trial together.",
      );
    }

    display_element.innerHTML = trial.message;
    // We render synchronously above, so the trial DOM is ready now. jsPsych only auto-fires on_load
    // for non-promise trials; because we return a promise below, we must signal load ourselves.
    on_load?.();

    const isReady = makeReadiness({
      groupSize,
      strategy: trial.strategy,
      rankBy: trial.rank_by ?? undefined,
      roleFrom: trial.role_from ?? undefined,
      ready: trial.ready ?? undefined,
      round: trial.round,
      seed: trial.seed ?? undefined,
    });

    // The snapshot the group was ready over, so the assignment covers exactly who was counted
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
    // never re-stamped) so the join order stays the same in every later role or match trial; the
    // page may also have written it at connect time. `write_data` goes in this trial's own scope,
    // which is also what marks this participant as having reached the trial.
    //
    // The two-argument `.then` is deliberate: the rejection handler catches ONLY the write/wait
    // chain's rejection. A throw from assignRoles is a different animal — readiness has already
    // certified the group complete, so a throw there means the assignment CONFIG is wrong (overflow
    // with no overflow_role, role_from returning an undeclared role, a custom strategy that
    // throws). Those propagate out of the returned promise so jsPsych halts the trial loudly. We
    // assign over the RESOLVED snapshot, never a fresh getAll(), which would reopen the
    // time-of-check gap.
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
      .then(
        () => {
          const roleMap = assignRoles(readySnapshot, {
            roles: trial.roles as AssignOptions["roles"],
            strategy: trial.strategy,
            seed: trial.seed ?? undefined,
            round: trial.round,
            balanced: trial.balanced,
            rankBy: trial.rank_by ?? undefined,
            roleFrom: trial.role_from ?? undefined,
            overflowRole: trial.overflow_role ?? undefined,
            // Session-shared shuffle, so every client in the group draws the same order.
            shuffle: (key, ids) => multiplayer.shuffle(key, ids),
          });
          const mine = roleMap[me];
          this.jsPsych.finishTrial({
            role: mine?.role ?? null,
            role_map: roleMap,
            // assigned_self is false only when an assignment ran but this participant is absent from the
            // agreed map — i.e. a custom strategy treated them as a spectator. (Overflow participants ARE
            // in the map, with overflow_role, so they read true.) It distinguishes that from the
            // unassigned outcomes, where role_map is null too.
            assigned_self: mine != null,
            multiplayer_outcome: "completed",
            left_participant: null,
            ...(trial.save_group ? { group: readySnapshot } : {}),
          });
        },
        (error) => {
          const outcome = outcomeOf(error);
          // A failed write or an adapter/backend error. Surface it loudly.
          if (outcome === null) throw error;
          // A cancelled wait is neither a timeout nor a failure: jsPsych cancels pending waits when
          // the trial or experiment ends, so this trial is already being torn down. Return quietly
          // — no on_timeout, no finishTrial, nothing logged.
          if (outcome === "cancelled") return;
          // Accessors throw routinely while data is still arriving, so those errors are only worth
          // reporting when the group never became ready — one may be the reason why.
          const lastError = isReady.lastError();
          if (lastError !== undefined) {
            console.error(
              "plugin-multiplayer-role: the group never became ready; the readiness check last threw",
              lastError,
            );
          }
          const left = isMultiplayerError(error, "participant_left")
            ? (error.participantId ?? null)
            : null;
          return this.endUnassigned(trial, outcome, left);
        },
      );
  }

  /**
   * The group never became ready: `timeout` elapsed, a participant left, or the connection was lost.
   * Fail loud, don't hang.
   */
  private endUnassigned(
    trial: TrialType<Info>,
    outcome: Exclude<MultiplayerOutcome, "completed" | "cancelled">,
    leftParticipant: string | null,
  ) {
    try {
      if (outcome === "timeout" && trial.on_timeout) trial.on_timeout(this.jsPsych);
    } catch (err) {
      // A throwing hook must NOT skip finishTrial below — that would reintroduce the exact hang the
      // timeout exists to prevent. Swallow it (after logging) so the trial still ends.
      console.error("plugin-multiplayer-role: on_timeout hook threw", err);
    }
    // ALWAYS end the trial ourselves, even if on_timeout ran — a hook that forgets to end the trial
    // would reintroduce the exact hang the timeout exists to prevent. `role_map: null` also clears
    // the accessors, so getMyRole() reads as undefined rather than a stale earlier role.
    this.jsPsych.finishTrial({
      role: null,
      role_map: null,
      assigned_self: false,
      multiplayer_outcome: outcome,
      left_participant: leftParticipant,
    });
  }
}

export default MultiplayerRolePlugin;
