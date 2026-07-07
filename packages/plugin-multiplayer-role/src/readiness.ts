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
  ready?: (s: Snapshot) => boolean;
  round?: number;
  seed?: string;
}

/** Run a predicate; a thrown error (e.g. accessor reading not-yet-present round data) means "not ready". */
const tryBool = (fn: () => boolean): boolean => {
  try {
    return !!fn();
  } catch {
    return false;
  }
};

/**
 * Build the readiness predicate for `api.wait(predicate)`. Accessors are called *speculatively*
 * during the propagation race, before round data lands, so the natural accessor
 * (`e => e.rounds[round].score`) will throw — treated here as "not ready yet" so researchers need
 * not write null-safe accessors.
 */
export function makeReadiness(opts: ReadinessOptions): (s: Snapshot) => boolean {
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

  if (opts.ready) return (s) => enoughPlayers(s) && tryBool(() => opts.ready!(s));
  if (opts.roleFrom) return every((e, id, c) => opts.roleFrom!(e, id, c) != null);
  if (opts.rankBy) return every((e, id, c) => Number.isFinite(opts.rankBy!(e, id, c)));
  if ((opts.strategy ?? "join_order") === "join_order")
    return (s) => enoughPlayers(s) && Object.keys(s).every((id) => s[id]?.joinedAt != null);
  // random / rotate need only the id set
  return (s) => enoughPlayers(s);
}
