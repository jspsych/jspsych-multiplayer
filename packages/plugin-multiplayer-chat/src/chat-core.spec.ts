import {
  ChatMessage,
  GroupSessionData,
  appendOwnMessage,
  makeMessageId,
  mergeMessages,
} from "./chat-core";

const DATA_KEY = "chat_messages";

/** Build a well-formed message with sensible defaults. */
function msg(senderId: string, seq: number, ts: number, text = `m${seq}`): ChatMessage {
  return { id: makeMessageId(senderId, seq), senderId, seq, text, ts };
}

describe("makeMessageId", () => {
  it("combines senderId and seq into a stable id", () => {
    expect(makeMessageId("p1", 0)).toBe("p1#0");
    expect(makeMessageId("p1", 3)).toBe("p1#3");
  });
});

describe("mergeMessages", () => {
  it("flattens every participant's array into one transcript", () => {
    const group: GroupSessionData = {
      p1: { [DATA_KEY]: [msg("p1", 0, 100)] },
      p2: { [DATA_KEY]: [msg("p2", 0, 200)] },
    };
    expect(mergeMessages(group, DATA_KEY).map((m) => m.id)).toEqual(["p1#0", "p2#0"]);
  });

  it("orders by (ts, senderId, seq)", () => {
    const group: GroupSessionData = {
      // deliberately out of order and with a ts tie between p1 and p2
      p2: { [DATA_KEY]: [msg("p2", 0, 100), msg("p2", 1, 300)] },
      p1: { [DATA_KEY]: [msg("p1", 0, 100), msg("p1", 1, 200)] },
    };
    // ts=100 tie -> senderId p1 before p2; then 200 (p1), then 300 (p2)
    expect(mergeMessages(group, DATA_KEY).map((m) => m.id)).toEqual([
      "p1#0",
      "p2#0",
      "p1#1",
      "p2#1",
    ]);
  });

  it("never reorders a single sender's messages among themselves", () => {
    // Same ts on two of one sender's messages: seq must keep them in order.
    const group: GroupSessionData = {
      p1: { [DATA_KEY]: [msg("p1", 0, 500), msg("p1", 1, 500), msg("p1", 2, 500)] },
    };
    expect(mergeMessages(group, DATA_KEY).map((m) => m.seq)).toEqual([0, 1, 2]);
  });

  it("de-duplicates by id, keeping the first occurrence (idempotent replay)", () => {
    const group: GroupSessionData = {
      p1: { [DATA_KEY]: [msg("p1", 0, 100), msg("p1", 0, 100)] },
    };
    expect(mergeMessages(group, DATA_KEY)).toHaveLength(1);
  });

  it("normalizes id from senderId+seq even if a client supplied a bad id", () => {
    const tampered = { ...msg("p1", 0, 100), id: "garbage" } as ChatMessage;
    const group: GroupSessionData = { p1: { [DATA_KEY]: [tampered] } };
    expect(mergeMessages(group, DATA_KEY)[0].id).toBe("p1#0");
  });

  it("ignores participants with no slot, no key, or a non-array value", () => {
    const group: GroupSessionData = {
      p1: { [DATA_KEY]: [msg("p1", 0, 100)] },
      p2: {}, // pushed other data but never chatted
      p3: { [DATA_KEY]: "not-an-array" as unknown as ChatMessage[] },
    };
    expect(mergeMessages(group, DATA_KEY).map((m) => m.id)).toEqual(["p1#0"]);
  });

  it("drops malformed message entries but keeps well-formed siblings", () => {
    const group: GroupSessionData = {
      p1: {
        [DATA_KEY]: [
          msg("p1", 0, 100),
          { senderId: "p1", seq: 1 } as unknown as ChatMessage, // missing text/ts
          null as unknown as ChatMessage,
        ],
      },
    };
    expect(mergeMessages(group, DATA_KEY).map((m) => m.id)).toEqual(["p1#0"]);
  });

  it("reads from a custom data key", () => {
    const group: GroupSessionData = { p1: { my_key: [msg("p1", 0, 100)] } };
    expect(mergeMessages(group, "my_key")).toHaveLength(1);
    expect(mergeMessages(group, "chat_messages")).toHaveLength(0);
  });

  it("returns an empty transcript for an empty group", () => {
    expect(mergeMessages({}, DATA_KEY)).toEqual([]);
  });
});

describe("appendOwnMessage", () => {
  it("appends a well-formed message without mutating the input", () => {
    const own = [msg("p1", 0, 100)];
    const next = appendOwnMessage(own, "hello", "p1", 1, 250);

    expect(own).toHaveLength(1); // original untouched
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ id: "p1#1", senderId: "p1", seq: 1, text: "hello", ts: 250 });
  });

  it("starts a fresh array from empty", () => {
    const next = appendOwnMessage([], "first", "p2", 0, 10);
    expect(next).toEqual([{ id: "p2#0", senderId: "p2", seq: 0, text: "first", ts: 10 }]);
  });

  it("preserves text verbatim (escaping is the renderer's job, not the model's)", () => {
    const next = appendOwnMessage([], "<img src=x onerror=alert(1)>", "p1", 0, 0);
    expect(next[0].text).toBe("<img src=x onerror=alert(1)>");
  });
});
