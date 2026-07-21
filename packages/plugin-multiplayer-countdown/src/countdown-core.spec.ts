import {
  GroupSessionData,
  computeElapsed,
  computeRemaining,
  formatTime,
  resolveStartedAt,
  startedAtKey,
} from "./countdown-core";

describe("startedAtKey", () => {
  it("namespaces the slot key by name", () => {
    expect(startedAtKey("round1")).toBe("countdown_round1_startedAt");
  });
});

describe("resolveStartedAt", () => {
  const KEY = startedAtKey("t");

  it("returns null for an empty group", () => {
    expect(resolveStartedAt({}, KEY)).toBeNull();
  });

  it("returns the sole timestamp when only one participant has pushed", () => {
    const group: GroupSessionData = { a: { [KEY]: 1000 } };
    expect(resolveStartedAt(group, KEY)).toBe(1000);
  });

  it("returns the MINIMUM timestamp across slots (order-independent)", () => {
    const group: GroupSessionData = {
      a: { [KEY]: 3000 },
      b: { [KEY]: 1000 },
      c: { [KEY]: 2000 },
    };
    expect(resolveStartedAt(group, KEY)).toBe(1000);
    // Same result regardless of key iteration order.
    const reordered: GroupSessionData = {
      c: { [KEY]: 2000 },
      b: { [KEY]: 1000 },
      a: { [KEY]: 3000 },
    };
    expect(resolveStartedAt(reordered, KEY)).toBe(1000);
  });

  it("ignores slots that don't carry the key (returns null when none do)", () => {
    const group: GroupSessionData = { a: { somethingElse: 5 }, b: {} };
    expect(resolveStartedAt(group, KEY)).toBeNull();
  });

  it("ignores the key from OTHER countdowns (namespacing)", () => {
    const group: GroupSessionData = {
      a: { [startedAtKey("other")]: 500, [KEY]: 2000 },
    };
    expect(resolveStartedAt(group, KEY)).toBe(2000);
  });

  it("ignores non-numeric or non-finite values instead of poisoning the min", () => {
    const group: GroupSessionData = {
      a: { [KEY]: "1000" as unknown as number },
      b: { [KEY]: NaN },
      c: { [KEY]: Infinity },
      d: { [KEY]: 4000 },
    };
    expect(resolveStartedAt(group, KEY)).toBe(4000);
  });

  it("tolerates a late joiner whose (higher) timestamp never lowers the min", () => {
    const group: GroupSessionData = { a: { [KEY]: 1000 }, late: { [KEY]: 9000 } };
    expect(resolveStartedAt(group, KEY)).toBe(1000);
  });
});

describe("computeRemaining", () => {
  it("computes startedAt + duration - now in range", () => {
    expect(computeRemaining(1000, 5000, 3000)).toBe(3000); // 1000 + 5000 - 3000
  });

  it("clamps to 0 once now is past the end (never negative)", () => {
    expect(computeRemaining(1000, 5000, 10_000)).toBe(0);
  });

  it("clamps to duration when now precedes the start (clock skew)", () => {
    expect(computeRemaining(1000, 5000, 0)).toBe(5000);
  });

  it("returns full duration at the exact start moment", () => {
    expect(computeRemaining(1000, 5000, 1000)).toBe(5000);
  });
});

describe("computeElapsed", () => {
  it("computes now - startedAt in range", () => {
    expect(computeElapsed(1000, 5000, 3000)).toBe(2000);
  });

  it("clamps to 0 before the start (clock skew)", () => {
    expect(computeElapsed(1000, 5000, 0)).toBe(0);
  });

  it("clamps to duration once elapsed exceeds it", () => {
    expect(computeElapsed(1000, 5000, 100_000)).toBe(5000);
  });

  it("is the complement of computeRemaining within range", () => {
    const startedAt = 2000;
    const duration = 8000;
    const now = 5000;
    expect(computeElapsed(startedAt, duration, now)).toBe(
      duration - computeRemaining(startedAt, duration, now)
    );
  });
});

describe("formatTime", () => {
  it("formats zero as 0:00", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  it("zero-pads the seconds", () => {
    expect(formatTime(5000)).toBe("0:05");
  });

  it("formats minutes and seconds", () => {
    expect(formatTime(65_000)).toBe("1:05");
  });

  it("rounds seconds UP by default (countdown) so a partial final second still shows 0:01", () => {
    expect(formatTime(1)).toBe("0:01");
    expect(formatTime(4500)).toBe("0:05");
  });

  it("pins the minute boundary under ceil rounding", () => {
    expect(formatTime(59_001)).toBe("1:00");
  });

  it("rounds DOWN with floor rounding (stopwatch / count-up convention)", () => {
    expect(formatTime(1, "floor")).toBe("0:00");
    expect(formatTime(4500, "floor")).toBe("0:04");
    expect(formatTime(59_001, "floor")).toBe("0:59");
  });

  it("handles minutes above nine without truncating", () => {
    expect(formatTime(10 * 60_000)).toBe("10:00");
  });

  it("treats negative input as zero", () => {
    expect(formatTime(-500)).toBe("0:00");
    expect(formatTime(-500, "floor")).toBe("0:00");
  });
});
