import LocalAdapter, { LocalAdapterOptions } from "./index";
import { SlotStorage } from "./local-store";
import { GroupSessionData } from "./multiplayer-adapter";
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
 * In-memory cross-tab bus with real BroadcastChannel semantics: a `post()` reaches every OTHER tab's
 * handler but never the poster's own (the writing tab self-notifies separately in the adapter).
 */
class Bus {
  private signals = new Set<BusSignal>();
  newSignal(): ChangeSignal {
    const sig = new BusSignal(this.signals);
    this.signals.add(sig);
    return sig;
  }
}
class BusSignal implements ChangeSignal {
  private handler: (() => void) | null = null;
  constructor(private peers: Set<BusSignal>) {}
  post(): void {
    // Only peers with a live handler (i.e. currently connected) receive the ping.
    for (const s of this.peers) if (s !== this && s.handler) s.handler();
  }
  onChange(handler: () => void): void {
    this.handler = handler;
  }
  close(): void {
    // Drop only the handler, not membership — a reconnect re-registers via onChange. This mirrors
    // the real adapter, which rebuilds a fresh signal on connect() after disconnect() closed the old.
    this.handler = null;
  }
}

/** Simulated browser: a shared store + bus, minting adapters that model separate tabs. */
function makeBrowser() {
  const storage = new MemoryStorage();
  const bus = new Bus();
  const openTab = (opts: Partial<LocalAdapterOptions> = {}) =>
    new LocalAdapter({
      sessionId: "sess",
      storage,
      signal: bus.newSignal(),
      ...opts,
    });
  return { storage, bus, openTab };
}

/** Let queued microtasks (the adapter's self-notify fan-out) run. */
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("LocalAdapter", () => {
  test("push() before connect() rejects", async () => {
    const { openTab } = makeBrowser();
    const a = openTab();
    await expect(a.push({ x: 1 })).rejects.toThrow(/connect/);
  });

  test("push writes a slot readable via get/getAll (REPLACE semantics)", async () => {
    const { openTab } = makeBrowser();
    const a = openTab({ participantId: "alice" });
    await a.connect();
    await a.push({ a: 1, b: 2 });
    expect(a.get("alice")).toEqual({ a: 1, b: 2 });
    await a.push({ c: 3 });
    expect(a.get("alice")).toEqual({ c: 3 }); // replaced, not merged
    expect(a.getAll()).toEqual({ alice: { c: 3 } });
  });

  test("push self-notifies own subscribers — on a microtask, not synchronously", async () => {
    const { openTab } = makeBrowser();
    const a = openTab({ participantId: "alice" });
    await a.connect();
    const seen: GroupSessionData[] = [];
    a.subscribe((data) => seen.push(data));

    const pushed = a.push({ hi: true }); // don't await — check before microtasks run
    expect(seen).toHaveLength(0); // not delivered synchronously
    await flush();
    expect(seen).toEqual([{ alice: { hi: true } }]);
    await pushed;
  });

  test("a subscriber that pushes again does not recurse and sees a written store", async () => {
    const { openTab } = makeBrowser();
    const a = openTab({ participantId: "alice" });
    await a.connect();

    let calls = 0;
    const observed: (Record<string, unknown> | undefined)[] = [];
    a.subscribe((data) => {
      calls++;
      observed.push(data.alice);
      if (calls === 1) {
        // React to the first update by pushing again — must not recurse into the current fan-out.
        void a.push({ step: 2 });
      }
    });

    await a.push({ step: 1 });
    await flush(); // first fan-out
    await flush(); // fan-out triggered by the reentrant push
    expect(calls).toBe(2);
    expect(observed).toEqual([{ step: 1 }, { step: 2 }]);
  });

  test("cross-tab: one tab's push notifies another tab's subscriber", async () => {
    const { openTab } = makeBrowser();
    const alice = openTab({ participantId: "alice" });
    const bob = openTab({ participantId: "bob" });
    await alice.connect();
    await bob.connect();

    const bobSaw: GroupSessionData[] = [];
    bob.subscribe((data) => bobSaw.push(data));

    await alice.push({ msg: "hello" });
    await flush();
    expect(bobSaw.at(-1)).toEqual({ alice: { msg: "hello" } });
    // and bob reads alice's slot directly
    expect(bob.get("alice")).toEqual({ msg: "hello" });
  });

  test("session namespacing isolates separate runs", async () => {
    const storage = new MemoryStorage();
    const bus = new Bus();
    const run1 = new LocalAdapter({
      sessionId: "r1",
      storage,
      signal: bus.newSignal(),
      participantId: "alice",
    });
    const run2 = new LocalAdapter({
      sessionId: "r2",
      storage,
      signal: bus.newSignal(),
      participantId: "bob",
    });
    await run1.connect();
    await run2.connect();

    await run1.push({ from: "r1" });
    await run2.push({ from: "r2" });

    expect(run1.getAll()).toEqual({ alice: { from: "r1" } });
    expect(run2.getAll()).toEqual({ bob: { from: "r2" } });
  });

  test("disconnect removes own slot and other tabs see it gone", async () => {
    const { openTab } = makeBrowser();
    const alice = openTab({ participantId: "alice" });
    const bob = openTab({ participantId: "bob" });
    await alice.connect();
    await bob.connect();
    await alice.push({ here: true });
    await bob.push({ here: true });

    const bobSaw: GroupSessionData[] = [];
    bob.subscribe((data) => bobSaw.push(data));

    await alice.disconnect();
    await flush();
    expect(bob.getAll()).toEqual({ bob: { here: true } });
    expect(bobSaw.at(-1)).toEqual({ bob: { here: true } });
  });

  test("reconnect after disconnect resumes cross-tab updates", async () => {
    const { openTab } = makeBrowser();
    const alice = openTab({ participantId: "alice" });
    const bob = openTab({ participantId: "bob" });
    await alice.connect();
    await bob.connect();

    await bob.disconnect();
    await bob.connect(); // reconnect — must re-register for cross-tab signals

    const bobSaw: GroupSessionData[] = [];
    bob.subscribe((data) => bobSaw.push(data));
    await alice.push({ msg: "again" });
    await flush();
    expect(bobSaw.at(-1)).toEqual({ alice: { msg: "again" } });
  });

  test("unsubscribe stops further updates", async () => {
    const { openTab } = makeBrowser();
    const a = openTab({ participantId: "alice" });
    await a.connect();
    const seen: GroupSessionData[] = [];
    const unsub = a.subscribe((data) => seen.push(data));

    await a.push({ n: 1 });
    await flush();
    unsub();
    await a.push({ n: 2 });
    await flush();
    expect(seen).toHaveLength(1);
  });

  test("distinct tabs get distinct random participant ids by default", () => {
    const { openTab } = makeBrowser();
    const a = openTab();
    const b = openTab();
    expect(a.participantId).toBeTruthy();
    expect(a.participantId).not.toBe(b.participantId);
  });

  test("push() rejects (catchably) when storage.setItem throws (e.g. quota exceeded)", async () => {
    const { storage, bus } = makeBrowser();
    // A storage double whose writes fail synchronously, as a real QuotaExceededError does.
    const throwingStorage: SlotStorage = {
      get length() {
        return storage.length;
      },
      key: (i) => storage.key(i),
      getItem: (k) => storage.getItem(k),
      setItem: () => {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      },
      removeItem: (k) => storage.removeItem(k),
    };
    const a = new LocalAdapter({
      sessionId: "sess",
      storage: throwingStorage,
      signal: bus.newSignal(),
      participantId: "alice",
    });
    await a.connect();
    // The synchronous setItem throw must surface through the returned promise, not escape past
    // .catch() as a synchronous throw from a Promise-returning method.
    await expect(a.push({ x: 1 })).rejects.toThrow(/quota/i);
  });

  test("constructor rejects a sessionId containing ':'", () => {
    const { storage, bus } = makeBrowser();
    expect(
      () =>
        new LocalAdapter({ sessionId: "a:b", storage, signal: bus.newSignal(), participantId: "p" })
    ).toThrow(/sessionId must not contain ":"/);
  });

  test("constructor rejects a participantId containing ':'", () => {
    const { storage, bus } = makeBrowser();
    expect(
      () =>
        new LocalAdapter({
          sessionId: "sess",
          storage,
          signal: bus.newSignal(),
          participantId: "a:b",
        })
    ).toThrow(/participantId must not contain ":"/);
  });

  test("a throwing subscriber does not break the fan-out to others", async () => {
    const { openTab } = makeBrowser();
    const a = openTab({ participantId: "alice" });
    await a.connect();
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const good: GroupSessionData[] = [];
    a.subscribe(() => {
      throw new Error("boom");
    });
    a.subscribe((data) => good.push(data));

    await a.push({ ok: 1 });
    await flush();
    expect(good).toEqual([{ alice: { ok: 1 } }]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
