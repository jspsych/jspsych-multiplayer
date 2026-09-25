/**
 * Pure storage helpers for the local adapter, isolated from the DOM/BroadcastChannel wiring so they
 * can be unit-tested against a plain in-memory `Storage` double.
 *
 * The store is **one key per participant** — `mp:<sessionId>:<participantId>` — never a single shared
 * blob. `localStorage` has no transactions, so a shared blob has a read-modify-write race: two tabs
 * read it, each mutates its own slice, and the second write clobbers the first (with no version to
 * detect the conflict). Per-participant keys sidestep that entirely — a tab only ever writes its own
 * key — and reproduce the JATOS adapter's REPLACE-the-whole-slot semantics exactly, so plugins can't
 * behave differently between the two adapters.
 */

/** The minimal slice of the Web Storage API this module needs (a subset of `Storage`). */
export interface SlotStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Prefix shared by every key belonging to one session: `mp:<sessionId>:`. */
export function slotPrefix(namespace: string, sessionId: string): string {
  return `${namespace}:${sessionId}:`;
}

/** Full storage key for one participant's slot. */
export function slotKey(namespace: string, sessionId: string, participantId: string): string {
  return slotPrefix(namespace, sessionId) + participantId;
}

/**
 * The participantId encoded in a storage key, or `null` if the key doesn't belong to this session.
 * The adapter rejects session and participant IDs that contain the prefix's `:` boundary, so a
 * single `startsWith` + slice is unambiguous.
 */
export function participantIdFromKey(
  namespace: string,
  sessionId: string,
  key: string,
): string | null {
  const prefix = slotPrefix(namespace, sessionId);
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** Read and JSON-parse one participant's slot; `undefined` if absent or unparseable. */
export function readSlot(
  storage: SlotStorage,
  namespace: string,
  sessionId: string,
  participantId: string,
): Record<string, unknown> | undefined {
  const raw = storage.getItem(slotKey(namespace, sessionId, participantId));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A slot corrupted by hand-editing shouldn't crash the whole snapshot read.
    return undefined;
  }
}

/**
 * Enumerate every slot in this session into a `participantId -> payload` snapshot. Each payload
 * is returned exactly as it was written.
 */
export function readAllSlots(
  storage: SlotStorage,
  namespace: string,
  sessionId: string,
): Record<string, unknown> {
  const all: Record<string, unknown> = {};
  // Snapshot the keys first: reading is side-effect-free, but iterating by live index while the
  // store could change underneath is fragile, and the key set is tiny (one per participant).
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) {
    const id = participantIdFromKey(namespace, sessionId, key);
    if (id === null) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      all[id] = JSON.parse(raw) as unknown;
    } catch {
      // Skip a corrupted slot rather than failing the whole enumeration.
    }
  }
  return all;
}

/** Write (REPLACE) one participant's slot. */
export function writeSlot(
  storage: SlotStorage,
  namespace: string,
  sessionId: string,
  participantId: string,
  data: Record<string, unknown>,
): void {
  storage.setItem(slotKey(namespace, sessionId, participantId), JSON.stringify(data));
}

/** Remove one participant's slot. */
export function removeSlot(
  storage: SlotStorage,
  namespace: string,
  sessionId: string,
  participantId: string,
): void {
  storage.removeItem(slotKey(namespace, sessionId, participantId));
}

/**
 * Prefix of every presence key in one session: `mp-presence:<sessionId>:`. It deliberately sits
 * outside the slot prefix (`mp:<sessionId>:`), because readAllSlots treats every key under that
 * prefix as a participant's slot.
 */
export function presencePrefix(namespace: string, sessionId: string): string {
  return `${namespace}-presence:${sessionId}:`;
}

/** Record that a participant's tab is alive right now. */
export function writePresence(
  storage: SlotStorage,
  namespace: string,
  sessionId: string,
  participantId: string,
  now: number,
): void {
  storage.setItem(presencePrefix(namespace, sessionId) + participantId, String(now));
}

/** Remove a participant's presence key, as their tab closes. */
export function removePresence(
  storage: SlotStorage,
  namespace: string,
  sessionId: string,
  participantId: string,
): void {
  storage.removeItem(presencePrefix(namespace, sessionId) + participantId);
}

/**
 * The participants whose presence key was refreshed within `timeoutMs` of `now`, sorted so callers
 * can compare two results as strings.
 */
export function readPresent(
  storage: SlotStorage,
  namespace: string,
  sessionId: string,
  now: number,
  timeoutMs: number,
): string[] {
  const prefix = presencePrefix(namespace, sessionId);
  const present: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    const beat = Number(storage.getItem(key));
    if (Number.isFinite(beat) && now - beat <= timeoutMs) {
      present.push(key.slice(prefix.length));
    }
  }
  return present.sort();
}
