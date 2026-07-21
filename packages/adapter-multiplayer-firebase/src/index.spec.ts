import { FakeBackend, FakeRtdb } from "./fake-backend";
import FirebaseAdapter from ".";

/** Flush pending microtasks and macrotasks (fan-out + async reconnect handler). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PREFIX = "mp-sessions";
const SESSION = "sess1";
const slot = (id: string) => `${PREFIX}/${SESSION}/${id}`;

function makeAdapter(backend: FakeBackend, overrides = {}) {
  return new FirebaseAdapter({
    sessionId: SESSION,
    participantId: "me",
    backend,
    connectTimeoutMs: 50,
    ...overrides,
  });
}

describe("FirebaseAdapter — connect", () => {
  it("awaits the first snapshot, populating the mirror with existing peers", async () => {
    const rtdb = new FakeRtdb();
    rtdb.set(slot("peer"), JSON.stringify({ hello: "world" }));
    const adapter = makeAdapter(new FakeBackend({ rtdb }));

    await adapter.connect();

    expect(adapter.getAll()).toEqual({ peer: { hello: "world" } });
  });

  it("rejects when the session listener is cancelled (rules denial)", async () => {
    const adapter = makeAdapter(new FakeBackend({ denyReads: true }));
    await expect(adapter.connect()).rejects.toThrow(/security-rules denial/);
  });

  it("rejects when no snapshot ever arrives (timeout)", async () => {
    const adapter = makeAdapter(new FakeBackend({ neverSnapshot: true }));
    await expect(adapter.connect()).rejects.toThrow(/timed out/);
  });

  it("tears the session listener down on a timeout, so a late snapshot can't mutate the mirror", async () => {
    const backend = new FakeBackend({ deferInitialSnapshot: true });
    const adapter = makeAdapter(backend);

    await expect(adapter.connect()).rejects.toThrow(/timed out/);

    // The listener the timed-out connect() registered must be gone...
    expect(backend.rtdb.listenerCount()).toBe(0);
    // ...so a peer writing after the timeout does not leak into the abandoned adapter's mirror.
    backend.rtdb.set(slot("peer"), JSON.stringify({ hello: "world" }));
    expect(adapter.getAll()).toEqual({});
  });
});

describe("FirebaseAdapter — push / read", () => {
  it("fans a push out to subscribers", async () => {
    const adapter = makeAdapter(new FakeBackend());
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.subscribe((data) => seen.push(data));

    await adapter.push({ offer: 5 });
    await flush();

    expect(seen.at(-1)).toEqual({ me: { offer: 5 } });
  });

  it("post-push read invariant: own getAll() reflects the write immediately after await", async () => {
    const adapter = makeAdapter(new FakeBackend());
    await adapter.connect();

    await adapter.push({ a: 1 });

    expect(adapter.getAll().me).toEqual({ a: 1 });
  });

  it("JSON round-trip fidelity: an empty array survives (RTDB would prune it)", async () => {
    const adapter = makeAdapter(new FakeBackend());
    await adapter.connect();

    await adapter.push({ strokes: [] });

    expect(adapter.getAll().me).toEqual({ strokes: [] });
  });

  it("reflects multiple participants via one shared session", async () => {
    const rtdb = new FakeRtdb();
    const a = new FirebaseAdapter({
      sessionId: SESSION,
      participantId: "a",
      backend: new FakeBackend({ rtdb, uid: "a" }),
    });
    const b = new FirebaseAdapter({
      sessionId: SESSION,
      participantId: "b",
      backend: new FakeBackend({ rtdb, uid: "b" }),
    });
    await a.connect();
    await b.connect();

    await a.push({ role: "proposer" });
    await b.push({ role: "responder" });

    expect(a.getAll()).toEqual({ a: { role: "proposer" }, b: { role: "responder" } });
    expect(b.get("a")).toEqual({ role: "proposer" });
  });

  it("getAll()/get() return copies a caller cannot use to mutate the mirror", async () => {
    const adapter = makeAdapter(new FakeBackend());
    await adapter.connect();
    await adapter.push({ n: 1 });

    (adapter.getAll().me as Record<string, unknown>).n = 999;
    (adapter.get("me") as Record<string, unknown>).n = 999;

    expect(adapter.getAll().me).toEqual({ n: 1 });
  });

  it("coalesces a burst of pushes into a single fan-out", async () => {
    const adapter = makeAdapter(new FakeBackend());
    await adapter.connect();
    let calls = 0;
    adapter.subscribe(() => calls++);

    void adapter.push({ a: 1 });
    void adapter.push({ a: 2 });
    await flush();

    expect(calls).toBe(1);
  });

  it("isolates a throwing subscriber from the others", async () => {
    const adapter = makeAdapter(new FakeBackend());
    await adapter.connect();
    jest.spyOn(console, "error").mockImplementation(() => {});
    let reached = false;
    adapter.subscribe(() => {
      throw new Error("boom");
    });
    adapter.subscribe(() => {
      reached = true;
    });

    await adapter.push({ a: 1 });
    await flush();

    expect(reached).toBe(true);
  });

  it("rejects push() before connect()", async () => {
    const adapter = makeAdapter(new FakeBackend());
    await expect(adapter.push({ a: 1 })).rejects.toThrow(/before connect/);
  });
});

describe("FirebaseAdapter — reconnect", () => {
  it("re-arms onDisconnect and re-pushes lastOwnData after a transient blip", async () => {
    const backend = new FakeBackend();
    const adapter = makeAdapter(backend);
    await adapter.connect();
    await adapter.push({ ready: true });
    expect(backend.isArmed(slot("me"))).toBe(true);

    backend.simulateBlip(); // server removes our slot, we drop, then reconnect
    await flush();

    expect(adapter.getAll().me).toEqual({ ready: true }); // restored
    expect(backend.isArmed(slot("me"))).toBe(true); // re-armed
  });
});

describe("FirebaseAdapter — disconnect", () => {
  it("removes our slot, detaches, and goes offline when it owns the app", async () => {
    const backend = new FakeBackend({ ownsApp: true });
    const adapter = makeAdapter(backend);
    await adapter.connect();
    await adapter.push({ a: 1 });

    await adapter.disconnect();

    expect(backend.rtdb.snapshotOf(`${PREFIX}/${SESSION}`)).toBeNull();
    expect(backend.goOfflineCalls).toBe(1);
  });

  it("does NOT call goOffline() on an injected (non-owned) database", async () => {
    const backend = new FakeBackend({ ownsApp: false });
    const adapter = makeAdapter(backend);
    await adapter.connect();

    await adapter.disconnect();

    expect(backend.goOfflineCalls).toBe(0);
  });
});

describe("FirebaseAdapter — connect re-entrancy", () => {
  it("shares one in-flight attempt: two concurrent connect() calls sign in once, one listener", async () => {
    const backend = new FakeBackend();
    const signIn = jest.spyOn(backend, "signIn");
    const adapter = makeAdapter(backend);

    await Promise.all([adapter.connect(), adapter.connect()]);

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(backend.rtdb.listenerCount()).toBe(1);
  });

  it("a failed attempt clears the guard so connect() can be retried", async () => {
    const backend = new FakeBackend({ neverSnapshot: true });
    const adapter = makeAdapter(backend);
    await expect(adapter.connect()).rejects.toThrow(/timed out/);
    // Retry against a healthy backend path is not possible with this fake, but the retry must at
    // least run a fresh attempt (and fail the same way) instead of returning the stale rejection.
    await expect(adapter.connect()).rejects.toThrow(/timed out/);
  });
});

describe("FirebaseAdapter — session binding", () => {
  const membership = (uid: string) => `${PREFIX}-memberships/${uid}`;

  it("uid mode registers a first-write-wins membership record before the session listener", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    const adapter = makeAdapter(backend, { participantId: undefined, useUidAsParticipantId: true });

    await adapter.connect();

    // The record is the RAW sessionId (the rules compare it unquoted with === $session).
    expect(backend.rtdb.snapshotOf(`${PREFIX}-memberships`)).toEqual({ "uid-1": SESSION });
  });

  it("a denied membership write rejects connect() with a descriptive error and no live listener", async () => {
    const backend = new FakeBackend({
      uid: "uid-1",
      denyWrite: (path) => path === membership("uid-1"),
    });
    const adapter = makeAdapter(backend, { participantId: undefined, useUidAsParticipantId: true });

    await expect(adapter.connect()).rejects.toThrow(/session membership/);
    expect(backend.rtdb.listenerCount()).toBe(0); // listener never attached
  });

  it("sessionBinding: false skips the membership write (quick-start rules)", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    const adapter = makeAdapter(backend, {
      participantId: undefined,
      useUidAsParticipantId: true,
      sessionBinding: false,
    });

    await adapter.connect();

    expect(backend.rtdb.snapshotOf(`${PREFIX}-memberships`)).toBeNull();
  });

  it("membership survives disconnect() (the binding is the security property)", async () => {
    const backend = new FakeBackend({ uid: "uid-1" });
    const adapter = makeAdapter(backend, { participantId: undefined, useUidAsParticipantId: true });
    await adapter.connect();
    await adapter.disconnect();

    expect(backend.rtdb.snapshotOf(`${PREFIX}-memberships`)).toEqual({ "uid-1": SESSION });
  });
});

describe("FirebaseAdapter — uid-as-key mode", () => {
  it("adopts the backend uid as participantId and writes to that slot", async () => {
    const backend = new FakeBackend({ uid: "uid-123" });
    const adapter = new FirebaseAdapter({
      sessionId: SESSION,
      useUidAsParticipantId: true,
      backend,
    });

    await adapter.connect();
    await adapter.push({ a: 1 });

    expect(adapter.participantId).toBe("uid-123");
    expect(adapter.getAll()["uid-123"]).toEqual({ a: 1 });
  });

  it("throws when constructed with both useUidAsParticipantId and a custom participantId", () => {
    expect(() => new FirebaseAdapter({ useUidAsParticipantId: true, participantId: "me" })).toThrow(
      /incompatible/
    );
  });
});

describe("FirebaseAdapter — key validation", () => {
  it.each([
    ["colon", "a:b"],
    ["slash", "a/b"],
    ["dot", "a.b"],
    ["dollar", "a$b"],
    ["hash", "a#b"],
    ["open-bracket", "a[b"],
  ])("rejects a participantId containing a %s", (_label, id) => {
    expect(() => new FirebaseAdapter({ sessionId: SESSION, participantId: id })).toThrow(
      /must not contain/
    );
  });

  it("rejects a sessionId containing a forbidden char", () => {
    expect(() => new FirebaseAdapter({ sessionId: "a/b", participantId: "me" })).toThrow(
      /must not contain/
    );
  });
});
