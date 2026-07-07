/**
 * Pure, framework-free core for the chat plugin: the message data model and the merge/append logic.
 *
 * None of this touches jsPsych, the DOM, or the multiplayer API — it is plain data in, plain data
 * out, so it can be unit-tested in isolation (mirroring `assignRoles` in `plugin-multiplayer-role`).
 * The thin `index.ts` trial wires these functions to `subscribe`/`push` and the DOM.
 *
 * ## Data model
 * The multiplayer API's `push` REPLACES a participant's whole slot (it does not merge — verified
 * against the JATOS adapter's `groupSession.set(participantId, data)`). A participant therefore owns
 * exactly one slot, so chat history is modeled as an **append-only array each participant keeps
 * under a namespaced key** (default `chat_messages`). The rendered transcript is the merge of every
 * participant's array, sorted and de-duplicated.
 */

/** A single chat message. `id` is stable (`senderId#seq`) so renders are idempotent across replays. */
export interface ChatMessage {
  /** `${senderId}#${seq}` — stable identity for de-duplication and idempotent rendering. */
  id: string;
  /** participantId of the sender. */
  senderId: string;
  /** Per-sender monotonic counter (0, 1, 2, …). Tie-breaks ordering within a single sender. */
  seq: number;
  /** The message body, exactly as typed. Rendering MUST escape this (it is untrusted input). */
  text: string;
  /** `Date.now()` on the SENDER's clock. Clocks are not synchronized across clients — see ordering. */
  ts: number;
}

/** A group-session snapshot: participantId -> that participant's pushed data. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** Build the stable message id for a given sender + sequence number. */
export function makeMessageId(senderId: string, seq: number): string {
  return `${senderId}#${seq}`;
}

/**
 * Read one participant's message array out of their slot, tolerating a missing slot, a missing key,
 * or malformed entries. Only well-formed `ChatMessage` objects are returned.
 */
function readMessages(slot: Record<string, unknown> | undefined, dataKey: string): ChatMessage[] {
  const raw = slot?.[dataKey];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isChatMessage);
}

function isChatMessage(m: unknown): m is ChatMessage {
  if (typeof m !== "object" || m === null) return false;
  const msg = m as Record<string, unknown>;
  return (
    typeof msg.senderId === "string" &&
    typeof msg.seq === "number" &&
    typeof msg.text === "string" &&
    typeof msg.ts === "number"
  );
}

/**
 * Flatten every participant's message array from the group snapshot into a single ordered,
 * de-duplicated transcript.
 *
 * Ordering is `(ts, senderId, seq)`: primarily by send time, then a deterministic tie-break. Because
 * `ts` comes from each sender's own unsynchronized clock, strict global order across senders is not
 * guaranteed (documented limitation); the tie-break guarantees a single sender's own messages never
 * reorder among themselves and that the sort is stable across clients.
 *
 * De-duplication is by `id`, keeping the first occurrence — so a `subscribe` replay that re-delivers
 * already-seen messages produces an identical transcript (idempotent render).
 */
export function mergeMessages(group: GroupSessionData, dataKey: string): ChatMessage[] {
  const all: ChatMessage[] = [];
  for (const participantId of Object.keys(group)) {
    for (const m of readMessages(group[participantId], dataKey)) {
      // Trust the sender's own id, but normalize `id` from senderId+seq so dedup is reliable even
      // if a client omitted or tampered with it.
      all.push({ ...m, id: makeMessageId(m.senderId, m.seq) });
    }
  }

  all.sort((a, b) => a.ts - b.ts || compareStrings(a.senderId, b.senderId) || a.seq - b.seq);

  const seen = new Set<string>();
  const deduped: ChatMessage[] = [];
  for (const m of all) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    deduped.push(m);
  }
  return deduped;
}

/**
 * Append a new message to this participant's own array, returning a NEW array (the input is not
 * mutated). The caller assigns `seq` from its own monotonic counter and pushes the result back into
 * its slot.
 */
export function appendOwnMessage(
  own: ChatMessage[],
  text: string,
  senderId: string,
  seq: number,
  now: number
): ChatMessage[] {
  return [...own, { id: makeMessageId(senderId, seq), senderId, seq, text, ts: now }];
}

/** Code-unit string comparison — locale-independent so ordering never diverges across clients. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
