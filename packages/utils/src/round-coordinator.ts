import type { Multiplayer } from "./index";

export type RoundPhase = "preparing" | "active" | "result" | "complete" | "failed";
export interface RoundDeadlines {
  response: number;
  preparation: number;
  receipt: number;
  feedback: number;
  write: number;
}
export interface RoundResult<T> {
  readonly id: string;
  readonly kind: "selection" | "timeout";
  readonly value: T | null;
  /** Authority-local monotonic time from activation; not physical stimulus onset. */
  readonly rt: number;
}
export interface RoundFailure {
  readonly reason: string;
  readonly phase: RoundPhase;
  readonly reporter: string;
}
export interface RoundState<T> {
  readonly roundId: string;
  readonly phase: RoundPhase;
  readonly revision: number;
  readonly result: RoundResult<T> | null;
  readonly failure: RoundFailure | null;
  readonly pendingWrites: number;
}
export interface RoundCoordinator<T> {
  readonly state: RoundState<T>;
  readonly authorityId: string;
  readonly members: readonly string[];
  ready(): void;
  submit(value: T): boolean;
  ack(stage: "result" | "feedback", resultId: string): void;
  subscribe(callback: (state: RoundState<T>) => void): () => void;
  abort(reason?: string): void;
  /** Release resources after complete/failure; does not announce a behavioral result. */
  dispose(): void;
}
export interface RoundCoordinatorOptions<T> {
  authorityId: string;
  members: readonly string[];
  roundIndex: number;
  deadlines: RoundDeadlines;
  /** Must accept only the JSON payloads this round permits, on both clients. */
  validate: (value: unknown) => value is T;
  signal?: AbortSignal;
}

interface Authority<T> {
  roundId: string;
  revision: number;
  phase: RoundPhase;
  result: RoundResult<T> | null;
}
interface RecordState<T> {
  roundId: string;
  deadlines: RoundDeadlines;
  ready: boolean;
  received: string | null;
  feedback: string | null;
  failure: RoundFailure | null;
  authority?: Authority<T>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const object = (x: unknown): x is Record<string, any> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
// JSON objects have no property-order semantics. Compare canonical values, not stringify order.
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/**
 * Cooperative fixed-authority dyad protocol over public multiplayer session snapshots.
 * All budgets run on the local monotonic clock. No scoring, rendering or precision clock.
 */
export function createRoundCoordinator<T>(
  multiplayer: Multiplayer,
  options: RoundCoordinatorOptions<T>,
): RoundCoordinator<T> {
  const me = multiplayer.participantId,
    session = multiplayer.sessionId;
  const members = Object.freeze([...options.members]);
  const authorityId = options.authorityId;
  const deadlines = freeze(clone(options.deadlines));
  const names = ["response", "preparation", "receipt", "feedback", "write"] as const;
  if (
    !me ||
    !session ||
    members.length !== 2 ||
    new Set(members).size !== 2 ||
    members.some((id) => typeof id !== "string" || !id) ||
    !members.includes(me) ||
    !members.includes(authorityId) ||
    !Number.isSafeInteger(options.roundIndex) ||
    options.roundIndex < 0 ||
    typeof options.validate !== "function" ||
    names.some((k) => !Number.isFinite(deadlines[k]) || deadlines[k] <= 0)
  ) {
    throw new TypeError(
      "createRoundCoordinator: connected fixed dyad, round index, validator and positive deadlines required.",
    );
  }
  const roundId = JSON.stringify([session, authorityId, options.roundIndex]);
  const resultId = roundId + ":result";
  // Encode the tuple so keys are portable through adapters; do not use a trial scope.
  const key = "round_coordination_" + encodeURIComponent(roundId).replace(/\./g, "%2E");
  if (multiplayer.get(me, { scope: "session" })?.[key] !== undefined) {
    throw new Error(
      "createRoundCoordinator: round identity already used; reload/replay is unsupported.",
    );
  }
  let authority: Authority<T> = { roundId, revision: 0, phase: "preparing", result: null };
  const own: RecordState<T> = {
    roundId,
    deadlines,
    ready: false,
    received: null,
    feedback: null,
    failure: null,
  };
  const peers = new Map<string, RecordState<T>>();
  const writes = new Map<number, number>();
  const listeners = new Set<(state: RoundState<T>) => void>();
  const controller = new AbortController();
  let failure: RoundFailure | null = null,
    disposed = false,
    sequence = 0;
  let phaseAt = performance.now(),
    activeAt: number | null = null;
  let notifying = false,
    again = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const state = (): RoundState<T> =>
    freeze(
      clone({
        ...authority,
        phase: failure ? "failed" : authority.phase,
        failure,
        pendingWrites: writes.size,
      }),
    );
  function notify() {
    if (notifying) {
      again = true;
      return;
    }
    notifying = true;
    try {
      do {
        again = false;
        const snapshot = state();
        for (const callback of [...listeners]) {
          if (!listeners.has(callback)) continue;
          try {
            callback(snapshot);
          } catch (error) {
            console.error("Round coordinator subscriber failed", error);
          }
        }
      } while (again && !disposed);
    } finally {
      notifying = false;
    }
  }
  function wire() {
    if (me === authorityId) own.authority = clone(authority);
    return clone(own);
  }
  function fail(reason: string) {
    if (failure || disposed) return;
    failure = freeze({ reason, phase: authority.phase, reporter: me! });
    own.failure = failure;
    // Accepted results remain intact. Failure announcement is best effort and never recursive.
    try {
      Promise.resolve(multiplayer.update({ [key]: wire() }, { scope: "session" })).catch(() => {});
    } catch {}
    clearInterval(timer);
    controller.abort();
    options.signal?.removeEventListener("abort", onAbort);
    notify();
  }
  function publish() {
    if (disposed || failure) return;
    peers.set(me!, clone(own));
    const seq = ++sequence;
    writes.set(seq, performance.now());
    try {
      Promise.resolve(multiplayer.update({ [key]: wire() }, { scope: "session" })).then(
        () => {
          if (disposed || !writes.delete(seq)) return;
          notify();
        },
        () => {
          writes.delete(seq);
          fail("transport_write_failed");
        },
      );
    } catch {
      writes.delete(seq);
      fail("transport_write_failed");
    }
    notify();
  }
  function transition(phase: RoundPhase, result = authority.result) {
    authority = { roundId, revision: authority.revision + 1, phase, result };
    phaseAt = performance.now();
    publish();
  }
  function advance() {
    if (disposed || failure || me !== authorityId) return;
    if (authority.phase === "preparing" && members.every((id) => peers.get(id)?.ready)) {
      activeAt = performance.now();
      transition("active");
    }
    if (
      authority.phase === "result" &&
      members.every(
        (id) => peers.get(id)?.received === resultId && peers.get(id)?.feedback === resultId,
      )
    )
      transition("complete");
  }
  function valid(value: unknown): value is T {
    try {
      return options.validate(value);
    } catch {
      return false;
    }
  }
  function validAuthority(a: any): a is Authority<T> {
    if (!object(a) || a.roundId !== roundId || !Number.isSafeInteger(a.revision)) return false;
    // Each authoritative transition increments once; snapshots may skip phases.
    const revisions = { preparing: 0, active: 1, result: 2, complete: 3 };
    if (!(a.phase in revisions) || a.revision !== revisions[a.phase as keyof typeof revisions])
      return false;
    if (a.phase === "preparing" || a.phase === "active") return a.result === null;
    const r = a.result;
    return (
      object(r) &&
      r.id === resultId &&
      Number.isFinite(r.rt) &&
      r.rt >= 0 &&
      (r.kind === "timeout"
        ? r.value === null && r.rt === deadlines.response
        : r.kind === "selection" && r.rt < deadlines.response && valid(r.value))
    );
  }
  function observe(sender: string, raw: unknown) {
    if (disposed || failure || !members.includes(sender) || !object(raw) || raw.roundId !== roundId)
      return;
    if (
      names.some((k) => raw.deadlines?.[k] !== deadlines[k]) ||
      typeof raw.ready !== "boolean" ||
      ![null, resultId].includes(raw.received) ||
      ![null, resultId].includes(raw.feedback) ||
      (raw.feedback !== null && raw.received !== resultId) ||
      (!raw.ready && (raw.received !== null || raw.feedback !== null)) ||
      (raw.authority !== undefined && sender !== authorityId)
    ) {
      fail("invalid_record");
      return;
    }
    let peerFailure: string | null = null;
    if (raw.failure !== null) {
      const f = raw.failure;
      if (
        !object(f) ||
        f.reporter !== sender ||
        typeof f.reason !== "string" ||
        !f.reason ||
        !["preparing", "active", "result", "complete"].includes(f.phase)
      )
        fail("invalid_record");
      else peerFailure = "peer_" + f.reason;
      if (failure) return;
    }
    const previous = peers.get(sender);
    peers.set(sender, {
      ...clone(raw as RecordState<T>),
      ready: previous?.ready || raw.ready,
      received: previous?.received || raw.received,
      feedback: previous?.feedback || raw.feedback,
    });
    if (sender === authorityId && sender !== me) {
      const a = raw.authority;
      if (!validAuthority(a) || (a.phase !== "preparing" && !raw.ready)) {
        fail("invalid_authority_state");
        return;
      }
      if (a.revision < authority.revision) {
        if (peerFailure) fail(peerFailure);
        return;
      }
      if (authority.result && canonical(a.result) !== canonical(authority.result)) {
        fail("conflicting_result");
        return;
      }
      if (a.revision === authority.revision) {
        if (canonical(a) !== canonical(authority)) fail("conflicting_revision");
        if (peerFailure) fail(peerFailure);
        return;
      }
      authority = freeze(clone(a));
      phaseAt = performance.now();
      if (a.phase === "active") activeAt = phaseAt;
      if (!peerFailure) notify();
    }
    if (peerFailure) {
      fail(peerFailure);
      return;
    }
    if (raw.received !== null && authority.result === null) {
      fail("premature_acknowledgment");
      return;
    }
    advance();
  }
  function checkReference(): boolean {
    if (
      multiplayer.participantId !== me ||
      multiplayer.sessionId !== session ||
      multiplayer.restarted
    )
      fail("reference_lost");
    else if (multiplayer.status === "closed") fail("transport_closed");
    else if (members.some((id) => multiplayer.presence()[id] === "left")) fail("participant_left");
    return !failure && !disposed;
  }
  function commit(value: T | null): boolean {
    if (
      !checkReference() ||
      me !== authorityId ||
      authority.phase !== "active" ||
      activeAt === null
    )
      return false;
    const elapsed = performance.now() - activeAt;
    if (elapsed >= deadlines.response + deadlines.receipt) {
      fail("authority_stalled");
      return false;
    }
    const timeout = elapsed >= deadlines.response;
    if (!timeout && !valid(value)) return false;
    transition(
      "result",
      freeze({
        id: resultId,
        kind: timeout ? "timeout" : "selection",
        value: timeout ? null : clone(value),
        rt: timeout ? deadlines.response : elapsed,
      }),
    );
    return true;
  }
  function tick() {
    if (!checkReference()) return;
    const now = performance.now(),
      elapsed = now - phaseAt;
    if ([...writes.values()].some((at) => now - at >= deadlines.write)) {
      fail("write_confirmation_timeout");
      return;
    }
    if (authority.phase === "preparing" && elapsed >= deadlines.preparation)
      fail("readiness_timeout");
    else if (authority.phase === "active") {
      if (me === authorityId && activeAt !== null && now - activeAt >= deadlines.response)
        commit(null);
      else if (me !== authorityId && elapsed >= deadlines.response + deadlines.receipt)
        fail("result_delivery_timeout");
    } else if (authority.phase === "result") {
      if (
        me === authorityId &&
        elapsed >= deadlines.receipt &&
        members.some((id) => peers.get(id)?.received !== resultId)
      )
        fail("result_ack_timeout");
      else if (elapsed >= deadlines.receipt + deadlines.feedback) fail("feedback_ack_timeout");
    }
  }
  function onAbort() {
    fail("cancelled");
  }
  const handle: RoundCoordinator<T> = {
    get state() {
      return state();
    },
    authorityId,
    members,
    ready() {
      tick();
      if (checkReference() && !own.ready) {
        own.ready = true;
        publish();
        advance();
      }
    },
    submit(value) {
      // Reject non-JSON values instead of silently altering the submitted payload.
      try {
        const copy = clone(value);
        if (canonical(copy) !== canonical(value)) return false;
        return commit(copy);
      } catch {
        return false;
      }
    },
    ack(stage, id) {
      tick();
      if (!checkReference() || authority.result?.id !== id || !own.ready) return;
      if (stage === "result" && own.received === null) own.received = id;
      else if (stage === "feedback" && own.received === id && own.feedback === null)
        own.feedback = id;
      else return;
      publish();
      advance();
    },
    subscribe(callback) {
      listeners.add(callback);
      callback(state());
      return () => listeners.delete(callback);
    },
    abort(reason = "cancelled") {
      fail(reason || "cancelled");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      controller.abort();
      options.signal?.removeEventListener("abort", onAbort);
      listeners.clear();
      writes.clear();
    },
  };
  if (options.signal?.aborted) fail("cancelled");
  else if (checkReference()) {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    multiplayer.subscribe(
      (data) => {
        if (!checkReference()) return;
        tick();
        if (failure || disposed) return;
        for (const id of members) {
          if (peers.has(id) && data[id]?.[key] === undefined) {
            fail("reference_lost");
            return;
          }
          observe(id, data[id]?.[key]);
        }
      },
      { scope: "session", signal: controller.signal },
    );
    if (!failure) {
      multiplayer
        .wait(() => false, { scope: "session", signal: controller.signal })
        .catch((error) => {
          if (!disposed && !failure)
            fail(error?.code === "cancelled" ? "cancelled" : "transport_closed");
        });
      timer = setInterval(tick, Math.min(50, ...names.map((k) => deadlines[k])));
    }
  }
  return handle;
}
