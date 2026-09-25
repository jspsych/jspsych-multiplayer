import {
  SESSION_PARAM,
  generateId,
  sessionIdFromUrl,
  tabId,
  validateId,
} from "@jspsych-multiplayer/utils";
import type { AdapterConnectOptions, MultiplayerAdapter, MultiplayerConnection } from "jspsych";

import {
  SlotStorage,
  presencePrefix,
  readAllSlots,
  readPresent,
  removePresence,
  slotPrefix,
  writePresence,
  writeSlot,
} from "./local-store";
import { ChangeSignal, createDefaultSignal } from "./signal";

const DEFAULT_NAMESPACE = "mp";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;
/**
 * Chrome throttles timers in a tab that has been hidden for 5 minutes to once a minute, so a
 * background tab may go a full minute between heartbeats. The default timeout leaves room for that;
 * tabs that close normally are removed at once by their pagehide handler.
 */
const DEFAULT_PRESENCE_TIMEOUT_MS = 70000;

export interface LocalAdapterOptions {
  /**
   * The group's session. All keys live under `<namespace>:<sessionId>:`. Defaults to the
   * `?mp_session=` URL parameter, or a fresh random id if that's absent (which is then reflected
   * back into the URL so the link can be shared with the other tabs). Must not contain any of
   * `: / . # $ [ ]`.
   */
  sessionId?: string;
  /**
   * This tab's participant id. Defaults to an id kept for this tab and session (see
   * `persistParticipant`). Must not contain any of `: / . # $ [ ]`.
   */
  participantId?: string;
  /**
   * Keep this tab's participant id in `sessionStorage` (per-tab, survives reload, gone when the
   * tab closes), so a reload keeps the same id and the other tabs can tell this participant
   * restarted rather than seeing a new stranger. Defaults to `true`. Set `false` to get a fresh
   * id on every page load. Ignored if `participantId` is given explicitly.
   */
  persistParticipant?: boolean;
  /**
   * Prefix of every storage key the adapter uses, so separate studies on one origin stay apart.
   * Defaults to `"mp"`. Must not contain `:`.
   */
  namespace?: string;
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
  namespace: string;
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
    if ("keyPrefix" in options) {
      console.warn(
        "LocalAdapter: the keyPrefix option was renamed namespace; keyPrefix is ignored.",
      );
    }
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    // A ":" is the key-namespace boundary (`<namespace>:<sessionId>:<participantId>`), and
    // participantIdFromKey slices on it assuming no part contains one; otherwise one session's
    // keys could be read as another's. validateId rejects ":" (among others) in the ids.
    if (typeof namespace !== "string" || namespace === "" || namespace.includes(":")) {
      throw new Error(
        `LocalAdapter: namespace must be a non-empty string without ":" ` +
          `(got ${JSON.stringify(namespace)}).`,
      );
    }
    const storage = options.storage ?? resolveLocalStorage();
    const sessionId = validateId(
      "LocalAdapter",
      "sessionId",
      options.sessionId ?? sessionIdFromUrl(SESSION_PARAM),
    );
    const participantId = validateId(
      "LocalAdapter",
      "participantId",
      options.participantId ??
        (options.persistParticipant === false
          ? generateId()
          : tabId(`${namespace}:participant:${sessionId}`)),
    );
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.config = {
      participantId,
      sessionId,
      namespace,
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
        `${config.namespace}:${config.sessionId}`,
        slotPrefix(config.namespace, config.sessionId),
        presencePrefix(config.namespace, config.sessionId),
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

  getAll(): Record<string, unknown> {
    return readAllSlots(this.config.storage, this.config.namespace, this.config.sessionId);
  }

  connectedParticipants(): string[] {
    return this.readPresent();
  }

  async push(data: Record<string, unknown>): Promise<void> {
    if (this.closed) {
      throw new Error("LocalAdapter: push() called after disconnect().");
    }
    // setItem throws on e.g. QuotaExceededError; being async, this rejects the returned promise
    const { storage, namespace, sessionId } = this.config;
    writeSlot(storage, namespace, sessionId, this.participantId, data);
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
   * that it resumed, so the session tells the group this page is still here.
   */
  private beat(announce = false) {
    if (this.closed) return;
    const { storage, namespace, sessionId, presenceTimeoutMs } = this.config;
    const now = Date.now();
    const lapsed = this.lastBeatAt > 0 && now - this.lastBeatAt > presenceTimeoutMs;
    let written = false;
    try {
      writePresence(storage, namespace, sessionId, this.participantId, now);
      this.lastBeatAt = now;
      written = true;
    } catch (e) {
      console.error("LocalAdapter: could not write the presence heartbeat", e);
    }
    if (announce || lapsed) this.signal.post();
    // Still lapsed if the write failed; the next successful beat reports it
    if (lapsed && written) this.options.onResumed();
    const present = this.readPresent().join("\n");
    if (present !== this.lastPresent) {
      this.lastPresent = present;
      this.options.onChange();
    }
  }

  private readPresent(): string[] {
    const { storage, namespace, sessionId, presenceTimeoutMs } = this.config;
    return readPresent(storage, namespace, sessionId, Date.now(), presenceTimeoutMs);
  }

  private removeOwnPresence() {
    const { storage, namespace, sessionId } = this.config;
    try {
      removePresence(storage, namespace, sessionId, this.participantId);
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
