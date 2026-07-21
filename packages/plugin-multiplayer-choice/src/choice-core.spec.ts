import {
  GroupSessionData,
  collectChoices,
  countChosen,
  plurality,
  readChoice,
  tally,
} from "./choice-core";

describe("readChoice", () => {
  it("pulls a valid index and label", () => {
    expect(readChoice({ choice: { index: 1, label: "Cooperate" } }, "choice")).toEqual({
      index: 1,
      label: "Cooperate",
    });
  });

  it("accepts index 0 (a real, falsy-but-valid selection)", () => {
    expect(readChoice({ choice: { index: 0, label: "Defect" } }, "choice")).toEqual({
      index: 0,
      label: "Defect",
    });
  });

  it("falls back to the stringified index when the label is missing or non-string", () => {
    expect(readChoice({ choice: { index: 2 } }, "choice")).toEqual({ index: 2, label: "2" });
    expect(readChoice({ choice: { index: 2, label: 99 } }, "choice")).toEqual({
      index: 2,
      label: "2",
    });
  });

  it("treats a missing slot/key or an invalid index as 'not chosen'", () => {
    expect(readChoice(undefined, "choice")).toBeNull();
    expect(readChoice({}, "choice")).toBeNull();
    expect(readChoice({ choice: { label: "no index" } }, "choice")).toBeNull();
    expect(readChoice({ choice: { index: -1 } }, "choice")).toBeNull(); // negative
    expect(readChoice({ choice: { index: 1.5 } }, "choice")).toBeNull(); // non-integer
    expect(readChoice({ choice: { index: "1" } }, "choice")).toBeNull(); // string, not number
    expect(readChoice({ choice: { index: NaN } }, "choice")).toBeNull();
  });

  it("reads from the configured data_key, not a hard-coded one", () => {
    expect(readChoice({ vote: { index: 0, label: "A" } }, "vote")).toEqual({
      index: 0,
      label: "A",
    });
    expect(readChoice({ vote: { index: 0, label: "A" } }, "choice")).toBeNull();
  });
});

describe("countChosen", () => {
  it("counts only participants with a valid choice", () => {
    const group: GroupSessionData = {
      a: { choice: { index: 0, label: "A" } },
      b: { choice: { index: 1, label: "B" } },
      c: { role: "observer" }, // present but has not chosen
      d: { choice: { index: -1 } }, // invalid index
    };
    expect(countChosen(group, "choice")).toBe(2);
  });

  it("bounds by optionCount so it agrees with what tally counts (out-of-range choices excluded)", () => {
    // A stale pick (e.g. left under a reused data_key by an earlier trial that had more options).
    const group: GroupSessionData = {
      a: { choice: { index: 0, label: "A" } },
      b: { choice: { index: 1, label: "B" } },
      c: { choice: { index: 4, label: "stale" } }, // out of range for a 2-option trial
    };
    expect(countChosen(group, "choice")).toBe(3); // no bound: every valid-integer index counts
    expect(countChosen(group, "choice", 2)).toBe(2); // bounded: the index-4 pick is excluded
    // The bounded count matches the number of picks tally actually tallies.
    const tallied = tally(group, "choice", ["A", "B"]).reduce((s, o) => s + o.count, 0);
    expect(countChosen(group, "choice", 2)).toBe(tallied);
  });
});

describe("tally", () => {
  const labels = ["Red", "Green", "Blue"];

  it("counts picks per option and includes zero-count options", () => {
    const group: GroupSessionData = {
      a: { choice: { index: 0, label: "Red" } },
      b: { choice: { index: 2, label: "Blue" } },
      c: { choice: { index: 0, label: "Red" } },
    };
    expect(tally(group, "choice", labels)).toEqual([
      { index: 0, label: "Red", count: 2 },
      { index: 1, label: "Green", count: 0 },
      { index: 2, label: "Blue", count: 1 },
    ]);
  });

  it("is anonymous: the tally carries counts only, no participant ids", () => {
    const group: GroupSessionData = {
      alice: { choice: { index: 1, label: "Green" } },
      bob: { choice: { index: 1, label: "Green" } },
    };
    const result = tally(group, "choice", labels);
    expect(JSON.stringify(result)).not.toContain("alice");
    expect(JSON.stringify(result)).not.toContain("bob");
    expect(result[1].count).toBe(2);
  });

  it("labels the tally from the passed choices, not from the (untrusted) pushed label", () => {
    const group: GroupSessionData = { a: { choice: { index: 0, label: "<evil>" } } };
    expect(tally(group, "choice", labels)[0]).toEqual({ index: 0, label: "Red", count: 1 });
  });

  it("drops picks whose index is out of range for the option list", () => {
    const group: GroupSessionData = {
      a: { choice: { index: 5, label: "off the end" } },
      b: { choice: { index: 1, label: "Green" } },
    };
    const result = tally(group, "choice", labels);
    expect(result.reduce((s, o) => s + o.count, 0)).toBe(1); // only the in-range pick counted
    expect(result[1].count).toBe(1);
  });

  it("ignores non-choosers", () => {
    const group: GroupSessionData = { a: { chat: [] }, b: { choice: { index: 0, label: "Red" } } };
    expect(tally(group, "choice", labels)[0].count).toBe(1);
  });
});

describe("plurality", () => {
  const t = (counts: number[]) =>
    counts.map((count, index) => ({ index, label: `opt${index}`, count }));

  it("picks the single option with the most picks", () => {
    const result = plurality(t([1, 3, 2]));
    expect(result.winner).toEqual({ index: 1, label: "opt1", count: 3 });
    expect(result.isTie).toBe(false);
    expect(result.tied).toEqual([]);
    expect(result.totalVotes).toBe(6);
  });

  it("reports a tie (no winner) when options share the top count", () => {
    const result = plurality(t([2, 2, 1]));
    expect(result.winner).toBeNull();
    expect(result.isTie).toBe(true);
    expect(result.tied).toEqual([
      { index: 0, label: "opt0", count: 2 },
      { index: 1, label: "opt1", count: 2 },
    ]);
    expect(result.totalVotes).toBe(5);
  });

  it("no picks: no winner and NOT a tie", () => {
    const result = plurality(t([0, 0, 0]));
    expect(result.winner).toBeNull();
    expect(result.isTie).toBe(false);
    expect(result.tied).toEqual([]);
    expect(result.totalVotes).toBe(0);
  });

  it("a lone pick wins outright (not treated as a tie with the zero-count options)", () => {
    const result = plurality(t([0, 1, 0]));
    expect(result.winner).toEqual({ index: 1, label: "opt1", count: 1 });
    expect(result.isTie).toBe(false);
  });
});

describe("collectChoices", () => {
  it("maps each chooser to their choice and drops non-choosers", () => {
    const group: GroupSessionData = {
      a: { choice: { index: 0, label: "Cooperate" } },
      b: { choice: { index: 1, label: "Defect" } },
      c: { chat: [] }, // no choice
    };
    expect(collectChoices(group, "choice")).toEqual({
      a: { index: 0, label: "Cooperate" },
      b: { index: 1, label: "Defect" },
    });
  });

  it("returns an empty map when no one has chosen", () => {
    expect(collectChoices({ a: { other: 1 } }, "choice")).toEqual({});
  });
});
