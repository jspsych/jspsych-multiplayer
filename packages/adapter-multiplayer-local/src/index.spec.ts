import { AdapterConnectOptions, initJsPsych, MultiplayerConnection } from "jspsych";

import { flushPromises } from "../../../test-utils/memory-backend";
import LocalAdapter, { LocalAdapterOptions } from "./index";
import { SlotStorage, writePresence } from "./local-store";
import { ChangeSignal } from "./signal";

/** In-memory Storage double shared by "tabs" of the same browser. */
class MemoryStorage implements SlotStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/**
 * In-memory cross-tab bus with real BroadcastChannel semantics: a `post()` reaches every OTHER
 * signal's handlers but never the poster's own.
 */
class Bus {
  private signals = new Set<BusSignal>();
  newSignal(): BusSignal {
    const sig = new BusSignal(this.signals);
    this.signals.add(sig);
    return sig;
  }
}
class BusSignal implements ChangeSignal {
  handlers = new Set<() => void>();
  closed = false;
  constructor(private peers: Set<BusSignal>) {}
  post(): void {
    for (const s of this.peers) if (s !== this) for (const h of [...s.handlers]) h();
  }
  onChange(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  close(): void {
    this.closed = true;
    this.handlers.clear();
  }
}

/**
 * Simulated browser: a shared store + bus, minting adapters that model separate tabs. Every tab
 * shares jsdom's one sessionStorage, so tabs get a fresh participant id unless a test asks to
 * keep one.
 */
function makeBrowser() {
  const storage = new MemoryStorage();
  const bus = new Bus();
  const openTab = (opts: Partial<LocalAdapterOptions> = {}) =>
    new LocalAdapter({
      sessionId: "sess",
      storage,
      signal: bus.newSignal(),
      heartbeatIntervalMs: 1000,
      presenceTimeoutMs: 3000,
      persistParticipant: false,
      ...opts,
    });
  return { storage, bus, openTab };
}

function connectOptions(): AdapterConnectOptions & {
  onChange: jest.Mock;
  onStatus: jest.Mock;
  onResumed: jest.Mock;
} {
  return {
    signal: new AbortController().signal,
    onChange: jest.fn(),
    onStatus: jest.fn(),
    onResumed: jest.fn(),
  };
}

const open: MultiplayerConnection[] = [];

/** Connect a tab and remember the connection so afterEach can close it. */
async function connect(adapter: LocalAdapter, options = connectOptions()) {
  const connection = await adapter.connect(options);
  open.push(connection);
  return { connection, options };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.disconnect()));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("LocalAdapter connections", () => {
  test("each connect() returns a new connection with the adapter's participantId", async () => {
    const { openTab } = makeBrowser();
    const adapter = openTab({ participantId: "alice" });
    const { connection: first } = await connect(adapter);
    const { connection: second } = await connect(adapter);
    expect(first).not.toBe(second);
    expect(first.participantId).toBe("alice");
    expect(second.participantId).toBe("alice");
  });

  test("every tab in a session reports the same session id", async () => {
    const { openTab } = makeBrowser();
    const { connection: a } = await connect(openTab({ participantId: "alice" }));
    const { connection: b } = await connect(openTab({ participantId: "bob" }));
    expect(a.sessionId).toBe("sess");
    expect(b.sessionId).toBe("sess");
  });

  test("connect() rejects when its signal is already aborted", async () => {
    const { openTab } = makeBrowser();
    const options = { ...connectOptions(), signal: AbortSignal.abort() };
    await expect(openTab().connect(options)).rejects.toThrow(/cancelled/);
  });

  test("getAll() returns each payload exactly as it was pushed", async () => {
    const { openTab } = makeBrowser();
    const { connection: a } = await connect(openTab({ participantId: "alice" }));
    const { connection: b } = await connect(openTab({ participantId: "bob" }));
    const payload = { $mp: { v: 1, instance: "i1", epoch: 2 }, session: { x: 1 }, scopes: {} };
    await a.push(payload);
    expect(b.getAll()).toEqual({ alice: payload });
  });

  test("push writes a slot every tab can read (REPLACE semantics)", async () => {
    const { openTab } = makeBrowser();
    const { connection: a } = await connect(openTab({ participantId: "alice" }));
    const { connection: b } = await connect(openTab({ participantId: "bob" }));
    await a.push({ a: 1, b: 2 });
    await a.push({ c: 3 });
    expect(b.getAll()).toEqual({ alice: { c: 3 } });
  });

  test("a push calls onChange in the other tabs", async () => {
    const { openTab } = makeBrowser();
    const { connection: a } = await connect(openTab());
    const { options: other } = await connect(openTab());
    other.onChange.mockClear();
    await a.push({ x: 1 });
    expect(other.onChange).toHaveBeenCalled();
  });

  test("session namespacing isolates separate runs", async () => {
    const { openTab } = makeBrowser();
    const { connection: a } = await connect(openTab({ participantId: "alice", sessionId: "s1" }));
    const { connection: b } = await connect(openTab({ participantId: "bob", sessionId: "s2" }));
    await a.push({ run: 1 });
    expect(b.getAll()).toEqual({});
    expect(b.connectedParticipants()).toEqual(["bob"]);
  });

  test("push() rejects (catchably) when storage.setItem throws (e.g. quota exceeded)", async () => {
    const { storage, bus } = makeBrowser();
    const connection = await new LocalAdapter({
      sessionId: "sess",
      participantId: "alice",
      signal: bus.newSignal(),
      storage: {
        get length() {
          return storage.length;
        },
        key: (i) => storage.key(i),
        getItem: (k) => storage.getItem(k),
        setItem: (k, v) => {
          // Let the presence heartbeat through; fail slot writes, as a full store would
          if (k.startsWith("mp:")) {
            const err = new Error("QuotaExceededError");
            err.name = "QuotaExceededError";
            throw err;
          }
          storage.setItem(k, v);
        },
        removeItem: (k) => storage.removeItem(k),
      },
    }).connect(connectOptions());
    open.push(connection);
    await expect(connection.push({ x: 1 })).rejects.toThrow(/quota/i);
  });

  test("push() after disconnect() rejects", async () => {
    const { openTab } = makeBrowser();
    const { connection } = await connect(openTab());
    await connection.disconnect();
    await expect(connection.push({ x: 1 })).rejects.toThrow(/disconnect/);
  });

  test("disconnect() keeps the data slot but removes the tab from connectedParticipants()", async () => {
    const { openTab } = makeBrowser();
    const { connection: a } = await connect(openTab({ participantId: "alice" }));
    const { connection: b, options: bOptions } = await connect(openTab({ participantId: "bob" }));
    await a.push({ answer: 1 });
    expect(b.connectedParticipants()).toEqual(["alice", "bob"]);

    bOptions.onChange.mockClear();
    await a.disconnect();
    expect(b.connectedParticipants()).toEqual(["bob"]);
    expect(b.getAll()).toEqual({ alice: { answer: 1 } });
    expect(bOptions.onChange).toHaveBeenCalled();
  });

  test("no callbacks fire after disconnect()", async () => {
    jest.useFakeTimers();
    const { openTab } = makeBrowser();
    const { connection: a, options } = await connect(openTab());
    const { connection: b } = await connect(openTab());
    await a.disconnect();
    options.onChange.mockClear();

    await b.push({ x: 1 });
    await b.disconnect();
    jest.advanceTimersByTime(10000);
    expect(options.onChange).not.toHaveBeenCalled();
  });

  test("an injected signal is never closed and keeps no handlers from closed connections", async () => {
    const { storage, bus } = makeBrowser();
    const signal = bus.newSignal();
    const adapter = new LocalAdapter({ sessionId: "sess", storage, signal });
    const { connection: first } = await connect(adapter);
    await first.disconnect();
    const { connection: second } = await connect(adapter);
    expect(signal.handlers.size).toBe(1);
    await second.disconnect();
    expect(signal.handlers.size).toBe(0);
    expect(signal.closed).toBe(false);
  });
});

describe("LocalAdapter presence", () => {
  test("a tab whose heartbeat stops drops out after the presence timeout", async () => {
    jest.useFakeTimers();
    const { storage, openTab } = makeBrowser();
    const { connection, options } = await connect(openTab({ participantId: "alice" }));
    // A crashed tab: its presence key stays behind but is never refreshed
    writePresence(storage, "mp", "sess", "crashed", Date.now());
    options.onChange.mockClear();

    jest.advanceTimersByTime(1000);
    expect(connection.connectedParticipants()).toEqual(["alice", "crashed"]);

    jest.advanceTimersByTime(3000);
    expect(connection.connectedParticipants()).toEqual(["alice"]);
    expect(options.onChange).toHaveBeenCalled();
  });

  test("the heartbeat keeps a live tab present indefinitely", async () => {
    jest.useFakeTimers();
    const { openTab } = makeBrowser();
    const { connection: a } = await connect(openTab({ participantId: "alice" }));
    await connect(openTab({ participantId: "bob" }));
    jest.advanceTimersByTime(60000);
    expect(a.connectedParticipants()).toEqual(["alice", "bob"]);
  });

  test("pagehide removes the tab's presence at once, and a bfcache pageshow restores it", async () => {
    const { openTab } = makeBrowser();
    const { connection: a } = await connect(openTab({ participantId: "alice" }));
    const { connection: b } = await connect(openTab({ participantId: "bob" }));

    // Both tabs share this jsdom window, so close the other tab before firing page events
    await b.disconnect();
    window.dispatchEvent(new Event("pagehide"));
    expect(a.connectedParticipants()).toEqual([]);

    const pageshow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    expect(a.connectedParticipants()).toEqual(["alice"]);
  });

  test("presenceTimeoutMs is never shorter than the heartbeat interval", async () => {
    jest.useFakeTimers();
    const { openTab } = makeBrowser();
    const { connection } = await connect(
      openTab({ participantId: "alice", heartbeatIntervalMs: 5000, presenceTimeoutMs: 10 }),
    );
    jest.advanceTimersByTime(4999);
    expect(connection.connectedParticipants()).toEqual(["alice"]);
  });
});

describe("LocalAdapter with jsPsych.multiplayer", () => {
  test("two tabs share data and presence through real sessions", async () => {
    const { openTab } = makeBrowser();
    const a = initJsPsych();
    const b = initJsPsych();
    await a.multiplayer.connect(openTab({ participantId: "alice" }));
    await b.multiplayer.connect(openTab({ participantId: "bob" }));

    const waiting = a.multiplayer.wait((data) => data.bob?.ready === true, {
      participants: ["bob"],
    });
    await b.multiplayer.update({ ready: true });
    expect((await waiting).bob).toEqual({ ready: true });
    expect(a.multiplayer.presence()).toEqual({ alice: "connected", bob: "connected" });

    await b.multiplayer.disconnect();
    expect(a.multiplayer.presence().bob).toBe("away");
    expect(a.multiplayer.get("bob")).toEqual({ ready: true });
    await a.multiplayer.disconnect();
  });
});

describe("LocalAdapter rejoining", () => {
  /** Make the page visible and fire visibilitychange, as when a background tab is shown again. */
  function showPage() {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    delete (document as { visibilityState?: string }).visibilityState;
  });

  test("a tab whose heartbeat lapsed reports that it resumed, and shows as connected again", async () => {
    jest.useFakeTimers();
    const { openTab } = makeBrowser();
    const a = initJsPsych();
    await a.multiplayer.connect(openTab({ participantId: "alice" }), { dropoutTimeout: 60000 });
    const statuses: string[] = [];
    const b = initJsPsych();
    // A throttled background tab: bob's heartbeat timer never fires on its own
    jest.spyOn(global, "setInterval").mockImplementationOnce(() => 0 as never);
    await b.multiplayer.connect(openTab({ participantId: "bob" }), {
      onStatusChange: (status) => statuses.push(status),
    });
    await b.multiplayer.update({ score: 2 }, { scope: "session" });

    // Past the presence timeout, so alice's tab stops seeing bob
    jest.advanceTimersByTime(4000);
    expect(a.multiplayer.presence().bob).toBe("away");

    showPage();
    await jest.advanceTimersByTimeAsync(0);
    // localStorage never disconnected, so bob's own status never changed
    expect(statuses).toEqual([]);
    expect(a.multiplayer.presence().bob).toBe("connected");
    expect(a.multiplayer.get("bob", { scope: "session" })).toEqual({ score: 2 });

    await b.multiplayer.disconnect();
    await a.multiplayer.disconnect();
  });

  test("a lapsed heartbeat calls onResumed() instead of reporting a status", async () => {
    jest.useFakeTimers();
    const { openTab } = makeBrowser();
    jest.spyOn(global, "setInterval").mockImplementationOnce(() => 0 as never);
    const { options } = await connect(openTab({ participantId: "alice" }));
    jest.advanceTimersByTime(4000);
    expect(options.onResumed).not.toHaveBeenCalled();
    showPage();
    expect(options.onResumed).toHaveBeenCalledTimes(1);
    expect(options.onStatus).not.toHaveBeenCalled();
  });

  test("regular heartbeats never report a drop", async () => {
    jest.useFakeTimers();
    const { openTab } = makeBrowser();
    const { options } = await connect(openTab({ participantId: "alice" }));
    jest.advanceTimersByTime(60000);
    showPage();
    jest.advanceTimersByTime(60000);
    expect(options.onStatus).not.toHaveBeenCalled();
    expect(options.onResumed).not.toHaveBeenCalled();
  });

  test("a refresh keeps the participant id, and the group sees a restart", async () => {
    sessionStorage.clear();
    const { openTab } = makeBrowser();
    const left = jest.fn();
    const a = initJsPsych();
    await a.multiplayer.connect(openTab({ participantId: "alice" }), {
      onParticipantLeft: left,
    });
    const before = initJsPsych();
    // The adapter's default: keep the id for this tab
    await before.multiplayer.connect(openTab({ persistParticipant: undefined }));
    const bob = before.multiplayer.participantId!;
    await before.multiplayer.update({ round: 3 }, { scope: "session" });

    // The refresh: the old page goes away, and a new page keeps the id from sessionStorage
    await before.multiplayer.disconnect();
    const after = initJsPsych();
    await after.multiplayer.connect(openTab({ persistParticipant: undefined }));
    await flushPromises();

    expect(after.multiplayer.participantId).toBe(bob);
    expect(after.multiplayer.restarted).toBe(true);
    expect(a.multiplayer.presence()[bob]).toBe("left");
    expect(left).toHaveBeenCalledWith(bob);

    await after.multiplayer.disconnect();
    await a.multiplayer.disconnect();
    sessionStorage.clear();
  });
});

describe("LocalAdapter configuration", () => {
  test("by default, the participant id is kept for this tab and session", () => {
    const { storage } = makeBrowser();
    sessionStorage.clear();
    const first = new LocalAdapter({ sessionId: "sess", storage });
    const second = new LocalAdapter({ sessionId: "sess", storage });
    const otherSession = new LocalAdapter({ sessionId: "other", storage });
    expect(first.participantId).toBeTruthy();
    expect(second.participantId).toBe(first.participantId);
    expect(otherSession.participantId).not.toBe(first.participantId);
    sessionStorage.clear();
  });

  test("persistParticipant: false gives a fresh id on every load", () => {
    const { storage } = makeBrowser();
    sessionStorage.clear();
    const a = new LocalAdapter({ sessionId: "sess", storage, persistParticipant: false });
    const b = new LocalAdapter({ sessionId: "sess", storage, persistParticipant: false });
    expect(a.participantId).toBeTruthy();
    expect(a.participantId).not.toBe(b.participantId);
    expect(sessionStorage.length).toBe(0);
  });

  test("namespace sets the prefix of every storage key", async () => {
    const { storage, openTab } = makeBrowser();
    const { connection } = await connect(openTab({ participantId: "alice", namespace: "study1" }));
    await connection.push({ x: 1 });
    expect(storage.getItem("study1:sess:alice")).toBe(JSON.stringify({ x: 1 }));
    expect(storage.getItem("study1-presence:sess:alice")).not.toBeNull();
    expect(storage.getItem("mp:sess:alice")).toBeNull();
  });

  test("constructor rejects a sessionId containing ':'", () => {
    const { openTab } = makeBrowser();
    expect(() => openTab({ sessionId: "a:b" })).toThrow(/sessionId must be a non-empty string/);
  });

  test("constructor rejects a participantId containing ':' or other unsafe characters", () => {
    const { openTab } = makeBrowser();
    expect(() => openTab({ participantId: "a:b" })).toThrow(/participantId must be/);
    expect(() => openTab({ participantId: "a.b" })).toThrow(/participantId must be/);
  });

  test("warns that keyPrefix was renamed namespace", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { openTab } = makeBrowser();
    openTab({ keyPrefix: "old" } as Partial<LocalAdapterOptions>);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/keyPrefix.*namespace/));
  });

  test("constructor rejects a namespace containing ':'", () => {
    const { openTab } = makeBrowser();
    expect(() => openTab({ namespace: "a:b" })).toThrow(/namespace must be/);
  });
});
