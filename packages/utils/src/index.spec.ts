import { MemoryHub, flushPromises } from "../../../test-utils/memory-backend";
import {
  generateId,
  isMultiplayerError,
  outcomeOf,
  pluginTimeout,
  remainingParticipants,
  sealedGroupSize,
  sessionIdFromUrl,
  tabId,
  validateId,
  waitForAll,
  withoutLeft,
} from ".";

afterEach(() => {
  jest.useRealTimers();
});

describe("errors and outcomes", () => {
  test("isMultiplayerError matches by name and code", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1");
    const error = await jsPsych.multiplayer.wait(() => false, { timeout: 1 }).catch((e) => e);
    expect(isMultiplayerError(error)).toBe(true);
    expect(isMultiplayerError(error, "timeout")).toBe(true);
    expect(isMultiplayerError(error, "cancelled")).toBe(false);
    expect(isMultiplayerError(new Error("x"))).toBe(false);
    // A copy of the class from another bundle still matches
    const foreign = Object.assign(new Error("x"), { name: "MultiplayerError", code: "cancelled" });
    expect(isMultiplayerError(foreign, "cancelled")).toBe(true);
  });

  test("outcomeOf maps wait failures and leaves other errors to the caller", () => {
    const make = (code: string) => Object.assign(new Error(), { name: "MultiplayerError", code });
    expect(outcomeOf(make("timeout"))).toBe("timeout");
    expect(outcomeOf(make("participant_left"))).toBe("participant_left");
    expect(outcomeOf(make("connection_lost"))).toBe("connection_lost");
    expect(outcomeOf(make("cancelled"))).toBe("cancelled");
    expect(outcomeOf(make("not_connected"))).toBeNull();
    expect(outcomeOf(new TypeError("bad condition"))).toBeNull();
  });

  test.each([
    [5000, 5000],
    [0, null],
    [-1, null],
    [null, null],
    [undefined, null],
    ["5000", null],
  ])("pluginTimeout(%p) is %p", (value, expected) => {
    expect(pluginTimeout(value)).toBe(expected);
  });
});

describe("group helpers", () => {
  test("remainingParticipants lists the others who are connected before the seal", async () => {
    const hub = new MemoryHub();
    hub.seed("ghost", { x: 1 });
    const { jsPsych } = await hub.join("p1");
    await hub.join("p2");
    expect(remainingParticipants(jsPsych.multiplayer)).toEqual(["p2"]);
    expect(sealedGroupSize(jsPsych.multiplayer)).toBeNull();
  });

  test("in a sealed group, remainingParticipants is the roster minus those who left", async () => {
    jest.useFakeTimers();
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("p1", { connect: { dropoutTimeout: 1000 } });
    const b = await hub.join("p2");
    await hub.join("p3");
    hub.seal(["p1", "p2", "p3"]);
    b.connection.setOnline(false);
    // Away members may come back, so they still count
    expect(remainingParticipants(jsPsych.multiplayer)).toEqual(["p2", "p3"]);
    jest.advanceTimersByTime(1000);
    expect(remainingParticipants(jsPsych.multiplayer)).toEqual(["p3"]);
    expect(sealedGroupSize(jsPsych.multiplayer)).toBe(2);
  });

  test("withoutLeft drops participants who have left", () => {
    expect(withoutLeft(["a", "b", "c"], { a: "connected", b: "left", c: "away" })).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("waitForAll", () => {
  test("resolves once enough participants have written the key", async () => {
    const hub = new MemoryHub();
    const a = await hub.join("p1");
    const b = await hub.join("p2");
    let done = false;
    const waiting = waitForAll(a.jsPsych.multiplayer, "ready", { count: 2 }).then(
      () => (done = true),
    );
    await a.jsPsych.multiplayer.update({ ready: true });
    await flushPromises();
    expect(done).toBe(false);
    await b.jsPsych.multiplayer.update({ ready: true });
    await waiting;
  });

  test("defaults the count to the sealed group", async () => {
    const hub = new MemoryHub();
    const a = await hub.join("p1");
    const b = await hub.join("p2");
    hub.seal(["p1", "p2"]);
    const waiting = waitForAll(a.jsPsych.multiplayer, "choice");
    await a.jsPsych.multiplayer.update({ choice: 1 });
    await b.jsPsych.multiplayer.update({ choice: 2 });
    const data = await waiting;
    expect(Object.keys(data).sort()).toEqual(["p1", "p2"]);
  });

  test("needs a count when the group isn't sealed", async () => {
    const hub = new MemoryHub();
    const a = await hub.join("p1");
    await expect(waitForAll(a.jsPsych.multiplayer, "x")).rejects.toThrow("count");
  });

  test("rejects when a participant it depends on leaves", async () => {
    jest.useFakeTimers();
    const hub = new MemoryHub();
    const a = await hub.join("p1", { connect: { dropoutTimeout: 1000 } });
    const b = await hub.join("p2");
    const waiting = waitForAll(a.jsPsych.multiplayer, "x", { count: 2 });
    await b.jsPsych.multiplayer.disconnect();
    jest.advanceTimersByTime(1000);
    await expect(waiting).rejects.toMatchObject({ code: "participant_left" });
  });
});

describe("adapter helpers", () => {
  test("generateId returns distinct IDs", () => {
    expect(generateId()).not.toBe(generateId());
  });

  test("sessionIdFromUrl reads the parameter, or mints one and writes it into the URL", () => {
    window.history.replaceState(null, "", "/?mp_session=abc");
    expect(sessionIdFromUrl()).toBe("abc");
    window.history.replaceState(null, "", "/");
    const minted = sessionIdFromUrl();
    expect(new URL(window.location.href).searchParams.get("mp_session")).toBe(minted);
    expect(sessionIdFromUrl()).toBe(minted);
  });

  test("tabId stays the same within the tab", () => {
    sessionStorage.clear();
    const id = tabId("test-key");
    expect(tabId("test-key")).toBe(id);
    expect(tabId("other-key")).not.toBe(id);
  });

  test("validateId rejects IDs some adapter can't store", () => {
    expect(validateId("Adapter", "participantId", "abc-123_X")).toBe("abc-123_X");
    for (const bad of ["", "a:b", "a/b", "a.b", "a#b", "a$b", "a[b", 7]) {
      expect(() => validateId("Adapter", "participantId", bad)).toThrow(
        "Adapter: participantId must be",
      );
    }
  });
});
