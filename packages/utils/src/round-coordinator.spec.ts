import { MemoryHub } from "../../../test-utils/memory-backend";
import { createRoundCoordinator, RoundCoordinator } from "./round-coordinator";

const deadlines = { response: 1000, preparation: 300, receipt: 200, feedback: 400, write: 200 };
const validate = (x: unknown): x is { choice: string } =>
  !!x && typeof x === "object" && typeof (x as any).choice === "string";
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const handles: RoundCoordinator<any>[] = [];
const clients: Awaited<ReturnType<MemoryHub["join"]>>[] = [];
afterEach(async () => {
  handles.splice(0).forEach((h) => h.dispose());
  await Promise.all(clients.splice(0).map((c) => c.jsPsych.multiplayer.disconnect()));
  jest.useRealTimers();
});
async function pair() {
  const hub = new MemoryHub();
  const m = await hub.join("m"),
    d = await hub.join("d");
  clients.push(m, d);
  jest.useFakeTimers();
  const config = { authorityId: "m", members: ["m", "d"], roundIndex: 0, deadlines, validate };
  const interval = jest.spyOn(globalThis, "setInterval");
  const a = createRoundCoordinator(m.jsPsych.multiplayer, config);
  const authorityTimer = interval.mock.results.at(-1)!.value;
  interval.mockRestore();
  const b = createRoundCoordinator(d.jsPsych.multiplayer, config);
  handles.push(a, b);
  const ready = async () => {
    a.ready();
    b.ready();
    await drain();
  };
  const advance = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    await drain();
  };
  const key = () =>
    Object.keys(m.jsPsych.multiplayer.get("m", { scope: "session" })!).find((k) =>
      k.startsWith("round_coordination_"),
    )!;
  return { hub, m, d, a, b, ready, advance, key, authorityTimer };
}

test("waits for construction, and both receipt and feedback acknowledgments", async () => {
  const p = await pair();
  p.a.ready();
  await drain();
  await p.advance(250);
  expect(p.a.state.phase).toBe("preparing");
  p.b.ready();
  await drain();
  expect(p.a.state.phase).toBe("active");
  expect(p.b.submit({ choice: "B" })).toBe(false);
  expect(p.a.submit({ choice: "A" })).toBe(true);
  await drain();
  const id = p.a.state.result!.id;
  p.a.ack("feedback", id);
  p.b.ack("result", "old");
  expect(p.a.state.phase).toBe("result");
  p.a.ack("result", id);
  p.b.ack("result", id);
  await drain();
  p.a.ack("feedback", id);
  await drain();
  expect(p.a.state.phase).toBe("result");
  p.b.ack("feedback", id);
  await drain();
  expect(p.a.state.phase).toBe("complete");
  expect(p.b.state.phase).toBe("complete");
  expect(p.a.state.pendingWrites).toBe(0);
  expect(p.b.state.result).toEqual(p.a.state.result);
  expect(Object.isFrozen(p.b.state.result!.value)).toBe(true);
});

test("selection before expiry survives late delivery and coalesced active snapshots", async () => {
  const p = await pair();
  let deliver: (() => void) | undefined;
  p.m.connection.pushImpl = (data) =>
    new Promise((resolve) => {
      deliver = () => {
        p.m.connection.write(data);
        resolve();
      };
    });
  // Director readiness reaches matcher, whose preparing/active writes are still in flight.
  p.a.ready();
  p.b.ready();
  await drain();
  expect(p.a.state.phase).toBe("active");
  expect(p.b.state.phase).toBe("preparing");
  // Confirm preparing first; the next push carries active and can coalesce into result.
  deliver!();
  await drain();
  await p.advance(150);
  expect(p.a.submit({ choice: "A" })).toBe(true);
  deliver!();
  await drain(); // release active; next push includes result
  deliver!();
  await drain();
  expect(p.b.state.result).toEqual(p.a.state.result);
  expect(p.b.state.result!.rt).toBe(150);
  expect(p.a.submit({ choice: "B" })).toBe(false);
});

test("pre-expiry result delivered beyond expiry stays a selection", async () => {
  const p = await pair();
  await p.ready();
  await p.advance(950);
  let deliver: (() => void) | undefined;
  p.m.connection.pushImpl = (data) =>
    new Promise((resolve) => {
      deliver = () => {
        p.m.connection.write(data);
        resolve();
      };
    });
  p.a.submit({ choice: "A" });
  await drain();
  await p.advance(100);
  expect(p.b.state.phase).toBe("active");
  deliver!();
  await drain();
  expect(p.b.state.result!.kind).toBe("selection");
  expect(p.b.state.result!.rt).toBe(950);
});

test("at expiry a selection loses even before the scheduled tick", async () => {
  const p = await pair();
  await p.ready();
  // Move monotonic time without running callbacks, as during an event-loop stall.
  jest.spyOn(performance, "now").mockReturnValue(1000);
  p.a.submit({ choice: "A" });
  await drain();
  expect(p.a.state.result).toMatchObject({ kind: "timeout", value: null, rt: 1000 });
  jest.restoreAllMocks();
});

test("ordinary timeout is one immutable result", async () => {
  const p = await pair();
  await p.ready();
  await p.advance(1000);
  expect(p.a.state.result!.kind).toBe("timeout");
  expect(p.b.state.result).toEqual(p.a.state.result);
  expect(p.a.submit({ choice: "late" })).toBe(false);
});

test.each(["readiness", "receipt", "feedback"])(
  "missing %s is bounded and preserves accepted results",
  async (stage) => {
    const p = await pair();
    if (stage === "readiness") {
      p.a.ready();
      await drain();
      await p.advance(300);
    } else {
      await p.ready();
      p.a.submit({ choice: "A" });
      await drain();
      p.a.ack("result", p.a.state.result!.id);
      if (stage === "feedback") p.b.ack("result", p.b.state.result!.id);
      await drain();
      await p.advance(stage === "receipt" ? 200 : 600);
    }
    expect(p.a.state.failure!.reason).toBe(
      {
        readiness: "readiness_timeout",
        receipt: "result_ack_timeout",
        feedback: "feedback_ack_timeout",
      }[stage],
    );
    expect(p.a.state.result?.kind ?? null).toBe(stage === "readiness" ? null : "selection");
  },
);

test("unconfirmed writes fail even though own writes notify synchronously", async () => {
  const p = await pair();
  p.m.connection.pushImpl = () => new Promise(() => {});
  p.a.ready();
  await p.advance(200);
  expect(p.a.state.failure!.reason).toBe("write_confirmation_timeout");
  expect(p.a.state.result).toBeNull();
});

test("write rejection becomes a bounded confirmation failure through core retry", async () => {
  const p = await pair();
  p.m.connection.pushImpl = async () => {
    throw new Error("offline");
  };
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  p.a.ready();
  await drain();
  await p.advance(200);
  expect(p.a.state.failure!.reason).toBe("write_confirmation_timeout");
  warning.mockRestore();
});

test("duplicates, stale records and unrelated participant authority cannot replace a result", async () => {
  const p = await pair();
  await p.ready();
  p.a.submit({ choice: "A" });
  await drain();
  const record = p.m.jsPsych.multiplayer.get("m", { scope: "session" })![p.key()] as any;
  await p.m.jsPsych.multiplayer.update({ [p.key()]: record }, { scope: "session" });
  p.hub.addPeer("spectator", {
    [p.key()]: {
      ...record,
      authority: {
        ...record.authority,
        result: { ...record.authority.result, value: { choice: "B" } },
      },
    },
  });
  await p.m.jsPsych.multiplayer.update(
    {
      [p.key()]: {
        ...record,
        authority: { ...record.authority, revision: 1, phase: "active", result: null },
      },
    },
    { scope: "session" },
  );
  expect(p.b.state.result!.value).toEqual({ choice: "A" });
  expect(p.b.state.failure).toBeNull();
  await p.m.jsPsych.multiplayer.update(
    {
      [p.key()]: {
        ...record,
        authority: {
          ...record.authority,
          result: { ...record.authority.result, value: { choice: "B" } },
        },
      },
    },
    { scope: "session" },
  );
  expect(p.b.state.failure!.reason).toBe("conflicting_result");
  expect(p.b.state.result!.value).toEqual({ choice: "A" });
});

test("malformed current authority and acknowledgment records fail closed", async () => {
  const p = await pair();
  await p.ready();
  const record = p.m.jsPsych.multiplayer.get("m", { scope: "session" })![p.key()] as any;
  await p.m.jsPsych.multiplayer.update(
    { [p.key()]: { ...record, feedback: "forged" } },
    { scope: "session" },
  );
  expect(p.b.state.failure!.reason).toBe("invalid_record");
});

test("transport close and explicit cancellation run failure cleanup", async () => {
  const p = await pair();
  await p.ready();
  await p.m.jsPsych.multiplayer.disconnect();
  await drain();
  expect(p.a.state.failure).not.toBeNull();
  expect(p.a.state.result).toBeNull();
  expect(p.a.submit({ choice: "A" })).toBe(false);
});

test("AbortSignal cancels without synthesizing a timeout", async () => {
  const p = await pair();
  p.a.dispose();
  p.b.dispose();
  const signal = new AbortController();
  const a = createRoundCoordinator(p.m.jsPsych.multiplayer, {
    authorityId: "m",
    members: ["m", "d"],
    roundIndex: 1,
    deadlines,
    validate,
    signal: signal.signal,
  });
  handles.push(a);
  a.ready();
  signal.abort();
  await drain();
  expect(a.state.failure!.reason).toBe("cancelled");
  expect(a.state.result).toBeNull();
});

test("reused identities are rejected; disposal releases observers and timers", async () => {
  const p = await pair();
  p.a.ready();
  await drain();
  expect(() =>
    createRoundCoordinator(p.m.jsPsych.multiplayer, {
      authorityId: "m",
      members: ["m", "d"],
      roundIndex: 0,
      deadlines,
      validate,
    }),
  ).toThrow("already used");
  const observer = jest.fn();
  const off = p.a.subscribe(observer);
  off();
  p.a.dispose();
  p.b.dispose();
  await p.advance(2000);
  expect(observer).toHaveBeenCalledTimes(1);
  expect(p.a.state.result).toBeNull();
});

test("long authority stall fails rather than inventing a timeout", async () => {
  const p = await pair();
  await p.ready();
  jest.spyOn(performance, "now").mockReturnValue(1200);
  expect(p.a.submit({ choice: "A" })).toBe(false);
  expect(p.a.state.failure!.reason).toBe("authority_stalled");
  jest.restoreAllMocks();
});

test("invalid selection and non-JSON mutation cannot publish", async () => {
  const p = await pair();
  await p.ready();
  expect(p.a.submit({ choice: 1 } as any)).toBe(false);
  expect(p.a.submit({ choice: "A", extra: undefined } as any)).toBe(false);
  expect(p.a.state.result).toBeNull();
});

test("a suspended authority timer is bounded by the observer without replacement", async () => {
  const p = await pair();
  await p.ready();
  clearInterval(p.authorityTimer);
  await p.advance(1200);
  expect(p.b.state.failure!.reason).toBe("result_delivery_timeout");
  expect(p.b.state.result).toBeNull();
  expect(p.a.state.result).toBeNull();
});

test("coalesced result plus failure preserves the accepted authority result", async () => {
  const p = await pair();
  await p.ready();
  let deliver: (() => void) | undefined;
  p.m.connection.pushImpl = (data) =>
    new Promise((resolve) => {
      deliver = () => {
        p.m.connection.write(data);
        resolve();
      };
    });
  // An unrelated push holds the sender while result and failure coalesce behind it.
  void p.m.jsPsych.multiplayer.update({ hold: true });
  await drain();
  p.a.submit({ choice: "A" });
  p.a.abort("cancelled");
  await drain();
  deliver!();
  await drain();
  deliver!();
  await drain();
  expect(p.b.state.failure!.reason).toBe("peer_cancelled");
  expect(p.b.state.result).toEqual(p.a.state.result);
});

test("lost cumulative reference fails rather than resetting readiness", async () => {
  const p = await pair();
  await p.ready();
  await p.m.jsPsych.multiplayer.replace({}, { scope: "session" });
  await drain();
  expect(p.b.state.failure!.reason).toBe("reference_lost");
  expect(p.b.state.result).toBeNull();
});

test("an actual reload identity is rejected and the peer detects departure", async () => {
  const p = await pair();
  await p.ready();
  const reloaded = await p.hub.join("m");
  clients.push(reloaded);
  const h = createRoundCoordinator(reloaded.jsPsych.multiplayer, {
    authorityId: "m",
    members: ["m", "d"],
    roundIndex: 1,
    deadlines,
    validate,
  });
  handles.push(h);
  await drain();
  expect(h.state.failure!.reason).toBe("reference_lost");
  expect(p.b.state.failure).not.toBeNull();
  expect(p.b.state.result).toBeNull();
});

test("loss of session identity and departure fail on the public lifecycle", async () => {
  const p = await pair();
  await p.ready();
  const session = jest.spyOn(p.m.jsPsych.multiplayer, "sessionId", "get").mockReturnValue("other");
  await p.advance(50);
  expect(p.a.state.failure!.reason).toBe("reference_lost");
  session.mockRestore();
});

test("complete waits for local confirmation and remains bounded when it never arrives", async () => {
  const p = await pair();
  await p.ready();
  p.a.submit({ choice: "A" });
  await drain();
  const id = p.a.state.result!.id;
  p.a.ack("result", id);
  p.b.ack("result", id);
  await drain();
  p.a.ack("feedback", id);
  await drain();
  p.m.connection.pushImpl = (data) => {
    p.m.connection.write(data);
    return new Promise(() => {});
  };
  p.b.ack("feedback", id);
  await drain();
  expect(p.a.state.phase).toBe("complete");
  expect(p.a.state.pendingWrites).toBeGreaterThan(0);
  await p.advance(200);
  expect(p.a.state.failure!.reason).toBe("write_confirmation_timeout");
  expect(p.a.state.result!.kind).toBe("selection");
});
