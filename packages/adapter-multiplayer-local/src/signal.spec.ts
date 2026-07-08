import { createDefaultSignal } from "./signal";

/**
 * Covers the default signal's `storage`-event path — the cross-browser fallback used when
 * BroadcastChannel is unavailable. The adapter's other tests inject an in-memory bus, so this is the
 * only coverage of the real DOM wiring. Requires a jsdom `window` with StorageEvent (the package's
 * jest environment).
 */
describe("createDefaultSignal storage-event handling", () => {
  const KEY_PREFIX = "mp:sess:";

  function dispatchStorage(key: string | null): void {
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }

  test("fires onChange for a key in our namespace", () => {
    const signal = createDefaultSignal("mp:sess", KEY_PREFIX);
    const handler = jest.fn();
    signal.onChange(handler);

    dispatchStorage(`${KEY_PREFIX}alice`);
    expect(handler).toHaveBeenCalledTimes(1);

    signal.close();
  });

  test("fires onChange on a full clear (key === null)", () => {
    const signal = createDefaultSignal("mp:sess", KEY_PREFIX);
    const handler = jest.fn();
    signal.onChange(handler);

    dispatchStorage(null);
    expect(handler).toHaveBeenCalledTimes(1);

    signal.close();
  });

  test("ignores keys outside our namespace", () => {
    const signal = createDefaultSignal("mp:sess", KEY_PREFIX);
    const handler = jest.fn();
    signal.onChange(handler);

    dispatchStorage("mp:other-session:alice");
    dispatchStorage("unrelated");
    expect(handler).not.toHaveBeenCalled();

    signal.close();
  });

  test("close() removes the storage listener", () => {
    const signal = createDefaultSignal("mp:sess", KEY_PREFIX);
    const handler = jest.fn();
    signal.onChange(handler);
    signal.close();

    dispatchStorage(`${KEY_PREFIX}alice`);
    expect(handler).not.toHaveBeenCalled();
  });

  test("post() does not throw", () => {
    const signal = createDefaultSignal("mp:sess", KEY_PREFIX);
    expect(() => signal.post()).not.toThrow();
    signal.close();
  });
});
