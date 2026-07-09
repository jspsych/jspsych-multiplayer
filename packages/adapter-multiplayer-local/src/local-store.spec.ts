import {
  SlotStorage,
  generateId,
  participantIdFromKey,
  readAllSlots,
  readSlot,
  removeSlot,
  slotKey,
  slotPrefix,
  writeSlot,
} from "./local-store";

/** A minimal in-memory Storage double implementing the SlotStorage subset. */
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

describe("local-store key helpers", () => {
  test("slotKey / slotPrefix compose the namespaced key", () => {
    expect(slotPrefix("mp", "s1")).toBe("mp:s1:");
    expect(slotKey("mp", "s1", "alice")).toBe("mp:s1:alice");
  });

  test("participantIdFromKey extracts the id only for matching session/prefix", () => {
    expect(participantIdFromKey("mp", "s1", "mp:s1:alice")).toBe("alice");
    expect(participantIdFromKey("mp", "s1", "mp:s2:alice")).toBeNull();
    expect(participantIdFromKey("mp", "s1", "other:s1:alice")).toBeNull();
    expect(participantIdFromKey("mp", "s1", "unrelated")).toBeNull();
  });
});

describe("local-store read/write", () => {
  test("writeSlot REPLACES the whole slot (no merge)", () => {
    const s = new MemoryStorage();
    writeSlot(s, "mp", "s1", "alice", { a: 1, b: 2 });
    expect(readSlot(s, "mp", "s1", "alice")).toEqual({ a: 1, b: 2 });
    writeSlot(s, "mp", "s1", "alice", { c: 3 });
    expect(readSlot(s, "mp", "s1", "alice")).toEqual({ c: 3 });
  });

  test("readSlot returns undefined when absent or unparseable", () => {
    const s = new MemoryStorage();
    expect(readSlot(s, "mp", "s1", "ghost")).toBeUndefined();
    s.setItem("mp:s1:corrupt", "{not json");
    expect(readSlot(s, "mp", "s1", "corrupt")).toBeUndefined();
  });

  test("readAllSlots enumerates only this session's slots", () => {
    const s = new MemoryStorage();
    writeSlot(s, "mp", "s1", "alice", { role: "proposer" });
    writeSlot(s, "mp", "s1", "bob", { role: "responder" });
    writeSlot(s, "mp", "s2", "carol", { role: "other" }); // different session
    s.setItem("unrelated-key", "x");

    expect(readAllSlots(s, "mp", "s1")).toEqual({
      alice: { role: "proposer" },
      bob: { role: "responder" },
    });
  });

  test("readAllSlots skips a corrupted slot instead of throwing", () => {
    const s = new MemoryStorage();
    writeSlot(s, "mp", "s1", "alice", { ok: true });
    s.setItem("mp:s1:bad", "{oops");
    expect(readAllSlots(s, "mp", "s1")).toEqual({ alice: { ok: true } });
  });

  test("removeSlot drops the slot from the snapshot", () => {
    const s = new MemoryStorage();
    writeSlot(s, "mp", "s1", "alice", { x: 1 });
    removeSlot(s, "mp", "s1", "alice");
    expect(readSlot(s, "mp", "s1", "alice")).toBeUndefined();
    expect(readAllSlots(s, "mp", "s1")).toEqual({});
  });
});

describe("generateId", () => {
  test("produces distinct, non-empty ids", () => {
    const a = generateId();
    const b = generateId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});
