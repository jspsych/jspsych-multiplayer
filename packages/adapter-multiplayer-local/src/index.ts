import type {
  AdapterConnectOptions,
  GroupSessionData,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";

import {
  SlotStorage,
  generateId,
  presencePrefix,
  readAllSlots,
  readPresent,
  removePresence,
  slotPrefix,
  writePresence,
  writeSlot,
} from "./local-store";
import { ChangeSignal, createDefaultSignal } from "./signal";

const SESSION_PARAM = "mp_session";
const DEFAULT_KEY_PREFIX = "mp";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;
/**
 * Chrome throttles timers in a tab that has been hidden for 5 minutes to once a minute, so a
 * background tab may go a full minute between heartbeats. The default timeout leaves room for that;
 * tabs that close normally are removed at once by their pagehide handler.
 */
const DEFAULT_PRESENCE_TIMEOUT_MS = 70000;

export interface LocalAdapterOptions {
  /**
   * Session namespace. All keys live under `<keyPrefix>:<sessionId>:`. Defaults to the
   * `?mp_session=` URL parameter, or a fresh random id if that's absent (which is then reflected
   * back into the URL so the link can be shared with the other tabs).
   */
  sessionId?: string;
  /**
   * This tab's participant id. Defaults to a fresh random id per construction — so a **refresh
   * starts a new participant** (its old slot is a mid-run ghost; open a new session for a clean
   * run). Set `persistParticipant: true` to instead reuse a stable id across reloads of this tab.
   */
  participantId?: string;
  /**
   * Persist this tab's participant id in `sessionStorage` (per-tab, survives reload, gone when the
   * tab closes) so a refresh keeps the same id instead of a new one. The refreshed page has still
   * restarted the experiment, so the other tabs see it as restarted, not rejoined. Ignored if
   * `participantId` is given explicitly.
   */
  persistParticipant?: boolean;
  /** Storage-key namespace prefix. Defaults to `"mp"`. */
  keyPrefix?: string;
  /** Storage backend. Defaults to `localStorage`. Injectable for tests. */
  storage?: SlotStorage;
  /**
   * Cross-tab change signal. Defaults to a new `BroadcastChannel` + `storage`-event signal per
   * connection, which the connection closes on disconnect. An injected signal belongs to the
   * caller: connections only add and remove their own handlers and never close it.
   */
  signal?: ChangeSignal;
  /** How often a connected tab refreshes its presence key, in ms. Defaults to 2000. */
  heartbeatIntervalMs?: number;
  /**
   * How long after its last heartbeat a tab still counts as connected, in ms. Defaults to 70000,
   * which covers browsers throttling timers in background tabs to once a minute.
   */
  presenceTimeoutMs?: number;
}

/** Everything a connection needs from the adapter's configuration. */
interface LocalConfig {
  participantId: string;
  sessionId: string;
  keyPrefix: string;
  storage: SlotStorage;
  signal?: ChangeSignal;
  heartbeatIntervalMs: number;
  presenceTimeoutMs: number;
}

/**
 * A zero-infrastructure multiplayer adapter backed by `localStorage`, signalled cross-tab.
 *
 * Swap it in for the JATOS adapter to run multiplayer experiments by simply opening two browser
 * tabs — no server:
 *
 *   const jsPsych = initJsPsych();
 *   await jsPsych.multiplayer.connect(new LocalAdapter());
 *   await jsPsych.run(timeline);
 *
 * **Development / demo / tutorial / CI only — not for data collection.** `localStorage` and its
 * signalling are same-origin, same-browser, same-machine: this adapter cannot cross devices,
 * browsers, or machines. Use JATOS/Firebase to collect real data.
 *
 * @author Hannah Tsukamoto
 */
export default class LocalAdapter implements MultiplayerAdapter {
  private readonly config: LocalConfig;

  constructor(options: LocalAdapterOptions = {}) {
    const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    const storage = options.storage ?? resolveLocalStorage();
    const sessionId = options.sessionId ?? resolveSessionId();
    const participantId =
      options.participantId ??
      resolveParticipantId(keyPrefix, sessionId, options.persistParticipant);
    // A ":" is the key-namespace boundary (`<keyPrefix>:<sessionId>:<participantId>`), and
    // participantIdFromKey slices on it assuming ids/sessions never contain one. Auto-generated ids
    // never do, but a user-supplied one could — which would silently mis-parse the snapshot (a
    // participantId with a ":" would look like it belonged to a different session, so it'd vanish
    // from getAll). Reject it up front with a clear message instead.
    if (sessionId.includes(":")) {
      throw new Error(
        `LocalAdapter: sessionId must not contain ":" (got "${sessionId}") — it is the ` +
          "reserved storage-key namespace separator.",
      );
    }
    if (participantId.includes(":")) {
      throw new Error(
        `LocalAdapter: participantId must not contain ":" (got "${participantId}") — it is ` +
          "the reserved storage-key namespace separator.",
      );
    }
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.config = {
      participantId,
      sessionId,
      keyPrefix,
      storage,
      signal: options.signal,
      heartbeatIntervalMs,
      presenceTimeoutMs: Math.max(
        options.presenceTimeoutMs ?? DEFAULT_PRESENCE_TIMEOUT_MS,
        heartbeatIntervalMs,
      ),
    };
  }

  /** The participant id every connection from this adapter uses. */
  get participantId(): string {
    return this.config.participantId;
  }

  async connect(options: AdapterConnectOptions): Promise<MultiplayerConnection> {
    if (options.signal.aborted) {
      throw new Error("LocalAdapter: connect() was cancelled.");
    }
    return new LocalConnection(this.config, options);
  }
}

/**
 * One tab's open connection: its own signal handler, heartbeat timer, and page-lifecycle
 * listeners. Created by LocalAdapter.connect(); nothing is shared between connections.
 */
class LocalConnection implements MultiplayerConnection {
  readonly participantId: string;
  readonly sessionId: string;

  private closed = false;
  private readonly signal: ChangeSignal;
  /** True when this connection created the signal and so must close it. */
  private readonly ownsSignal: boolean;
  private readonly removeSignalHandler: () => void;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  /** Present participants at the last check, as a string, to tell when the set changes. */
  private lastPresent = "";
  /** When this tab last wrote its heartbeat; 0 before the first write. */
  private lastBeatAt = 0;

  private readonly onPageHide = () => {
    // Best effort: the tab is going away (or into the back/forward cache), so drop our presence
    // key right away instead of letting other tabs wait out the timeout.
    this.removeOwnPresence();
    this.signal.post();
  };

  private readonly onPageShow = (event: PageTransitionEvent) => {
    // Restored from the back/forward cache: the connection is still open, so reappear.
    if (event.persisted) this.beat(true);
  };

  private readonly onVisibilityChange = () => {
    // A hidden tab's timers may have been throttled; beat as soon as it's visible again.
    if (typeof document !== "undefined" && document.visibilityState === "visible") this.beat();
  };

  constructor(
    private readonly config: LocalConfig,
    private readonly options: AdapterConnectOptions,
  ) {
    this.participantId = config.participantId;
    this.sessionId = config.sessionId;
    this.ownsSignal = !config.signal;
    this.signal =
      config.signal ??
      createDefaultSignal(
        `${config.keyPrefix}:${config.sessionId}`,
        slotPrefix(config.keyPrefix, config.sessionId),
        presencePrefix(config.keyPrefix, config.sessionId),
      );
    // Another tab changed the store: data or presence may have changed
    this.removeSignalHandler = this.signal.onChange(() => this.notify());

    this.beat(true);
    this.heartbeat = setInterval(() => this.beat(), config.heartbeatIntervalMs);
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  getAll(): GroupSessionData {
    return readAllSlots(this.config.storage, this.config.keyPrefix, this.config.sessionId);
  }

  connectedParticipants(): string[] {
    return this.readPresent();
  }

  async push(data: Record<string, unknown>): Promise<void> {
    if (this.closed) {
      throw new Error("LocalAdapter: push() called after disconnect().");
    }
    // setItem throws on e.g. QuotaExceededError; being async, this rejects the returned promise
    const { storage, keyPrefix, sessionId } = this.config;
    writeSlot(storage, keyPrefix, sessionId, this.participantId, data);
    // Tell the other tabs to re-read
    this.signal.post();
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.removeSignalHandler();
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("pageshow", this.onPageShow);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    // The data slot stays: presence, not the slot, says who is still here
    this.removeOwnPresence();
    this.signal.post();
    if (this.ownsSignal) this.signal.close();
  }

  /**
   * Refresh our presence key and check whether anyone else's has appeared or gone stale. A tab
   * that crashed sends no signal, so this periodic check is how the others notice it's gone.
   * `announce` also pings the other tabs, for the moments when our own presence changes.
   *
   * localStorage never disconnects, but a tab's heartbeat can still lapse: a throttled background
   * tab, or a page frozen in the back/forward cache, may go longer than `presenceTimeoutMs`
   * without a beat, and the other tabs then count it as gone. When that happens this tab reports
   * a drop and a recovery, so the session tells the group this page is back and it can rejoin.
   */
  private beat(announce = false) {
    if (this.closed) return;
    const { storage, keyPrefix, sessionId, presenceTimeoutMs } = this.config;
    const now = Date.now();
    const lapsed = this.lastBeatAt > 0 && now - this.lastBeatAt > presenceTimeoutMs;
    if (lapsed) this.options.onStatus("reconnecting");
    let written = false;
    try {
      writePresence(storage, keyPrefix, sessionId, this.participantId, now);
      this.lastBeatAt = now;
      written = true;
    } catch (e) {
      console.error("LocalAdapter: could not write the presence heartbeat", e);
    }
    if (announce || lapsed) this.signal.post();
    // Still lapsed if the write failed; the next successful beat reports the recovery
    if (lapsed && written) this.options.onStatus("connected");
    const present = this.readPresent().join("\n");
    if (present !== this.lastPresent) {
      this.lastPresent = present;
      this.options.onChange();
    }
  }

  private readPresent(): string[] {
    const { storage, keyPrefix, sessionId, presenceTimeoutMs } = this.config;
    return readPresent(storage, keyPrefix, sessionId, Date.now(), presenceTimeoutMs);
  }

  private removeOwnPresence() {
    const { storage, keyPrefix, sessionId } = this.config;
    try {
      removePresence(storage, keyPrefix, sessionId, this.participantId);
    } catch {
      // Best effort; the key expires on its own
    }
  }

  private notify() {
    if (this.closed) return;
    this.lastPresent = this.readPresent().join("\n");
    this.options.onChange();
  }
}

function resolveLocalStorage(): SlotStorage {
  if (typeof localStorage === "undefined") {
    throw new Error(
      "LocalAdapter: localStorage is not available in this environment. " +
        "Serve the experiment over http(s) (e.g. `npx http-server`) rather than opening it from a " +
        "file:// URL, or pass a `storage` option.",
    );
  }
  return localStorage;
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
    // Reflect the fresh session into the URL (without a navigation) so the user can copy the link
    // into the other tabs for a shared run.
    window.history?.replaceState?.(window.history.state, "", url.toString());
    return fresh;
  } catch {
    return generateId();
  }
}

/** Resolve this tab's participant id, optionally persisting it per-tab across refreshes. */
function resolveParticipantId(
  keyPrefix: string,
  sessionId: string,
  persist: boolean | undefined,
): string {
  if (!persist || typeof sessionStorage === "undefined") {
    return generateId();
  }
  const key = `${keyPrefix}:participant:${sessionId}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const fresh = generateId();
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return generateId();
  }
}
