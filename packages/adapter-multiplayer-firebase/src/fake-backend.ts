/**
 * A faithful in-memory `FirebaseBackend` for unit tests — NOT shipped/used at runtime. It models the
 * RTDB behaviors the adapter depends on:
 *  - values are stored as the exact strings written (the adapter JSON-encodes), so a test can never
 *    pass on a shape the real SDK would coerce;
 *  - `set()` fires the local `onValue` echo SYNCHRONOUSLY, BEFORE its promise resolves — this is the
 *    real SDK's optimistic-local-fire ordering the post-push read invariant relies on;
 *  - a shared `FakeRtdb` lets multiple backends (i.e. multiple simulated participants) see each
 *    other's writes through one session listener.
 *
 * Test-only helpers (not part of the interface): `setConnected`, `simulateDrop`, `simulateBlip`, `FakeRtdb.get` /
 * `cancelListeners`, and the `denyReads` / `neverSnapshot` construction flags for the connect()
 * failure paths.
 */

import { DbNode, FirebaseBackend, TransactionValue, Unsubscribe } from "./firebase-backend";

interface NodeListener {
  path: string;
  onData: (value: TransactionValue) => void;
  onError: (error: Error) => void;
}

/** The shared "server": a flat path->string store of leaves plus the listeners watching it. */
export class FakeRtdb {
  private readonly data = new Map<string, string>();
  private readonly listeners = new Set<NodeListener>();

  set(path: string, value: string): void {
    this.replace(path, value);
  }

  remove(path: string): void {
    this.replace(path, null);
  }

  /** The raw string stored at `path`, if `path` is a leaf. */
  get(path: string): string | undefined {
    return this.data.get(path);
  }

  /** The value at `path`: its string, a tree of its descendants, or null. */
  valueAt(path: string): TransactionValue {
    const leaf = this.data.get(path);
    if (leaf !== undefined) return leaf;
    const prefix = `${path}/`;
    const out: DbNode = {};
    let any = false;
    for (const [key, value] of this.data) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split("/");
      let node = out;
      for (const part of parts.slice(0, -1)) {
        const child = node[part];
        node = typeof child === "object" ? child : (node[part] = {});
      }
      node[parts[parts.length - 1]] = value;
      any = true;
    }
    return any ? out : null;
  }

  /** Replace `path` and everything under it with `value`, then notify listeners once. */
  replace(path: string, value: TransactionValue): void {
    for (const key of [...this.data.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.data.delete(key);
    }
    this.write(path, value);
    this.fire(path);
  }

  /**
   * Cancel every live listener on `path` (or every listener, if omitted), as RTDB does when read
   * access is revoked: the listener's cancel callback fires and it never fires again.
   */
  cancelListeners(path?: string, error = new Error("permission_denied")): void {
    for (const listener of [...this.listeners]) {
      if (path === undefined || listener.path === path) {
        this.listeners.delete(listener);
        listener.onError(error);
      }
    }
  }

  register(listener: NodeListener, deliverInitial = true): Unsubscribe {
    this.listeners.add(listener);
    // Real RTDB delivers an initial value event on registration; deliver it synchronously here so
    // the adapter's await-first-snapshot resolves deterministically in tests. `deliverInitial: false`
    // models a registered-but-slow listener (see FakeBackend `deferInitialSnapshot`).
    if (deliverInitial) listener.onData(this.valueAt(listener.path));
    return () => this.listeners.delete(listener);
  }

  /** Number of live listeners — for asserting a listener was torn down. */
  listenerCount(): number {
    return this.listeners.size;
  }

  private write(path: string, value: TransactionValue): void {
    if (typeof value === "string") {
      this.data.set(path, value);
    } else if (value) {
      for (const [child, childValue] of Object.entries(value)) {
        this.write(`${path}/${child}`, childValue);
      }
    }
  }

  private fire(changedPath: string): void {
    for (const listener of [...this.listeners]) {
      const { path } = listener;
      if (
        changedPath === path ||
        changedPath.startsWith(`${path}/`) ||
        path.startsWith(`${changedPath}/`)
      ) {
        listener.onData(this.valueAt(path));
      }
    }
  }
}

export interface FakeBackendOptions {
  rtdb?: FakeRtdb;
  uid?: string;
  ownsApp?: boolean;
  /** onValue immediately invokes its error/cancel callback (simulates a rules denial). */
  denyReads?: boolean;
  /** onValue registers but never delivers a snapshot (simulates a silent hang). */
  neverSnapshot?: boolean;
  /**
   * onValue registers a LIVE listener but withholds the initial snapshot (simulates a
   * connected-but-slow backend). Unlike `neverSnapshot`, the listener is real, so a later rtdb
   * change would fire it — which is exactly what lets a test catch a listener the adapter failed
   * to tear down when connect() was cancelled.
   */
  deferInitialSnapshot?: boolean;
  /**
   * `set()` rejects with PERMISSION_DENIED for any path matching this predicate (simulates a
   * security-rules write denial, e.g. a membership record already bound to another session).
   */
  denyWrite?: (path: string) => boolean;
  /**
   * Transactions first run their update on null, as the real SDK does before it has the server's
   * value, and then on the stored value. The first result is discarded.
   */
  transactionsGuessNull?: boolean;
  /** Runs inside each transaction, after the update guessed and before it reads the stored value. */
  beforeTransactionRead?: (path: string) => void;
  /**
   * `onDisconnectRemove()` rejects for paths matching this predicate. RTDB checks the rules when
   * an onDisconnect is armed, so arming a write the rules forbid fails at once.
   */
  denyOnDisconnect?: (path: string) => boolean;
}

export class FakeBackend implements FirebaseBackend {
  readonly rtdb: FakeRtdb;
  readonly ownsApp: boolean;
  private readonly uid: string;
  private readonly denyReads: boolean;
  private readonly neverSnapshot: boolean;
  private readonly deferInitialSnapshot: boolean;
  private readonly denyWrite: ((path: string) => boolean) | null;
  private readonly transactionsGuessNull: boolean;
  private readonly beforeTransactionRead: ((path: string) => void) | null;
  private readonly denyOnDisconnect: ((path: string) => boolean) | null;
  transactionCalls: string[] = [];

  /** Paths with an armed onDisconnect().remove(), consumed when the "server" fires it. */
  private readonly armed = new Set<string>();
  private readonly connectedCbs = new Set<(connected: boolean) => void>();

  goOfflineCalls = 0;

  constructor(options: FakeBackendOptions = {}) {
    this.rtdb = options.rtdb ?? new FakeRtdb();
    this.uid = options.uid ?? "fake-uid";
    this.ownsApp = options.ownsApp ?? true;
    this.denyReads = options.denyReads ?? false;
    this.neverSnapshot = options.neverSnapshot ?? false;
    this.deferInitialSnapshot = options.deferInitialSnapshot ?? false;
    this.denyWrite = options.denyWrite ?? null;
    this.transactionsGuessNull = options.transactionsGuessNull ?? false;
    this.beforeTransactionRead = options.beforeTransactionRead ?? null;
    this.denyOnDisconnect = options.denyOnDisconnect ?? null;
  }

  signIn(): Promise<string> {
    return Promise.resolve(this.uid);
  }

  set(path: string, value: string): Promise<void> {
    if (this.denyWrite?.(path)) {
      return Promise.reject(
        new Error("PERMISSION_DENIED: Client doesn't have permission to access the desired data."),
      );
    }
    this.rtdb.set(path, value); // fires the echo synchronously, before we resolve
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.rtdb.remove(path);
    return Promise.resolve();
  }

  get(path: string): Promise<TransactionValue> {
    return Promise.resolve(this.rtdb.valueAt(path));
  }

  /** Atomic, as the server makes it: nothing else runs between the read and the write. */
  async transaction(
    path: string,
    update: (current: TransactionValue) => TransactionValue | undefined,
  ): Promise<{ committed: boolean; value: TransactionValue }> {
    this.transactionCalls.push(path);
    if (this.transactionsGuessNull) update(null);
    this.beforeTransactionRead?.(path);
    const current = this.rtdb.valueAt(path);
    const next = update(current);
    if (next === undefined) return { committed: false, value: current };
    if (this.denyWrite?.(path)) {
      throw new Error(
        "PERMISSION_DENIED: Client doesn't have permission to access the desired data.",
      );
    }
    this.rtdb.replace(path, next);
    return { committed: true, value: next };
  }

  onValue(
    path: string,
    onData: (value: TransactionValue) => void,
    onError: (error: Error) => void,
  ): Unsubscribe {
    if (this.denyReads) {
      onError(
        new Error("PERMISSION_DENIED: Client doesn't have permission to access the desired data."),
      );
      return () => {};
    }
    if (this.neverSnapshot) {
      return () => {};
    }
    return this.rtdb.register({ path, onData, onError }, !this.deferInitialSnapshot);
  }

  onDisconnectRemove(path: string): Promise<void> {
    if (this.denyOnDisconnect?.(path)) {
      return Promise.reject(new Error("PERMISSION_DENIED: Permission denied"));
    }
    this.armed.add(path);
    return Promise.resolve();
  }

  cancelOnDisconnect(path: string): Promise<void> {
    this.armed.delete(path);
    return Promise.resolve();
  }

  onConnectedChange(cb: (connected: boolean) => void): Unsubscribe {
    this.connectedCbs.add(cb);
    cb(true); // initial connection
    return () => this.connectedCbs.delete(cb);
  }

  goOffline(): void {
    this.goOfflineCalls++;
  }

  // ---- test-only helpers ----

  /** Toggle `.info/connected` and notify subscribers. */
  setConnected(connected: boolean): void {
    for (const cb of [...this.connectedCbs]) cb(connected);
  }

  /**
   * Simulate losing the network: the client goes offline, then the server notices and fires our
   * armed onDisconnects (one-shot). `setConnected(true)` brings the client back.
   */
  simulateDrop(): void {
    this.setConnected(false);
    const armed = [...this.armed];
    this.armed.clear();
    for (const path of armed) this.rtdb.remove(path);
  }

  /**
   * Simulate a transient network blip: a drop followed at once by a reconnect. The adapter's
   * reconnect handler should re-arm and re-write presence in response.
   */
  simulateBlip(): void {
    this.simulateDrop();
    this.setConnected(true);
  }

  /** Whether a path currently has an armed onDisconnect (for assertions). */
  isArmed(path: string): boolean {
    return this.armed.has(path);
  }
}
