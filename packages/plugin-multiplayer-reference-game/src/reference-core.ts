/**
 * Pure, DOM-free core for `plugin-multiplayer-reference-game`.
 *
 * Everything here is a pure function — no I/O, no jsPsych, no network, no DOM — so it can be
 * unit-tested in isolation (mirroring `roles.ts` in `plugin-multiplayer-role` and `chat-core.ts` in
 * `plugin-multiplayer-chat`). The thin `index.ts` trial wires these functions to `subscribe`/`push`
 * and the DOM.
 *
 * It owns:
 *  - the deterministic per-participant scramble (seeded hash + Fisher–Yates, same helpers as the
 *    role plugin's `random` strategy) that gives the director and matcher different-but-stable
 *    layouts;
 *  - the slot-assignment model (the matcher's `slot -> objectId` map, 1-based slots);
 *  - scoring (`per_slot`, `all_or_nothing`, or a custom function; ordered vs unordered comparison);
 *  - per-round group-session data read/merge helpers (namespaced under `data_key[round]`, mirroring
 *    the role plugin's `rounds[round]` approach so successive rounds never clobber each other).
 */

/** One object in the shared set. Exactly one of `src` (image URL) / `html` (inline SVG/HTML/emoji) is used; `label` is a text fallback/caption. */
export interface StimulusSpec {
  id: string;
  src?: string;
  html?: string;
  label?: string;
}

/** The matcher's answer: 1-based slot number -> objectId. With k = 1 there is a single slot, 1. */
export type SlotAssignment = Record<number, string>;

/** How the director's and matcher's layouts relate. */
export type ScrambleMode = "independent" | "shared" | "matcher_only";

/** `per_slot` counts correct slots; `all_or_nothing` scores k or 0; a function computes n_correct itself. */
export type ScoringSpec =
  | "per_slot"
  | "all_or_nothing"
  | ((assignment: SlotAssignment, targets: string[]) => number);

export interface ScoreResult {
  nCorrect: number;
  nTargets: number;
  /** nCorrect / nTargets (0 when there are no targets). */
  accuracy: number;
  /** True iff every target slot is right (independent of the scoring preset's nCorrect). */
  correct: boolean;
}

/** One pre-submit matcher action, recorded only when `save_interaction_history` is on. */
export interface InteractionEvent {
  /** Milliseconds since trial start. */
  t: number;
  action: "assign" | "reassign" | "clear";
  /** 1-based slot the action applied to. */
  slot: number;
  /** The object assigned, or null for a clear. */
  object_id: string | null;
}

/** The matcher's submitted answer as read back out of the group session. */
export interface Submission {
  assignment: SlotAssignment;
  rt?: number;
  timed_out?: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Deterministic scramble
// ---------------------------------------------------------------------------------------------------

/** Deterministic string hash (cyrb53-style mix) so the scramble is identical on every client. */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32). Same seed -> same sequence on every client. */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded Fisher–Yates shuffle. Pure: returns a NEW array, same seed -> same order, every time. */
export function scramble(ids: string[], seed: string): string[] {
  const rnd = mulberry32(hashSeed(seed));
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Structural equality for two string arrays. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The two independent layouts for a director/matcher pair, GUARANTEED different whenever there is
 * more than one object.
 *
 * Both clients call this with the same `ids` and the same pair of participant ids (in either order)
 * and get identical, consistent results — so each side can compute its own layout AND its partner's
 * (which is how `partner_order` lands in the data without an extra push). The canonically-lower id
 * keeps its plain scramble; the higher id's layout is re-salted deterministically until it differs.
 * This makes the "you can't point by position" property hold even for a small object set, where two
 * independent scrambles could otherwise coincide (for N=2 they collide 50% of the time).
 */
export function independentOrders(
  ids: string[],
  round: number,
  idA: string,
  idB: string,
  seed?: string | null
): Record<string, string[]> {
  const base = seed ?? "";
  const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
  const loOrder = scramble(ids, `${base}#${round}#${lo}`);
  let hiOrder = scramble(ids, `${base}#${round}#${hi}`);
  // Terminates for ids.length > 1: there are >= 2 distinct permutations, and re-salting resamples
  // them, so a different one is reached in a handful of iterations.
  let salt = 1;
  while (ids.length > 1 && arraysEqual(loOrder, hiOrder)) {
    hiOrder = scramble(ids, `${base}#${round}#${hi}#${salt++}`);
  }
  return { [lo]: loOrder, [hi]: hiOrder };
}

/**
 * This participant's display order for the round.
 *
 * The seed always mixes in the round (layouts re-scramble every round) and — in the per-participant
 * modes — the participantId, so the director and matcher get different-but-stable layouts (the
 * classic "you can't point by position" design). An explicit `seed` is a base mixed into the
 * derivation, not a replacement — otherwise a fixed seed would silently collapse "independent" into
 * "shared".
 *
 *  - `"independent"`: with a known `partnerId`, uses `independentOrders` so the two layouts are
 *    GUARANTEED to differ (N>1). Without one (partner not yet present) it falls back to a plain
 *    per-participant scramble.
 *  - `"shared"`:      seeded by (seed, round) only — identical on both clients.
 *  - `"matcher_only"`: the matcher scrambles as in independent; the director sees the canonical
 *    `stimuli` order.
 */
export function displayOrder(
  ids: string[],
  role: string,
  mode: ScrambleMode,
  round: number,
  participantId: string,
  seed?: string | null,
  partnerId?: string | null
): string[] {
  const base = seed ?? "";
  switch (mode) {
    case "shared":
      return scramble(ids, `${base}#${round}#shared`);
    case "matcher_only":
      return role === "matcher" ? scramble(ids, `${base}#${round}#${participantId}`) : [...ids];
    case "independent":
    default:
      if (partnerId != null && partnerId !== participantId) {
        return independentOrders(ids, round, participantId, partnerId, seed)[participantId];
      }
      return scramble(ids, `${base}#${round}#${participantId}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Slot-assignment model
// ---------------------------------------------------------------------------------------------------

/**
 * Assign `objectId` to `slot` (or clear the slot with `objectId: null`), returning the NEW
 * assignment plus the interaction events the change produced (for `save_interaction_history`).
 *
 * An object can occupy only one slot: assigning an object that already sits in another slot MOVES
 * it (the old slot is cleared, recorded as a "clear" event). This makes duplicate assignments
 * impossible by construction, which the unordered scorer relies on.
 */
export function assignObject(
  prev: SlotAssignment,
  slot: number,
  objectId: string | null,
  t: number
): { next: SlotAssignment; events: InteractionEvent[] } {
  const next: SlotAssignment = { ...prev };
  const events: InteractionEvent[] = [];

  if (objectId === null) {
    if (prev[slot] != null) {
      delete next[slot];
      events.push({ t, action: "clear", slot, object_id: null });
    }
    return { next, events };
  }

  // Moving an object out of its old slot clears that slot first.
  for (const [s, id] of Object.entries(prev)) {
    const slotNum = Number(s);
    if (id === objectId && slotNum !== slot) {
      delete next[slotNum];
      events.push({ t, action: "clear", slot: slotNum, object_id: null });
    }
  }

  events.push({ t, action: prev[slot] == null ? "assign" : "reassign", slot, object_id: objectId });
  next[slot] = objectId;
  return { next, events };
}

/** True once every slot 1..k holds an object. */
export function isComplete(assignment: SlotAssignment, k: number): boolean {
  for (let s = 1; s <= k; s++) {
    if (typeof assignment[s] !== "string") return false;
  }
  return true;
}

/**
 * The next empty slot to make active, scanning forward from `from` and wrapping. Returns null when
 * every slot is filled (keep the current slot active so the matcher can still revise).
 */
export function nextUnfilledSlot(assignment: SlotAssignment, k: number, from = 0): number | null {
  for (let step = 1; step <= k; step++) {
    const s = ((from - 1 + step) % k) + 1;
    if (typeof assignment[s] !== "string") return s;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------------

/**
 * Score the matcher's assignment against the ordered target list.
 *
 * `ordered: true` compares slot-by-slot (slot i must hold targets[i-1]); `ordered: false` compares
 * as sets (any target in any slot counts once — duplicates can't occur, see `assignObject`).
 * `correct` always means "every slot right" under the chosen comparison, independent of what the
 * scoring preset reports as nCorrect (so `all_or_nothing` still yields `correct: false, nCorrect: 0`
 * on a near miss). A custom scoring function's return is coerced/clamped into `[0, k]`.
 */
export function scoreAssignment(
  assignment: SlotAssignment,
  targets: string[],
  opts: { ordered?: boolean; scoring?: ScoringSpec } = {}
): ScoreResult {
  const k = targets.length;
  const ordered = opts.ordered ?? k > 1;
  const scoring = opts.scoring ?? "per_slot";

  const baseCorrect = countCorrect(assignment, targets, ordered);

  let nCorrect: number;
  if (typeof scoring === "function") {
    const raw = Number(scoring(assignment, targets));
    nCorrect = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), k) : 0;
  } else if (scoring === "all_or_nothing") {
    nCorrect = baseCorrect === k ? k : 0;
  } else {
    nCorrect = baseCorrect;
  }

  return {
    nCorrect,
    nTargets: k,
    accuracy: k > 0 ? nCorrect / k : 0,
    correct: k > 0 && baseCorrect === k,
  };
}

function countCorrect(assignment: SlotAssignment, targets: string[], ordered: boolean): number {
  if (ordered) {
    let n = 0;
    targets.forEach((target, i) => {
      if (assignment[i + 1] === target) n++;
    });
    return n;
  }
  const targetSet = new Set(targets);
  const assigned = new Set(Object.values(assignment)); // dedupe defensively
  let n = 0;
  for (const id of assigned) {
    if (targetSet.has(id)) n++;
  }
  return Math.min(n, targets.length);
}

// ---------------------------------------------------------------------------------------------------
// Per-round group-session data helpers
// ---------------------------------------------------------------------------------------------------

/** Read one participant's round-scoped data out of their slot, tolerating anything malformed. */
export function readRoundData(
  slot: Record<string, unknown> | undefined,
  dataKey: string,
  round: number
): Record<string, unknown> | undefined {
  const rounds = slot?.[dataKey];
  if (typeof rounds !== "object" || rounds === null || Array.isArray(rounds)) return undefined;
  const data = (rounds as Record<string, unknown>)[String(round)];
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

/**
 * Merge round-scoped data into this participant's slot, returning the NEW slot object to push.
 *
 * `push` REPLACES the whole slot, so `prev` is spread first: every top-level key pushed by earlier
 * trials (`joinedAt` from the lobby/role trial, chat arrays, earlier data) survives, and per-round
 * data is namespaced under `dataKey[round]` so a later round never clobbers an earlier one —
 * mirroring the role plugin's `rounds[round]` approach.
 */
export function mergeRoundData(
  prev: Record<string, unknown>,
  dataKey: string,
  round: number,
  data: Record<string, unknown>
): Record<string, unknown> {
  const rounds = prev[dataKey];
  const existing =
    typeof rounds === "object" && rounds !== null && !Array.isArray(rounds)
      ? (rounds as Record<string, unknown>)
      : {};
  return { ...prev, [dataKey]: { ...existing, [round]: data } };
}

/**
 * Read the matcher's SUBMITTED assignment for this round out of the group snapshot. Returns
 * undefined until a well-formed assignment is present — this is the shared trigger both clients'
 * subscriptions watch for.
 */
export function readSubmission(
  group: Record<string, Record<string, unknown>>,
  participantId: string,
  dataKey: string,
  round: number
): Submission | undefined {
  const roundData = readRoundData(group[participantId], dataKey, round);
  const raw = roundData?.assignment;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const assignment: SlotAssignment = {};
  for (const [key, value] of Object.entries(raw)) {
    const slotNum = Number(key);
    if (Number.isInteger(slotNum) && slotNum >= 1 && typeof value === "string") {
      assignment[slotNum] = value;
    }
  }
  return {
    assignment,
    rt: typeof roundData!.rt === "number" ? (roundData!.rt as number) : undefined,
    timed_out: roundData!.timed_out === true,
  };
}

/** Cumulative n_correct across every round stored under `dataKey` in a (matcher's) slot. */
export function runningScore(slot: Record<string, unknown> | undefined, dataKey: string): number {
  const rounds = slot?.[dataKey];
  if (typeof rounds !== "object" || rounds === null || Array.isArray(rounds)) return 0;
  let total = 0;
  for (const value of Object.values(rounds as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null) {
      const n = (value as Record<string, unknown>).n_correct;
      if (typeof n === "number" && Number.isFinite(n)) total += n;
    }
  }
  return total;
}
