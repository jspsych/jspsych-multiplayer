import {
  AdapterConnectOptions,
  ConnectionStatus,
  ConnectOptions,
  initJsPsych,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";

import { scopeData } from "../../../test-utils/memory-backend";
import JatosAdapter from ".";
import { SEALED_KEY } from "./sealed-key";

/**
 * These tests drive the adapter against a mock of the `jatos` global injected by jatos.js.
 * The mock follows jatos.js's behavior where it matters to the adapter:
 * - joinGroup() replaces the page's single set of callbacks and returns a promise that
 *   settles when the channel opens or fails to open;
 * - groupChannels lists the members whose channel is open;
 * - when the channel closes, jatos.js wipes its local copy of the session data and the
 *   channel list (clearGroupChannel) before calling onClose;
 * - leaveGroup() resolves when the server confirms, which can be before the socket has
 *   finished closing; until it has, joinGroup() is refused with jatos.js's "not in readyState
 *   CLOSED" rejection, without onError.
 */
function makeMockJatos(
  // Pass null to simulate a context where studyResultId is not populated.
  studyResultId: string | number | null = 1001,
  workerId: string | number = "worker-99",
) {
  // What the JATOS server holds; the local copy is wiped while the channel is closed
  const store: Record<string, unknown> = {};
  let wiped = false;
  /** The group result ID jatos.js sets when the channel opens. */
  let groupId: string | null = "77";
  let callbacks: Record<string, ((...args: unknown[]) => void) | undefined> = {};
  let join: { resolve: () => void; reject: (reason: unknown) => void } | null = null;
  /** The socket from a left channel is still closing. */
  let closing = false;
  /** Leaving leaves the socket closing, until finishClosing(). */
  let leaveLeavesSocketClosing = false;
  /** Held leave requests, released by finishLeave(). */
  let heldLeave: (() => void) | null = null;
  let holdLeaves = false;
  /** When set, the next setGroupFixed() fails with it. */
  let fixFailure: string | null = null;
  /** Called whenever what the server holds changes: data or open channels. */
  const serverListeners = new Set<() => void>();
  const serverChanged = () => serverListeners.forEach((listener) => listener());

  const jatos = {
    studyResultId: studyResultId ?? undefined,
    workerId,
    groupResultId: null as string | number | null,
    groupChannels: [] as Array<string | number>,
    groupMembers: [] as Array<string | number>,
    batchProperties: { maxActiveMembers: null } as { maxActiveMembers: number | null },
    /** Like the server: fixing confirms only to the member who asked, after a round trip. */
    setGroupFixed: jest.fn((onSuccess?: () => void, onFail?: (err: unknown) => void) => {
      const failure = fixFailure;
      fixFailure = null;
      void Promise.resolve().then(() => (failure ? onFail?.(failure) : onSuccess?.()));
    }),
    joinGroup: jest.fn((cbs: Record<string, (...args: unknown[]) => void>): unknown => {
      callbacks = cbs;
      if (closing) {
        return Promise.reject("Can't open a WebSocket that is not in readyState CLOSED.");
      }
      return new Promise<void>((resolve, reject) => {
        join = { resolve, reject };
      });
    }),
    groupSession: {
      set: jest.fn(async (key: string, value: unknown) => {
        store[key] = JSON.parse(JSON.stringify(value));
        serverChanged();
      }),
      getAll: jest.fn(() => (wiped ? {} : JSON.parse(JSON.stringify(store)))),
    },
    leaveGroup: jest.fn((onSuccess?: () => void) => {
      const done = () => {
        jatos.groupChannels = jatos.groupChannels.filter((c) => c !== self);
        if (leaveLeavesSocketClosing) closing = true;
        serverChanged();
        onSuccess?.();
      };
      if (holdLeaves) heldLeave = done;
      else done();
    }),
  };

  const self = studyResultId ?? workerId;

  return {
    jatos,
    store,
    serverListeners,
    /** Make the next setGroupFixed() fail. */
    failNextFix(reason: string) {
      fixFailure = reason;
    },
    /** Another member leaves the group for good, freeing their place in an unfixed group. */
    memberLeave(id: number) {
      jatos.groupMembers = jatos.groupMembers.filter((m) => m !== id);
      jatos.groupChannels = jatos.groupChannels.filter((c) => c !== id);
      callbacks.onMemberLeave?.(id);
      serverChanged();
    },
    /** Later channels open without a group result ID. */
    omitGroupResultId() {
      groupId = null;
    },
    /** Make later leaves leave the socket closing until finishClosing(). */
    leaveSlowly() {
      leaveLeavesSocketClosing = true;
    },
    /** The closing socket finishes closing, so jatos.js can open a new channel. */
    finishClosing() {
      closing = false;
    },
    /** Hold later leave requests until finishLeave(). */
    holdLeave() {
      holdLeaves = true;
    },
    finishLeave() {
      holdLeaves = false;
      heldLeave?.();
      heldLeave = null;
    },
    /** The channel opens: jatos.js resolves the join and calls onOpen for this member. */
    open() {
      wiped = false;
      jatos.groupResultId = groupId;
      if (!jatos.groupChannels.includes(self)) jatos.groupChannels.push(self);
      if (!jatos.groupMembers.includes(self)) jatos.groupMembers.push(self);
      join?.resolve();
      join = null;
      callbacks.onOpen?.(self);
      serverChanged();
    },
    /** jatos.js refuses to open, rejecting the join without calling onError. */
    refuse(reason: string) {
      join?.reject(reason);
      join = null;
    },
    /** A channel error: like jatos.js, report it through onError and fail a pending join. */
    fireError(msg?: string) {
      callbacks.onError?.(msg);
      join?.reject(msg);
      join = null;
    },
    fireGroupSession: () => callbacks.onGroupSession?.("/", "add"),
    /** Another member's channel opens. */
    memberOpen(id: number) {
      jatos.groupChannels.push(id);
      if (!jatos.groupMembers.includes(id)) jatos.groupMembers.push(id);
      callbacks.onMemberOpen?.(id);
      serverChanged();
    },
    /** Another member's channel closes. */
    memberClose(id: number) {
      jatos.groupChannels = jatos.groupChannels.filter((c) => c !== id);
      callbacks.onMemberClose?.(id);
      serverChanged();
    },
    /**
     * This member's channel drops: jatos.js wipes its local state, then calls onClose.
     * (groupChannels keeps the server's view, which other members see: the adapter doesn't
     * read it while reconnecting.)
     */
    drop() {
      wiped = true;
      jatos.groupResultId = null;
      jatos.groupChannels = jatos.groupChannels.filter((c) => c !== self);
      callbacks.onClose?.();
      serverChanged();
    },
  };
}

let mock: ReturnType<typeof makeMockJatos>;
let open: MultiplayerConnection[] = [];

beforeEach(() => {
  mock = makeMockJatos();
  (globalThis as Record<string, unknown>).jatos = mock.jatos;
});

afterEach(async () => {
  jest.useRealTimers();
  // Release the adapter's page-wide one-connection guard
  await Promise.all(open.map((c) => c.disconnect()));
  open = [];
  // Settle a join a test left in flight, as jatos.js eventually does, so the guard is released
  mock.refuse("test cleanup");
  await flushPromises();
  delete (globalThis as Record<string, unknown>).jatos;
});

function connectOptions(signal = new AbortController().signal) {
  const statuses: ConnectionStatus[] = [];
  const options: AdapterConnectOptions = {
    signal,
    onChange: jest.fn(),
    onStatus: jest.fn((status: ConnectionStatus) => statuses.push(status)),
    onResumed: jest.fn(),
  };
  return { options, statuses };
}

/** Connect and complete the handshake. */
async function connected(adapter = new JatosAdapter()) {
  const { options, statuses } = connectOptions();
  const promise = adapter.connect(options);
  mock.open();
  const connection = await promise;
  open.push(connection);
  return { connection, options, statuses };
}

async function flushPromises() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Member 2002 as a real jsPsych session that sees what the JATOS server holds (not jatos.js's
 * local copy), as another participant's browser would.
 */
async function serverPeer(connect?: ConnectOptions) {
  const adapter: MultiplayerAdapter = {
    async connect(options) {
      mock.serverListeners.add(options.onChange);
      mock.memberOpen(2002);
      return {
        participantId: "2002",
        sessionId: "77",
        getAll: () => JSON.parse(JSON.stringify(mock.store)),
        connectedParticipants: () => mock.jatos.groupChannels.map(String),
        push: async (data) => {
          mock.store["2002"] = JSON.parse(JSON.stringify(data));
          mock.fireGroupSession();
          mock.serverListeners.forEach((listener) => listener());
        },
        disconnect: async () => {
          mock.serverListeners.delete(options.onChange);
        },
      };
    },
  };
  const jsPsych = initJsPsych();
  await jsPsych.multiplayer.connect(adapter, connect);
  return jsPsych;
}

/** A jsPsych instance connected through a JatosAdapter, with the handshake completed. */
async function jatosSession(adapter = new JatosAdapter()) {
  const jsPsych = initJsPsych();
  const connecting = jsPsych.multiplayer.connect(adapter);
  mock.open();
  await connecting;
  return jsPsych;
}

describe("construction", () => {
  test("throws a helpful error when the jatos global is missing", () => {
    delete (globalThis as Record<string, unknown>).jatos;
    expect(() => new JatosAdapter()).toThrow(/jatos global is not defined/);
  });

  test("warns that the removed timeout options are ignored, naming their replacements", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    new JatosAdapter({ connectTimeoutMs: 5, closeAfterReconnectingMs: 5 } as never);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/connectTimeoutMs.*connectTimeout/));
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/closeAfterReconnectingMs.*reconnectTimeout/),
    );
    warn.mockRestore();
  });
});

describe("connect", () => {
  test("resolves with a connection keyed by the study result id", async () => {
    const { connection } = await connected();
    expect(connection.participantId).toBe("1001");
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(1);
  });

  test("falls back to the worker id when studyResultId is absent", async () => {
    mock = makeMockJatos(null, 777);
    (globalThis as Record<string, unknown>).jatos = mock.jatos;
    const { connection } = await connected();
    expect(connection.participantId).toBe("777");
  });

  test("uses the group result id as the session id", async () => {
    const { connection } = await connected();
    expect(connection.sessionId).toBe("77");
  });

  test("keeps the session id while jatos.js reconnects", async () => {
    const { connection } = await connected();
    mock.drop();
    expect(mock.jatos.groupResultId).toBeNull();
    expect(connection.sessionId).toBe("77");
  });

  test("rejects and leaves the group when the channel opens without a group result id", async () => {
    mock.omitGroupResultId();
    const { options } = connectOptions();
    const promise = new JatosAdapter().connect(options);
    mock.open();
    await expect(promise).rejects.toThrow("group result ID");
    expect(mock.jatos.leaveGroup).toHaveBeenCalledTimes(1);
  });

  test("each connect() returns a new connection", async () => {
    const adapter = new JatosAdapter();
    const first = await connected(adapter);
    await first.connection.disconnect();
    const second = await connected(adapter);
    expect(second.connection).not.toBe(first.connection);
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(2);
  });

  test("rejects a second connection while one is open, without touching jatos.js", async () => {
    await connected();
    const { options } = connectOptions();
    await expect(new JatosAdapter().connect(options)).rejects.toThrow(/already open or opening/);
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(1);
  });

  test("rejects, surfacing the error message, if joining the group fails", async () => {
    const { options } = connectOptions();
    const promise = new JatosAdapter().connect(options);
    mock.fireError("boom");
    await expect(promise).rejects.toThrow(/boom/);
  });

  test("rejects promptly when jatos.js refuses to open the channel without calling onError", async () => {
    const { options } = connectOptions();
    const promise = new JatosAdapter().connect(options);
    mock.refuse("Can't open group channel. This study run is invalid.");
    await expect(promise).rejects.toThrow(/study run is invalid/);
  });

  test("resolves when the join promise resolves, even if onOpen never fires", async () => {
    const { options } = connectOptions();
    const promise = new JatosAdapter().connect(options);
    // Resolve the join but swallow onOpen
    const onOpen = (mock.jatos.joinGroup.mock.calls[0][0] as Record<string, unknown>).onOpen;
    (mock.jatos.joinGroup.mock.calls[0][0] as Record<string, unknown>).onOpen = undefined;
    mock.open();
    const connection = await promise;
    open.push(connection);
    expect(onOpen).toBeDefined();
    expect(connection.participantId).toBe("1001");
  });

  test("works with older jatos.js builds whose joinGroup returns nothing", async () => {
    mock.jatos.joinGroup.mockImplementationOnce((cbs) => {
      mock.jatos.joinGroup.mock.calls[0][0] = cbs;
      return undefined;
    });
    const { options } = connectOptions();
    const promise = new JatosAdapter().connect(options);
    // jatos.js sets the group variables before it calls onOpen
    mock.jatos.groupResultId = "77";
    (mock.jatos.joinGroup.mock.calls[0][0] as { onOpen: () => void }).onOpen();
    const connection = await promise;
    open.push(connection);
    expect(connection.participantId).toBe("1001");
  });

  test("a failed connect() allows a retry", async () => {
    const adapter = new JatosAdapter();
    const { options } = connectOptions();
    const first = adapter.connect(options);
    mock.fireError("boom");
    await expect(first).rejects.toThrow(/boom/);
    await flushPromises();

    const { connection } = await connected(adapter);
    expect(connection.participantId).toBe("1001");
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(2);
  });

  test("jsPsych's connect timeout aborts a join JATOS never answers", async () => {
    jest.useFakeTimers();
    const jsPsych = initJsPsych();
    const assertion = jsPsych.multiplayer
      .connect(new JatosAdapter(), { connectTimeout: 5000 })
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await assertion).toMatchObject({ name: "MultiplayerError", code: "timeout" });
    // The join settles later; the adapter releases jatos.js for the next connection
    mock.refuse("gave up");
    await flushPromises();
    const { options } = connectOptions();
    const next = new JatosAdapter().connect(options);
    mock.open();
    open.push(await next);
  });

  test("an already-aborted signal rejects without joining", async () => {
    const { options } = connectOptions(AbortSignal.abort());
    await expect(new JatosAdapter().connect(options)).rejects.toThrow(/cancelled/);
    expect(mock.jatos.joinGroup).not.toHaveBeenCalled();
  });

  test("aborting mid-join rejects, and leaves the group if the channel opens later", async () => {
    const controller = new AbortController();
    const { options } = connectOptions(controller.signal);
    const promise = new JatosAdapter().connect(options);
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);

    // Until the join settles, a new connection waits instead of taking over jatos.js's callbacks
    const next = new JatosAdapter().connect(connectOptions().options);
    await flushPromises();
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(1);

    mock.open();
    await flushPromises();
    expect(mock.jatos.leaveGroup).toHaveBeenCalledTimes(1);
    expect(options.onChange).not.toHaveBeenCalled();
    expect(options.onStatus).not.toHaveBeenCalled();

    // The cancelled channel has been left, so the waiting connection joins
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(2);
    mock.open();
    open.push(await next);
  });
});

describe("reading", () => {
  test("getAll() returns the group session and connectedParticipants() the open channels", async () => {
    mock.store["1001"] = { a: 1 };
    mock.store["2002"] = { b: 2 };
    const { connection } = await connected();
    mock.memberOpen(2002);
    expect(connection.getAll()).toEqual({ "1001": { a: 1 }, "2002": { b: 2 } });
    expect(connection.connectedParticipants()).toEqual(["1001", "2002"]);
  });

  test("getAll() returns each payload unchanged and leaves out the adapter's own keys", async () => {
    const payload = { $mp: { v: 1, instance: "i", epoch: 1 }, session: { a: 1 }, scopes: {} };
    mock.store["1001"] = payload;
    mock.store[SEALED_KEY] = { by: "1001", members: ["1001"] };
    mock.store["$other"] = 1;
    const { connection } = await connected();
    expect(connection.getAll()).toEqual({ "1001": payload });
  });

  test("getAll() returns {} when JATOS reports a null session", async () => {
    mock.jatos.groupSession.getAll.mockReturnValue(null);
    const { connection } = await connected();
    expect(connection.getAll()).toEqual({});
  });

  test("group session updates and member changes call onChange", async () => {
    const { connection, options } = await connected();
    mock.store["2002"] = { hi: 1 };
    mock.fireGroupSession();
    expect(options.onChange).toHaveBeenCalledTimes(1);
    expect(connection.getAll()).toEqual({ "2002": { hi: 1 } });

    mock.memberOpen(2002);
    expect(connection.connectedParticipants()).toEqual(["1001", "2002"]);
    mock.memberClose(2002);
    expect(connection.connectedParticipants()).toEqual(["1001"]);
    expect(options.onChange).toHaveBeenCalledTimes(3);
  });

  test("while the channel is down, reads return the last data jatos.js had", async () => {
    mock.store["2002"] = { hi: 1 };
    const { connection, options } = await connected();
    mock.memberOpen(2002);
    const changes = (options.onChange as jest.Mock).mock.calls.length;

    mock.drop();
    expect(connection.getAll()).toEqual({ "2002": { hi: 1 } });
    expect(connection.connectedParticipants()).toEqual(["1001", "2002"]);
    mock.fireGroupSession();
    expect(options.onChange).toHaveBeenCalledTimes(changes);
  });
});

describe("connection status", () => {
  test("a dropped channel reports reconnecting, and a reopened one connected", async () => {
    const { options, statuses } = await connected();
    mock.drop();
    expect(statuses).toEqual(["reconnecting"]);
    mock.open();
    expect(statuses).toEqual(["reconnecting", "connected"]);
    expect(options.onChange).toHaveBeenCalled();
  });

  test("an error after the channel opened reports reconnecting", async () => {
    const { statuses } = await connected();
    mock.fireError("Group channel heartbeat fail");
    expect(statuses).toEqual(["reconnecting"]);
  });

  test("a channel that stays down never reports closed by itself", async () => {
    jest.useFakeTimers();
    const { statuses } = await connected();
    mock.drop();
    jest.advanceTimersByTime(60 * 60_000);
    expect(statuses).toEqual(["reconnecting"]);
    mock.open();
    expect(statuses).toEqual(["reconnecting", "connected"]);
  });

  test("jsPsych's reconnectTimeout gives up on a channel that stays down, and leaves the group", async () => {
    jest.useFakeTimers();
    const jsPsych = initJsPsych();
    const connecting = jsPsych.multiplayer.connect(new JatosAdapter(), {
      reconnectTimeout: 30_000,
    });
    mock.open();
    await connecting;
    mock.drop();
    jest.advanceTimersByTime(29_999);
    expect(jsPsych.multiplayer.status).toBe("reconnecting");
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(jsPsych.multiplayer.status).toBe("closed");
    expect(mock.jatos.leaveGroup).toHaveBeenCalledTimes(1);
  });
});

describe("push", () => {
  test("writes data keyed by participantId", async () => {
    const { connection } = await connected();
    await connection.push({ score: 5 });
    expect(mock.jatos.groupSession.set).toHaveBeenCalledWith("1001", { score: 5 });
  });

  test("retries on a version conflict and eventually succeeds", async () => {
    jest.useFakeTimers();
    const { connection } = await connected();
    let calls = 0;
    mock.jatos.groupSession.set.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error("version conflict");
    });

    const promise = connection.push({ x: 1 });
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    // Every attempt re-sends the same (participantId -> data) write, which is what makes
    // retrying safe
    expect(mock.jatos.groupSession.set.mock.calls).toEqual([
      ["1001", { x: 1 }],
      ["1001", { x: 1 }],
      ["1001", { x: 1 }],
    ]);
  });

  test("rejects after a few attempts, preserving the cause", async () => {
    jest.useFakeTimers();
    const { connection } = await connected();
    const underlying = new Error("version conflict");
    mock.jatos.groupSession.set.mockRejectedValue(underlying);

    const assertion = connection.push({ x: 1 }).catch((e: unknown) => e);
    await jest.runAllTimersAsync();
    const err = (await assertion) as Error & { cause?: unknown };

    expect(err.message).toMatch(/after 3 attempts/);
    expect(err.cause).toBe(underlying);
    expect(mock.jatos.groupSession.set).toHaveBeenCalledTimes(3);
  });

  test("a push made while the channel is down rejects at once, without writing", async () => {
    const { connection } = await connected();
    mock.drop();
    await expect(connection.push({ x: 1 })).rejects.toThrow(/channel is down/);
    expect(mock.jatos.groupSession.set).not.toHaveBeenCalled();
  });

  test("a write that fails because the channel dropped rejects without retrying", async () => {
    const { connection } = await connected();
    const underlying = new Error("No open group channel");
    mock.jatos.groupSession.set.mockImplementationOnce(async () => {
      mock.drop();
      throw underlying;
    });
    const err = (await connection.push({ x: 1 }).catch((e: unknown) => e)) as Error & {
      cause?: unknown;
    };
    expect(err.cause).toBe(underlying);
    expect(mock.jatos.groupSession.set).toHaveBeenCalledTimes(1);
  });

  test("a write that failed while the channel was down reaches the group once it reopens", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const jsPsych = await jatosSession();
    mock.drop();
    let done = false;
    const writing = jsPsych.multiplayer.update({ x: 1 }).then(() => (done = true));
    await jest.advanceTimersByTimeAsync(5000);
    expect(done).toBe(false);

    mock.open();
    await jest.advanceTimersByTimeAsync(0);
    await writing;
    expect(scopeData(mock.store["1001"])).toEqual({ x: 1 });
    await jsPsych.multiplayer.disconnect();
    warn.mockRestore();
  });

  test("push rejects after disconnect", async () => {
    const { connection } = await connected();
    await connection.disconnect();
    await expect(connection.push({ x: 1 })).rejects.toThrow(/closed/);
    expect(mock.jatos.groupSession.set).not.toHaveBeenCalled();
  });
});

describe("disconnect", () => {
  test("leaves the JATOS group", async () => {
    const { connection } = await connected();
    await connection.disconnect();
    expect(mock.jatos.leaveGroup).toHaveBeenCalledTimes(1);
  });

  test("no callbacks fire after disconnect, though jatos.js keeps them registered", async () => {
    const { connection, options } = await connected();
    await connection.disconnect();
    mock.fireGroupSession();
    mock.memberOpen(2002);
    mock.drop();
    mock.open();
    expect(options.onChange).not.toHaveBeenCalled();
    expect(options.onStatus).not.toHaveBeenCalled();
  });

  test("resolves even when jatos.js does not expose leaveGroup", async () => {
    const { connection } = await connected();
    (mock.jatos as { leaveGroup?: unknown }).leaveGroup = undefined;
    await expect(connection.disconnect()).resolves.toBeUndefined();
  });
});

describe("with the jsPsych multiplayer session", () => {
  test("reports presence from the open group channels", async () => {
    jest.useFakeTimers();
    const jsPsych = initJsPsych();
    const connecting = jsPsych.multiplayer.connect(new JatosAdapter(), { dropoutTimeout: 5000 });
    mock.open();
    await connecting;

    mock.memberOpen(2002);
    expect(jsPsych.multiplayer.presence()).toEqual({ "1001": "connected", "2002": "connected" });

    mock.memberClose(2002);
    expect(jsPsych.multiplayer.presence()["2002"]).toBe("away");
    jest.advanceTimersByTime(5000);
    expect(jsPsych.multiplayer.presence()["2002"]).toBe("left");

    await jsPsych.multiplayer.disconnect();
  });

  test("writes reach the group session and a dropped channel shows as reconnecting", async () => {
    const jsPsych = initJsPsych();
    const connecting = jsPsych.multiplayer.connect(new JatosAdapter());
    mock.open();
    await connecting;

    await jsPsych.multiplayer.update({ ready: true });
    expect(scopeData(mock.store["1001"])).toEqual({ ready: true });

    mock.drop();
    expect(jsPsych.multiplayer.status).toBe("reconnecting");
    expect(jsPsych.multiplayer.get("1001")).toEqual({ ready: true });
    mock.open();
    expect(jsPsych.multiplayer.status).toBe("connected");

    await jsPsych.multiplayer.disconnect();
  });
});

describe("forming groups", () => {
  test("group() reports the batch's maxActiveMembers and the group's members", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 3;
    const { connection } = await connected();
    mock.memberOpen(2002);
    expect(connection.group!()).toEqual({ size: 3, members: ["1001", "2002"], sealed: false });

    // A member whose channel dropped is still a member
    mock.memberClose(2002);
    expect(connection.group!().members).toEqual(["1001", "2002"]);
  });

  test("without maxActiveMembers the size is null and the group is never fixed automatically", async () => {
    const { connection } = await connected();
    mock.memberOpen(2002);
    await flushPromises();
    expect(connection.group!().size).toBeNull();
    expect(mock.jatos.setGroupFixed).not.toHaveBeenCalled();
  });

  test("fixes the group once it has maxActiveMembers, and reports it sealed", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 2;
    const { connection, options } = await connected();
    expect(mock.jatos.setGroupFixed).not.toHaveBeenCalled();

    (options.onChange as jest.Mock).mockClear();
    mock.memberOpen(2002);
    // Sealed only once the server confirms
    expect(connection.group!().sealed).toBe(false);
    await flushPromises();
    expect(mock.jatos.setGroupFixed).toHaveBeenCalledTimes(1);
    expect(connection.group!()).toEqual({ size: 2, members: ["1001", "2002"], sealed: true });
    expect(options.onChange).toHaveBeenCalled();

    // Later changes don't ask again
    mock.fireGroupSession();
    await flushPromises();
    expect(mock.jatos.setGroupFixed).toHaveBeenCalledTimes(1);
  });

  test("a place freed before the group is full is not sealed away", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 3;
    const { connection } = await connected();
    mock.memberOpen(2002);
    mock.memberLeave(2002);
    mock.memberOpen(3003);
    expect(connection.group!()).toEqual({ size: 3, members: ["1001", "3003"], sealed: false });
    expect(mock.jatos.setGroupFixed).not.toHaveBeenCalled();
  });

  test("with sealWhenFull false, only sealGroup() fixes the group", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 2;
    const { connection } = await connected(new JatosAdapter({ sealWhenFull: false }));
    mock.memberOpen(2002);
    await flushPromises();
    expect(mock.jatos.setGroupFixed).not.toHaveBeenCalled();

    await connection.sealGroup!();
    expect(mock.jatos.setGroupFixed).toHaveBeenCalledTimes(1);
    expect(connection.group!().sealed).toBe(true);
    await connection.sealGroup!();
    expect(mock.jatos.setGroupFixed).toHaveBeenCalledTimes(1);
  });

  test("a failed fix rejects sealGroup(), and the automatic fix is retried on the next change", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mock.jatos.batchProperties.maxActiveMembers = 2;
    const { connection } = await connected();
    mock.failNextFix("Timeout sending message");
    mock.memberOpen(2002);
    await flushPromises();
    expect(connection.group!().sealed).toBe(false);
    expect(warn).toHaveBeenCalled();

    mock.fireGroupSession();
    await flushPromises();
    expect(mock.jatos.setGroupFixed).toHaveBeenCalledTimes(2);
    expect(connection.group!().sealed).toBe(true);
    warn.mockRestore();
  });

  test("sealGroup() waits for a dropped channel to reopen", async () => {
    const { connection } = await connected(new JatosAdapter({ sealWhenFull: false }));
    mock.drop();
    const sealing = connection.sealGroup!();
    await flushPromises();
    expect(mock.jatos.setGroupFixed).not.toHaveBeenCalled();
    mock.open();
    await sealing;
    expect(connection.group!().sealed).toBe(true);
  });

  test("sealGroup() is left out when jatos.js has no setGroupFixed()", async () => {
    delete (mock.jatos as { setGroupFixed?: unknown }).setGroupFixed;
    mock.jatos.batchProperties.maxActiveMembers = 2;
    const { connection } = await connected();
    expect(connection.sealGroup).toBeUndefined();
    mock.memberOpen(2002);
    expect(connection.group!().sealed).toBe(false);
  });

  test("without setGroupFixed(), jsPsych's sealGroup() fails as unsupported", async () => {
    delete (mock.jatos as { setGroupFixed?: unknown }).setGroupFixed;
    const jsPsych = await jatosSession();
    await expect(jsPsych.multiplayer.sealGroup()).rejects.toMatchObject({ code: "unsupported" });
    await jsPsych.multiplayer.disconnect();
  });

  test("once sealed, members who leave stay on the roster", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 2;
    const { connection } = await connected();
    mock.memberOpen(2002);
    await flushPromises();
    mock.memberLeave(2002);
    expect(mock.jatos.groupMembers).toEqual([1001]);
    expect(connection.group!()).toEqual({ size: 2, members: ["1001", "2002"], sealed: true });
  });
});

describe("telling the group it is sealed", () => {
  /** Another member publishes a seal record, as its adapter does once JATOS confirms. */
  function publish(record: unknown) {
    mock.store[SEALED_KEY] = record;
    mock.fireGroupSession();
  }

  test("the member whose fix is confirmed publishes the sorted roster", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 3;
    await connected();
    mock.memberOpen(3003);
    mock.memberOpen(2002);
    await flushPromises();
    expect(mock.store[SEALED_KEY]).toEqual({ by: "1001", members: ["1001", "2002", "3003"] });
  });

  test("a member JATOS doesn't tell learns of the seal from the record", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 2;
    const { connection, options } = await connected(new JatosAdapter({ sealWhenFull: false }));
    mock.memberOpen(2002);
    (options.onChange as jest.Mock).mockClear();
    publish({ by: "2002", members: ["1001", "2002"] });
    expect(connection.group!()).toEqual({ size: 2, members: ["1001", "2002"], sealed: true });
    expect(options.onChange).toHaveBeenCalled();

    // It never asks JATOS itself, and sealing again succeeds at once
    await connection.sealGroup!();
    expect(mock.jatos.setGroupFixed).not.toHaveBeenCalled();
  });

  test("with sealWhenFull, a member stops asking once it learns of the seal", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 2;
    // JATOS lists the group's members as the channel opens
    mock.jatos.groupMembers = [2002];
    mock.store[SEALED_KEY] = { by: "2002", members: ["1001", "2002"] };
    const { connection } = await connected();
    mock.memberOpen(2002);
    await flushPromises();
    expect(connection.group!().sealed).toBe(true);
    expect(mock.jatos.setGroupFixed).not.toHaveBeenCalled();
  });

  test("a member who learned of the seal keeps dropouts on the roster", async () => {
    const { connection } = await connected(new JatosAdapter({ sealWhenFull: false }));
    mock.memberOpen(2002);
    mock.memberOpen(3003);
    publish({ by: "2002", members: ["1001", "2002", "3003"] });
    mock.memberLeave(2002);
    // A record rewritten without the dropout doesn't shrink the roster
    publish({ by: "3003", members: ["1001", "3003"] });
    expect(connection.group!().members).toEqual(["1001", "2002", "3003"]);
  });

  test("doesn't publish again when the record already has everyone", async () => {
    mock.jatos.groupMembers = [2002];
    mock.store[SEALED_KEY] = { by: "2002", members: ["1001", "2002"] };
    const { connection } = await connected(new JatosAdapter({ sealWhenFull: false }));
    mock.memberOpen(2002);
    // Sealing with a trusted record present resolves at once
    await connection.sealGroup!();
    expect(mock.jatos.groupSession.set).not.toHaveBeenCalled();
    expect(mock.jatos.setGroupFixed).not.toHaveBeenCalled();
  });

  test("a record published while the channel was down is written once it reopens", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { connection } = await connected(new JatosAdapter({ sealWhenFull: false }));
    mock.memberOpen(2002);
    mock.jatos.groupSession.set.mockImplementationOnce(async () => {
      mock.drop();
      throw new Error("No open group channel");
    });
    await connection.sealGroup!();
    expect(connection.group!().sealed).toBe(true);
    await flushPromises();
    expect(mock.store[SEALED_KEY]).toBeUndefined();

    mock.open();
    await flushPromises();
    expect(mock.store[SEALED_KEY]).toEqual({ by: "1001", members: ["1001", "2002"] });
    warn.mockRestore();
  });

  test("a failed publish is retried with backoff", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { connection } = await connected(new JatosAdapter({ sealWhenFull: false }));
    mock.memberOpen(2002);
    mock.jatos.groupSession.set.mockRejectedValueOnce(new Error("conflict"));
    mock.jatos.groupSession.set.mockRejectedValueOnce(new Error("conflict"));
    mock.jatos.groupSession.set.mockRejectedValueOnce(new Error("conflict"));
    await connection.sealGroup!();
    await jest.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/retrying/), expect.anything());
    await jest.advanceTimersByTimeAsync(1000);
    expect(mock.store[SEALED_KEY]).toEqual({ by: "1001", members: ["1001", "2002"] });
    warn.mockRestore();
  });

  describe("ignores a record that doesn't match the group", () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    async function recordIsIgnored(record: unknown) {
      const { connection } = await connected(new JatosAdapter({ sealWhenFull: false }));
      mock.memberOpen(2002);
      mock.memberOpen(3003);
      publish(record);
      expect(connection.group!()).toEqual({
        size: null,
        members: ["1001", "2002", "3003"],
        sealed: false,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      // The same record is reported once
      mock.fireGroupSession();
      expect(warn).toHaveBeenCalledTimes(1);
    }

    test("without this participant on it", () =>
      recordIsIgnored({ by: "2002", members: ["2002", "3003"] }));

    test("without a current member on it", () =>
      recordIsIgnored({ by: "2002", members: ["1001", "2002"] }));

    test("without its writer on it", () =>
      recordIsIgnored({ by: "4004", members: ["1001", "2002", "3003"] }));

    test("naming someone never seen in the group", () =>
      recordIsIgnored({ by: "2002", members: ["1001", "2002", "3003", "9999"] }));

    test("that is malformed", () => recordIsIgnored({ members: "everyone" }));
  });

  test("a dropout who wrote data before this member joined may be on the roster", async () => {
    mock.store["2002"] = { $mp: {} };
    const { connection } = await connected(new JatosAdapter({ sealWhenFull: false }));
    mock.memberOpen(3003);
    publish({ by: "3003", members: ["1001", "2002", "3003"] });
    expect(connection.group!()).toEqual({
      size: null,
      members: ["1001", "2002", "3003"],
      sealed: true,
    });
  });

  test("with jsPsych, waitForGroup() resolves for the member JATOS didn't tell", async () => {
    mock.jatos.batchProperties.maxActiveMembers = 2;
    const jsPsych = await jatosSession(new JatosAdapter({ sealWhenFull: false }));
    mock.memberOpen(2002);
    const waiting = jsPsych.multiplayer.waitForGroup();
    publish({ by: "2002", members: ["1001", "2002"] });
    await expect(waiting).resolves.toEqual({ size: 2, members: ["1001", "2002"], sealed: true });
    await jsPsych.multiplayer.disconnect();
  });
});

describe("reconnecting on the same page", () => {
  test("a new connection waits for a closed one to finish leaving the group", async () => {
    const first = await connected();
    mock.holdLeave();
    const leaving = first.connection.disconnect();
    const { options } = connectOptions();
    const second = new JatosAdapter().connect(options);
    await flushPromises();
    // jatos.js refuses to open a channel while it is still leaving the group
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(1);

    mock.finishLeave();
    await leaving;
    await flushPromises();
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(2);
    mock.open();
    const connection = await second;
    open.push(connection);
    expect(connection.participantId).toBe("1001");
  });

  test("a join refused because the old socket is still closing is retried", async () => {
    jest.useFakeTimers();
    mock.leaveSlowly();
    const first = await connected();
    await first.connection.disconnect();

    const { options } = connectOptions();
    const second = new JatosAdapter().connect(options);
    await flushPromises();
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(2); // refused: still closing
    jest.advanceTimersByTime(100);
    await flushPromises();
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(3); // refused again

    mock.finishClosing();
    jest.advanceTimersByTime(200);
    await flushPromises();
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(4);
    mock.open();
    open.push(await second);
  });

  test("a join that keeps being refused stops when the connect is aborted", async () => {
    jest.useFakeTimers();
    mock.leaveSlowly();
    const first = await connected();
    await first.connection.disconnect();

    const controller = new AbortController();
    const { options } = connectOptions(controller.signal);
    const second = new JatosAdapter().connect(options).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(1000);
    const joins = mock.jatos.joinGroup.mock.calls.length;
    controller.abort();
    expect(((await second) as Error).message).toMatch(/cancelled/);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mock.jatos.joinGroup).toHaveBeenCalledTimes(joins);
  });
});

describe("rejoining", () => {
  test("a participant whose channel reopens within the dropout timeout is connected again", async () => {
    jest.useFakeTimers();
    const jsPsych = await jatosSession();
    await jsPsych.multiplayer.update({ round: 2 });
    const left = jest.fn();
    const peer = await serverPeer({ dropoutTimeout: 5000, onParticipantLeft: left });
    expect(peer.multiplayer.presence()["1001"]).toBe("connected");

    mock.drop();
    expect(jsPsych.multiplayer.status).toBe("reconnecting");
    expect(peer.multiplayer.presence()["1001"]).toBe("away");
    jest.advanceTimersByTime(4000);

    mock.open();
    await flushPromises();
    expect(jsPsych.multiplayer.status).toBe("connected");
    expect(peer.multiplayer.presence()["1001"]).toBe("connected");
    expect(left).not.toHaveBeenCalled();
    expect(peer.multiplayer.get("1001")).toEqual({ round: 2 });

    await peer.multiplayer.disconnect();
    await jsPsych.multiplayer.disconnect();
  });

  test("a participant gone past the dropout timeout stays left when their channel reopens", async () => {
    jest.useFakeTimers();
    const jsPsych = await jatosSession();
    const peer = await serverPeer({ dropoutTimeout: 5000 });
    mock.drop();
    jest.advanceTimersByTime(10 * 60_000);
    expect(peer.multiplayer.presence()["1001"]).toBe("left");
    // By default the adapter keeps waiting
    expect(jsPsych.multiplayer.status).toBe("reconnecting");

    mock.open();
    await flushPromises();
    expect(peer.multiplayer.presence()["1001"]).toBe("left");

    await peer.multiplayer.disconnect();
    await jsPsych.multiplayer.disconnect();
  });

  test("disconnecting and connecting again on the same page rejoins, even while the old socket closes", async () => {
    jest.useFakeTimers();
    mock.leaveSlowly();
    const jsPsych = await jatosSession();
    const left = jest.fn();
    const peer = await serverPeer({ dropoutTimeout: 5000, onParticipantLeft: left });

    await jsPsych.multiplayer.disconnect();
    expect(peer.multiplayer.presence()["1001"]).toBe("away");

    const connecting = jsPsych.multiplayer.connect(new JatosAdapter());
    await flushPromises();
    mock.finishClosing();
    await jest.advanceTimersByTimeAsync(100);
    mock.open();
    await connecting;
    await flushPromises();

    expect(jsPsych.multiplayer.participantId).toBe("1001");
    expect(jsPsych.multiplayer.restarted).toBe(false);
    expect(peer.multiplayer.presence()["1001"]).toBe("connected");
    expect(left).not.toHaveBeenCalled();

    await peer.multiplayer.disconnect();
    await jsPsych.multiplayer.disconnect();
  });

  test("a reloaded page under the same study result id counts as restarted", async () => {
    jest.useFakeTimers();
    const first = await jatosSession();
    const left = jest.fn();
    const peer = await serverPeer({ dropoutTimeout: 1000, onParticipantLeft: left });
    await first.multiplayer.disconnect();

    // A reload: a new page (new jsPsych) under the same study result id
    const reloaded = await jatosSession();
    await flushPromises();
    expect(reloaded.multiplayer.restarted).toBe(true);
    expect(reloaded.multiplayer.status).toBe("closed");
    expect(peer.multiplayer.presence()["1001"]).toBe("left");
    expect(left).toHaveBeenCalledWith("1001");

    await peer.multiplayer.disconnect();
    await reloaded.multiplayer.disconnect();
  });
});
