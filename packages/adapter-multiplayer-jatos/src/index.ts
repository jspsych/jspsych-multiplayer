import { validateId } from "@jspsych-multiplayer/utils";
import type {
  AdapterConnectOptions,
  GroupState,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";
import { SEALED_KEY } from "./sealed-key";

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
  /**
   * ID of the group this study run joined. jatos.js sets it when the group channel opens,
   * and sets it back to null while the channel is closed.
   */
  groupResultId?: string | number | null;
  /** IDs of the group members whose group channel is currently open. */
  groupChannels?: Array<string | number>;
  /**
   * IDs of the group's members, whether or not their channel is open. A member who leaves
   * the group (not just drops their channel) is removed.
   */
  groupMembers?: Array<string | number>;
  /** The batch's settings. `maxActiveMembers` is null when the batch sets no limit. */
  batchProperties?: { maxActiveMembers?: number | null } | null;
  /**
   * Ask the server to fix the group, so no new members can join. jatos.js calls onSuccess
   * once the server confirms. The server tells only this member, not the others.
   */
  setGroupFixed?(onSuccess?: () => void, onFail?: (err: unknown) => void): unknown;
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
  /**
   * Fix the JATOS group once it has the batch's `maxActiveMembers`, so a member who drops
   * out mid-study counts as a dropout instead of freeing their place for a newcomer.
   * Default `true`. Set `false` to decide when to seal yourself, with
   * `jsPsych.multiplayer.sealGroup()`.
   */
  sealWhenFull?: boolean;
}

/** First and longest wait, in ms, before retrying a join that jatos.js refused. */
const JOIN_RETRY_MIN_MS = 100;
const JOIN_RETRY_MAX_MS = 1000;

/**
 * How many times a write is attempted before it rejects. JATOS rejects a group session write
 * that races another member's (optimistic concurrency), so a couple of quick retries ride out
 * the common collision; anything longer is left to jsPsych, which retries a failed push with
 * backoff.
 */
const WRITE_ATTEMPTS = 3;

/** First and longest wait, in ms, before retrying to publish a confirmed seal. */
const SEAL_RETRY_MIN_MS = 250;
const SEAL_RETRY_MAX_MS = 10_000;

/** What a member publishes under SEALED_KEY. */
interface SealRecord {
  /** The participant who published it. */
  by: string;
  /** The final roster, sorted. */
  members: string[];
}

/** Options the adapter no longer takes, with what replaced them. */
const REMOVED_OPTIONS: Record<string, string> = {
  connectTimeoutMs: "the `connectTimeout` option of jsPsych.multiplayer.connect()",
  closeAfterReconnectingMs: "the `reconnectTimeout` option of jsPsych.multiplayer.connect()",
};

/**
 * jatos.js refuses to open a group channel while the previous one is still closing, e.g.
 * right after leaveGroup(), which resolves before the socket has finished closing. It rejects
 * the join without calling onError, so the refusal is recognized by its message.
 */
function isStillClosing(reason: unknown): boolean {
  return String(reason).includes("readyState CLOSED");
}

/**
 * The connection that currently owns jatos.js's group callbacks, or has a join or a leave in
 * flight. jatos.js supports one group channel per page, and joinGroup() replaces the page's
 * callbacks even when it then refuses to open a second channel, so no other connection may
 * call it until this one is done. A new connection waits for a closed one to finish; only an
 * open one blocks it.
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
  private readonly sealWhenFull: boolean;

  constructor(options: JatosAdapterOptions = {}) {
    if (typeof jatos === "undefined") {
      throw new Error(
        "JatosAdapter: the jatos global is not defined. " +
          "Ensure jatos.js is loaded before creating a JatosAdapter. " +
          "This adapter only works when the experiment is running inside JATOS.",
      );
    }
    for (const [name, replacement] of Object.entries(REMOVED_OPTIONS)) {
      if (name in options) {
        console.warn(
          `JatosAdapter: the ${name} option was removed and is ignored; use ${replacement}.`,
        );
      }
    }
    this.sealWhenFull = options.sealWhenFull ?? true;
  }

  connect(options: AdapterConnectOptions): Promise<MultiplayerConnection> {
    if (options.signal.aborted) {
      return Promise.reject(new Error("JatosAdapter: connect() was cancelled."));
    }
    const previous = activeConnection;
    if (previous && !previous.isClosed()) {
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
    let participantId: string;
    try {
      participantId = validateId(
        "JatosAdapter",
        "the study result ID",
        String(jatos.studyResultId ?? jatos.workerId),
      );
    } catch (e) {
      return Promise.reject(e);
    }
    const connection = new JatosConnection(participantId, options, {
      sealWhenFull: this.sealWhenFull,
    });
    activeConnection = connection;
    // A closed connection may still be leaving the group or settling a cancelled join; the
    // new one takes over jatos.js only after it has.
    return connection.open(previous?.released);
  }
}

type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

class JatosConnection implements MultiplayerConnection {
  private state: ConnectionState = "connecting";

  /** The JATOS group result ID, read when the channel first opens. */
  sessionId = "";

  /**
   * Ask JATOS to fix the group. Defined only when jatos.js has setGroupFixed(), so jsPsych can
   * tell a backend that can't seal groups.
   */
  readonly sealGroup?: () => Promise<void>;

  /**
   * The last participant data, open channels, and members read from jatos.js. jatos.js wipes
   * them when the channel closes, so while it reconnects the connection keeps serving these.
   */
  private data: Record<string, unknown> = {};
  private channels: string[] = [];
  private members: string[] = [];
  /** Everyone this connection has seen as a member of the group, for checking seal records. */
  private readonly seenMembers = new Set<string>();

  /** True once the JATOS server confirmed to this member that it fixed the group. */
  private fixed = false;
  /** The setGroupFixed() request in flight, if any. */
  private fixing: Promise<void> | null = null;
  /**
   * The final roster, once this member knows the group is sealed: from its own confirmed fix,
   * or from a seal record another member published. Rosters are merged, so nobody drops off.
   */
  private roster: Set<string> | null = null;
  /** True while this member's seal record is being written. */
  private publishingSeal = false;
  private sealRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private sealRetryDelay = 0;
  /** The last seal record this connection refused, so it warns about each one once. */
  private refusedSealRecord = "";

  /** Settles the pending connect() promise; null once it has settled. */
  private settleOpen: { resolve: () => void; reject: (error: Error) => void } | null = null;

  /** True while jatos.js's join promise is unsettled. */
  private joinPending = false;

  private joinRetryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Resolves once this connection has released jatos.js to the next one. */
  readonly released: Promise<void>;
  private resolveReleased!: () => void;
  private isReleased = false;

  /** sealGroup() calls waiting for a dropped channel to reopen. */
  private reopenWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  private leaving: Promise<void> | null = null;

  constructor(
    readonly participantId: string,
    private readonly options: AdapterConnectOptions,
    private readonly settings: { sealWhenFull: boolean },
  ) {
    this.released = new Promise((resolve) => (this.resolveReleased = resolve));
    if (typeof jatos.setGroupFixed === "function") {
      this.sealGroup = () => this.seal();
    }
  }

  isClosed(): boolean {
    return this.state === "closed";
  }

  /**
   * Join the group once `previous` (a closed connection still leaving) has released jatos.js.
   * The abort signal, which jsPsych also aborts when its connect timeout runs out, covers the
   * whole wait.
   */
  open(previous?: Promise<void>): Promise<MultiplayerConnection> {
    return new Promise((resolve, reject) => {
      const { signal } = this.options;
      const onAbort = () => this.failOpen(new Error("JatosAdapter: connect() was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });

      this.settleOpen = {
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve(this);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };

      if (previous) {
        void previous.then(() => {
          if (this.state === "connecting") this.join(JOIN_RETRY_MIN_MS);
        });
      } else {
        this.join(JOIN_RETRY_MIN_MS);
      }
    });
  }

  /** Ask jatos.js to join the group, retrying while the previous channel is still closing. */
  private join(retryDelayMs: number) {
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
          if (this.state === "connecting" && isStillClosing(reason)) {
            // A socket from an earlier connection on this page hasn't finished closing: try
            // again shortly, until jsPsych's connect timeout aborts the attempt
            this.joinRetryTimer = setTimeout(() => {
              if (this.state === "connecting") {
                this.join(Math.min(retryDelayMs * 2, JOIN_RETRY_MAX_MS));
              }
            }, retryDelayMs);
            return;
          }
          this.failOpen(
            new Error(`JatosAdapter: failed to join group — ${reason ?? "unknown error"}`),
          );
          this.release();
        },
      );
    }
  }

  // ---------------------------------------------------------------- MultiplayerConnection

  getAll(): Record<string, unknown> {
    return this.data;
  }

  connectedParticipants(): string[] {
    return this.channels;
  }

  /**
   * Write this participant's data. Rejects at once while the channel is down, and after a few
   * quick attempts if JATOS keeps refusing the write; jsPsych retries with backoff, and pushes
   * again once the channel reopens.
   */
  async push(data: Record<string, unknown>): Promise<void> {
    await this.write(this.participantId, data);
  }

  group(): GroupState {
    if (this.roster) {
      return { size: groupSize(), members: [...this.roster].sort(), sealed: true };
    }
    return { size: groupSize(), members: this.members, sealed: false };
  }

  disconnect(): Promise<void> {
    if (this.state !== "closed") {
      this.close(new Error("JatosAdapter: the connection was disconnected."));
    }
    return this.leave();
  }

  // ---------------------------------------------------------------- sealing

  /** Fix the JATOS group, waiting for a dropped channel to reopen first. */
  private seal(): Promise<void> {
    if (this.roster) return Promise.resolve();
    this.fixing ??= (async () => {
      try {
        await this.whenOpen();
        await new Promise<void>((resolve, reject) => {
          jatos.setGroupFixed!(
            () => resolve(),
            (err) => reject(new Error(`JatosAdapter: couldn't fix the group — ${err}`)),
          );
        });
        if (this.state === "closed") return;
        this.fixed = true;
        // Nobody can join from now on, so the members JATOS lists now are the final roster
        this.refresh();
        this.addToRoster(this.members);
        this.publishSeal();
        this.options.onChange();
      } finally {
        this.fixing = null;
      }
    })();
    return this.fixing;
  }

  /**
   * With `sealWhenFull`, fix the group once it has the batch's maxActiveMembers. JATOS
   * assigns members on its server and never puts one into a full group, but a member who
   * leaves an unfixed group frees their place. Every member asks until one of them publishes
   * the seal; the server treats the extra requests as no-ops. A failed request is retried on
   * the next change.
   */
  private sealIfFull() {
    if (
      !this.settings.sealWhenFull ||
      !this.sealGroup ||
      this.roster ||
      this.fixing ||
      this.state !== "connected"
    ) {
      return;
    }
    const size = groupSize();
    if (size !== null && this.members.length >= size) {
      this.sealGroup().catch((e) => console.warn(e));
    }
  }

  /**
   * JATOS tells only the member who asked that it fixed the group, so that member publishes the
   * final roster in the group session, where every member reads it. Skipped when a record
   * already there has everyone on this member's roster; retried with backoff if the write fails,
   * and again when the channel reopens.
   */
  private publishSeal() {
    if (!this.fixed || !this.roster || this.publishingSeal || this.state !== "connected") return;
    const published = this.readSealRecord();
    if (published && [...this.roster].every((id) => published.members.includes(id))) return;
    clearTimeout(this.sealRetryTimer);
    this.publishingSeal = true;
    const record: SealRecord = { by: this.participantId, members: [...this.roster].sort() };
    this.write(SEALED_KEY, record).then(
      () => {
        this.publishingSeal = false;
        this.sealRetryDelay = 0;
      },
      (e) => {
        this.publishingSeal = false;
        if (this.state !== "connected") return; // Retried when the channel reopens
        console.warn("JatosAdapter: couldn't tell the group it is sealed; retrying", e);
        this.sealRetryDelay = Math.min(
          this.sealRetryDelay === 0 ? SEAL_RETRY_MIN_MS : this.sealRetryDelay * 2,
          SEAL_RETRY_MAX_MS,
        );
        this.sealRetryTimer = setTimeout(() => this.publishSeal(), this.sealRetryDelay);
      },
    );
  }

  /**
   * The seal record in the group session, if there is one this member trusts. JATOS lets any
   * member write any key, so a record is checked against what this member knows before it is
   * believed: its writer and this participant must be on its roster, everyone JATOS lists as a
   * member now must be too (after a real fix nobody can join, so the current members are always
   * part of the final roster), and everyone on it must have been seen as a member or have
   * written data. A record that fails is ignored, and the group stays unsealed for this member
   * until a record passes or its own fix is confirmed.
   */
  private readSealRecord(): SealRecord | null {
    const raw = (jatos.groupSession.getAll() ?? {})[SEALED_KEY];
    if (raw === undefined || raw === null) return null;
    const record = raw as Partial<SealRecord>;
    const members = Array.isArray(record.members) ? record.members.map(String) : null;
    const by = typeof record.by === "string" ? record.by : null;
    const known = (id: string) => this.seenMembers.has(id) || id in this.data;
    const trusted =
      members !== null &&
      by !== null &&
      members.includes(by) &&
      members.includes(this.participantId) &&
      this.members.every((id) => members.includes(id)) &&
      members.every(known);
    if (!trusted) {
      const json = JSON.stringify(raw);
      if (json !== this.refusedSealRecord) {
        this.refusedSealRecord = json;
        console.warn("JatosAdapter: ignoring a seal record that doesn't match the group", raw);
      }
      return null;
    }
    return { by, members };
  }

  private addToRoster(ids: Iterable<string>) {
    this.roster ??= new Set();
    for (const id of ids) this.roster.add(id);
  }

  // ---------------------------------------------------------------- jatos.js callbacks

  private handleOpen() {
    if (this.state === "closed") {
      // connect() failed or was cancelled while jatos.js was still joining, and the channel
      // opened anyway: leave the group so no one is left in it by mistake. A newer connection
      // waits for this one to release jatos.js, so this one still owns it.
      if (!this.isReleased && !this.leaving) void this.leave();
      return;
    }
    if (this.state === "connecting") {
      // Every member of a JATOS group shares its group result ID, and a study run that
      // rejoins returns to the same group, so it identifies the session
      const groupResultId = jatos.groupResultId;
      if (groupResultId === null || groupResultId === undefined || groupResultId === "") {
        this.failOpen(
          new Error("JatosAdapter: the group channel opened without a group result ID."),
        );
        if (!this.isReleased && !this.leaving) void this.leave();
        return;
      }
      this.sessionId = String(groupResultId);
    }
    this.refresh();
    if (this.state === "connecting") {
      this.state = "connected";
      const settle = this.settleOpen;
      this.settleOpen = null;
      settle?.resolve();
      this.sealIfFull();
    } else if (this.state === "reconnecting") {
      // jatos.js reopened a dropped channel
      this.state = "connected";
      for (const waiter of this.reopenWaiters.splice(0)) waiter.resolve();
      this.options.onStatus("connected");
      this.options.onChange();
      this.publishSeal();
      this.sealIfFull();
    }
  }

  private handleChange() {
    if (this.state !== "connected") return;
    this.refresh();
    this.options.onChange();
    this.publishSeal();
    this.sealIfFull();
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

  /**
   * This member's channel dropped. jatos.js keeps trying to reopen it, so the connection waits
   * as long as it takes; jsPsych's `reconnectTimeout` decides when to give up.
   */
  private handleDrop() {
    if (this.state === "connecting") {
      this.failOpen(
        new Error("JatosAdapter: the group channel closed before it finished opening."),
      );
      return;
    }
    if (this.state !== "connected") return;
    this.state = "reconnecting";
    clearTimeout(this.sealRetryTimer);
    this.options.onStatus("reconnecting");
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Read the current data, open channels, and members from jatos.js, while the channel is
   * open, and take in a seal another member published.
   */
  private refresh() {
    if (this.state === "reconnecting" || this.state === "closed") return;
    const all = jatos.groupSession.getAll() ?? {};
    const data: Record<string, unknown> = {};
    for (const key of Object.keys(all)) {
      // Keys starting with "$" are the adapter's own, such as the seal record
      if (!key.startsWith("$")) data[key] = all[key];
    }
    this.data = data;
    this.channels = (jatos.groupChannels ?? []).map(String);
    this.members = (jatos.groupMembers ?? []).map(String);
    for (const id of this.members) this.seenMembers.add(id);
    const record = this.readSealRecord();
    if (record) this.addToRoster(record.members);
  }

  /**
   * Write one group session key, with a few quick retries for JATOS's version conflicts. Each
   * attempt re-sends the same key and value, so a retry can never lose or double-apply another
   * member's write. Rejects at once if the channel is down or drops during the write.
   */
  private async write(key: string, value: unknown): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; ; attempt++) {
      if (this.state !== "connected") {
        throw withCause(
          new Error(
            this.state === "closed"
              ? "JatosAdapter: push failed because the connection is closed."
              : "JatosAdapter: push failed because the group channel is down.",
          ),
          lastError,
        );
      }
      try {
        await jatos.groupSession.set(key, value);
        this.refresh();
        return;
      } catch (err) {
        lastError = err;
        if (attempt >= WRITE_ATTEMPTS || this.state !== "connected") {
          // Preserve the underlying error so the real cause (a persistent version conflict,
          // payload too large, a dropped channel, etc.) isn't hidden behind the generic
          // message. JATOS errors are untyped strings, so we can't assert which it was.
          throw withCause(
            new Error(
              `JatosAdapter: push failed after ${attempt} attempt${attempt === 1 ? "" : "s"} ` +
                "(may include group session version conflicts)",
            ),
            lastError,
          );
        }
        const delayMs = 50 * Math.pow(2, attempt - 1) + Math.random() * 50;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private failOpen(error: Error) {
    const settle = this.settleOpen;
    if (!settle) return;
    this.settleOpen = null;
    this.close(error);
    settle.reject(error);
  }

  /**
   * Stop all callbacks and fail a pending seal. Doesn't leave the group or report status.
   * The page-wide guard is kept while a join is still in flight, so a new connection can't
   * take over jatos.js's callbacks before this channel has opened and been left, and after a
   * channel opened, until leave() has finished: jatos.js refuses to open a channel while it is
   * still leaving the group.
   */
  private close(error: Error) {
    const hadChannel = this.state === "connected" || this.state === "reconnecting";
    this.state = "closed";
    clearTimeout(this.joinRetryTimer);
    clearTimeout(this.sealRetryTimer);
    for (const waiter of this.reopenWaiters.splice(0)) waiter.reject(error);
    if (!hadChannel && !this.joinPending) this.release();
  }

  private release() {
    if (activeConnection === this) activeConnection = null;
    this.isReleased = true;
    this.resolveReleased();
  }

  /** Resolves once the channel is open; waits while jatos.js reopens a dropped one. */
  private whenOpen(): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.state === "reconnecting") {
      return new Promise((resolve, reject) => this.reopenWaiters.push({ resolve, reject }));
    }
    return Promise.reject(new Error("JatosAdapter: the connection is closed."));
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

/** The batch's maxActiveMembers, or null when it sets no limit. */
function groupSize(): number | null {
  const size = jatos.batchProperties?.maxActiveMembers;
  return typeof size === "number" && Number.isInteger(size) && size > 0 ? size : null;
}

function withCause(error: Error, cause: unknown): Error {
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}
