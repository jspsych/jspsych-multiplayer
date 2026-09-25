import { AdapterConnectOptions, initJsPsych } from "jspsych";

import { FakeBackend, FakeRtdb } from "./fake-backend";
import FirebaseAdapter, { FirebaseAdapterOptions } from ".";

/** Flush pending microtasks and macrotasks (the async reconnect handler). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PREFIX = "mp-sessions";
const SESSION = "sess1";
const slot = (id: string) => `${PREFIX}/${SESSION}/${id}`;
const presence = (id: string) => `${PREFIX}-presence/${SESSION}/${id}`;
const membership = (uid: string) => `${PREFIX}-memberships/${uid}`;

function makeAdapter(backend: FakeBackend, overrides: FirebaseAdapterOptions = {}) {
  return new FirebaseAdapter({
    sessionId: SESSION,
    participantId: "me",
    backend,
    connectTimeoutMs: 50,
    ...overrides,
  });
}

function makeOptions(signal = new AbortController().signal) {
  return {
    signal,
    onChange: jest.fn(),
    onStatus: jest.fn(),
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

  it("rejects when no snapshot ever arrives (timeout)", async () => {
    const adapter = makeAdapter(new FakeBackend({ neverSnapshot: true }));
    await expect(adapter.connect(makeOptions())).rejects.toThrow(/timed out/);
  });

  it("tears its listeners down on a timeout, so a late snapshot can't reach the core", async () => {
    const backend = new FakeBackend({ deferInitialSnapshot: true });
    const options = makeOptions();

    await expect(makeAdapter(backend).connect(options)).rejects.toThrow(/timed out/);

    expect(backend.rtdb.listenerCount()).toBe(0);
    backend.rtdb.set(slot("peer"), JSON.stringify({ hello: "world" }));
    expect(options.onChange).not.toHaveBeenCalled();
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

  it("stops waiting for the first snapshot as soon as the signal is aborted", async () => {
    const backend = new FakeBackend({ deferInitialSnapshot: true });
    const controller = new AbortController();
    const adapter = makeAdapter(backend, { connectTimeoutMs: 60000 });

    const connecting = adapter.connect(makeOptions(controller.signal));
    await flush();
    controller.abort();

    await expect(connecting).rejects.toThrow(/cancelled/);
    expect(backend.rtdb.listenerCount()).toBe(0);
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

  it("round-trips an empty array (RTDB would prune it if stored raw)", async () => {
    const connection = await makeAdapter(new FakeBackend()).connect(makeOptions());
    await connection.push({ strokes: [] });
    expect(connection.getAll().me).toEqual({ strokes: [] });
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
});

describe("FirebaseAdapter — own connection status", () => {
  it("reports reconnecting and connected across a blip, and restores presence", async () => {
    const backend = new FakeBackend();
    const options = makeOptions();
    const connection = await makeAdapter(backend).connect(options);

    backend.simulateBlip(); // the server removes our presence, we drop, then reconnect
    await flush();

    expect(options.onStatus.mock.calls).toEqual([["reconnecting"], ["connected"]]);
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

    backend.rtdb.cancelListeners(`${PREFIX}/${SESSION}`);

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

describe("FirebaseAdapter — session binding", () => {
  it("uid mode registers a first-write-wins membership record before the session listener", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    const adapter = makeAdapter(backend, { participantId: undefined, useUidAsParticipantId: true });

    await adapter.connect(makeOptions());

    // The record is the RAW sessionId (the rules compare it unquoted with === $session).
    expect(backend.rtdb.get(membership("uid-1"))).toBe(SESSION);
  });

  it("a denied membership write rejects connect() with a descriptive error and no live listener", async () => {
    const backend = new FakeBackend({
      uid: "uid-1",
      denyWrite: (path) => path === membership("uid-1"),
    });
    const adapter = makeAdapter(backend, { participantId: undefined, useUidAsParticipantId: true });

    await expect(adapter.connect(makeOptions())).rejects.toThrow(/session membership/);
    expect(backend.rtdb.listenerCount()).toBe(0);
  });

  it("sessionBinding: false skips the membership write (quick-start rules)", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    const adapter = makeAdapter(backend, {
      participantId: undefined,
      useUidAsParticipantId: true,
      sessionBinding: false,
    });

    await adapter.connect(makeOptions());

    expect(backend.rtdb.get(membership("uid-1"))).toBeUndefined();
  });

  it("membership survives disconnect() (the binding is the security property)", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    const adapter = makeAdapter(backend, { participantId: undefined, useUidAsParticipantId: true });
    const connection = await adapter.connect(makeOptions());
    await connection.disconnect();

    expect(backend.rtdb.get(membership("uid-1"))).toBe(SESSION);
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
  });

  it("reuses a minted participantId across connections made with the same adapter", async () => {
    const adapter = new FirebaseAdapter({ sessionId: SESSION, backend: new FakeBackend() });
    const first = await adapter.connect(makeOptions());
    await first.disconnect();
    const second = await adapter.connect(makeOptions());
    expect(second.participantId).toBe(first.participantId);
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
  ])("rejects a participantId containing a %s", (_label, id) => {
    expect(() => new FirebaseAdapter({ sessionId: SESSION, participantId: id })).toThrow(
      /must not contain/,
    );
  });

  it("rejects a sessionId containing a forbidden char", () => {
    expect(() => new FirebaseAdapter({ sessionId: "a/b", participantId: "me" })).toThrow(
      /must not contain/,
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

  it("a participant whose connection comes back after they left rejoins", async () => {
    const rtdb = new FakeRtdb();
    const rejoined = jest.fn();
    const a = initJsPsych();
    await a.multiplayer.connect(
      makeAdapter(new FakeBackend({ rtdb, uid: "a", ownsApp: false }), { participantId: "a" }),
      { dropoutTimeout: 20, onParticipantRejoined: rejoined },
    );
    const bBackend = new FakeBackend({ rtdb, uid: "b", ownsApp: false });
    const b = initJsPsych();
    const statuses: string[] = [];
    await b.multiplayer.connect(makeAdapter(bBackend, { participantId: "b" }), {
      onStatusChange: (status) => statuses.push(status),
    });
    await b.multiplayer.update({ score: 1 });

    bBackend.simulateDrop();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(a.multiplayer.presence().b).toBe("left");

    bBackend.setConnected(true);
    await flush();
    expect(statuses).toEqual(["reconnecting", "connected"]);
    expect(a.multiplayer.presence().b).toBe("connected");
    expect(rejoined).toHaveBeenCalledWith("b");
    expect(a.multiplayer.get("b")).toEqual({ score: 1 });
    await b.multiplayer.disconnect();
    await a.multiplayer.disconnect();
  });

  it("a new page load under the same participant id is a restart, not a rejoin", async () => {
    const rtdb = new FakeRtdb();
    const rejoined = jest.fn();
    const restarted = jest.fn();
    const a = initJsPsych();
    await a.multiplayer.connect(
      makeAdapter(new FakeBackend({ rtdb, uid: "a", ownsApp: false }), { participantId: "a" }),
      { onParticipantRejoined: rejoined, onParticipantRestarted: restarted },
    );
    const before = await connectJsPsych(rtdb, "b");
    await before.multiplayer.update({ round: 2 });
    await before.multiplayer.disconnect();

    // A reload: a new page (new jsPsych.multiplayer) with the same participant id
    const after = await connectJsPsych(rtdb, "b");
    expect(after.multiplayer.previousInstance).not.toBeNull();
    expect(a.multiplayer.presence().b).toBe("left");
    expect(restarted).toHaveBeenCalledWith("b");
    expect(rejoined).not.toHaveBeenCalled();
    await after.multiplayer.disconnect();
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
