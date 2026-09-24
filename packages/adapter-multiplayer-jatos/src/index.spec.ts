import {
  AdapterConnectOptions,
  ConnectionStatus,
  ConnectOptions,
  initJsPsych,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";

import { stripMeta } from "../../../test-utils/memory-backend";
import JatosAdapter from ".";

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
  const store: Record<string, Record<string, unknown>> = {};
  let wiped = false;
  let callbacks: Record<string, ((...args: unknown[]) => void) | undefined> = {};
  let join: { resolve: () => void; reject: (reason: unknown) => void } | null = null;
  /** The socket from a left channel is still closing. */
  let closing = false;
  /** Leaving leaves the socket closing, until finishClosing(). */
  let leaveLeavesSocketClosing = false;
  /** Held leave requests, released by finishLeave(). */
  let heldLeave: (() => void) | null = null;
  let holdLeaves = false;
  /** Called whenever what the server holds changes: data or open channels. */
  const serverListeners = new Set<() => void>();
  const serverChanged = () => serverListeners.forEach((listener) => listener());

  const jatos = {
    studyResultId: studyResultId ?? undefined,
    workerId,
    groupChannels: [] as Array<string | number>,
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
        store[key] = value as Record<string, unknown>;
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
      if (!jatos.groupChannels.includes(self)) jatos.groupChannels.push(self);
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

  test("rejects with a diagnostic if JATOS never reports success or failure", async () => {
    jest.useFakeTimers();
    const { options } = connectOptions();
    const assertion = new JatosAdapter({ connectTimeoutMs: 5 })
      .connect(options)
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(5);
    expect(((await assertion) as Error).message).toMatch(/timed out after 5 ms/);
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

  test("by default, a channel that stays down never reports closed", async () => {
    jest.useFakeTimers();
    const { statuses } = await connected();
    mock.drop();
    jest.advanceTimersByTime(60 * 60_000);
    expect(statuses).toEqual(["reconnecting"]);
    mock.open();
    expect(statuses).toEqual(["reconnecting", "connected"]);
  });

  test("with closeAfterReconnectingMs, a channel that stays down that long reports closed", async () => {
    jest.useFakeTimers();
    const { statuses } = await connected(new JatosAdapter({ closeAfterReconnectingMs: 30_000 }));
    mock.drop();
    jest.advanceTimersByTime(29_999);
    expect(statuses).toEqual(["reconnecting"]);
    jest.advanceTimersByTime(1);
    expect(statuses).toEqual(["reconnecting", "closed"]);

    // jatos.js reopening afterward doesn't revive the connection
    mock.open();
    expect(statuses).toEqual(["reconnecting", "closed"]);
  });

  test("closeAfterReconnectingMs sets how long to wait, and null waits forever", async () => {
    jest.useFakeTimers();
    const short = await connected(new JatosAdapter({ closeAfterReconnectingMs: 100 }));
    mock.drop();
    jest.advanceTimersByTime(100);
    expect(short.statuses).toEqual(["reconnecting", "closed"]);
    await short.connection.disconnect();

    const never = await connected(new JatosAdapter({ closeAfterReconnectingMs: null }));
    mock.drop();
    jest.advanceTimersByTime(10 * 60_000);
    expect(never.statuses).toEqual(["reconnecting"]);
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

  test("throws after exhausting all retry attempts, preserving the cause", async () => {
    jest.useFakeTimers();
    const { connection } = await connected();
    const underlying = new Error("version conflict");
    mock.jatos.groupSession.set.mockRejectedValue(underlying);

    const assertion = connection.push({ x: 1 }).catch((e: unknown) => e);
    await jest.runAllTimersAsync();
    const err = (await assertion) as Error & { cause?: unknown };

    expect(err.message).toMatch(/after 8 attempts/);
    expect(err.cause).toBe(underlying);
    expect(mock.jatos.groupSession.set).toHaveBeenCalledTimes(8);
  });

  test("a push made while the channel is down is sent once it reopens", async () => {
    const { connection } = await connected();
    mock.drop();
    let done = false;
    const pushing = connection.push({ x: 1 }).then(() => (done = true));
    await flushPromises();
    expect(done).toBe(false);
    expect(mock.jatos.groupSession.set).not.toHaveBeenCalled();

    mock.open();
    await pushing;
    expect(mock.store["1001"]).toEqual({ x: 1 });
  });

  test("a write that fails because the channel dropped is retried after it reopens", async () => {
    const { connection } = await connected();
    mock.jatos.groupSession.set.mockImplementationOnce(async () => {
      mock.drop();
      throw new Error("No open group channel");
    });
    const pushing = connection.push({ x: 1 });
    await flushPromises();
    mock.open();
    await pushing;
    expect(mock.store["1001"]).toEqual({ x: 1 });
  });

  test("a push waiting for the channel rejects once the connection is lost", async () => {
    jest.useFakeTimers();
    const { connection } = await connected(new JatosAdapter({ closeAfterReconnectingMs: 30_000 }));
    mock.drop();
    const assertion = connection.push({ x: 1 }).catch((e: unknown) => e);
    jest.advanceTimersByTime(30_000);
    expect(((await assertion) as Error).message).toMatch(/stayed closed/);
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
    expect(stripMeta(mock.store["1001"])).toEqual({ ready: true });

    mock.drop();
    expect(jsPsych.multiplayer.status).toBe("reconnecting");
    expect(jsPsych.multiplayer.get("1001")).toEqual({ ready: true });
    mock.open();
    expect(jsPsych.multiplayer.status).toBe("connected");

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

  test("a join that keeps being refused fails at the connect timeout", async () => {
    jest.useFakeTimers();
    mock.leaveSlowly();
    const first = await connected();
    await first.connection.disconnect();

    const { options } = connectOptions();
    const second = new JatosAdapter({ connectTimeoutMs: 2000 })
      .connect(options)
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(2000);
    expect(((await second) as Error).message).toMatch(/timed out/);
  });
});

describe("rejoining", () => {
  test("a participant whose channel reopens after leaving rejoins", async () => {
    jest.useFakeTimers();
    const jsPsych = await jatosSession();
    await jsPsych.multiplayer.update({ round: 2 });
    const rejoined = jest.fn();
    const restarted = jest.fn();
    const peer = await serverPeer({
      dropoutTimeout: 5000,
      onParticipantRejoined: rejoined,
      onParticipantRestarted: restarted,
    });
    expect(peer.multiplayer.presence()["1001"]).toBe("connected");

    mock.drop();
    expect(jsPsych.multiplayer.status).toBe("reconnecting");
    expect(peer.multiplayer.presence()["1001"]).toBe("away");
    // Long past the dropout timeout; by default the adapter keeps waiting
    jest.advanceTimersByTime(10 * 60_000);
    expect(peer.multiplayer.presence()["1001"]).toBe("left");
    expect(jsPsych.multiplayer.status).toBe("reconnecting");

    mock.open();
    await flushPromises();
    expect(jsPsych.multiplayer.status).toBe("connected");
    expect(peer.multiplayer.presence()["1001"]).toBe("connected");
    expect(rejoined).toHaveBeenCalledWith("1001");
    expect(restarted).not.toHaveBeenCalled();
    expect(peer.multiplayer.get("1001")).toEqual({ round: 2 });

    await peer.multiplayer.disconnect();
    await jsPsych.multiplayer.disconnect();
  });

  test("disconnecting and connecting again on the same page rejoins, even while the old socket closes", async () => {
    jest.useFakeTimers();
    mock.leaveSlowly();
    const jsPsych = await jatosSession();
    const rejoined = jest.fn();
    const restarted = jest.fn();
    const peer = await serverPeer({
      dropoutTimeout: 1000,
      onParticipantRejoined: rejoined,
      onParticipantRestarted: restarted,
    });

    await jsPsych.multiplayer.disconnect();
    expect(peer.multiplayer.presence()["1001"]).toBe("away");
    jest.advanceTimersByTime(1000);
    expect(peer.multiplayer.presence()["1001"]).toBe("left");

    const connecting = jsPsych.multiplayer.connect(new JatosAdapter());
    await flushPromises();
    mock.finishClosing();
    await jest.advanceTimersByTimeAsync(100);
    mock.open();
    await connecting;
    await flushPromises();

    expect(jsPsych.multiplayer.participantId).toBe("1001");
    expect(jsPsych.multiplayer.previousInstance).toBeNull();
    expect(peer.multiplayer.presence()["1001"]).toBe("connected");
    expect(rejoined).toHaveBeenCalledWith("1001");
    expect(restarted).not.toHaveBeenCalled();

    await peer.multiplayer.disconnect();
    await jsPsych.multiplayer.disconnect();
  });

  test("a reloaded page under the same study result id counts as restarted", async () => {
    jest.useFakeTimers();
    const first = await jatosSession();
    const restarted = jest.fn();
    const peer = await serverPeer({ dropoutTimeout: 1000, onParticipantRestarted: restarted });
    await first.multiplayer.disconnect();

    // A reload: a new page (new jsPsych) under the same study result id
    const reloaded = await jatosSession();
    await flushPromises();
    expect(reloaded.multiplayer.previousInstance).not.toBeNull();
    expect(peer.multiplayer.presence()["1001"]).toBe("left");
    expect(restarted).toHaveBeenCalledWith("1001");

    await peer.multiplayer.disconnect();
    await reloaded.multiplayer.disconnect();
  });
});
