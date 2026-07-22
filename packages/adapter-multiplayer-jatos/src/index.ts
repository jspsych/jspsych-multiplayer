import { GroupSessionData, MultiplayerAdapter, Unsubscribe } from "./multiplayer-adapter";

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
  /** Join a group study and open the WebSocket channel. */
  joinGroup(callbacks: {
    onOpen?: () => void;
    onMemberOpen?: (memberId: string) => void;
    onMemberClose?: (memberId: string) => void;
    onMessage?: (msg: unknown) => void;
    onGroupSession?: () => void;
    onError?: (errMsg: string) => void;
    onClose?: () => void;
  }): void;
  /** Shared persistent key-value store for the group. */
  groupSession: {
    get(key: string): Record<string, unknown> | undefined;
    set(key: string, value: unknown): Promise<void>;
    getAll(): Record<string, unknown> | null;
  };
  /**
   * Leave the group and close the WebSocket channel. Older jatos.js builds may
   * not expose this, so the adapter guards for its absence before calling.
   */
  leaveGroup?(onSuccess?: () => void, onFail?: (err: unknown) => void): void;
};

/**
 * Multiplayer adapter backed by JATOS group studies.
 *
 * Usage:
 *   const jsPsych = initJsPsych({ ... });
 *   await jsPsych.multiplayer.connect(new JatosAdapter());
 *   await jsPsych.run(timeline);
 *
 * Each participant's pushed data is stored under groupSession[studyResultId]
 * (JATOS's group member id), so keys never collide across participants.
 *
 * @author Hannah Tsukamoto
 */
export default class JatosAdapter implements MultiplayerAdapter {
  readonly participantId: string;

  /** Set once the group channel is open; push() requires it. */
  private connected = false;

  /**
   * Set when a channel that was previously open goes down (onClose, or an onError delivered
   * after onOpen). Distinguishes "the channel dropped" from "never connected" so push()
   * reports the accurate cause instead of the generic "call connect() first".
   */
  private channelClosed = false;

  /**
   * Local fan-out list. jatos.onGroupSession accepts only a single callback,
   * so the adapter registers one dispatcher and routes it to all subscribers.
   */
  private subscribers = new Set<(data: GroupSessionData) => void>();

  /**
   * The promise from the first connect() call. connect() is not re-entrant —
   * calling jatos.joinGroup twice would double-register the lifecycle callbacks —
   * so subsequent calls get the same in-flight/settled promise back.
   */
  private connectPromise: Promise<void> | null = null;

  /** Maximum time to wait for the group channel to open before giving up, in ms. */
  private readonly connectTimeoutMs: number;

  constructor(options: { connectTimeoutMs?: number } = {}) {
    if (typeof jatos === "undefined") {
      throw new Error(
        "JatosAdapter: the jatos global is not defined. " +
          "Ensure jatos.js is loaded before creating a JatosAdapter. " +
          "This adapter only works when the experiment is running inside JATOS."
      );
    }
    // Key by studyResultId: it is unique per study run, whereas workerId can repeat
    // when the same worker runs the study more than once — two runs keyed by workerId
    // would collide in the group session. jatos.groupMemberId is the canonical name
    // for this id but CANNOT be read here: jatos.js leaves it null until the first
    // group message arrives after joinGroup(), long after this constructor runs —
    // and then merely assigns it from studyResultId. So studyResultId IS the group
    // member id, just available up front. Fall back to workerId if it is absent.
    this.participantId = String(jatos.studyResultId ?? jatos.workerId);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
  }

  connect(): Promise<void> {
    // Re-entry guard: hand back the existing promise instead of joining twice.
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }
    this.connectPromise = new Promise((resolve, reject) => {
      // onOpen reports the channel opening (not the group filling), so it should arrive
      // promptly. If JATOS delivers neither onOpen nor onError — a dropped handshake or
      // unreachable server mid-connect — the promise would otherwise hang forever and the
      // experiment would stall with no diagnostic. Bound the wait and fail loudly instead.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `JatosAdapter: timed out after ${this.connectTimeoutMs} ms waiting for the ` +
              "group channel to open. JATOS reported neither success nor failure — the server may " +
              "be unreachable or the handshake was dropped."
          )
        );
      }, this.connectTimeoutMs);

      jatos.joinGroup({
        onOpen: () => {
          // Restore the flags before the settled guard: jatos.js can close the channel
          // (onClose) and later reopen it, and that reopen fires onOpen long after the
          // connect promise settled. Skipping the flags here would leave push() dead
          // forever while subscriptions kept firing.
          this.connected = true;
          this.channelClosed = false;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        onGroupSession: () => {
          const data = this.getAll();
          for (const cb of this.subscribers) {
            // Isolate subscribers: one throwing listener must not stop the fan-out
            // to the others (and must not escape into jatos.js's callback).
            try {
              cb(data);
            } catch (err) {
              console.error("JatosAdapter: a group-session subscriber threw", err);
            }
          }
        },
        onError: (errMsg) => {
          // An error delivered before onOpen rejects the connect promise. One delivered
          // after (the channel was up, then failed) can't reject an already-settled promise,
          // so mark the channel down — otherwise push() would keep retrying a dead channel.
          if (settled) {
            this.connected = false;
            this.channelClosed = true;
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(new Error(`JatosAdapter: failed to join group — ${errMsg ?? "unknown error"}`));
        },
        onClose: () => {
          // The channel closed mid-session. Flip the flags so push()'s guard is accurate and
          // its retry loop bails instead of spinning against a dead channel. Subscribers are
          // left intact — a close isn't necessarily permanent, and disconnect() owns teardown.
          this.connected = false;
          this.channelClosed = true;
        },
      });
    });
    // A failed connect should not poison future attempts: clear the cache on rejection
    // so connect() can be called again. The caller still receives the rejection — this
    // internal handler only resets the guard.
    const promise = this.connectPromise;
    promise.catch(() => {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    });
    return promise;
  }

  async push(data: Record<string, unknown>): Promise<void> {
    if (!this.connected) {
      throw new Error(
        this.channelClosed
          ? "JatosAdapter: push() called after the group channel closed."
          : "JatosAdapter: push() called before connect(); call connect() first."
      );
    }
    // JATOS group session uses optimistic concurrency: concurrent writes from
    // multiple participants cause version conflicts. Retry with exponential
    // backoff + jitter so the retries spread out and don't re-collide. Each retry
    // re-sends the same (participantId -> data) write, so a retry can never lose
    // or double-apply another participant's update.
    const maxAttempts = 8;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // If the channel closed (onClose/late onError flipped this), retrying is pointless —
      // every attempt would fail and we'd burn the full backoff budget before giving up.
      // Bail immediately with an accurate message. Re-checked each iteration so a close that
      // lands during a backoff sleep is caught before the next attempt, not after all 8.
      if (!this.connected) {
        const wrapped = new Error("JatosAdapter: push failed because the group channel is closed.");
        if (lastError !== undefined) {
          (wrapped as Error & { cause?: unknown }).cause = lastError;
        }
        throw wrapped;
      }
      try {
        await jatos.groupSession.set(this.participantId, data);
        return;
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts - 1) {
          // Preserve the underlying error so the real cause (a persistent version conflict,
          // payload too large, etc.) isn't hidden behind the generic message. JATOS errors
          // are untyped strings, so we can't assert which it was — hence "may include".
          const wrapped = new Error(
            "JatosAdapter: push failed after 8 attempts (may include repeated group session version conflicts)"
          );
          (wrapped as Error & { cause?: unknown }).cause = lastError;
          throw wrapped;
        }
        const delayMs = 50 * Math.pow(2, attempt) + Math.random() * 50;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  getAll(): GroupSessionData {
    return (jatos.groupSession.getAll() ?? {}) as GroupSessionData;
  }

  get(participantId: string): Record<string, unknown> | undefined {
    return jatos.groupSession.get(participantId);
  }

  subscribe(callback: (data: GroupSessionData) => void): Unsubscribe {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  disconnect(): Promise<void> {
    this.subscribers.clear();
    this.connected = false;
    // Full teardown resets the re-entry guard so a fresh connect() can rejoin the group.
    this.connectPromise = null;
    // Close the channel cleanly by leaving the group. Resolve on either outcome —
    // the local teardown above has already happened — and guard for older jatos.js
    // builds that don't expose leaveGroup.
    return new Promise((resolve) => {
      if (typeof jatos.leaveGroup === "function") {
        jatos.leaveGroup(
          () => resolve(),
          () => resolve()
        );
      } else {
        resolve();
      }
    });
  }
}
