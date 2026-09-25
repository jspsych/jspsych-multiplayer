/**
 * The injectable seam over the Firebase SDK. The adapter owns ALL protocol logic — path building,
 * JSON encoding of slot payloads, id resolution/validation, the in-memory mirror, and the reconnect
 * dance — so this interface is the absolute minimum Firebase surface, expressed in terms of plain
 * string paths and string values. That keeps the test fake faithful: it stores exactly the strings
 * the real SDK stores, so a unit test can never pass on a shape the real RTDB would mangle.
 *
 * Each session node holds one child per participant, and each child's value is a JSON-encoded STRING
 * (never a raw object tree) — see the adapter's JSON-encoding policy. So a session `onValue` snapshot
 * is `Record<participantId, string>`. The presence node has the same shape, with a placeholder
 * string per connected participant.
 */

/** Calling this removes the associated subscription. */
export type Unsubscribe = () => void;

/** A session snapshot as RTDB hands it back: participantId -> that slot's raw JSON string. */
export type RawSessionSnapshot = Record<string, string>;

/** A value a transaction reads or writes: a string, an object of strings, or null for none. */
export type TransactionValue = string | Record<string, string> | null;

export interface FirebaseBackend {
  /** True when this backend created the Firebase app/database itself (vs. a caller-injected one).
   *  Gates `goOffline()` (app-global) and per-tab auth persistence — neither is touched when injected. */
  readonly ownsApp: boolean;

  /** Sign in anonymously; resolve the resulting uid. */
  signIn(): Promise<string>;

  /** REPLACE the value at `path` with the given string (a JSON-encoded slot payload, or the raw
   *  sessionId for a membership record — the rules compare that one unquoted). */
  set(path: string, value: string): Promise<void>;

  /** Remove the value at `path`. */
  remove(path: string): Promise<void>;

  /** Read the string at `path` once, or null if there is none. */
  get(path: string): Promise<string | null>;

  /**
   * Run an RTDB transaction on `path`, whose value is a string or an object of strings (null when
   * empty). `update` may run more than once, starting with a guess such as null, and must return
   * the new value, null to delete, or undefined to abort. Resolves with whether the transaction
   * committed and the value it saw last.
   */
  transaction(
    path: string,
    update: (current: TransactionValue) => TransactionValue | undefined,
  ): Promise<{ committed: boolean; value: TransactionValue }>;

  /**
   * Listen to a session or presence node. `onData` fires with the current snapshot (or `null` when the node is
   * empty/removed) on every change, including the initial value and the local echo of our own writes.
   * `onError` fires on the listener's cancel path (e.g. a security-rules denial). Returns an
   * unsubscribe.
   */
  onValue(
    path: string,
    onData: (snapshot: RawSessionSnapshot | null) => void,
    onError: (error: Error) => void,
  ): Unsubscribe;

  /** Arm a server-side `remove(path)` to fire if this client's connection drops. Resolves once the
   *  registration is acknowledged (one-shot — must be re-armed after it fires or after a reconnect). */
  onDisconnectRemove(path: string): Promise<void>;

  /** Cancel any armed onDisconnect for `path` (used on a clean disconnect). */
  cancelOnDisconnect(path: string): Promise<void>;

  /** Subscribe to `.info/connected`. `cb` fires with the current connection state and on every
   *  transition. Returns an unsubscribe. */
  onConnectedChange(cb: (connected: boolean) => void): Unsubscribe;

  /** Close this Database instance's connection. App-global — only call when `ownsApp`. */
  goOffline(): void;
}
