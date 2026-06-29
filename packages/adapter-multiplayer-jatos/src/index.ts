import { GroupSessionData, MultiplayerAdapter, Unsubscribe } from "./multiplayer-adapter";

/**
 * Minimal ambient types for the jatos global injected by jatos.js.
 * Only the subset used by this adapter is declared here.
 */
declare const jatos: {
  /** Worker ID assigned by JATOS — used as the per-participant namespace key. */
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
 *   await jsPsych.pluginAPI.connect(new JatosAdapter());
 *   await jsPsych.run(timeline);
 *
 * Each participant's pushed data is stored under groupSession[workerId],
 * so keys never collide across participants.
 *
 * @author Hannah Tsukamoto
 */
export default class JatosAdapter implements MultiplayerAdapter {
  readonly participantId: string;

  /** Set once the group channel is open; push() requires it. */
  private connected = false;

  /**
   * Local fan-out list. jatos.onGroupSession accepts only a single callback,
   * so the adapter registers one dispatcher and routes it to all subscribers.
   */
  private subscribers = new Set<(data: GroupSessionData) => void>();

  constructor() {
    if (typeof jatos === "undefined") {
      throw new Error(
        "JatosAdapter: the jatos global is not defined. " +
          "Ensure jatos.js is loaded before creating a JatosAdapter. " +
          "This adapter only works when the experiment is running inside JATOS."
      );
    }
    this.participantId = String(jatos.workerId);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      jatos.joinGroup({
        onOpen: () => {
          this.connected = true;
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
          reject(new Error(`JatosAdapter: failed to join group — ${errMsg ?? "unknown error"}`));
        },
      });
    });
  }

  async push(data: Record<string, unknown>): Promise<void> {
    if (!this.connected) {
      throw new Error("JatosAdapter: push() called before connect(); call connect() first.");
    }
    // JATOS group session uses optimistic concurrency: concurrent writes from
    // multiple participants cause version conflicts. Retry with exponential
    // backoff + jitter so the retries spread out and don't re-collide. Each retry
    // re-sends the same (participantId -> data) write, so a retry can never lose
    // or double-apply another participant's update.
    const maxAttempts = 8;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await jatos.groupSession.set(this.participantId, data);
        return;
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts - 1) {
          // Preserve the underlying error so a non-conflict failure (channel down,
          // payload too large) isn't hidden behind the generic message.
          const wrapped = new Error(
            "JatosAdapter: push failed after 8 attempts (likely repeated group session version conflicts)"
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
