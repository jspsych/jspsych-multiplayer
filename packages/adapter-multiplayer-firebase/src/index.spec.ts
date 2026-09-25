import { readFileSync } from "fs";
import { join as joinPath } from "path";

import { AdapterConnectOptions, initJsPsych } from "jspsych";

import rules from "../database.rules.json";
import { FakeBackend, FakeRtdb } from "./fake-backend";
import FirebaseAdapter, { FirebaseAdapterOptions } from ".";

/** Flush pending microtasks and macrotasks (the async reconnect handler). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const NS = "mp-sessions";
const SESSION = "sess1";
const slot = (id: string, session = SESSION) => `${NS}/${session}/${id}`;
const presence = (id: string, session = SESSION) => `${NS}-presence/${session}/${id}`;
const owner = (id: string, session = SESSION) => `${NS}-owners/${session}/${id}`;
const membership = (uid: string) => `${NS}-memberships/${uid}`;
const PARTICIPANT_KEY = `jspsych-multiplayer-firebase:${NS}:participant`;

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeAdapter(backend: FakeBackend, overrides: FirebaseAdapterOptions = {}) {
  return new FirebaseAdapter({
    sessionId: SESSION,
    participantId: "me",
    backend,
    ...overrides,
  });
}

function makeOptions(signal = new AbortController().signal) {
  return {
    signal,
    onChange: jest.fn(),
    onStatus: jest.fn(),
    onResumed: jest.fn(),
  } satisfies AdapterConnectOptions;
}

/** Connect a participant with its own backend on a shared rtdb. */
async function join(rtdb: FakeRtdb, id: string, backendOptions = {}) {
  const backend = new FakeBackend({ rtdb, uid: id, ...backendOptions });
  const options = makeOptions();
  const connection = await makeAdapter(backend, { participantId: id }).connect(options);
  return { backend, options, connection };
}

describe("FirebaseAdapter — connect", () => {
  it("resolves with a connection once both the session and presence nodes have loaded", async () => {
    const rtdb = new FakeRtdb();
    rtdb.set(slot("peer"), JSON.stringify({ hello: "world" }));
    rtdb.set(presence("peer"), "1");

    const connection = await makeAdapter(new FakeBackend({ rtdb })).connect(makeOptions());

    expect(connection.participantId).toBe("me");
    expect(connection.sessionId).toBe(SESSION);
    expect(connection.getAll()).toEqual({ peer: { hello: "world" } });
    expect(connection.connectedParticipants().sort()).toEqual(["me", "peer"]);
  });

  it("rejects when the session listener is cancelled (rules denial)", async () => {
    const adapter = makeAdapter(new FakeBackend({ denyReads: true }));
    await expect(adapter.connect(makeOptions())).rejects.toThrow(/security-rules denial/);
  });

  it("waits for the first snapshot until the signal aborts, then tears its listeners down", async () => {
    const backend = new FakeBackend({ deferInitialSnapshot: true });
    const controller = new AbortController();
    const options = makeOptions(controller.signal);

    const connecting = makeAdapter(backend).connect(options);
    await flush();
    controller.abort();

    await expect(connecting).rejects.toThrow(/cancelled/);
    expect(backend.rtdb.listenerCount()).toBe(0);
    backend.rtdb.set(slot("peer"), JSON.stringify({ hello: "world" }));
    expect(options.onChange).not.toHaveBeenCalled();
  });

  it("leaves the time limit to the core's connectTimeout", async () => {
    const jsPsych = initJsPsych();
    const backend = new FakeBackend({ neverSnapshot: true });
    await expect(
      jsPsych.multiplayer.connect(makeAdapter(backend), { connectTimeout: 20 }),
    ).rejects.toMatchObject({ name: "MultiplayerError", code: "timeout" });
    expect(backend.goOfflineCalls).toBe(1);
  });

  it("rejects the removed options with a pointer to their replacements", () => {
    const backend = new FakeBackend();
    expect(() => makeAdapter(backend, { pathPrefix: "x" } as FirebaseAdapterOptions)).toThrow(
      /namespace/,
    );
    expect(() => makeAdapter(backend, { connectTimeoutMs: 5 } as FirebaseAdapterOptions)).toThrow(
      /connectTimeout/,
    );
  });

  it("releases everything when arming onDisconnect fails, and a retry works", async () => {
    const backend = new FakeBackend();
    jest
      .spyOn(backend, "onDisconnectRemove")
      .mockRejectedValueOnce(new Error("onDisconnect denied"));
    const adapter = makeAdapter(backend);

    await expect(adapter.connect(makeOptions())).rejects.toThrow(/onDisconnect denied/);
    expect(backend.rtdb.listenerCount()).toBe(0);
    expect(backend.goOfflineCalls).toBe(1);

    const connection = await adapter.connect(makeOptions());
    await connection.push({ x: 1 });
    expect(connection.getAll().me).toEqual({ x: 1 });
  });

  it("returns a new, independent connection on every connect()", async () => {
    const backend = new FakeBackend({ ownsApp: false });
    const adapter = makeAdapter(backend);

    const first = await adapter.connect(makeOptions());
    const secondOptions = makeOptions();
    const second = await adapter.connect(secondOptions);
    expect(second).not.toBe(first);

    await first.disconnect();
    secondOptions.onChange.mockClear();
    await second.push({ still: "here" });
    expect(second.getAll().me).toEqual({ still: "here" });
    expect(secondOptions.onChange).toHaveBeenCalled();
  });

  it("uses a namespace for every node", async () => {
    const backend = new FakeBackend({ uid: "u" });
    const connection = await makeAdapter(backend, { namespace: "study" }).connect(makeOptions());
    await connection.push({ x: 1 });
    expect(backend.rtdb.get(`study/${SESSION}/me`)).toBe(JSON.stringify({ x: 1 }));
    expect(backend.rtdb.get(`study-presence/${SESSION}/me`)).toBe("1");
    expect(backend.rtdb.get(`study-owners/${SESSION}/me`)).toBe("u");
    expect(backend.rtdb.get("study-memberships/u")).toBe(SESSION);
  });
});

describe("FirebaseAdapter — cancelling connect()", () => {
  it("rejects without touching the backend when the signal is already aborted", async () => {
    const backend = new FakeBackend();
    const signIn = jest.spyOn(backend, "signIn");
    const controller = new AbortController();
    controller.abort();

    await expect(makeAdapter(backend).connect(makeOptions(controller.signal))).rejects.toThrow(
      /cancelled/,
    );
    expect(signIn).not.toHaveBeenCalled();
  });

  it("stops after sign-in when aborted during it, leaving nothing open", async () => {
    const backend = new FakeBackend();
    let finishSignIn!: (uid: string) => void;
    jest.spyOn(backend, "signIn").mockReturnValue(new Promise((r) => (finishSignIn = r)));
    const controller = new AbortController();

    const connecting = makeAdapter(backend).connect(makeOptions(controller.signal));
    controller.abort();
    finishSignIn("me");

    await expect(connecting).rejects.toThrow(/cancelled/);
    expect(backend.rtdb.listenerCount()).toBe(0);
    expect(backend.rtdb.get(presence("me"))).toBeUndefined();
  });
});

describe("FirebaseAdapter — data", () => {
  it("stores each push JSON-encoded in this participant's slot", async () => {
    const backend = new FakeBackend();
    const connection = await makeAdapter(backend).connect(makeOptions());

    await connection.push({ offer: 5 });

    expect(backend.rtdb.get(slot("me"))).toBe(JSON.stringify({ offer: 5 }));
    expect(connection.getAll().me).toEqual({ offer: 5 });
  });

  it("returns each stored payload unchanged", async () => {
    const connection = await makeAdapter(new FakeBackend()).connect(makeOptions());
    const payload = {
      $mp: { v: 1, instance: "i", epoch: 3, left: ["x"] },
      session: { strokes: [], nested: [[1, 2], []], empty: {} },
      scopes: { "0": { a: null } },
    };
    await connection.push(payload);
    expect(connection.getAll().me).toEqual(payload);
  });

  it("calls onChange when another participant writes", async () => {
    const rtdb = new FakeRtdb();
    const a = await join(rtdb, "a");
    const b = await join(rtdb, "b");
    a.options.onChange.mockClear();

    await b.connection.push({ role: "responder" });

    expect(a.options.onChange).toHaveBeenCalled();
    expect(a.connection.getAll()).toEqual({ b: { role: "responder" } });
  });

  it("rejects push() after disconnect()", async () => {
    const connection = await makeAdapter(new FakeBackend()).connect(makeOptions());
    await connection.disconnect();
    await expect(connection.push({ a: 1 })).rejects.toThrow(/closed connection/);
  });

  it("push() rejects when the write fails", async () => {
    const backend = new FakeBackend({ denyWrite: (path) => path === slot("me") });
    const connection = await makeAdapter(backend).connect(makeOptions());
    await expect(connection.push({ a: 1 })).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe("FirebaseAdapter — presence", () => {
  it("writes a presence node on connect, armed for server-side removal", async () => {
    const backend = new FakeBackend();
    await makeAdapter(backend).connect(makeOptions());

    expect(backend.rtdb.get(presence("me"))).toBe("1");
    expect(backend.isArmed(presence("me"))).toBe(true);
  });

  it("lists participants as they connect and disconnect, and keeps their data", async () => {
    const rtdb = new FakeRtdb();
    const a = await join(rtdb, "a");
    const b = await join(rtdb, "b");
    expect(a.connection.connectedParticipants().sort()).toEqual(["a", "b"]);

    await b.connection.push({ answer: 42 });
    a.options.onChange.mockClear();
    await b.connection.disconnect();

    expect(a.options.onChange).toHaveBeenCalled();
    expect(a.connection.connectedParticipants()).toEqual(["a"]);
    expect(a.connection.getAll().b).toEqual({ answer: 42 });
  });

  it("drops a participant whose connection is lost, when the server fires their onDisconnect", async () => {
    const rtdb = new FakeRtdb();
    const a = await join(rtdb, "a");
    const b = await join(rtdb, "b");

    b.backend.setConnected(false);
    rtdb.remove(presence("b")); // what the server's armed onDisconnect does

    expect(a.connection.connectedParticipants()).toEqual(["a"]);
  });

  it("restores its presence and calls onResumed when the server removed it without a drop", async () => {
    const backend = new FakeBackend();
    const options = makeOptions();
    await makeAdapter(backend).connect(options);

    // e.g. the server timed the channel out, but .info/connected never went false here
    backend.rtdb.remove(presence("me"));
    await flush();

    expect(backend.rtdb.get(presence("me"))).toBe("1");
    expect(backend.isArmed(presence("me"))).toBe(true);
    expect(options.onResumed).toHaveBeenCalledTimes(1);
    expect(options.onStatus).not.toHaveBeenCalled();
  });
});

describe("FirebaseAdapter — own connection status", () => {
  it("reports reconnecting and connected across a blip, and restores presence", async () => {
    const backend = new FakeBackend();
    const options = makeOptions();
    const connection = await makeAdapter(backend).connect(options);

    backend.simulateBlip(); // we drop, the server removes our presence, then we reconnect
    await flush();

    expect(options.onStatus.mock.calls).toEqual([["reconnecting"], ["connected"]]);
    expect(options.onResumed).not.toHaveBeenCalled();
    expect(backend.rtdb.get(presence("me"))).toBe("1");
    expect(backend.isArmed(presence("me"))).toBe(true);
    expect(connection.connectedParticipants()).toEqual(["me"]);
  });

  it("does not delete or re-write the data slot on a blip", async () => {
    const backend = new FakeBackend();
    const connection = await makeAdapter(backend).connect(makeOptions());
    await connection.push({ ready: true });
    const set = jest.spyOn(backend, "set");

    backend.simulateBlip();
    await flush();

    expect(backend.isArmed(slot("me"))).toBe(false);
    expect(set.mock.calls.map(([path]) => path)).not.toContain(slot("me"));
    expect(connection.getAll().me).toEqual({ ready: true });
  });

  it("reports closed when a listener is cancelled after connecting", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const backend = new FakeBackend();
    const options = makeOptions();
    await makeAdapter(backend).connect(options);

    backend.rtdb.cancelListeners(`${NS}/${SESSION}`);

    expect(options.onStatus.mock.calls).toEqual([["closed"]]);
    expect(console.error).toHaveBeenCalled();
  });

  it("reports closed only once, even if both listeners are cancelled", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const backend = new FakeBackend();
    const options = makeOptions();
    await makeAdapter(backend).connect(options);

    backend.rtdb.cancelListeners();

    expect(options.onStatus.mock.calls).toEqual([["closed"]]);
  });
});

describe("FirebaseAdapter — disconnect", () => {
  it("withdraws presence, keeps the data slot, and goes offline when it owns the app", async () => {
    const backend = new FakeBackend({ ownsApp: true });
    const connection = await makeAdapter(backend).connect(makeOptions());
    await connection.push({ a: 1 });

    await connection.disconnect();

    expect(backend.rtdb.get(presence("me"))).toBeUndefined();
    expect(backend.isArmed(presence("me"))).toBe(false);
    expect(backend.rtdb.get(slot("me"))).toBe(JSON.stringify({ a: 1 }));
    expect(backend.rtdb.listenerCount()).toBe(0);
    expect(backend.goOfflineCalls).toBe(1);
  });

  it("does not call goOffline() on an injected (non-owned) database", async () => {
    const backend = new FakeBackend({ ownsApp: false });
    const connection = await makeAdapter(backend).connect(makeOptions());
    await connection.disconnect();
    expect(backend.goOfflineCalls).toBe(0);
  });

  it("stops every callback, and is safe to call twice", async () => {
    const rtdb = new FakeRtdb();
    const a = await join(rtdb, "a");
    const b = await join(rtdb, "b");

    await a.connection.disconnect();
    await a.connection.disconnect();
    a.options.onChange.mockClear();

    await b.connection.push({ n: 1 });
    a.backend.setConnected(false);
    a.backend.setConnected(true);
    await flush();

    expect(a.options.onChange).not.toHaveBeenCalled();
    expect(a.options.onStatus).not.toHaveBeenCalled();
    expect(a.backend.goOfflineCalls).toBe(1);
  });
});

describe("FirebaseAdapter — session binding and slot claims", () => {
  it("registers a membership record and a slot claim by default, before the session listener", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    const order: string[] = [];
    jest.spyOn(backend, "set").mockImplementation(async (path, value) => {
      order.push(path);
      backend.rtdb.set(path, value);
    });
    const onValue = jest.spyOn(backend, "onValue");
    onValue.mockImplementation((path, ...rest) => {
      order.push(`listen ${path}`);
      return FakeBackend.prototype.onValue.call(backend, path, ...rest);
    });

    await makeAdapter(backend).connect(makeOptions());

    // Both are RAW ids (the rules compare them unquoted)
    expect(backend.rtdb.get(membership("uid-1"))).toBe(SESSION);
    expect(backend.rtdb.get(owner("me"))).toBe("uid-1");
    expect(order.slice(0, 3)).toEqual([
      membership("uid-1"),
      owner("me"),
      `listen ${NS}/${SESSION}`,
    ]);
  });

  it("a denied membership write rejects connect() with a descriptive error and no live listener", async () => {
    const backend = new FakeBackend({
      uid: "uid-1",
      denyWrite: (path) => path === membership("uid-1"),
    });

    await expect(makeAdapter(backend).connect(makeOptions())).rejects.toThrow(/session membership/);
    expect(backend.rtdb.listenerCount()).toBe(0);
  });

  it("a denied slot claim (another identity owns the id) rejects connect()", async () => {
    const backend = new FakeBackend({ uid: "uid-2", denyWrite: (path) => path === owner("me") });
    await expect(makeAdapter(backend).connect(makeOptions())).rejects.toThrow(
      /claiming participant "me"/,
    );
    expect(backend.rtdb.listenerCount()).toBe(0);
  });

  it("sessionBinding: false skips the membership write but still claims the slot", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    await makeAdapter(backend, { sessionBinding: false }).connect(makeOptions());

    expect(backend.rtdb.get(membership("uid-1"))).toBeUndefined();
    expect(backend.rtdb.get(owner("me"))).toBe("uid-1");
  });

  it("membership and slot claim survive disconnect() (they are the security property)", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    const connection = await makeAdapter(backend).connect(makeOptions());
    await connection.disconnect();

    expect(backend.rtdb.get(membership("uid-1"))).toBe(SESSION);
    expect(backend.rtdb.get(owner("me"))).toBe("uid-1");
  });
});

describe("FirebaseAdapter — participant ids", () => {
  it("uses the auth uid as participantId in uid-as-key mode", async () => {
    const backend = new FakeBackend({ uid: "uid-123" });
    const adapter = new FirebaseAdapter({
      sessionId: SESSION,
      useUidAsParticipantId: true,
      backend,
    });

    const connection = await adapter.connect(makeOptions());
    await connection.push({ a: 1 });

    expect(connection.participantId).toBe("uid-123");
    expect(connection.getAll()["uid-123"]).toEqual({ a: 1 });
    expect(sessionStorage.getItem(PARTICIPANT_KEY)).toBeNull();
  });

  it("reuses the participantId across connections made with the same adapter", async () => {
    const adapter = new FirebaseAdapter({ sessionId: SESSION, backend: new FakeBackend() });
    const first = await adapter.connect(makeOptions());
    await first.disconnect();
    const second = await adapter.connect(makeOptions());
    expect(second.participantId).toBe(first.participantId);
  });

  it("keeps the default participantId for this tab, so a reload is the same participant", async () => {
    const first = new FirebaseAdapter({ sessionId: SESSION, backend: new FakeBackend() });
    const before = await first.connect(makeOptions());
    expect(sessionStorage.getItem(PARTICIPANT_KEY)).toBe(before.participantId);

    // A reload: a new page constructs a new adapter in the same tab
    const reloaded = new FirebaseAdapter({ sessionId: SESSION, backend: new FakeBackend() });
    const after = await reloaded.connect(makeOptions());
    expect(after.participantId).toBe(before.participantId);

    // A new tab starts with empty sessionStorage
    sessionStorage.clear();
    const newTab = new FirebaseAdapter({ sessionId: SESSION, backend: new FakeBackend() });
    expect((await newTab.connect(makeOptions())).participantId).not.toBe(before.participantId);
  });

  it("persistParticipant: false mints a new participantId for every page load", async () => {
    const make = () =>
      new FirebaseAdapter({
        sessionId: SESSION,
        persistParticipant: false,
        backend: new FakeBackend(),
      });
    const a = await make().connect(makeOptions());
    const b = await make().connect(makeOptions());
    expect(a.participantId).not.toBe(b.participantId);
    expect(sessionStorage.getItem(PARTICIPANT_KEY)).toBeNull();
  });

  it("throws when constructed with both useUidAsParticipantId and a custom participantId", () => {
    expect(() => new FirebaseAdapter({ useUidAsParticipantId: true, participantId: "me" })).toThrow(
      /incompatible/,
    );
  });

  it.each([
    ["colon", "a:b"],
    ["slash", "a/b"],
    ["dot", "a.b"],
    ["dollar", "a$b"],
    ["hash", "a#b"],
    ["open-bracket", "a[b"],
    ["empty", ""],
  ])("rejects a participantId containing a %s", (_label, id) => {
    expect(() => new FirebaseAdapter({ sessionId: SESSION, participantId: id })).toThrow(
      /participantId must be a non-empty string without/,
    );
  });

  it("rejects a sessionId or namespace containing a forbidden char", () => {
    expect(() => new FirebaseAdapter({ sessionId: "a/b", participantId: "me" })).toThrow(
      /sessionId must be/,
    );
    expect(
      () => new FirebaseAdapter({ sessionId: SESSION, participantId: "me", namespace: "a.b" }),
    ).toThrow(/namespace must be/);
  });

  it("reads the session from ?mp_session=, or writes a new one into the URL", () => {
    window.history.replaceState(null, "", "/?mp_session=from-url");
    const fromUrl = new FirebaseAdapter({ participantId: "me", backend: new FakeBackend() });
    window.history.replaceState(null, "", "/");
    const minted = new FirebaseAdapter({ participantId: "me", backend: new FakeBackend() });
    const url = new URL(window.location.href).searchParams.get("mp_session");
    expect(url).toBeTruthy();
    return Promise.all([fromUrl.connect(makeOptions()), minted.connect(makeOptions())]).then(
      ([a, b]) => {
        expect(a.sessionId).toBe("from-url");
        expect(b.sessionId).toBe(url);
      },
    );
  });
});

describe("FirebaseAdapter — with the jsPsych multiplayer core", () => {
  function connectJsPsych(rtdb: FakeRtdb, id: string) {
    const jsPsych = initJsPsych();
    const connecting = jsPsych.multiplayer.connect(
      makeAdapter(new FakeBackend({ rtdb, uid: id, ownsApp: false }), { participantId: id }),
    );
    return connecting.then(() => jsPsych);
  }

  it("shares data and reports a partner who leaves as away", async () => {
    const rtdb = new FakeRtdb();
    const a = await connectJsPsych(rtdb, "a");
    const b = await connectJsPsych(rtdb, "b");

    const waiting = a.multiplayer.wait((data) => data.b?.ready === true, { participants: ["b"] });
    await b.multiplayer.update({ ready: true });
    expect((await waiting).b).toEqual({ ready: true });
    expect(a.multiplayer.presence()).toEqual({ a: "connected", b: "connected" });

    await b.multiplayer.disconnect();
    expect(a.multiplayer.presence().b).toBe("away");
    expect(a.multiplayer.get("b")).toEqual({ ready: true });
    await a.multiplayer.disconnect();
  });

  it("a participant whose network comes back before the dropout timeout is connected again", async () => {
    const rtdb = new FakeRtdb();
    const a = await connectJsPsych(rtdb, "a");
    const bBackend = new FakeBackend({ rtdb, uid: "b", ownsApp: false });
    const b = initJsPsych();
    const statuses: string[] = [];
    await b.multiplayer.connect(makeAdapter(bBackend, { participantId: "b" }), {
      onStatusChange: (status) => statuses.push(status),
    });
    await b.multiplayer.update({ score: 1 });

    bBackend.simulateDrop();
    expect(a.multiplayer.presence().b).toBe("away");

    bBackend.setConnected(true);
    await flush();
    expect(statuses).toEqual(["reconnecting", "connected"]);
    expect(a.multiplayer.presence().b).toBe("connected");
    expect(a.multiplayer.get("b")).toEqual({ score: 1 });
    await b.multiplayer.disconnect();
    await a.multiplayer.disconnect();
  });

  it("a reload of the tab comes back as the same participant, which the core reports as a restart", async () => {
    const rtdb = new FakeRtdb();
    const left = jest.fn();
    const a = initJsPsych();
    await a.multiplayer.connect(
      makeAdapter(new FakeBackend({ rtdb, uid: "a", ownsApp: false }), { participantId: "a" }),
      { onParticipantLeft: left },
    );

    // b uses the default, tab-persisted participant id
    const page = () =>
      new FirebaseAdapter({
        sessionId: SESSION,
        backend: new FakeBackend({ rtdb, uid: "uid-b", ownsApp: false }),
      });
    const before = initJsPsych();
    await before.multiplayer.connect(page());
    const b = before.multiplayer.participantId!;
    await before.multiplayer.update({ round: 2 });
    await before.multiplayer.disconnect();

    const after = initJsPsych();
    await after.multiplayer.connect(page());
    await flush();

    expect(after.multiplayer.participantId).toBe(b);
    expect(after.multiplayer.sessionId).toBe(SESSION);
    expect(after.multiplayer.restarted).toBe(true);
    expect(after.multiplayer.get(b)).toEqual({ round: 2 });
    expect(a.multiplayer.presence()[b]).toBe("left");
    expect(left).toHaveBeenCalledWith(b);
    await a.multiplayer.disconnect();
  });

  it("closes the session when the adapter loses read access", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const rtdb = new FakeRtdb();
    const a = await connectJsPsych(rtdb, "a");

    rtdb.cancelListeners();
    await flush();

    expect(a.multiplayer.status).toBe("closed");
  });
});

describe("FirebaseAdapter — matchmaking", () => {
  const LOBBY = "study-1";
  const lobbyPath = `${NS}-lobby/${LOBBY}`;
  const groupPath = (session: string) => `${NS}-groups/${session}`;
  const seatPath = (session: string, seat: number) => `${groupPath(session)}/seats/${seat}`;

  function matchmakingAdapter(
    backend: FakeBackend,
    id: string,
    overrides: FirebaseAdapterOptions = {},
  ) {
    return new FirebaseAdapter({
      participantId: id,
      backend,
      matchmaking: { lobby: LOBBY, groupSize: 2 },
      // Every simulated participant shares jsdom's one sessionStorage, as if in one tab
      persistParticipant: false,
      ...overrides,
    });
  }

  async function arrive(
    rtdb: FakeRtdb,
    id: string,
    overrides: FirebaseAdapterOptions = {},
    backendOptions = {},
  ) {
    const backend = new FakeBackend({ rtdb, uid: `uid-${id}`, ...backendOptions });
    const options = makeOptions();
    const connection = await matchmakingAdapter(backend, id, overrides).connect(options);
    return { backend, options, connection };
  }

  it("rejects bad options", () => {
    const backend = new FakeBackend();
    expect(() => matchmakingAdapter(backend, "a", { sessionId: "s" })).toThrow(/sessionId/);
    expect(() =>
      matchmakingAdapter(backend, "a", { matchmaking: { lobby: LOBBY, groupSize: 0 } }),
    ).toThrow(/groupSize/);
    expect(() =>
      matchmakingAdapter(backend, "a", { matchmaking: { lobby: "a/b", groupSize: 2 } }),
    ).toThrow(/lobby/);
  });

  it("without matchmaking the connection doesn't form groups", async () => {
    const { connection } = await join(new FakeRtdb(), "a");
    expect(connection.group).toBeUndefined();
    expect(connection.sealGroup).toBeUndefined();
  });

  it("fills a group as participants arrive, seals it when full, and starts the next", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    expect(a.connection.group!()).toEqual({ size: 2, members: ["a"], sealed: false });

    const b = await arrive(rtdb, "b");
    expect(b.connection.sessionId).toBe(a.connection.sessionId);
    expect(a.connection.group!()).toEqual({ size: 2, members: ["a", "b"], sealed: true });
    expect(b.connection.group!()).toEqual({ size: 2, members: ["a", "b"], sealed: true });

    const c = await arrive(rtdb, "c");
    expect(c.connection.sessionId).not.toBe(a.connection.sessionId);
    expect(c.connection.group!()).toEqual({ size: 2, members: ["c"], sealed: false });
    expect(rtdb.get(lobbyPath)).toBe(c.connection.sessionId);
  });

  it("stores each seat under the holder's uid, and the sealed roster as a copy of the seats", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    await arrive(rtdb, "b");
    const session = a.connection.sessionId;
    const seats = { "0": { uid: "uid-a", id: "a" }, "1": { uid: "uid-b", id: "b" } };
    // Either member may be the one who seals: b as the last arrival, or a on seeing it full
    expect(rtdb.valueAt(groupPath(session))).toEqual({
      seats,
      sealed: { by: expect.stringMatching(/^[01]$/), seats },
    });
    // Once sealed, no seat is armed for removal: the roster is final
    await flush();
    expect(a.backend.isArmed(seatPath(session, 0))).toBe(false);
  });

  it("the session paths use the assigned session", async () => {
    const rtdb = new FakeRtdb();
    const { connection } = await arrive(rtdb, "a");
    const session = connection.sessionId;
    expect(rtdb.get(presence("a", session))).toBe("1");
    expect(rtdb.get(owner("a", session))).toBe("uid-a");
    await connection.push({ x: 1 });
    expect(rtdb.get(slot("a", session))).toBe(JSON.stringify({ x: 1 }));
  });

  it("a participant who leaves a filling group frees their place", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    await a.connection.disconnect();
    expect(rtdb.valueAt(seatPath(a.connection.sessionId, 0))).toBeNull();

    const b = await arrive(rtdb, "b");
    expect(b.connection.sessionId).toBe(a.connection.sessionId);
    expect(b.connection.group!()).toEqual({ size: 2, members: ["b"], sealed: false });
  });

  it("a participant who leaves a sealed group stays on the roster", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    const b = await arrive(rtdb, "b");
    await b.connection.disconnect();
    expect(a.connection.group!()).toEqual({ size: 2, members: ["a", "b"], sealed: true });
  });

  it("the server frees the place of a participant whose network drops while the group fills", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    a.backend.simulateDrop();
    expect(rtdb.valueAt(seatPath(a.connection.sessionId, 0))).toBeNull();

    // Back before anyone took it: they take their place again
    a.backend.setConnected(true);
    await flush();
    expect(a.options.onStatus).toHaveBeenLastCalledWith("connected");
    expect(a.connection.group!().members).toEqual(["a"]);
  });

  it("a participant whose place was filled while they were away is closed out", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    a.backend.simulateDrop();
    const b = await arrive(rtdb, "b");
    const c = await arrive(rtdb, "c");
    expect(c.connection.sessionId).toBe(b.connection.sessionId);
    expect(b.connection.sessionId).toBe(a.connection.sessionId);
    expect(b.connection.group!()).toEqual({ size: 2, members: ["b", "c"], sealed: true });

    a.backend.setConnected(true);
    await flush();
    expect(a.options.onStatus).toHaveBeenLastCalledWith("closed");
  });

  it("sealGroup() seals the group early, and later arrivals go to a new group", async () => {
    const rtdb = new FakeRtdb();
    const three = { matchmaking: { lobby: LOBBY, groupSize: 3 } };
    const a = await arrive(rtdb, "a", three);
    const b = await arrive(rtdb, "b", three);
    await a.connection.sealGroup!();
    expect(a.connection.group!()).toEqual({ size: 3, members: ["a", "b"], sealed: true });
    expect(b.connection.group!()).toEqual({ size: 3, members: ["a", "b"], sealed: true });
    await b.connection.sealGroup!();

    const c = await arrive(rtdb, "c", three);
    expect(c.connection.sessionId).not.toBe(a.connection.sessionId);
  });

  it("a late arrival moves on from a sealed group whose rules refuse its seat", async () => {
    const rtdb = new FakeRtdb();
    const three = { matchmaking: { lobby: LOBBY, groupSize: 3 } };
    const a = await arrive(rtdb, "a", three);
    const session = a.connection.sessionId;
    // Race: the late arrival read the group before the seal, then the rules refuse its seat
    let sealedMeanwhile = false;
    const b = await arrive(rtdb, "b", three, {
      beforeTransactionRead: (path: string) => {
        if (path === seatPath(session, 1) && !sealedMeanwhile) {
          sealedMeanwhile = true;
          rtdb.replace(`${groupPath(session)}/sealed`, {
            by: "0",
            seats: { "0": { uid: "uid-a", id: "a" } },
          });
        }
      },
      denyWrite: (path: string) => path === seatPath(session, 1),
    });
    expect(b.connection.sessionId).not.toBe(session);
    expect(b.backend.isArmed(seatPath(b.connection.sessionId, 0))).toBe(true);
  });

  it("a group that fills between reading it and taking a seat sends the arrival on", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    const session = a.connection.sessionId;
    let raced = false;
    const c = await arrive(
      rtdb,
      "c",
      {},
      {
        beforeTransactionRead: (path: string) => {
          if (path === seatPath(session, 1) && !raced) {
            raced = true;
            // Another participant's claim commits first, fills the group, and seals it
            rtdb.replace(seatPath(session, 1), { uid: "uid-b", id: "b" });
            rtdb.replace(`${groupPath(session)}/sealed`, {
              by: "1",
              seats: { "0": { uid: "uid-a", id: "a" }, "1": { uid: "uid-b", id: "b" } },
            });
          }
        },
      },
    );
    expect(c.connection.sessionId).not.toBe(session);
    expect(c.connection.group!().members).toEqual(["c"]);
  });

  it("a member seals a full group whose last arrival didn't get to seal it", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    const session = a.connection.sessionId;
    // b took the last seat, then its tab closed before it sealed
    rtdb.replace(seatPath(session, 1), { uid: "uid-b", id: "b" });
    await flush();
    expect(a.connection.group!()).toEqual({ size: 2, members: ["a", "b"], sealed: true });
  });

  it("an arrival waits for a full group to be sealed before the lobby moves on", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    const session = a.connection.sessionId;
    await a.connection.disconnect(); // nobody left to seal it
    rtdb.replace(groupPath(session), {
      seats: { "0": { uid: "uid-x", id: "x" }, "1": { uid: "uid-y", id: "y" } },
    });
    setTimeout(() => {
      rtdb.replace(`${groupPath(session)}/sealed`, {
        by: "0",
        seats: { "0": { uid: "uid-x", id: "x" }, "1": { uid: "uid-y", id: "y" } },
      });
    }, 50);
    const c = await arrive(rtdb, "c");
    expect(c.connection.sessionId).not.toBe(session);
  });

  it("works when transactions first run on a guessed null, as the real SDK's do", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a", {}, { transactionsGuessNull: true });
    const b = await arrive(rtdb, "b", {}, { transactionsGuessNull: true });
    expect(b.connection.sessionId).toBe(a.connection.sessionId);
    expect(b.connection.group!().sealed).toBe(true);
  });

  it("with session binding, a reload goes back to its own group", async () => {
    const rtdb = new FakeRtdb();
    const a = await arrive(rtdb, "a");
    expect(rtdb.get(membership("uid-a"))).toBe(a.connection.sessionId);
    await arrive(rtdb, "b");
    await a.connection.disconnect();

    // The lobby has moved on, but a's uid is bound to its first group
    await arrive(rtdb, "c");
    sessionStorage.clear(); // not the tab's memory: the binding
    const reloaded = await arrive(rtdb, "a");
    expect(reloaded.connection.sessionId).toBe(a.connection.sessionId);
  });

  it("without session binding, the tab remembers its group across a reload", async () => {
    const rtdb = new FakeRtdb();
    const unbound = { participantId: undefined, sessionBinding: false, persistParticipant: true };
    const a = await arrive(rtdb, "a", unbound);
    const id = a.connection.participantId;
    await arrive(rtdb, "b", { sessionBinding: false });
    await a.connection.disconnect();
    await arrive(rtdb, "c", { sessionBinding: false });

    // A reload: same tab storage, and even a new anonymous identity
    const reloaded = await arrive(rtdb, "a", unbound, { uid: "uid-a-again" });
    expect(reloaded.connection.participantId).toBe(id);
    expect(reloaded.connection.sessionId).toBe(a.connection.sessionId);
    expect(reloaded.connection.group!()).toEqual({
      size: 2,
      members: [id, "b"].sort(),
      sealed: true,
    });
  });

  it("with the core, everyone's waiting room ends when the group is full", async () => {
    const rtdb = new FakeRtdb();
    const connectJsPsych = async (id: string) => {
      const jsPsych = initJsPsych();
      await jsPsych.multiplayer.connect(
        matchmakingAdapter(new FakeBackend({ rtdb, uid: id, ownsApp: false }), id),
      );
      return jsPsych;
    };
    const a = await connectJsPsych("a");
    const waiting = a.multiplayer.waitForGroup();
    const b = await connectJsPsych("b");
    await expect(waiting).resolves.toEqual({ size: 2, members: ["a", "b"], sealed: true });
    expect(b.multiplayer.group()).toEqual({ size: 2, members: ["a", "b"], sealed: true });
    expect(b.multiplayer.sessionId).toBe(a.multiplayer.sessionId);
    expect(b.multiplayer.shuffle("order", [1, 2, 3, 4])).toEqual(
      a.multiplayer.shuffle("order", [1, 2, 3, 4]),
    );
    await a.multiplayer.disconnect();
    await b.multiplayer.disconnect();
  });
});

describe("database.rules.json", () => {
  type RuleNode = { [key: string]: RuleNode | string | boolean };
  const root = (rules as { rules: RuleNode }).rules;
  const node = (...path: string[]) =>
    path.reduce<RuleNode>((current, key) => current[key] as RuleNode, root);

  it("covers every node the adapter writes, and nothing else", () => {
    expect(Object.keys(root).sort()).toEqual(
      ["", "-groups", "-lobby", "-memberships", "-owners", "-presence"].map((s) => NS + s),
    );
  });

  it("lets a participant write only the data slot and presence they claimed", () => {
    for (const top of [NS, `${NS}-presence`]) {
      const write = node(top, "$session", "$pid")[".write"];
      expect(write).toContain(
        `root.child('${NS}-owners').child($session).child($pid).val() === auth.uid`,
      );
      expect(node(top, "$session")[".write"]).toBeUndefined();
    }
    const claim = node(`${NS}-owners`, "$session", "$pid")[".write"];
    expect(claim).toContain("newData.val() === auth.uid");
    expect(claim).toContain("(!data.exists() || data.val() === auth.uid)");
  });

  it("never grants write on a whole group node, so each seat is written alone", () => {
    const group = node(`${NS}-groups`, "$session");
    expect(group[".write"]).toBeUndefined();
    expect(node(`${NS}-groups`)[".write"]).toBeUndefined();
    const seat = node(`${NS}-groups`, "$session", "seats", "$seat")[".write"];
    // Take an empty seat as yourself, or free your own; never once sealed
    expect(seat).toContain("!data.exists() && newData.child('uid').val() === auth.uid");
    expect(seat).toContain("data.child('uid').val() === auth.uid && !newData.exists()");
    expect(seat).toContain("!data.parent().parent().child('sealed').exists()");
    // The roster: written once, by a member, copying the seats
    const sealed = node(`${NS}-groups`, "$session", "sealed");
    expect(sealed[".write"]).toContain("!data.exists()");
    expect(sealed[".write"]).toContain(
      "child(newData.child('by').val()).child('uid').val() === auth.uid",
    );
    expect(node(`${NS}-groups`, "$session", "sealed", "seats", "$seat")[".validate"]).toContain(
      "child('seats').child($seat).child('uid').val()",
    );
  });

  it("only moves a lobby off a sealed group, onto a new one", () => {
    const write = node(`${NS}-lobby`, "$lobby")[".write"];
    expect(write).toContain(`!root.child('${NS}-groups').child(newData.val()).exists()`);
    expect(write).toContain(
      `(!data.exists() || root.child('${NS}-groups').child(data.val()).child('sealed').exists())`,
    );
  });

  it("matches the recommended rules in the README", () => {
    const readme = readFileSync(joinPath(__dirname, "..", "README.md"), "utf8");
    const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    expect(blocks).toContainEqual(rules);
    // The quick-start rules cover the same nodes, so the default options work with both
    const quickStart = blocks.find(
      (block) => block.rules?.[NS]?.$session?.[".write"] === "auth != null",
    );
    expect(Object.keys(quickStart.rules).sort()).toEqual(Object.keys(root).sort());
  });
});
