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
function makeMockJatos(
  // Pass null to simulate a context where studyResultId is not populated.
  studyResultId: string | number | null = "w1",
  workerId: string | number = "worker-99",
) {
  const store: Record<string, unknown> = {};
  let callbacks: Record<string, ((arg?: unknown) => void) | undefined> = {};
  let groupOpening = false;

  const jatos = {
    // Mirrors real jatos.js semantics: groupMemberId is null until the first group
    // message arrives AFTER joinGroup (updateGroupVars then assigns it from
    // studyResultId). It is NEVER populated at construction time, so the adapter
    // must not read it in its constructor — keeping it null here makes any such
    // regression fail the participantId tests instead of silently passing.
    groupMemberId: null,
    studyResultId: studyResultId ?? undefined,
    workerId,
    groupResultId: null as string | number | null,
    groupMembers: [] as Array<string | number>,
    groupChannels: [] as Array<string | number>,
    joinGroup: jest.fn((cbs: Record<string, (arg?: unknown) => void>) => {
      callbacks = cbs;
      groupOpening = true;
    }),
    groupSession: {
      get: jest.fn((key: string) => store[key]),
      set: jest.fn(async (key: string, value: unknown) => {
        store[key] = value;
      }),
      getAll: jest.fn(() => ({ ...store })),
    },
    leaveGroup: jest.fn((onSuccess?: () => void, onFail?: (error: unknown) => void) => {
      if (groupOpening) {
        onFail?.("Can't leave group if not joined yet.");
      } else {
        onSuccess?.();
      }
    }),
    setGroupFixed: jest.fn((onSuccess?: () => void) => onSuccess?.()),
  };

  return {
    jatos,
    store,
    fireOpen: (groupId = "group-7") => {
      groupOpening = false;
      jatos.groupResultId = groupId;
      jatos.groupMembers = [String(studyResultId ?? workerId)];
      jatos.groupChannels = [String(studyResultId ?? workerId)];
      callbacks.onOpen?.();
    },
    fireGroupSession: () => callbacks.onGroupSession?.(),
    fireError: (msg?: string) => {
      groupOpening = false;
      callbacks.onError?.(msg);
    },
    fireClose: () => {
      groupOpening = false;
      // Real jatos.js clears group variables while the channel is down.
      jatos.groupResultId = null;
      callbacks.onClose?.();
    },
    fireMemberJoin: (id: string) => {
      jatos.groupMembers = [...jatos.groupMembers, id];
      callbacks.onMemberJoin?.(id);
    },
    fireMemberOpen: (id: string) => {
      jatos.groupChannels = [...jatos.groupChannels, id];
      callbacks.onMemberOpen?.(id);
    },
    fireMemberClose: (id: string) => {
      jatos.groupChannels = jatos.groupChannels.filter((memberId) => memberId !== id);
      callbacks.onMemberClose?.(id);
    },
    fireMemberLeave: (id: string) => {
      jatos.groupMembers = jatos.groupMembers.filter((memberId) => memberId !== id);
      callbacks.onMemberLeave?.(id);
    },
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

  test("derives participantId from the study result id as a string", () => {
    // studyResultId, not workerId: it is unique per study run (and is what jatos.js
    // later exposes as groupMemberId), whereas the same workerId can recur when a
    // worker runs the study more than once. groupMemberId itself is still null at
    // construction time — the mock pins it to null to enforce that.
    (globalThis as Record<string, unknown>).jatos = makeMockJatos(12345, 777).jatos;
    expect(new JatosAdapter().participantId).toBe("12345");
  });

  test("falls back to the worker id when studyResultId is absent", () => {
    (globalThis as Record<string, unknown>).jatos = makeMockJatos(null, 777).jatos;
    expect(new JatosAdapter().participantId).toBe("777");
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

  test("calling connect() again returns the same promise instead of rejoining the group", async () => {
    const adapter = new JatosAdapter();
    const first = adapter.connect();
    const second = adapter.connect(); // while still in flight
    mock.fireOpen();
    await first;
    const third = adapter.connect(); // after it settled

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(1);
  });

  test("a failed connect() does not block a retry", async () => {
    const adapter = new JatosAdapter();
    const first = adapter.connect();
    mock.fireError("boom");
    await expect(first).rejects.toThrow(/boom/);

    const retry = adapter.connect();
    mock.fireOpen();
    await expect(retry).resolves.toBeUndefined();
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(2);
  });

  test("a failed attempt reports lifecycle and cannot reopen from a stale callback", async () => {
    const adapter = new JatosAdapter();
    const events: string[] = [];
    adapter.subscribePresence((event) => events.push(event.type));
    const first = adapter.connect();
    mock.fireError("boom");
    await expect(first).rejects.toThrow(/boom/);

    mock.fireOpen();
    expect(adapter.getPresence().localChannelOpen).toBe(false);
    expect(events).toEqual(["snapshot", "local-error"]);
  });

  test("honors a custom connectTimeoutMs option", async () => {
    jest.useFakeTimers();
    const adapter = new JatosAdapter({ connectTimeoutMs: 5 });
    const promise = adapter.connect();
    const assertion = promise.catch((e: unknown) => e);

    await jest.advanceTimersByTimeAsync(5);
    const err = (await assertion) as Error;

    expect(err.message).toMatch(/timed out after 5 ms/);
  });

  test("disconnect during connect rejects the handshake and both promises settle", async () => {
    const adapter = new JatosAdapter();
    const connecting = adapter.connect();
    const connectionResult = connecting.catch((error: unknown) => error);

    const disconnecting = adapter.disconnect();
    const error = (await connectionResult) as Error;
    expect(error.message).toMatch(/cancelled by disconnect/);
    expect(mock.jatos.leaveGroup).not.toHaveBeenCalled();

    // Real JATOS rejects leaveGroup while its opening deferred is pending. Once the underlying join
    // succeeds, the adapter must immediately leave rather than ignoring onOpen and leaking a ghost.
    mock.fireOpen();
    await expect(disconnecting).resolves.toBeUndefined();
    expect(mock.jatos.leaveGroup).toHaveBeenCalledTimes(1);
    expect(adapter.getPresence().localChannelOpen).toBe(false);
  });

  test("disconnect during connect settles without leave when the underlying join fails", async () => {
    const adapter = new JatosAdapter();
    const connecting = adapter.connect().catch((error: unknown) => error);
    const disconnecting = adapter.disconnect();

    mock.fireError("opening failed");

    await expect(connecting).resolves.toBeInstanceOf(Error);
    await expect(disconnecting).resolves.toBeUndefined();
    expect(mock.jatos.leaveGroup).not.toHaveBeenCalled();
  });

  test("disconnect during a silent join is bounded, idempotent, and still cleans up a late open", async () => {
    jest.useFakeTimers();
    const adapter = new JatosAdapter({ connectTimeoutMs: 5 });
    const connecting = adapter.connect().catch((error: unknown) => error);

    const firstDisconnect = adapter.disconnect();
    const secondDisconnect = adapter.disconnect();
    expect(secondDisconnect).toBe(firstDisconnect);
    await expect(connecting).resolves.toBeInstanceOf(Error);

    await jest.advanceTimersByTimeAsync(5);
    await expect(firstDisconnect).resolves.toBeUndefined();
    expect(mock.jatos.leaveGroup).not.toHaveBeenCalled();
    await expect(adapter.connect()).rejects.toThrow(/cancelled JATOS join is still settling/);

    // The public teardown is bounded, but its tombstone remains long enough to leave a join that
    // eventually opens instead of leaking a ghost member.
    mock.fireOpen();
    expect(mock.jatos.leaveGroup).toHaveBeenCalledTimes(1);
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

  test("push() works again after jatos reopens a closed channel", async () => {
    const adapter = await connectedAdapter();

    // Channel drops: push must fail loudly.
    mock.fireClose();
    await expect(adapter.push({ x: 1 })).rejects.toThrow(/channel closed/);

    // jatos.js reopens the channel (onOpen fires again, long after connect settled).
    // The adapter must restore its connection flags — not just subscriptions.
    mock.fireOpen();
    await expect(adapter.push({ x: 2 })).resolves.toBeUndefined();
    expect(mock.jatos.groupSession.set).toHaveBeenCalledWith("w1", { x: 2 });
  });
});

describe("JATOS presence and group lifecycle", () => {
  test("exposes the shared group id only after connection", async () => {
    const adapter = new JatosAdapter();
    expect(adapter.groupId).toBeNull();
    const connecting = adapter.connect();
    mock.fireOpen();
    await connecting;
    expect(adapter.groupId).toBe("group-7");
  });

  test("distinguishes assigned members from currently open channels", async () => {
    const adapter = await connectedAdapter();
    mock.fireMemberJoin("w2");
    mock.fireMemberOpen("w2");
    mock.fireMemberClose("w2");

    expect(adapter.getPresence()).toEqual({
      groupId: "group-7",
      assignedMemberIds: ["w1", "w2"],
      openChannelMemberIds: ["w1"],
      localChannelOpen: true,
    });
  });

  test("returns frozen snapshots that do not expose JATOS arrays", async () => {
    const adapter = await connectedAdapter();
    const snapshot = adapter.getPresence();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.assignedMemberIds)).toBe(true);
    expect(Object.isFrozen(snapshot.openChannelMemberIds)).toBe(true);
    expect(snapshot.assignedMemberIds).not.toBe(mock.jatos.groupMembers);

    mock.jatos.groupMembers.push("later");
    expect(snapshot.assignedMemberIds).toEqual(["w1"]);
  });

  test("replays immediately, reports peer lifecycle, and unsubscribes", async () => {
    const adapter = await connectedAdapter();
    const events: Array<{ type: string; memberId?: string }> = [];
    const unsubscribe = adapter.subscribePresence((event) =>
      events.push({ type: event.type, memberId: event.memberId }),
    );

    mock.fireMemberJoin("w2");
    mock.fireMemberOpen("w2");
    mock.fireMemberClose("w2");
    mock.fireMemberLeave("w2");
    unsubscribe();
    mock.fireMemberJoin("w3");

    expect(events).toEqual([
      { type: "snapshot", memberId: undefined },
      { type: "member-join", memberId: "w2" },
      { type: "member-open", memberId: "w2" },
      { type: "member-close", memberId: "w2" },
      { type: "member-leave", memberId: "w2" },
    ]);
  });

  test("retains the group ID across close/reopen and verifies the reopened identity", async () => {
    const adapter = await connectedAdapter();
    const events: Array<{ type: string; groupId: string | null }> = [];
    adapter.subscribePresence((event) =>
      events.push({ type: event.type, groupId: event.snapshot.groupId }),
    );

    mock.fireClose();
    expect(adapter.getPresence()).toMatchObject({
      groupId: "group-7",
      localChannelOpen: false,
    });
    mock.fireOpen();
    expect(adapter.getPresence()).toMatchObject({ groupId: "group-7", localChannelOpen: true });
    expect(events).toEqual([
      { type: "snapshot", groupId: "group-7" },
      { type: "local-close", groupId: "group-7" },
      { type: "local-open", groupId: "group-7" },
    ]);
  });

  test("rejects a reopened channel that reports a different group ID", async () => {
    const adapter = await connectedAdapter();
    const events: string[] = [];
    adapter.subscribePresence((event) => events.push(event.type));

    mock.fireClose();
    mock.fireOpen("different-group");

    expect(adapter.groupId).toBe("group-7");
    expect(adapter.getPresence().localChannelOpen).toBe(false);
    expect(events).toEqual(["snapshot", "local-close", "local-error"]);
  });

  test("retains groupId after explicit disconnect and replaces it on a fresh join", async () => {
    const adapter = await connectedAdapter();
    await adapter.disconnect();
    expect(adapter.groupId).toBe("group-7");

    const reconnecting = adapter.connect();
    mock.fireOpen("group-8");
    await reconnecting;
    expect(adapter.groupId).toBe("group-8");
  });

  test("seals a connected group once and reports success", async () => {
    const adapter = await connectedAdapter();
    const events: string[] = [];
    adapter.subscribePresence((event) => events.push(event.type));

    const first = adapter.sealGroup();
    const second = adapter.sealGroup();
    await expect(first).resolves.toBeUndefined();
    expect(second).toBe(first);
    expect(mock.jatos.setGroupFixed).toHaveBeenCalledTimes(1);
    expect(events).toContain("group-fixed");
  });

  test("rejects a failed seal with the JATOS error as cause and permits retry", async () => {
    const adapter = await connectedAdapter();
    const underlying = new Error("server refused");
    mock.jatos.setGroupFixed.mockImplementationOnce(
      (_ok?: () => void, fail?: (error: unknown) => void) => fail?.(underlying),
    );

    const error = (await adapter.sealGroup().catch((value) => value)) as Error & {
      cause?: unknown;
    };
    expect(error.message).toMatch(/failed to fix/);
    expect(error.cause).toBe(underlying);
    await expect(adapter.sealGroup()).resolves.toBeUndefined();
    expect(mock.jatos.setGroupFixed).toHaveBeenCalledTimes(2);
  });

  test("rejects sealing before connection or when unsupported", async () => {
    const adapter = new JatosAdapter();
    await expect(adapter.sealGroup()).rejects.toThrow(/open group channel/);
    const connected = await connectedAdapter();
    (mock.jatos as { setGroupFixed?: unknown }).setGroupFixed = undefined;
    await expect(connected.sealGroup()).rejects.toThrow(/does not expose setGroupFixed/);
  });

  test("explicit disconnect emits terminal lifecycle and ignores stale reopen callbacks", async () => {
    const adapter = await connectedAdapter();
    const events: string[] = [];
    adapter.subscribePresence((event) => events.push(event.type));

    await adapter.disconnect();
    mock.fireOpen();

    expect(events).toEqual(["snapshot", "local-disconnect", "left-group"]);
    expect(adapter.getPresence()).toMatchObject({
      localChannelOpen: false,
      openChannelMemberIds: [],
    });
  });

  test("failed leave is observable although disconnect still fulfills its legacy contract", async () => {
    const adapter = await connectedAdapter();
    const events: Array<{ type: string; error?: unknown }> = [];
    adapter.subscribePresence((event) => events.push({ type: event.type, error: event.error }));
    const underlying = new Error("leave failed");
    mock.jatos.leaveGroup.mockImplementationOnce(
      (_ok?: () => void, fail?: (error: unknown) => void) => fail?.(underlying),
    );

    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "leave-failed", error: underlying });
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
