import type { FirebaseOptions } from "firebase/app";
import type { Database } from "firebase/database";

import { FirebaseBackend, RawSessionSnapshot, Unsubscribe } from "./firebase-backend";
import { GroupSessionData, MultiplayerAdapter } from "./multiplayer-adapter";
import { createRealBackend } from "./real-backend";

const SESSION_PARAM = "mp_session";
const DEFAULT_PATH_PREFIX = "mp-sessions";
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

/**
 * Characters that must not appear in an id/session/prefix. RTDB forbids `. # $ [ ] /` in keys; we
 * ALSO forbid `:` — not for Firebase, but for cross-adapter portability, since the local adapter uses
 * `:` as its key-namespace separator and an id minted/accepted here may be replayed against it in a
 * demo swap. Validating against the union keeps ids portable both ways.
 */
const FORBIDDEN_KEY_CHARS = /[.#$[\]/:]/;

export interface FirebaseAdapterOptions {
  /** A Firebase app config object (the adapter initializes + owns a dedicated app). */
  firebaseConfig?: FirebaseOptions;
  /** An already-initialized RTDB `Database` instance (the caller owns the app + auth). */
  database?: Database;

  /**
   * Session namespace. All participant slots live under `<pathPrefix>/<sessionId>`. Defaults to the
   * `?mp_session=` URL parameter, or a fresh random id reflected back into the URL so the link can be
   * shared with the other players.
   */
  sessionId?: string;
  /** This participant's id. Defaults to a fresh locally-minted id (NOT the auth uid — see
   *  `useUidAsParticipantId`). Rejected if combined with `useUidAsParticipantId`. */
  participantId?: string;
  /**
   * Adopt the anonymous-auth uid as this participant's id during `connect()` (uid-as-key mode), which
   * enables the strict uid-as-slot-key security rules. The id is a fresh placeholder until `connect()`
   * resolves, then becomes the uid — never read/cache `participantId` before connecting in this mode.
   * Incompatible with a supplied `participantId` (constructing with both throws). Default `false`.
   */
  useUidAsParticipantId?: boolean;

  /** RTDB path namespace. Defaults to `"mp-sessions"`. */
  pathPrefix?: string;
  /** Whether to server-remove our slot on disconnect via `onDisconnect().remove()`. Default `true`. */
  removeOnDisconnect?: boolean;
  /** Timeout (ms) for the await-first-snapshot step of `connect()`. Default `20000`. */
  connectTimeoutMs?: number;

  /** Inject a `FirebaseBackend` (for tests). Defaults to the real `firebase/*` implementation. */
  backend?: FirebaseBackend;
}

/**
 * A Firebase Realtime Database multiplayer adapter: real cross-device multiplayer with essentially no
 * backend to write or host. Sits between `adapter-multiplayer-local` (same-browser dev/demo) and
 * `adapter-multiplayer-jatos` (self-hosted research server).
 *
 *   const jsPsych = initJsPsych();
 *   await jsPsych.pluginAPI.connect(new FirebaseAdapter({ firebaseConfig }));
 *   await jsPsych.run(timeline);
 *
 * The contract's `getAll()`/`get()` are synchronous but every Firebase read is async, so the adapter
 * keeps an in-memory MIRROR of the session node, kept live by a single `onValue` listener, and answers
 * reads from it. `connect()` does not resolve until the first snapshot lands. Each participant's slot
 * is stored JSON-encoded as a string, so pushed payloads round-trip exactly over RTDB's JSON coercion.
 *
 * @author Hannah Tsukamoto
 */
export default class FirebaseAdapter implements MultiplayerAdapter {
  /** Contract-`readonly`. In uid-as-key mode it is reassigned ONCE, during connect(), before the
   *  connect() promise resolves — never mutated while anything can observe it. */
  participantId: string;

  private readonly sessionId: string;
  private readonly pathPrefix: string;
  private readonly removeOnDisconnect: boolean;
  private readonly connectTimeoutMs: number;
  private readonly useUid: boolean;
  private readonly backendFactory: () => Promise<FirebaseBackend>;

  private backend: FirebaseBackend | null = null;
  private connected = false;
  private readonly mirror: GroupSessionData = {};
  /** Last payload we pushed, re-sent after a reconnect so a transient blip can't erase us. */
  private lastOwnData: Record<string, unknown> | null = null;
  /** Whether we've seen `.info/connected` go true at least once (so the FIRST true isn't a "reconnect"). */
  private hadFirstConnection = false;

  private unsubscribeSession: Unsubscribe | null = null;
  private unsubscribeConnected: Unsubscribe | null = null;

  private readonly subscribers = new Set<(data: GroupSessionData) => void>();
  private notifyScheduled = false;

  constructor(options: FirebaseAdapterOptions = {}) {
    if (options.useUidAsParticipantId && options.participantId !== undefined) {
      throw new Error(
        "FirebaseAdapter: `useUidAsParticipantId` is incompatible with a supplied `participantId` " +
          "— the uid becomes the id in that mode. Pass one or the other, not both."
      );
    }

    this.useUid = options.useUidAsParticipantId ?? false;
    this.pathPrefix = options.pathPrefix ?? DEFAULT_PATH_PREFIX;
    this.sessionId = options.sessionId ?? resolveSessionId();
    // In uid mode this placeholder is replaced with the real uid during connect().
    this.participantId = options.participantId ?? generateId();
    this.removeOnDisconnect = options.removeOnDisconnect ?? true;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    validateKey("pathPrefix", this.pathPrefix);
    validateKey("sessionId", this.sessionId);
    // A locally-minted or user-supplied id is validated now; a uid adopted in connect() is validated there.
    if (!this.useUid) validateKey("participantId", this.participantId);

    const injected = options.backend;
    if (injected) {
      this.backendFactory = () => Promise.resolve(injected);
    } else {
      // Build the real backend on connect() (not construction) so a reconnect after disconnect()
      // gets a fresh app — goOffline() tears the old one down. Unit tests inject a fake and never
      // reach this path, so the firebase SDK is never loaded under test.
      this.backendFactory = () =>
        createRealBackend({
          firebaseConfig: options.firebaseConfig,
          database: options.database,
        });
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const backend = await this.backendFactory();
    this.backend = backend;

    const uid = await backend.signIn();
    if (this.useUid) {
      this.participantId = uid;
      validateKey("participantId (auth uid)", this.participantId);
    }

    // Register the session listener and wait for the first snapshot before resolving, so a plugin
    // never reads an empty mirror. Both failure paths (rules denial via the cancel callback, and a
    // silent hang) must settle the promise or the whole experiment stalls.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      // On any failure, tear the session listener down before rejecting: connect() rejected means
      // the caller treats this adapter as unconnected, so a still-live listener would keep mutating
      // the mirror (and firing fan-outs) behind their back. A synchronously-cancelled listener (a
      // rules denial in the real SDK) is already dead, so the unsubscribe is a harmless no-op there.
      const fail = (error: Error) =>
        finish(() => {
          this.unsubscribeSession?.();
          this.unsubscribeSession = null;
          reject(error);
        });

      const timer = setTimeout(() => {
        fail(
          new Error(
            `FirebaseAdapter: connect() timed out after ${this.connectTimeoutMs}ms waiting for the ` +
              "first session snapshot. Check the database URL, network, and that your security " +
              "rules grant read access to this session (see the README rules recipe)."
          )
        );
      }, this.connectTimeoutMs);

      this.unsubscribeSession = backend.onValue(
        this.sessionPath(),
        (snapshot) => {
          this.applySnapshot(snapshot);
          finish(resolve);
          // After the first snapshot, subsequent updates just refresh the mirror + fan out.
          this.scheduleNotify();
        },
        (error) => {
          fail(
            new Error(
              "FirebaseAdapter: the session listener was cancelled — this is almost always a " +
                "security-rules denial. Grant read access to this session (see the README rules " +
                `recipe). Underlying error: ${error.message}`
            )
          );
        }
      );
    });

    this.connected = true;

    // Arm server-side ghost cleanup, then wire reconnect handling.
    if (this.removeOnDisconnect) {
      await backend.onDisconnectRemove(this.slotPath());
    }
    this.unsubscribeConnected = backend.onConnectedChange((isConnected) => {
      void this.handleConnectionChange(isConnected);
    });
  }

  async push(data: Record<string, unknown>): Promise<void> {
    if (!this.connected || !this.backend) {
      throw new Error("FirebaseAdapter: push() called before connect(); call connect() first.");
    }
    this.lastOwnData = data;
    // Store JSON-encoded so the payload survives RTDB's JSON coercion — raw, RTDB prunes empty
    // arrays/objects and coerces arrays to objects; the string round-trips those unchanged. (`undefined`
    // is still dropped, but JSON can't represent it either way.) The mirror updates from the echoed
    // onValue, not here (RTDB fires the local listener optimistically, so our own getAll() reflects
    // the write immediately after this resolves).
    await this.backend.set(this.slotPath(), JSON.stringify(data));
  }

  getAll(): GroupSessionData {
    const out: GroupSessionData = {};
    for (const [id, record] of Object.entries(this.mirror)) {
      out[id] = { ...record };
    }
    return out;
  }

  get(participantId: string): Record<string, unknown> | undefined {
    const record = this.mirror[participantId];
    return record ? { ...record } : undefined;
  }

  subscribe(callback: (data: GroupSessionData) => void): Unsubscribe {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.backend) return;
    const backend = this.backend;

    // Remove our slot first so peers re-read a snapshot without us; cancel the armed onDisconnect so
    // it can't fire later against a reused connection.
    try {
      await backend.remove(this.slotPath());
    } catch {
      // Best-effort: a failed removal shouldn't block teardown (the onDisconnect hook is the backstop).
    }
    if (this.removeOnDisconnect) {
      try {
        await backend.cancelOnDisconnect(this.slotPath());
      } catch {
        // Best-effort.
      }
    }

    this.unsubscribeSession?.();
    this.unsubscribeConnected?.();
    this.unsubscribeSession = null;
    this.unsubscribeConnected = null;

    // goOffline() is app-global — only safe when the backend owns the app (never on an injected one).
    if (backend.ownsApp) backend.goOffline();

    this.subscribers.clear();
    for (const id of Object.keys(this.mirror)) delete this.mirror[id];
    this.lastOwnData = null;
    this.hadFirstConnection = false;
    this.connected = false;
    this.backend = null;
  }

  /**
   * `.info/connected` handler. The first `true` is the initial connection (already handled by
   * connect()). Every LATER `true` is a reconnect after a blip: the server may have fired our armed
   * onDisconnect and deleted our slot, and RTDB won't re-send it — so we re-arm onDisconnect FIRST
   * (it's one-shot; re-pushing before re-arming leaves a window where another drop orphans the slot),
   * then re-push our last-known data.
   */
  private async handleConnectionChange(isConnected: boolean): Promise<void> {
    if (!isConnected) return;
    if (!this.hadFirstConnection) {
      this.hadFirstConnection = true;
      return;
    }
    if (!this.connected || !this.backend) return;
    try {
      if (this.removeOnDisconnect) {
        await this.backend.onDisconnectRemove(this.slotPath());
      }
      if (this.lastOwnData !== null) {
        await this.backend.set(this.slotPath(), JSON.stringify(this.lastOwnData));
      }
    } catch (err) {
      console.error("FirebaseAdapter: failed to restore own slot after reconnect", err);
    }
  }

  /** Replace the mirror wholesale from a session snapshot, decoding each slot's JSON string. */
  private applySnapshot(snapshot: RawSessionSnapshot | null): void {
    for (const id of Object.keys(this.mirror)) delete this.mirror[id];
    if (!snapshot) return;
    for (const [id, raw] of Object.entries(snapshot)) {
      if (typeof raw !== "string") continue; // defensive: our writes are always encoded strings
      try {
        this.mirror[id] = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Skip a slot that isn't valid JSON rather than failing the whole snapshot.
      }
    }
  }

  private sessionPath(): string {
    return `${this.pathPrefix}/${this.sessionId}`;
  }

  private slotPath(): string {
    return `${this.pathPrefix}/${this.sessionId}/${this.participantId}`;
  }

  /**
   * Fan a single coalesced update out to local subscribers on a microtask. Guarantees the callback
   * never runs synchronously inside a listener/push, so a subscriber that pushes again enqueues
   * another fan-out instead of recursing, and always sees a fully-applied mirror.
   */
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      const data = this.getAll();
      for (const cb of [...this.subscribers]) {
        try {
          cb(data);
        } catch (err) {
          console.error("FirebaseAdapter: a group-session subscriber threw", err);
        }
      }
    });
  }
}

/** Read `?mp_session=` from the URL; if absent, mint one and reflect it back so it can be shared. */
function resolveSessionId(): string {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    return generateId();
  }
  try {
    const url = new URL(window.location.href);
    const existing = url.searchParams.get(SESSION_PARAM);
    if (existing) return existing;
    const fresh = generateId();
    url.searchParams.set(SESSION_PARAM, fresh);
    window.history?.replaceState?.(window.history.state, "", url.toString());
    return fresh;
  } catch {
    return generateId();
  }
}

/** Reject an id/session/prefix that would break an RTDB key or cross-adapter portability. */
function validateKey(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`FirebaseAdapter: ${label} must not be empty.`);
  }
  const match = FORBIDDEN_KEY_CHARS.exec(value);
  if (match) {
    throw new Error(
      `FirebaseAdapter: ${label} must not contain "${match[0]}" (got "${value}"). RTDB keys forbid ` +
        '. # $ [ ] / and we also reserve ":" for cross-adapter id portability with the local adapter.'
    );
  }
}

/** A random, collision-free identifier (RFC 4122 UUID when available). Matches the local adapter. */
function generateId(): string {
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
