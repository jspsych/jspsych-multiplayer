import {
  SlotStorage,
  generateId,
  readAllSlots,
  readSlot,
  removeSlot,
  slotPrefix,
  writeSlot,
} from "./local-store";
import { GroupSessionData, MultiplayerAdapter, Unsubscribe } from "./multiplayer-adapter";
import { ChangeSignal, createDefaultSignal } from "./signal";

const SESSION_PARAM = "mp_session";
const DEFAULT_KEY_PREFIX = "mp";

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
   * tab closes) so a refresh rejoins as the same participant instead of a new one. Ignored if
   * `participantId` is given explicitly.
   */
  persistParticipant?: boolean;
  /** Storage-key namespace prefix. Defaults to `"mp"`. */
  keyPrefix?: string;
  /** Storage backend. Defaults to `localStorage`. Injectable for tests. */
  storage?: SlotStorage;
  /** Cross-tab change signal. Defaults to `BroadcastChannel` + `storage` event. Injectable for tests. */
  signal?: ChangeSignal;
}

/**
 * A zero-infrastructure multiplayer adapter backed by `localStorage`, signalled cross-tab.
 *
 * Swap it in for the JATOS adapter to run multiplayer experiments by simply opening two browser
 * tabs — no server:
 *
 *   const jsPsych = initJsPsych();
 *   await jsPsych.pluginAPI.connect(new LocalAdapter());
 *   await jsPsych.run(timeline);
 *
 * **Development / demo / tutorial / CI only — not for data collection.** `localStorage` and its
 * signalling are same-origin, same-browser, same-machine: this adapter cannot cross devices,
 * browsers, or machines. Use JATOS/Firebase to collect real data.
 *
 * @author Hannah Tsukamoto
 */
export default class LocalAdapter implements MultiplayerAdapter {
  readonly participantId: string;

  private readonly sessionId: string;
  private readonly keyPrefix: string;
  private readonly storage: SlotStorage;
  /** Builds a fresh signal; called on each connect() so a reconnect after disconnect() works. */
  private readonly createSignal: () => ChangeSignal;
  /** The live signal while connected; null before connect() and after disconnect(). */
  private signal: ChangeSignal | null = null;

  private connected = false;
  private readonly subscribers = new Set<(data: GroupSessionData) => void>();
  /** Coalescing flag so many writes in one tick fan out once, on a microtask. */
  private notifyScheduled = false;

  constructor(options: LocalAdapterOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.storage = options.storage ?? resolveLocalStorage();
    this.sessionId = options.sessionId ?? resolveSessionId();
    this.participantId =
      options.participantId ??
      resolveParticipantId(this.keyPrefix, this.sessionId, options.persistParticipant);
    // Store a factory, not a signal instance: disconnect() closes the signal (releasing the
    // BroadcastChannel and storage listener), and a later connect() must build a fresh one — a
    // reused closed signal would silently never receive cross-tab updates again. An injected signal
    // is returned as-is (the injector owns its lifecycle).
    const injected = options.signal;
    this.createSignal = injected
      ? () => injected
      : () =>
          createDefaultSignal(
            `${this.keyPrefix}:${this.sessionId}`,
            slotPrefix(this.keyPrefix, this.sessionId)
          );
  }

  connect(): Promise<void> {
    if (!this.connected) {
      this.connected = true;
      this.signal = this.createSignal();
      // A signal from another tab means the store changed — re-read and fan out to our subscribers.
      this.signal.onChange(() => this.scheduleNotify());
    }
    return Promise.resolve();
  }

  push(data: Record<string, unknown>): Promise<void> {
    if (!this.connected) {
      return Promise.reject(
        new Error("LocalAdapter: push() called before connect(); call connect() first.")
      );
    }
    writeSlot(this.storage, this.keyPrefix, this.sessionId, this.participantId, data);
    // Self-notify: neither the storage event nor BroadcastChannel fires in the writing tab, but our
    // plugins wait on conditions their own push satisfies. Deliver it on a microtask (see
    // scheduleNotify) rather than synchronously so a subscriber that reacts by pushing again can't
    // recurse into this call or observe the store mid-update.
    this.scheduleNotify();
    // Tell the other tabs to re-read. (signal is non-null whenever connected.)
    this.signal?.post();
    return Promise.resolve();
  }

  getAll(): GroupSessionData {
    return readAllSlots(this.storage, this.keyPrefix, this.sessionId);
  }

  get(participantId: string): Record<string, unknown> | undefined {
    return readSlot(this.storage, this.keyPrefix, this.sessionId, participantId);
  }

  subscribe(callback: (data: GroupSessionData) => void): Unsubscribe {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  disconnect(): Promise<void> {
    // Remove our own slot first, then signal, so other tabs re-read a snapshot that no longer
    // includes us (a lingering slot would inflate their group_size).
    if (this.connected) {
      removeSlot(this.storage, this.keyPrefix, this.sessionId, this.participantId);
      this.signal?.post();
    }
    this.signal?.close();
    // Null the signal so a later connect() rebuilds a fresh one (see createSignal).
    this.signal = null;
    this.subscribers.clear();
    this.connected = false;
    // Note: a persisted participant id (persistParticipant) is intentionally left in sessionStorage
    // so a refresh rejoins as the same participant. Its slot was removed above and is re-created on
    // the next push — the brief gap is expected for the rejoin-on-refresh flow.
    return Promise.resolve();
  }

  /**
   * Schedule a single fan-out to local subscribers on a microtask. Coalesces bursts of writes and,
   * crucially, guarantees the notification never runs synchronously inside `push()` — so a
   * subscriber calling `push()` again enqueues another fan-out instead of recursing, and always sees
   * a fully-written store.
   */
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      const data = this.getAll();
      // Snapshot so a subscriber that unsubscribes (or subscribes) mid-fan-out doesn't disturb it.
      for (const cb of [...this.subscribers]) {
        try {
          cb(data);
        } catch (err) {
          console.error("LocalAdapter: a group-session subscriber threw", err);
        }
      }
    });
  }
}

function resolveLocalStorage(): SlotStorage {
  if (typeof localStorage === "undefined") {
    throw new Error(
      "LocalAdapter: localStorage is not available in this environment. " +
        "Serve the experiment over http(s) (e.g. `npx http-server`) rather than opening it from a " +
        "file:// URL, or pass a `storage` option."
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

/** Resolve this tab's participant id, optionally persisting it per-tab for rejoin-on-refresh. */
function resolveParticipantId(
  keyPrefix: string,
  sessionId: string,
  persist: boolean | undefined
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
