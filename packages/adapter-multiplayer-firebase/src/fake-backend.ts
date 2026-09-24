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

import { FirebaseBackend, RawSessionSnapshot, Unsubscribe } from "./firebase-backend";

interface SessionListener {
  path: string;
  onData: (snapshot: RawSessionSnapshot | null) => void;
  onError: (error: Error) => void;
}

/** The shared "server": a flat path->string store plus the session listeners watching it. */
export class FakeRtdb {
  private readonly data = new Map<string, string>();
  private readonly listeners = new Set<SessionListener>();

  set(path: string, value: string): void {
    this.data.set(path, value);
    this.fire(path);
  }

  remove(path: string): void {
    this.data.delete(path);
    this.fire(path);
  }

  /** The raw string stored at `path`, if any. */
  get(path: string): string | undefined {
    return this.data.get(path);
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

  /** Immediate children of a session node: `{ childKey: value }`, or null if none. */
  snapshotOf(sessionPath: string): RawSessionSnapshot | null {
    const prefix = `${sessionPath}/`;
    const out: RawSessionSnapshot = {};
    let any = false;
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        const child = key.slice(prefix.length);
        // Only immediate children (no deeper nesting in our slot model).
        if (!child.includes("/")) {
          out[child] = value;
          any = true;
        }
      }
    }
    return any ? out : null;
  }

  register(listener: SessionListener, deliverInitial = true): Unsubscribe {
    this.listeners.add(listener);
    // Real RTDB delivers an initial value event on registration; deliver it synchronously here so
    // the adapter's await-first-snapshot resolves deterministically in tests. `deliverInitial: false`
    // models a registered-but-slow listener (see FakeBackend `deferInitialSnapshot`).
    if (deliverInitial) listener.onData(this.snapshotOf(listener.path));
    return () => this.listeners.delete(listener);
  }

  /** Number of live session listeners — for asserting a listener was torn down. */
  listenerCount(): number {
    return this.listeners.size;
  }

  private fire(changedPath: string): void {
    for (const listener of this.listeners) {
      if (changedPath === listener.path || changedPath.startsWith(`${listener.path}/`)) {
        listener.onData(this.snapshotOf(listener.path));
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
  /** onValue registers but never delivers a snapshot (simulates a silent hang → connect timeout). */
  neverSnapshot?: boolean;
  /**
   * onValue registers a LIVE session listener but withholds the initial snapshot (simulates a
   * connected-but-slow backend → connect timeout). Unlike `neverSnapshot`, the listener is real, so a
   * later rtdb change would fire it — which is exactly what lets a test catch a listener the adapter
   * failed to tear down on the timeout reject.
   */
  deferInitialSnapshot?: boolean;
  /**
   * `set()` rejects with PERMISSION_DENIED for any path matching this predicate (simulates a
   * security-rules write denial, e.g. a membership record already bound to another session).
   */
  denyWrite?: (path: string) => boolean;
}

export class FakeBackend implements FirebaseBackend {
  readonly rtdb: FakeRtdb;
  readonly ownsApp: boolean;
  private readonly uid: string;
  private readonly denyReads: boolean;
  private readonly neverSnapshot: boolean;
  private readonly deferInitialSnapshot: boolean;
  private readonly denyWrite: ((path: string) => boolean) | null;

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

  onValue(
    path: string,
    onData: (snapshot: RawSessionSnapshot | null) => void,
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
   * Simulate losing the network: the server fires our armed onDisconnect (removing our presence
   * node, one-shot) and the client goes offline. `setConnected(true)` brings it back.
   */
  simulateDrop(): void {
    for (const path of this.armed) this.rtdb.remove(path);
    this.armed.clear();
    this.setConnected(false);
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
