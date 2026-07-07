import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { MultiplayerApiLike } from "./multiplayer-api";
import { makeReadiness } from "./readiness";
import { AssignOptions, assignRoles } from "./roles";
import {
  getMyAssignment,
  getMyRole,
  getRoleMap,
  participantsByRole,
  setMyAssignment,
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
    /** Wait for EXACTLY this many participants before computing (fail-loud). `null` trusts an upstream barrier. */
    group_size: { type: ParameterType.INT, default: null },
    /** Round index, for `rotate` and per-round `random`. Increment each re-run. */
    round: { type: ParameterType.INT, default: 0 },
    /** For `rotate`: use the balanced (Williams) variant. */
    balanced: { type: ParameterType.BOOL, default: false },
    /** Shared seed for `random`. Defaults to a hash of the sorted ids + round. */
    seed: { type: ParameterType.STRING, default: null },
    /** `(entry, id, ctx) => number`. Order by a numeric key, highest first. FUNCTION: see `strategy`. */
    rank_by: { type: ParameterType.FUNCTION, default: null },
    /** `(entry, id, ctx) => string`. The role IS a value each participant carries. FUNCTION: see `strategy`. */
    role_from: { type: ParameterType.FUNCTION, default: null },
    /** `(snapshot) => boolean`. Override the readiness gate; REQUIRED when `strategy` is a custom function. */
    ready: { type: ParameterType.FUNCTION, default: null },
    /** Role for participants beyond the declared slots. Applies whenever the participant count exceeds the declared slots (capped or not); without it, overflow throws. */
    overflow_role: { type: ParameterType.STRING, default: null },
    /** Round-scoped data this client contributes (e.g. the score `rank_by` ranks on). Namespaced under the round. */
    push_data: { type: ParameterType.OBJECT, default: {} },
    /** Include the full group snapshot in the trial data. Off by default to avoid bloat. */
    save_group: { type: ParameterType.BOOL, default: false },
    /**
     * Milliseconds to wait for readiness before giving up; `wait()` REJECTS on expiry. `null` waits
     * forever (discouraged). 30 s suits "compose after a sync lobby" (only data propagation remains);
     * if this trial self-gates arrivals (`group_size` set), raise it substantially or keep arrival
     * waiting in an upstream `plugin-multiplayer-sync` barrier.
     */
    timeout: { type: ParameterType.INT, default: 30000 },
    /** Hook run on timeout. The trial always ends with `role: null, timed_out: true` regardless. */
    on_timeout: { type: ParameterType.FUNCTION, default: null },
    /** Shown while waiting. */
    message: { type: ParameterType.HTML_STRING, default: "<p>Assigning roles…</p>" },
  },
  data: {
    /** This participant's assigned role (`null` on timeout). */
    role: { type: ParameterType.STRING },
    /** The full `participantId -> { role }` map every client agreed on (`null` on timeout). */
    role_map: { type: ParameterType.OBJECT },
    /** Whether this participant appears in the map — distinguishes spectator/overflow from a timeout. */
    assigned_self: { type: ParameterType.BOOL },
    /** `true` if readiness was not reached before `timeout`. */
    timed_out: { type: ParameterType.BOOL },
    /** The full snapshot assigned over — only present when `save_group: true`. */
    group: { type: ParameterType.OBJECT },
  },
  // When you run build on your plugin, citations will be generated here based on the CITATION.cff.
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;

/**
 * **plugin-multiplayer-role**
 *
 * Assigns each participant in a multiplayer group a role by deterministic consensus — every client
 * independently computes the same role map from the shared group-session snapshot, with no
 * coordinator and no extra round-trip.
 *
 * The trial runs as a short barrier: it pushes this client's round-scoped data, waits (via the
 * multiplayer API's `wait`/`communicate`) until the group is ready per the chosen strategy, computes
 * the map over the resolved snapshot, exposes the role to downstream trials through the accessor
 * store, and saves the assignment to the data record. On timeout it fails loud (`role: null,
 * timed_out: true`) rather than hanging.
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

  // Role accessors for downstream trials. These read the store this plugin populates, so they return
  // undefined/empty until an assignment has run.
  static getMyRole = getMyRole;
  static getMyAssignment = getMyAssignment;
  static getRoleMap = getRoleMap;
  static participantsByRole = participantsByRole;

  constructor(private jsPsych: JsPsych) {}

  trial(display_element: HTMLElement, trial: TrialType<Info>, on_load?: () => void) {
    // The multiplayer API is flattened onto pluginAPI by jsPsych core (jsPsych#3694). The published
    // `jspsych` types don't carry it yet, so reach it through the local interface with one cast.
    const api = this.jsPsych.pluginAPI as unknown as MultiplayerApiLike;

    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "plugin-multiplayer-role: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.pluginAPI.connect(adapter)) before this trial runs."
      );
    }

    // A custom strategy function is opaque to the readiness derivation, so it cannot infer when the
    // group is safe to assign over. Require an explicit `ready` predicate rather than silently gating
    // on participant count alone.
    if (typeof trial.strategy === "function" && trial.ready == null) {
      throw new Error(
        "plugin-multiplayer-role: a custom `strategy` function requires an explicit `ready` " +
          "predicate (the readiness gate cannot be derived from an opaque strategy)."
      );
    }

    // Without an exact `group_size` (and without a custom `ready`), the readiness gate quantifies only
    // over participants PRESENT in the snapshot, so it can resolve the instant THIS client has pushed —
    // assigning over a partial group. Warn unless an upstream barrier is trusted to have admitted and
    // pushed every peer first.
    if (trial.group_size == null && trial.ready == null) {
      console.warn(
        "plugin-multiplayer-role: no `group_size` and no custom `ready` — readiness can resolve as " +
          "soon as this client has pushed, assigning over a partial group. Set `group_size` (the exact " +
          "count) or supply a `ready` predicate unless an upstream barrier guarantees all peers have " +
          "already pushed into this session."
      );
    }

    // ROUND-SCOPED push: read this client's own prior entry first, then merge. The push REPLACES this
    // client's whole entry (overwrite-per-participant adapter semantics), so `prev` is spread first —
    // every top-level key pushed by earlier trials (e.g. a `cond` field that `role_from`/`rank_by`
    // reads) must survive this trial's push. `joinedAt` is written ONCE (first-seen, never re-stamped)
    // so the join-order base stays stable across rounds; per-round data is namespaced under
    // `rounds[round]` so a later round never clobbers `joinedAt` or an earlier round's score. (Rests
    // on the adapter being read-back consistent for this client's own writes.)
    const prev = api.get(me) ?? {};
    const payload: Record<string, unknown> = {
      ...prev,
      joinedAt: (prev.joinedAt as number | undefined) ?? Date.now(),
      rounds: {
        ...((prev.rounds as Record<string, unknown>) ?? {}),
        [trial.round]: trial.push_data,
      },
    };

    display_element.innerHTML = trial.message;
    // We render synchronously above, so the trial DOM is ready now. jsPsych only auto-fires on_load
    // for non-promise trials; because we return a promise below, we must signal load ourselves.
    on_load?.();

    const isReady = makeReadiness({
      groupSize: trial.group_size,
      strategy: trial.strategy,
      rankBy: trial.rank_by ?? undefined,
      roleFrom: trial.role_from ?? undefined,
      ready: trial.ready ?? undefined,
      round: trial.round,
      seed: trial.seed ?? undefined,
    });

    // communicate() pushes our payload, then waits for readiness. The two-argument `.then` is
    // deliberate: the rejection handler catches ONLY communicate's rejection (a real timeout or
    // backend/push failure) and routes it to the soft, fail-loud timeout path. A throw from
    // assignRoles is a different animal — readiness has already certified the group complete, so a
    // throw there means the assignment CONFIG is wrong (overflow with no overflow_role, role_from
    // returning an undeclared role, a custom strategy that throws). Those must NOT be relabelled as a
    // timeout; they propagate out of the returned promise so jsPsych halts the trial loudly. We assign
    // over the RESOLVED snapshot, never a fresh getAll(), which would reopen the time-of-check gap.
    return api.communicate(payload, isReady, trial.timeout ?? undefined).then(
      (group) => {
        const roleMap = assignRoles(group, {
          roles: trial.roles as AssignOptions["roles"],
          strategy: trial.strategy,
          seed: trial.seed ?? undefined,
          round: trial.round,
          balanced: trial.balanced,
          rankBy: trial.rank_by ?? undefined,
          roleFrom: trial.role_from ?? undefined,
          overflowRole: trial.overflow_role ?? undefined,
        });
        const mine = roleMap[me];
        setMyAssignment(mine, roleMap); // update accessor store for downstream trials
        this.jsPsych.finishTrial({
          role: mine?.role ?? null,
          role_map: roleMap,
          // assigned_self is false only when an assignment ran but this participant is absent from the
          // agreed map — i.e. a custom strategy treated them as a spectator. (Overflow participants ARE
          // in the map, with overflow_role, so they read true.) It distinguishes that from a timeout,
          // where role_map is null too.
          assigned_self: mine != null,
          timed_out: false,
          ...(trial.save_group ? { group } : {}),
        });
      },
      () => this.handleTimeout(trial) // ONLY communicate rejection (timeout / backend / push failure)
    );
  }

  /** Readiness never reached within `timeout` (or a backend/push error). Fail loud, don't hang. */
  private handleTimeout(trial: TrialType<Info>) {
    setMyAssignment(undefined); // clear any stale assignment so getMyRole() reads as undefined
    try {
      if (trial.on_timeout) trial.on_timeout(this.jsPsych);
    } catch (err) {
      // A throwing hook must NOT skip finishTrial below — that would reintroduce the exact hang the
      // timeout exists to prevent. Swallow it (after logging) so the trial still ends.
      console.error("plugin-multiplayer-role: on_timeout hook threw", err);
    }
    // ALWAYS end the trial ourselves, even if on_timeout ran — a hook that forgets to end the trial
    // would reintroduce the exact hang the timeout exists to prevent.
    this.jsPsych.finishTrial({ role: null, role_map: null, assigned_self: false, timed_out: true });
  }
}

export default MultiplayerRolePlugin;
