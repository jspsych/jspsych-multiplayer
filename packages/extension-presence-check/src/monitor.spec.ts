import { PresenceOutcome, PresenceSummary, createPresenceMonitor } from "./monitor";

// A monitor on a fake clock with the study's defaults (30s, 30s, 2 misses). `at(ms)` moves the
// clock and ticks, as the extension's interval does.
function setup(
  options: {
    maxConsecutiveMisses?: number | null;
    consecutiveMisses?: number;
    start?: number;
    hidden?: boolean;
  } = {},
) {
  let t = options.start ?? 0;
  const shown: number[] = [];
  const hidden: Array<[number, PresenceOutcome]> = [];
  const expiries: Array<[number, PresenceSummary]> = [];
  const monitor = createPresenceMonitor({
    promptAfter: 30000,
    respondWithin: 30000,
    maxConsecutiveMisses:
      options.maxConsecutiveMisses === undefined ? 2 : options.maxConsecutiveMisses,
    consecutiveMisses: options.consecutiveMisses,
    hidden: options.hidden,
    now: () => t,
    onShow: () => shown.push(t),
    onHide: (outcome) => hidden.push([t, outcome]),
    onExpire: (summary) => expiries.push([t, summary]),
  });
  const at = (ms: number, paused = false) => {
    t = ms;
    monitor.tick(paused);
  };
  /** Ticks every 250 ms up to `ms`, like the page does. */
  const run = (from: number, to: number, paused = false) => {
    for (let ms = from; ms <= to; ms += 250) at(ms, paused);
  };
  return { monitor, at, run, shown, hidden, expiries, set: (ms: number) => (t = ms) };
}

describe("presence monitor", () => {
  it("shows a warning only after prompt_after with no activity", () => {
    const { at, shown } = setup();
    at(29999);
    expect(shown).toEqual([]);
    at(30000);
    expect(shown).toEqual([30000]);
  });

  it("expires the 30/30/2 sequence at about 120s, calling on_expire once", () => {
    const { run, shown, hidden, expiries, monitor } = setup();
    run(0, 200000);
    expect(shown).toEqual([30000, 90000]);
    expect(hidden).toEqual([
      [60000, "missed"],
      [120000, "expired"],
    ]);
    expect(expiries).toHaveLength(1);
    expect(expiries[0][0]).toBe(120000);
    expect(monitor.isOpen).toBe(false);
    expect(monitor.expired).toBe(true);
    const summary = expiries[0][1];
    expect(summary).toMatchObject({
      presence_prompts: 2,
      presence_missed: 2,
      presence_responded: 0,
      presence_consecutive_misses: 2,
      presence_expired: true,
    });
    expect(summary.presence_events.map((e) => e.outcome)).toEqual(["missed", "expired"]);
  });

  it("a response after a miss resets the count, so warnings can repeat without expiring", () => {
    const { monitor, at, set, expiries, hidden } = setup();
    let t = 0;
    for (let i = 0; i < 10; i++) {
      at((t += 30000)); // shown
      at((t += 30000)); // missed: count 1
      expect(monitor.consecutiveMisses).toBe(1);
      at((t += 30000)); // shown again
      set((t += 5000));
      monitor.respond("keyboard"); // count back to 0
      expect(monitor.consecutiveMisses).toBe(0);
    }
    expect(expiries).toEqual([]);
    expect(hidden.filter(([, o]) => o === "missed")).toHaveLength(10);
    const events = monitor.summary().presence_events;
    expect(events[1]).toEqual({
      shown_at: 90000,
      outcome: "responded",
      rt: 5000,
      dismissed_by: "keyboard",
      backdrop_clicks: 0,
      hidden_at_show: false,
      hidden_ms: 0,
    });
  });

  it("activity between warnings resets the count and the idle clock", () => {
    const { monitor, at, set, shown, expiries } = setup();
    at(30000);
    at(60000); // missed
    expect(monitor.consecutiveMisses).toBe(1);
    set(70000);
    monitor.activity();
    expect(monitor.consecutiveMisses).toBe(0);
    at(99999);
    expect(shown).toEqual([30000]);
    at(100000); // shown
    at(130000); // missed: only the first in a row
    expect(monitor.consecutiveMisses).toBe(1);
    expect(expiries).toEqual([]);
  });

  it("activity while a warning is open is not a response", () => {
    const { monitor, at, set } = setup();
    at(30000);
    set(35000);
    monitor.activity();
    expect(monitor.isOpen).toBe(true);
    at(60000);
    expect(monitor.summary().presence_events[0].outcome).toBe("missed");
  });

  it("carries the count across trials, and a pause in between neither counts nor resets", () => {
    // Round 5: one miss, then feedback (paused) interrupts the next warning.
    const round5 = setup();
    round5.run(0, 60000); // shown at 30s, missed at 60s
    round5.run(60250, 90000); // next warning at 90s
    round5.at(95000, true); // feedback starts: interrupted
    round5.run(95250, 200000, true); // a long feedback screen shows nothing
    expect(round5.hidden.map(([, o]) => o)).toEqual(["missed", "interrupted"]);
    expect(round5.monitor.consecutiveMisses).toBe(1);
    round5.monitor.stop();
    // Round 6 starts from that count, so its first miss expires.
    const round6 = setup({ consecutiveMisses: round5.monitor.consecutiveMisses });
    round6.run(0, 60000);
    expect(round6.hidden).toEqual([[60000, "expired"]]);
    expect(round6.expiries).toHaveLength(1);
  });

  it("starts from zero when the trial does not carry the count", () => {
    const { run, hidden, expiries } = setup({ consecutiveMisses: 0 });
    run(0, 60000);
    expect(hidden).toEqual([[60000, "missed"]]);
    expect(expiries).toEqual([]);
  });

  it.each([0, null])("never expires with max_consecutive_misses %p", (max) => {
    const { run, expiries, monitor } = setup({ maxConsecutiveMisses: max });
    run(0, 600000);
    expect(expiries).toEqual([]);
    expect(monitor.summary().presence_missed).toBe(10);
    expect(monitor.consecutiveMisses).toBe(10);
  });

  it("stops prompting after expiry and starts the count over, keeping it at expiry in the data", () => {
    const { run, shown, monitor, expiries } = setup();
    run(0, 120000);
    expect(expiries[0][1].presence_consecutive_misses).toBe(2);
    run(120250, 400000);
    expect(shown).toEqual([30000, 90000]);
    expect(monitor.consecutiveMisses).toBe(0);
    monitor.stop();
    expect(monitor.summary().presence_consecutive_misses).toBe(2);
  });

  it("a trial after an expiry needs the full number of misses to expire again", () => {
    const first = setup();
    first.run(0, 120000);
    first.monitor.stop();
    const second = setup({ consecutiveMisses: first.monitor.consecutiveMisses });
    second.run(0, 200000);
    expect(second.hidden).toEqual([
      [60000, "missed"],
      [120000, "expired"],
    ]);
  });

  it("clears the count before on_expire, so a callback that ends the trial carries 0", () => {
    let seen: number | null = null;
    let t = 0;
    const monitor = createPresenceMonitor({
      promptAfter: 1000,
      respondWithin: 1000,
      maxConsecutiveMisses: 1,
      now: () => t,
      onShow: () => {},
      onHide: () => {},
      onExpire: () => {
        seen = monitor.consecutiveMisses;
      },
    });
    t = 1000;
    monitor.tick();
    t = 2000;
    monitor.tick();
    expect(seen).toBe(0);
  });

  describe("hidden document", () => {
    it("records hidden_at_show and the hidden ms of each warning", () => {
      const { monitor, at, set } = setup({ maxConsecutiveMisses: 0 });
      set(10000);
      monitor.visibility(true); // hidden before the first warning
      at(30000); // shown while hidden
      set(40000);
      monitor.visibility(false);
      set(45000);
      monitor.visibility(true);
      at(60000); // missed: hidden 30000-40000 and 45000-60000
      at(90000); // next warning, still hidden
      set(100000);
      monitor.visibility(false);
      monitor.respond("mouse_move");
      at(130000); // visible the whole time
      set(131000);
      monitor.stop();
      const summary = monitor.summary();
      expect(
        summary.presence_events.map((e) => [e.outcome, e.hidden_at_show, e.hidden_ms]),
      ).toEqual([
        ["missed", true, 25000],
        ["responded", true, 10000],
        ["interrupted", false, 0],
      ]);
      expect(summary.presence_hidden_ms).toBe(85000);
    });

    it("starts hidden when the document is hidden at creation, and stops counting at stop()", () => {
      const { monitor, set } = setup({ hidden: true });
      set(5000);
      monitor.stop();
      set(9000);
      monitor.visibility(false);
      expect(monitor.summary().presence_hidden_ms).toBe(5000);
    });

    it("visibility changes are neither activity nor a response", () => {
      const { monitor, at, set, shown } = setup({ maxConsecutiveMisses: 0 });
      at(20000);
      monitor.visibility(true);
      set(25000);
      monitor.visibility(false);
      at(30000);
      expect(shown).toEqual([30000]); // the idle clock was not restarted
      monitor.visibility(true);
      monitor.visibility(false);
      expect(monitor.isOpen).toBe(true);
      at(60000);
      expect(monitor.summary().presence_events[0].outcome).toBe("missed");
      expect(monitor.consecutiveMisses).toBe(1);
    });

    it("stops counting at expiry", () => {
      const { monitor, run, set, expiries } = setup({ hidden: true });
      run(0, 120000);
      expect(expiries[0][1].presence_hidden_ms).toBe(120000);
      expect(expiries[0][1].presence_events.map((e) => e.hidden_ms)).toEqual([30000, 30000]);
      set(500000);
      monitor.stop();
      expect(monitor.summary().presence_hidden_ms).toBe(120000);
    });
  });

  it("stopping with a warning open records it as interrupted without changing the count", () => {
    const { monitor, at, run } = setup();
    run(0, 60000); // one miss
    at(90000); // shown
    monitor.stop();
    monitor.stop();
    const summary = monitor.summary();
    expect(summary.presence_events.map((e) => e.outcome)).toEqual(["missed", "interrupted"]);
    expect(summary.presence_consecutive_misses).toBe(1);
    expect(summary.presence_interrupted).toBe(1);
  });

  it("counts backdrop clicks per warning", () => {
    const { monitor, at, set } = setup({ maxConsecutiveMisses: 0 });
    monitor.backdropClick(); // none open: ignored
    at(30000);
    monitor.backdropClick();
    monitor.backdropClick();
    set(31000);
    monitor.respond("button");
    at(61000);
    monitor.backdropClick();
    at(91000);
    const summary = monitor.summary();
    expect(summary.presence_events.map((e) => [e.outcome, e.backdrop_clicks])).toEqual([
      ["responded", 2],
      ["missed", 1],
    ]);
    expect(summary.presence_backdrop_clicks).toBe(3);
  });

  it("resetMisses clears the count", () => {
    const { monitor, run } = setup();
    run(0, 60000);
    monitor.resetMisses();
    expect(monitor.consecutiveMisses).toBe(0);
  });
});
