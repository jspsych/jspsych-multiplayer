import type { GroupSessionData } from "./multiplayer-adapter";
import JatosAdapter from ".";

/**
 * These tests drive the adapter against a mock of the `jatos` global injected by
 * jatos.js. The mock keeps a stateful group-session store and lets each test fire
 * the joinGroup lifecycle callbacks (onOpen / onError / onGroupSession) by hand.
 *
 * Note on subscribe(): the adapter's subscribe() is intentionally *future-only* —
 * it fans out on every onGroupSession event and does not replay the current
 * snapshot on registration. The core MultiplayerAPI (jsPsych#3694) now performs
 * replay-on-registration itself, emitting the current snapshot once when it wraps
 * this adapter's subscribe(); keeping the adapter future-only is exactly what that
 * relies on — an adapter that also replayed would make core emit the snapshot twice.
 */

/** Build a controllable mock of the jatos global plus helpers to drive its callbacks. */
function makeMockJatos(workerId: string | number = "w1") {
  const store: Record<string, unknown> = {};
  let callbacks: Record<string, ((arg?: unknown) => void) | undefined> = {};

  const jatos = {
    workerId,
    joinGroup: jest.fn((cbs: Record<string, (arg?: unknown) => void>) => {
      callbacks = cbs;
    }),
    groupSession: {
      get: jest.fn((key: string) => store[key]),
      set: jest.fn(async (key: string, value: unknown) => {
        store[key] = value;
      }),
      getAll: jest.fn(() => ({ ...store })),
    },
    leaveGroup: jest.fn((onSuccess?: () => void) => onSuccess?.()),
  };

  return {
    jatos,
    store,
    fireOpen: () => callbacks.onOpen?.(),
    fireGroupSession: () => callbacks.onGroupSession?.(),
    fireError: (msg?: string) => callbacks.onError?.(msg),
    fireClose: () => callbacks.onClose?.(),
  };
}

let mock: ReturnType<typeof makeMockJatos>;

beforeEach(() => {
  mock = makeMockJatos();
  (globalThis as Record<string, unknown>).jatos = mock.jatos;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).jatos;
  jest.useRealTimers();
});

/** Construct an adapter and complete the connect handshake. */
async function connectedAdapter() {
  const adapter = new JatosAdapter();
  const promise = adapter.connect();
  mock.fireOpen();
  await promise;
  return adapter;
}

describe("construction", () => {
  test("throws a helpful error when the jatos global is missing", () => {
    delete (globalThis as Record<string, unknown>).jatos;
    expect(() => new JatosAdapter()).toThrow(/jatos global is not defined/);
  });

  test("derives participantId from the worker id as a string", () => {
    (globalThis as Record<string, unknown>).jatos = makeMockJatos(12345).jatos;
    expect(new JatosAdapter().participantId).toBe("12345");
  });
});

describe("connect", () => {
  test("resolves once the group channel opens", async () => {
    const adapter = new JatosAdapter();
    const promise = adapter.connect();
    mock.fireOpen();
    await expect(promise).resolves.toBeUndefined();
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(1);
  });

  test("rejects, surfacing the error message, if joining the group fails", async () => {
    const adapter = new JatosAdapter();
    const promise = adapter.connect();
    mock.fireError("boom");
    await expect(promise).rejects.toThrow(/boom/);
  });

  test("rejects with a diagnostic if neither onOpen nor onError ever fires", async () => {
    jest.useFakeTimers();
    const adapter = new JatosAdapter();
    const promise = adapter.connect();
    const assertion = promise.catch((e: unknown) => e);

    // JATOS never calls back; the bounded wait should reject instead of hanging forever.
    await jest.runAllTimersAsync();
    const err = (await assertion) as Error;

    expect(err.message).toMatch(/timed out/);
  });
});

describe("reads", () => {
  test("getAll() returns the full store", async () => {
    const adapter = await connectedAdapter();
    mock.store.w1 = { a: 1 };
    mock.store.w2 = { b: 2 };
    expect(adapter.getAll()).toEqual({ w1: { a: 1 }, w2: { b: 2 } });
  });

  test("getAll() returns {} when JATOS reports a null session", async () => {
    const adapter = await connectedAdapter();
    mock.jatos.groupSession.getAll.mockReturnValueOnce(null);
    expect(adapter.getAll()).toEqual({});
  });

  test("get() reads a single participant's entry, or undefined", async () => {
    const adapter = await connectedAdapter();
    mock.store.w2 = { name: "Bob" };
    expect(adapter.get("w2")).toEqual({ name: "Bob" });
    expect(adapter.get("nobody")).toBeUndefined();
  });
});

describe("subscribe", () => {
  test("fans out every group-session update to all subscribers", async () => {
    const adapter = await connectedAdapter();
    const a: GroupSessionData[] = [];
    const b: GroupSessionData[] = [];
    adapter.subscribe((data) => a.push(data));
    adapter.subscribe((data) => b.push(data));

    mock.store.w1 = { hi: 1 };
    mock.fireGroupSession();

    expect(a).toEqual([{ w1: { hi: 1 } }]);
    expect(b).toEqual([{ w1: { hi: 1 } }]);
  });

  test("does not replay current state on registration (future-only)", async () => {
    const adapter = await connectedAdapter();
    mock.store.w1 = { already: "here" };
    const received: GroupSessionData[] = [];
    adapter.subscribe((data) => received.push(data));
    // No callback until the next group-session event.
    expect(received).toHaveLength(0);
    mock.fireGroupSession();
    expect(received).toHaveLength(1);
  });

  test("a throwing subscriber does not stop the fan-out to the others", async () => {
    const adapter = await connectedAdapter();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const received: GroupSessionData[] = [];
    adapter.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    adapter.subscribe((data) => received.push(data));

    mock.store.w1 = { hi: 1 };
    expect(() => mock.fireGroupSession()).not.toThrow();
    expect(received).toEqual([{ w1: { hi: 1 } }]);

    errSpy.mockRestore();
  });

  test("unsubscribe stops further updates without affecting other subscribers", async () => {
    const adapter = await connectedAdapter();
    const kept: GroupSessionData[] = [];
    const dropped: GroupSessionData[] = [];
    adapter.subscribe((data) => kept.push(data));
    const unsub = adapter.subscribe((data) => dropped.push(data));

    mock.fireGroupSession();
    unsub();
    mock.fireGroupSession();

    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
  });
});

describe("push", () => {
  test("writes data keyed by participantId", async () => {
    const adapter = await connectedAdapter();
    await adapter.push({ score: 5 });
    expect(mock.jatos.groupSession.set).toHaveBeenCalledWith("w1", { score: 5 });
  });

  test("throws if push() is called before connect()", async () => {
    const adapter = new JatosAdapter();
    await expect(adapter.push({ x: 1 })).rejects.toThrow(/before connect/);
    expect(mock.jatos.groupSession.set).not.toHaveBeenCalled();
  });

  test("retries on a version conflict and eventually succeeds", async () => {
    jest.useFakeTimers();
    const adapter = await connectedAdapter();
    let calls = 0;
    mock.jatos.groupSession.set.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error("version conflict");
    });

    const promise = adapter.push({ x: 1 });
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    expect(calls).toBe(3);
    // Every attempt must re-send the SAME (participantId -> data) write, so a retry
    // can't lose or mutate the value — the property that makes retrying safe.
    expect(mock.jatos.groupSession.set.mock.calls).toEqual([
      ["w1", { x: 1 }],
      ["w1", { x: 1 }],
      ["w1", { x: 1 }],
    ]);
  });

  test("throws after exhausting all retry attempts, preserving the cause", async () => {
    jest.useFakeTimers();
    const adapter = await connectedAdapter();
    const underlying = new Error("version conflict");
    mock.jatos.groupSession.set.mockRejectedValue(underlying);

    const promise = adapter.push({ x: 1 });
    // Attach the rejection expectation before advancing timers so the eventual
    // rejection is never momentarily unhandled.
    const assertion = promise.catch((e: unknown) => e);
    await jest.runAllTimersAsync();
    const err = (await assertion) as Error & { cause?: unknown };

    expect(err.message).toMatch(/after 8 attempts/);
    expect(err.cause).toBe(underlying);
    expect(mock.jatos.groupSession.set).toHaveBeenCalledTimes(8);
  });
});

describe("channel lifecycle", () => {
  test("push() bails immediately, without retrying, after the channel closes", async () => {
    const adapter = await connectedAdapter();
    mock.fireClose();

    await expect(adapter.push({ x: 1 })).rejects.toThrow(/channel closed/);
    // No set() attempt and no 6s of backoff: the closed channel is caught up front.
    expect(mock.jatos.groupSession.set).not.toHaveBeenCalled();
  });

  test("a close landing mid-retry stops the remaining attempts", async () => {
    jest.useFakeTimers();
    const adapter = await connectedAdapter();
    let calls = 0;
    mock.jatos.groupSession.set.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) mock.fireClose(); // channel dies during the second attempt's backoff
      throw new Error("version conflict");
    });

    const promise = adapter.push({ x: 1 });
    const assertion = promise.catch((e: unknown) => e);
    await jest.runAllTimersAsync();
    const err = (await assertion) as Error & { cause?: unknown };

    // Two attempts ran; the post-backoff re-check then bailed instead of finishing all 8.
    expect(calls).toBe(2);
    expect(err.message).toMatch(/channel is closed/);
    expect(err.cause).toBeInstanceOf(Error); // the version-conflict error from the last attempt
  });

  test("an error delivered after the channel opened marks it closed", async () => {
    const adapter = await connectedAdapter();
    // A late onError can't reject the already-resolved connect promise, but it must still
    // bring down the channel so push() reports it accurately rather than retrying blindly.
    mock.fireError("socket dropped");

    await expect(adapter.push({ x: 1 })).rejects.toThrow(/channel closed/);
    expect(mock.jatos.groupSession.set).not.toHaveBeenCalled();
  });
});

describe("disconnect", () => {
  test("clears subscribers so later updates are ignored", async () => {
    const adapter = await connectedAdapter();
    const received: GroupSessionData[] = [];
    adapter.subscribe((data) => received.push(data));

    await adapter.disconnect();
    mock.fireGroupSession();

    expect(received).toHaveLength(0);
  });

  test("leaves the JATOS group to close the channel", async () => {
    const adapter = await connectedAdapter();
    await adapter.disconnect();
    expect(mock.jatos.leaveGroup).toHaveBeenCalledTimes(1);
  });

  test("resolves even when jatos.js does not expose leaveGroup", async () => {
    const adapter = await connectedAdapter();
    (mock.jatos as { leaveGroup?: unknown }).leaveGroup = undefined;
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });
});
