import type {
  AdapterConnectOptions,
  GroupSessionData,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";

/** Callbacks accepted by jatos.joinGroup(). */
interface JatosGroupCallbacks {
  onOpen?: (memberId?: string | number) => void;
  onClose?: () => void;
  onError?: (errMsg?: string) => void;
  onMessage?: (msg: unknown) => void;
  onMemberJoin?: (memberId: string | number) => void;
  onMemberOpen?: (memberId: string | number) => void;
  onMemberLeave?: (memberId: string | number) => void;
  onMemberClose?: (memberId: string | number) => void;
  onGroupSession?: (path?: string, op?: string) => void;
}

/** A jQuery promise (a Promises/A+ thenable), as returned by jatos.js. */
interface JatosPromise {
  then(
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): unknown;
}

/**
 * Minimal ambient types for the jatos global injected by jatos.js.
 * Only the subset used by this adapter is declared here.
 */
declare const jatos: {
  /**
   * Study result ID assigned by JATOS — unique per study run and available as soon
   * as jatos.js initializes. jatos.js defines the group member id as this very value
   * (it assigns `jatos.groupMemberId = jatos.studyResultId` when group messages
   * arrive), so this is the canonical per-membership key, readable before joining.
   */
  studyResultId?: string | number | null;
  /** Worker ID assigned by JATOS — fallback namespace key when studyResultId is absent. */
  workerId: string | number;
  /** IDs of the group members whose group channel is currently open. */
  groupChannels?: Array<string | number>;
  /**
   * Join a group study and open the WebSocket channel. jatos.js keeps one set of
   * callbacks for the whole page, and each call replaces it. Current builds return a
   * promise that settles when the channel opens or fails to open; older builds return
   * nothing.
   */
  joinGroup(callbacks: JatosGroupCallbacks): JatosPromise | void;
  /** Shared persistent key-value store for the group. */
  groupSession: {
    set(key: string, value: unknown): Promise<void>;
    getAll(): Record<string, unknown> | null;
  };
  /**
   * Leave the group and close the WebSocket channel. Older jatos.js builds may
   * not expose this, so the adapter guards for its absence before calling.
   */
  leaveGroup?(onSuccess?: () => void, onFail?: (err: unknown) => void): unknown;
};

export interface JatosAdapterOptions {
  /** How long to wait for the group channel to open before connect() rejects, in ms. Default 20000. */
  connectTimeoutMs?: number;
  /**
   * How long the channel can stay down before the connection counts as lost for good, in
   * ms. jatos.js keeps trying to reopen a dropped channel; after this long the adapter stops
   * waiting and reports the connection as closed. Default 30000. `null` or `Infinity` means
   * never give up.
   */
  closeAfterReconnectingMs?: number | null;
}

/**
 * The connection that currently owns jatos.js's group callbacks, or has a join in flight.
 * jatos.js supports one group channel per page, and joinGroup() replaces the page's
 * callbacks even when it then refuses to open a second channel, so no other connection may
 * call it until this one is done.
 */
let activeConnection: JatosConnection | null = null;

/**
 * Multiplayer adapter backed by JATOS group studies.
 *
 * Usage:
 *   const jsPsych = initJsPsych({ ... });
 *   await jsPsych.multiplayer.connect(new JatosAdapter());
 *   await jsPsych.run(timeline);
 *
 * Each participant's data is stored under groupSession[studyResultId]
 * (JATOS's group member id), so keys never collide across participants.
 *
 * @author Hannah Tsukamoto
 */
export default class JatosAdapter implements MultiplayerAdapter {
  private readonly connectTimeoutMs: number;
  private readonly closeAfterReconnectingMs: number | null;

  constructor(options: JatosAdapterOptions = {}) {
    if (typeof jatos === "undefined") {
      throw new Error(
        "JatosAdapter: the jatos global is not defined. " +
          "Ensure jatos.js is loaded before creating a JatosAdapter. " +
          "This adapter only works when the experiment is running inside JATOS.",
      );
    }
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    const closeAfter = options.closeAfterReconnectingMs;
    this.closeAfterReconnectingMs =
      closeAfter === undefined
        ? 30_000
        : typeof closeAfter === "number" && Number.isFinite(closeAfter) && closeAfter >= 0
          ? closeAfter
          : null;
  }

  connect(options: AdapterConnectOptions): Promise<MultiplayerConnection> {
    if (options.signal.aborted) {
      return Promise.reject(new Error("JatosAdapter: connect() was cancelled."));
    }
    if (activeConnection) {
      return Promise.reject(
        new Error(
          "JatosAdapter: a JATOS group connection is already open or opening on this page. " +
            "jatos.js supports one group channel per page; disconnect the other connection first.",
        ),
      );
    }
    // Key by studyResultId: it is unique per study run, whereas workerId can repeat when the
    // same worker runs the study more than once. jatos.groupMemberId is the canonical name for
    // this id but stays null until the first group message arrives after joinGroup(), and
    // jatos.js then merely assigns it from studyResultId. Fall back to workerId if it is absent.
    const participantId = String(jatos.studyResultId ?? jatos.workerId);
    const connection = new JatosConnection(participantId, options, {
      connectTimeoutMs: this.connectTimeoutMs,
      closeAfterReconnectingMs: this.closeAfterReconnectingMs,
    });
    activeConnection = connection;
    return connection.open();
  }
}

type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

class JatosConnection implements MultiplayerConnection {
  private state: ConnectionState = "connecting";

  /**
   * The last group session data and open channels read from jatos.js. jatos.js wipes both
   * when the channel closes, so while it reconnects the connection keeps serving these.
   */
  private data: GroupSessionData = {};
  private channels: string[] = [];

  /** Settles the pending connect() promise; null once it has settled. */
  private settleOpen: { resolve: () => void; reject: (error: Error) => void } | null = null;

  /** True while jatos.js's join promise is unsettled. */
  private joinPending = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /** push() calls waiting for a dropped channel to reopen. */
  private reopenWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  private leaving: Promise<void> | null = null;

  constructor(
    readonly participantId: string,
    private readonly options: AdapterConnectOptions,
    private readonly settings: {
      connectTimeoutMs: number;
      closeAfterReconnectingMs: number | null;
    },
  ) {}

  open(): Promise<MultiplayerConnection> {
    return new Promise((resolve, reject) => {
      const { signal } = this.options;
      // If JATOS reports neither success nor failure (a dropped handshake or an unreachable
      // server), the promise would otherwise hang forever; bound the wait and fail loudly.
      const timer = setTimeout(() => {
        this.failOpen(
          new Error(
            `JatosAdapter: timed out after ${this.settings.connectTimeoutMs} ms waiting for the ` +
              "group channel to open. JATOS reported neither success nor failure — the server may " +
              "be unreachable or the handshake was dropped.",
          ),
        );
      }, this.settings.connectTimeoutMs);
      const onAbort = () => this.failOpen(new Error("JatosAdapter: connect() was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });

      this.settleOpen = {
        resolve: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(this);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };

      let joining: JatosPromise | void;
      try {
        joining = jatos.joinGroup({
          onOpen: () => this.handleOpen(),
          onClose: () => this.handleDrop(),
          onError: (errMsg) => this.handleError(errMsg),
          onGroupSession: () => this.handleChange(),
          onMemberJoin: () => this.handleChange(),
          onMemberOpen: () => this.handleChange(),
          onMemberLeave: () => this.handleChange(),
          onMemberClose: () => this.handleChange(),
        });
      } catch (e) {
        this.failOpen(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      // The promise settles even when jatos.js refuses to open a channel without calling
      // onError (e.g. while a previous channel is still closing), and resolves even if onOpen
      // is missed, so it is used alongside the callbacks.
      if (joining && typeof joining.then === "function") {
        this.joinPending = true;
        joining.then(
          () => {
            this.joinPending = false;
            this.handleOpen();
          },
          (reason) => {
            this.joinPending = false;
            this.failOpen(
              new Error(`JatosAdapter: failed to join group — ${reason ?? "unknown error"}`),
            );
            this.release();
          },
        );
      }
    });
  }

  // ---------------------------------------------------------------- MultiplayerConnection

  getAll(): GroupSessionData {
    return this.data;
  }

  connectedParticipants(): string[] {
    return this.channels;
  }

  async push(data: Record<string, unknown>): Promise<void> {
    // JATOS group session uses optimistic concurrency: concurrent writes from multiple
    // participants cause version conflicts. Retry with exponential backoff + jitter so the
    // retries spread out and don't re-collide. Each retry re-sends the same
    // (participantId -> data) write, so a retry can never lose or double-apply another
    // participant's update. A write made while the channel is down waits for it to reopen.
    const maxAttempts = 8;
    let failures = 0;
    let lastError: unknown;
    for (;;) {
      await this.whenOpen(lastError);
      try {
        await jatos.groupSession.set(this.participantId, data);
        this.refresh();
        return;
      } catch (err) {
        lastError = err;
        // The channel dropped during the write: wait for it to reopen and try again
        if (this.state !== "connected") continue;
        failures++;
        if (failures >= maxAttempts) {
          // Preserve the underlying error so the real cause (a persistent version conflict,
          // payload too large, etc.) isn't hidden behind the generic message. JATOS errors
          // are untyped strings, so we can't assert which it was — hence "may include".
          throw withCause(
            new Error(
              `JatosAdapter: push failed after ${maxAttempts} attempts (may include repeated group session version conflicts)`,
            ),
            lastError,
          );
        }
        const delayMs = 50 * Math.pow(2, failures - 1) + Math.random() * 50;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  disconnect(): Promise<void> {
    if (this.state !== "closed") {
      this.close(new Error("JatosAdapter: push failed because the connection was disconnected."));
    }
    return this.leave();
  }

  // ---------------------------------------------------------------- jatos.js callbacks

  private handleOpen() {
    if (this.state === "closed") {
      // connect() failed or was cancelled while jatos.js was still joining, and the channel
      // opened anyway: leave the group so no one is left in it by mistake.
      if (activeConnection === this && !this.leaving) void this.leave();
      return;
    }
    this.refresh();
    if (this.state === "connecting") {
      this.state = "connected";
      const settle = this.settleOpen;
      this.settleOpen = null;
      settle?.resolve();
    } else if (this.state === "reconnecting") {
      // jatos.js reopened a dropped channel
      this.state = "connected";
      clearTimeout(this.reconnectTimer);
      for (const waiter of this.reopenWaiters.splice(0)) waiter.resolve();
      this.options.onStatus("connected");
      this.options.onChange();
    }
  }

  private handleChange() {
    if (this.state !== "connected") return;
    this.refresh();
    this.options.onChange();
  }

  private handleError(errMsg?: string) {
    if (this.state === "connecting") {
      this.failOpen(new Error(`JatosAdapter: failed to join group — ${errMsg ?? "unknown error"}`));
    } else {
      // After the channel opened, jatos.js reports a failed heartbeat or a closed socket
      // through onError and then reopens the channel itself
      this.handleDrop();
    }
  }

  private handleDrop() {
    if (this.state === "connecting") {
      this.failOpen(
        new Error("JatosAdapter: the group channel closed before it finished opening."),
      );
      return;
    }
    if (this.state !== "connected") return;
    this.state = "reconnecting";
    this.options.onStatus("reconnecting");
    const { closeAfterReconnectingMs } = this.settings;
    if (closeAfterReconnectingMs !== null) {
      this.reconnectTimer = setTimeout(() => {
        if (this.state !== "reconnecting") return;
        // jatos.js may still be retrying, or the server may have closed our channel for good
        // (which jatos.js only logs). Either way, stop waiting and report the connection lost.
        this.close(
          new Error(
            `JatosAdapter: push failed because the group channel stayed closed for ${closeAfterReconnectingMs} ms.`,
          ),
        );
        this.options.onStatus("closed");
      }, closeAfterReconnectingMs);
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Read the current data and open channels from jatos.js, while the channel is open. */
  private refresh() {
    if (this.state === "reconnecting" || this.state === "closed") return;
    this.data = (jatos.groupSession.getAll() ?? {}) as GroupSessionData;
    this.channels = (jatos.groupChannels ?? []).map(String);
  }

  private failOpen(error: Error) {
    const settle = this.settleOpen;
    if (!settle) return;
    this.settleOpen = null;
    this.close(error);
    settle.reject(error);
  }

  /**
   * Stop all callbacks and fail pending pushes. Doesn't leave the group or report status.
   * The page-wide guard is kept while a join is still in flight, so a new connection can't
   * take over jatos.js's callbacks before this channel has opened and been left.
   */
  private close(error: Error) {
    this.state = "closed";
    clearTimeout(this.reconnectTimer);
    for (const waiter of this.reopenWaiters.splice(0)) waiter.reject(error);
    if (!this.joinPending) this.release();
  }

  private release() {
    if (activeConnection === this) activeConnection = null;
  }

  private whenOpen(lastError: unknown): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.state === "reconnecting") {
      return new Promise((resolve, reject) => this.reopenWaiters.push({ resolve, reject }));
    }
    return Promise.reject(
      withCause(
        new Error("JatosAdapter: push failed because the group channel is closed."),
        lastError,
      ),
    );
  }

  /** Leave the JATOS group once, then release the page-wide guard. Resolves either way. */
  private leave(): Promise<void> {
    this.leaving ??= new Promise<void>((resolve) => {
      if (typeof jatos.leaveGroup !== "function") {
        resolve();
        return;
      }
      try {
        jatos.leaveGroup(
          () => resolve(),
          () => resolve(),
        );
      } catch {
        resolve();
      }
    }).then(() => this.release());
    return this.leaving;
  }
}

function withCause(error: Error, cause: unknown): Error {
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}
