/**
 * Pure readiness gate for `plugin-multiplayer-role`.
 *
 * This is where correctness actually lives. It decides *when* a snapshot is safe to
 * assign over. It does NOT manufacture membership consensus — that comes from an upstream "capped,
 * agreed set of N" contract (a waiting-room barrier). Given that contract, this adds field-readiness:
 * don't assign until every present participant carries the data the chosen strategy will read.
 */
import { AssignOptions, Ctx, Snapshot, byId } from "./roles";

export interface ReadinessOptions {
  /** If set, require exactly this many participants (exact-count, not >= — overshoot stalls loudly). */
  groupSize?: number | null;
  strategy?: AssignOptions["strategy"];
  rankBy?: AssignOptions["rankBy"];
  roleFrom?: AssignOptions["roleFrom"];
  /** Required for a custom function strategy (opaque to derivation). */
  ready?: (s: Snapshot, presence: Presence) => boolean;
  round?: number;
  seed?: string;
}

/** Presence status per participant, as jsPsych's multiplayer API reports it. */
export type Presence = Record<string, string>;

/**
 * A readiness predicate. `lastError()` returns the most recent error an accessor or `ready`
 * threw, so a caller can report it if the group never becomes ready.
 */
export type ReadinessPredicate = ((s: Snapshot, presence?: Presence) => boolean) & {
  lastError: () => unknown;
};

/**
 * Build the readiness predicate for `api.wait(predicate)`. Accessors are called *speculatively*
 * during the propagation race, before every participant's data lands, so the natural accessor
 * (`e => e.stats.score`) will throw — treated here as "not ready yet" so researchers need
 * not write null-safe accessors.
 */
export function makeReadiness(opts: ReadinessOptions): ReadinessPredicate {
  let lastError: unknown;
  /** Run a predicate; a thrown error (e.g. an accessor reading not-yet-present round data) means "not ready". */
  const tryBool = (fn: () => boolean): boolean => {
    try {
      return !!fn();
    } catch (e) {
      lastError = e;
      return false;
    }
  };

  // Exact count converts a contract violation (overshoot) into a loud stall->timeout rather than a
  // silent subset assignment. It does NOT create membership consensus.
  const enoughPlayers = (s: Snapshot) =>
    opts.groupSize == null || Object.keys(s).length === opts.groupSize;

  const ctx = (s: Snapshot): Ctx => ({
    ids: Object.keys(s).sort(byId), // code-unit order, matching assignRoles (locale-independent)
    round: opts.round ?? 0,
    seed: opts.seed ?? "",
  });

  const every = (fn: (entry: any, id: string, c: Ctx) => boolean) => (s: Snapshot) =>
    enoughPlayers(s) && Object.keys(s).every((id) => tryBool(() => fn(s[id], id, ctx(s))));

  let predicate: (s: Snapshot, presence?: Presence) => boolean;
  if (opts.ready) {
    predicate = (s, presence = {}) => enoughPlayers(s) && tryBool(() => opts.ready!(s, presence));
  } else if (opts.roleFrom) {
    predicate = every((e, id, c) => opts.roleFrom!(e, id, c) != null);
  } else if (opts.rankBy) {
    predicate = every((e, id, c) => Number.isFinite(opts.rankBy!(e, id, c)));
  } else if ((opts.strategy ?? "join_order") === "join_order") {
    predicate = (s) => enoughPlayers(s) && Object.keys(s).every((id) => s[id]?.joinedAt != null);
  } else {
    // random / rotate need only the id set
    predicate = (s) => enoughPlayers(s);
  }
  return Object.assign(predicate, { lastError: () => lastError });
}
