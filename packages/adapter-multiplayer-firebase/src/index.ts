import type { FirebaseOptions } from "firebase/app";
import type { Database } from "firebase/database";
import type {
  AdapterConnectOptions,
  GroupSessionData,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";

import { FirebaseBackend, RawSessionSnapshot, Unsubscribe } from "./firebase-backend";
import { createRealBackend } from "./real-backend";

const SESSION_PARAM = "mp_session";
const DEFAULT_PATH_PREFIX = "mp-sessions";
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

/** The value written to a presence node. Only its existence matters. */
const PRESENT = "1";

/**
 * Characters that must not appear in an id/session/prefix. RTDB forbids `. # $ [ ] /` in keys; we
 * ALSO forbid `:` — not for Firebase, but for cross-adapter portability, since the local adapter uses
 * `:` as its key-namespace separator and an id minted/accepted here may be replayed against it in a
 * demo swap. Validating against the union keeps ids portable both ways.
 */
const FORBIDDEN_KEY_CHARS = /[.#$[\]/:]/;

export interface FirebaseAdapterOptions {
  /** A Firebase app config object (the adapter initializes + owns a dedicated app per connection). */
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
   * Use the anonymous-auth uid as this participant's id (uid-as-key mode), which enables the strict
   * uid-as-slot-key security rules. Incompatible with a supplied `participantId` (constructing with
   * both throws). Default `false`.
   */
  useUidAsParticipantId?: boolean;
  /**
   * Register a `<pathPrefix>-memberships/<uid> = sessionId` record during `connect()`, before the
   * session listener attaches. The recommended (session-locked) security rules make that record
   * FIRST-WRITE-WINS and require it to match on every session read/write, which is what enforces
   * "a client can only touch the session it first joined" — the enforcement lives in the
   * server-evaluated rules; this write is just the client's half of the handshake. Defaults to the
   * value of `useUidAsParticipantId` (the locked rules need uid-as-key). Set `false` when using the
   * quick-start rules, which have no memberships node.
   */
  sessionBinding?: boolean;

  /** RTDB path namespace. Defaults to `"mp-sessions"`. */
  pathPrefix?: string;
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
 *   await jsPsych.multiplayer.connect(new FirebaseAdapter({ firebaseConfig }));
 *   await jsPsych.run(timeline);
 *
 * The adapter holds configuration only. Each `connect()` opens a new connection with its own
 * Firebase app (or the injected database), listeners, and mirrors, so reconnecting with the same
 * adapter object never shares state with an earlier connection.
 *
 * @author Hannah Tsukamoto
 */
export default class FirebaseAdapter implements MultiplayerAdapter {
  private readonly config: ConnectionConfig;

  constructor(options: FirebaseAdapterOptions = {}) {
    if (options.useUidAsParticipantId && options.participantId !== undefined) {
      throw new Error(
        "FirebaseAdapter: `useUidAsParticipantId` is incompatible with a supplied `participantId` " +
          "— the uid becomes the id in that mode. Pass one or the other, not both.",
      );
    }

    const useUid = options.useUidAsParticipantId ?? false;
    const pathPrefix = options.pathPrefix ?? DEFAULT_PATH_PREFIX;
    const sessionId = options.sessionId ?? resolveSessionId();
    // Minted once, so every connection made with this adapter reuses the same id. In uid mode the
    // id comes from sign-in instead.
    const participantId = useUid ? null : (options.participantId ?? generateId());

    validateKey("pathPrefix", pathPrefix);
    validateKey("sessionId", sessionId);
    if (participantId !== null) validateKey("participantId", participantId);

    const injected = options.backend;
    this.config = {
      sessionId,
      pathPrefix,
      participantId,
      sessionBinding: options.sessionBinding ?? useUid,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      // Build the real backend per connection (not at construction) so each connection gets a fresh
      // app — goOffline() tears the old one down. Unit tests inject a fake and never reach this
      // path, so the firebase SDK is never loaded under test.
      backendFactory: injected
        ? () => Promise.resolve(injected)
        : () =>
            createRealBackend({
              firebaseConfig: options.firebaseConfig,
              database: options.database,
            }),
    };
  }

  async connect(options: AdapterConnectOptions): Promise<MultiplayerConnection> {
    const connection = new FirebaseConnection(this.config, options);
    try {
      await connection.open();
    } catch (err) {
      // A failed connect() hands the caller nothing to disconnect, so release everything here
      await connection.disconnect();
      throw err;
    }
    return connection;
  }
}

interface ConnectionConfig {
  sessionId: string;
  pathPrefix: string;
  /** Null in uid-as-key mode, where the id is the auth uid. */
  participantId: string | null;
  sessionBinding: boolean;
  connectTimeoutMs: number;
  backendFactory: () => Promise<FirebaseBackend>;
}

type OwnStatus = "connected" | "reconnecting" | "closed";

/**
 * One open connection to a Firebase session. The core's reads are synchronous but every Firebase read
 * is async, so the connection keeps in-memory mirrors of the session node (everyone's data) and the
 * presence node (who is connected), each kept live by one `onValue` listener.
 */
class FirebaseConnection implements MultiplayerConnection {
  participantId = "";
  readonly sessionId: string;

  private backend: FirebaseBackend | null = null;
  private mirror: GroupSessionData = {};
  private present = new Set<string>();

  /** Set by disconnect(); after it, no callback reaches the core. */
  private closed = false;
  /** Whether open() has finished; before then, failures reject connect() instead. */
  private opened = false;
  /** A listener failure that arrived after the first snapshots but before open() finished. */
  private openError: Error | null = null;
  /** Whether our presence node may exist, so disconnect() knows to remove it. */
  private presenceWritten = false;
  /** Whether `.info/connected` has been true at least once since connecting. */
  private hadFirstConnection = false;
  private status: OwnStatus = "connected";

  private readonly unsubscribes: Unsubscribe[] = [];

  constructor(
    private readonly config: ConnectionConfig,
    private readonly options: AdapterConnectOptions,
  ) {
    this.sessionId = config.sessionId;
  }

  /** Connect, sign in, bind the session, load both nodes, and announce our presence. */
  async open(): Promise<void> {
    const { signal } = this.options;
    const check = () => {
      if (this.openError) throw this.openError;
      if (signal.aborted || this.closed) {
        throw new Error("FirebaseAdapter: connect() was cancelled.");
      }
    };
    check();

    const backend = await this.config.backendFactory();
    this.backend = backend;
    check();

    const uid = await backend.signIn();
    check();
    if (this.config.participantId === null) {
      validateKey("participantId (auth uid)", uid);
      this.participantId = uid;
    } else {
      this.participantId = this.config.participantId;
    }

    // Session binding: claim (or re-assert) this uid's membership BEFORE the session listener
    // attaches — under the recommended session-locked rules, reading the session already requires a
    // matching membership record. The record is first-write-wins server-side (`.validate` makes it
    // immutable), so re-asserting the SAME session on a rejoin succeeds and claiming a DIFFERENT
    // one is denied. Never removed on disconnect: the binding IS the security property.
    if (this.config.sessionBinding) {
      try {
        await backend.set(this.membershipPath(uid), this.config.sessionId);
      } catch (err) {
        throw new Error(
          "FirebaseAdapter: registering session membership failed — either this client's anonymous " +
            `identity is already bound to a different session (rejoining "${this.config.sessionId}" ` +
            "from a browser profile that first joined another session; use a fresh tab/profile or " +
            "clear site data), or the security rules are missing the memberships block (see the " +
            `README's recommended rules). Underlying error: ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
      check();
    }

    await this.loadNodes(backend);
    check();

    // Arm the server-side removal before writing, so a drop between the two can't leave a ghost
    this.presenceWritten = true;
    await backend.onDisconnectRemove(this.presencePath());
    check();
    await backend.set(this.presencePath(), PRESENT);
    check();

    this.unsubscribes.push(
      backend.onConnectedChange((isConnected) => {
        void this.handleConnectionChange(isConnected);
      }),
    );
    check();
    this.opened = true;
  }

  /**
   * Attach the session and presence listeners and wait until both have delivered a first snapshot,
   * so the core never reads an empty mirror. A rules denial, a silent hang, and an abort all settle
   * the wait; connect()'s cleanup then removes whatever listeners were attached.
   */
  private loadNodes(backend: FirebaseBackend): Promise<void> {
    const { signal } = this.options;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let sessionLoaded = false;
      let presenceLoaded = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const fail = (error: Error) => finish(() => reject(error));
      const onAbort = () => fail(new Error("FirebaseAdapter: connect() was cancelled."));
      const maybeResolve = () => {
        if (sessionLoaded && presenceLoaded) finish(resolve);
      };

      const timer = setTimeout(() => {
        fail(
          new Error(
            `FirebaseAdapter: connect() timed out after ${this.config.connectTimeoutMs}ms waiting ` +
              "for the first session snapshot. Check the database URL, network, and that your " +
              "security rules grant read access to this session (see the README rules recipe).",
          ),
        );
      }, this.config.connectTimeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });

      // A cancelled listener means we can no longer see the session. Before the first snapshots it
      // rejects connect(); once connected, it closes the connection.
      const onListenerError = (node: string) => (error: Error) => {
        const wrapped = new Error(
          `FirebaseAdapter: the ${node} listener was cancelled — this is almost always a ` +
            `security-rules denial. Grant read access to this session's ${node} node (see the ` +
            `README rules recipe). Underlying error: ${error.message}`,
        );
        if (!settled) {
          fail(wrapped);
        } else if (!this.opened) {
          this.openError = wrapped;
        } else {
          console.error(wrapped);
          this.reportStatus("closed");
        }
      };

      this.unsubscribes.push(
        backend.onValue(
          this.sessionPath(),
          (snapshot) => {
            if (this.closed) return;
            this.mirror = decodeSession(snapshot);
            sessionLoaded = true;
            maybeResolve();
            this.options.onChange();
          },
          onListenerError("session"),
        ),
      );
      if (settled) return; // a synchronous denial already rejected
      this.unsubscribes.push(
        backend.onValue(
          this.presenceRootPath(),
          (snapshot) => {
            if (this.closed) return;
            this.present = new Set(Object.keys(snapshot ?? {}));
            presenceLoaded = true;
            maybeResolve();
            this.options.onChange();
          },
          onListenerError("presence"),
        ),
      );
    });
  }

  getAll(): GroupSessionData {
    // The core copies what this returns, so the mirror can be handed over directly
    return this.mirror;
  }

  connectedParticipants(): string[] {
    return [...this.present];
  }

  async push(data: Record<string, unknown>): Promise<void> {
    const backend = this.backend;
    if (this.closed || !backend) {
      throw new Error("FirebaseAdapter: push() called on a closed connection.");
    }
    // Store JSON-encoded so the payload survives RTDB's JSON coercion — raw, RTDB prunes empty
    // arrays/objects and coerces arrays to objects; the string round-trips those unchanged. The
    // mirror updates from the echoed onValue (RTDB fires the local listener optimistically).
    await backend.set(this.slotPath(), JSON.stringify(data));
  }

  /**
   * Close the connection: stop all callbacks, withdraw our presence, and release an owned app. The
   * data slot stays, so peers keep this participant's last data; presence is what tells them the
   * participant is gone. Safe to call more than once, and on a half-open connection.
   */
  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();

    const backend = this.backend;
    this.backend = null;
    if (!backend) return;

    if (this.presenceWritten) {
      try {
        await backend.remove(this.presencePath());
      } catch {
        // Best-effort: the armed onDisconnect is the backstop
      }
      try {
        // Cancel so the armed removal can't fire later against a reused app
        await backend.cancelOnDisconnect(this.presencePath());
      } catch {
        // Best-effort
      }
    }
    // goOffline() is app-global — only safe when the backend owns the app (never on an injected one)
    if (backend.ownsApp) backend.goOffline();
  }

  /**
   * `.info/connected` handler. The first `true` is the initial connection, which open() already
   * handled. A later `false` means our channel dropped; the server then fires our armed onDisconnect
   * and removes our presence node. The next `true` is the recovery: re-arm the one-shot removal
   * FIRST (re-writing presence before re-arming leaves a window where another drop orphans it), then
   * write presence again.
   */
  private async handleConnectionChange(isConnected: boolean): Promise<void> {
    if (this.closed) return;
    if (!isConnected) {
      if (this.hadFirstConnection) this.reportStatus("reconnecting");
      return;
    }
    if (!this.hadFirstConnection) {
      this.hadFirstConnection = true;
      return;
    }
    const backend = this.backend;
    if (!backend) return;
    try {
      await backend.onDisconnectRemove(this.presencePath());
      if (this.closed) return;
      await backend.set(this.presencePath(), PRESENT);
      if (this.closed) return;
    } catch (err) {
      console.error("FirebaseAdapter: failed to restore presence after reconnecting", err);
    }
    this.reportStatus("connected");
  }

  private reportStatus(status: OwnStatus): void {
    if (this.closed || this.status === "closed" || this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private sessionPath(): string {
    return `${this.config.pathPrefix}/${this.config.sessionId}`;
  }

  private slotPath(): string {
    return `${this.sessionPath()}/${this.participantId}`;
  }

  /**
   * The presence node: a SIBLING namespace of the sessions node, so the per-session slot rules never
   * govern it and it never shows up as a slot. Holds one child per connected participant, removed by
   * the server when that participant's connection drops.
   */
  private presenceRootPath(): string {
    return `${this.config.pathPrefix}-presence/${this.config.sessionId}`;
  }

  private presencePath(): string {
    return `${this.presenceRootPath()}/${this.participantId}`;
  }

  /**
   * The membership record's path. A SIBLING namespace of the sessions node (never inside it, where
   * the per-session rules would govern it), derived from `pathPrefix` so a custom prefix keeps the
   * pair collision-free. The stored value is the raw sessionId string — the rules compare it with
   * `=== $session`, so it must not be JSON-quoted.
   */
  private membershipPath(uid: string): string {
    return `${this.config.pathPrefix}-memberships/${uid}`;
  }
}

/** Decode a session snapshot: each slot is stored as a JSON string. */
function decodeSession(snapshot: RawSessionSnapshot | null): GroupSessionData {
  const out: GroupSessionData = {};
  if (!snapshot) return out;
  for (const [id, raw] of Object.entries(snapshot)) {
    if (typeof raw !== "string") continue; // defensive: our writes are always encoded strings
    try {
      out[id] = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Skip a slot that isn't valid JSON rather than failing the whole snapshot.
    }
  }
  return out;
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
        '. # $ [ ] / and we also reserve ":" for cross-adapter id portability with the local adapter.',
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
