import { GroupSessionData, countVoted, plurality, readVote, tally } from "./vote-core";

describe("readVote", () => {
  it("pulls a valid index and label", () => {
    expect(readVote({ vote: { index: 1, label: "Blue" } }, "vote")).toEqual({
      index: 1,
      label: "Blue",
    });
  });

  it("accepts index 0 (a real, falsy-but-valid selection)", () => {
    expect(readVote({ vote: { index: 0, label: "Red" } }, "vote")).toEqual({
      index: 0,
      label: "Red",
    });
  });

  it("falls back to the stringified index when the label is missing or non-string", () => {
    expect(readVote({ vote: { index: 2 } }, "vote")).toEqual({ index: 2, label: "2" });
    expect(readVote({ vote: { index: 2, label: 99 } }, "vote")).toEqual({ index: 2, label: "2" });
  });

  it("treats a missing slot/key or an invalid index as 'not voted'", () => {
    expect(readVote(undefined, "vote")).toBeNull();
    expect(readVote({}, "vote")).toBeNull();
    expect(readVote({ vote: { label: "no index" } }, "vote")).toBeNull();
    expect(readVote({ vote: { index: -1 } }, "vote")).toBeNull(); // negative
    expect(readVote({ vote: { index: 1.5 } }, "vote")).toBeNull(); // non-integer
    expect(readVote({ vote: { index: "1" } }, "vote")).toBeNull(); // string, not number
    expect(readVote({ vote: { index: NaN } }, "vote")).toBeNull();
  });

  it("reads from the configured data_key, not a hard-coded one", () => {
    expect(readVote({ poll: { index: 0, label: "A" } }, "poll")).toEqual({ index: 0, label: "A" });
    expect(readVote({ poll: { index: 0, label: "A" } }, "vote")).toBeNull();
  });
});

describe("countVoted", () => {
  it("counts only participants with a valid vote", () => {
    const group: GroupSessionData = {
      a: { vote: { index: 0, label: "A" } },
      b: { vote: { index: 1, label: "B" } },
      c: { role: "observer" }, // present but has not voted
      d: { vote: { index: -1 } }, // invalid index
    };
    expect(countVoted(group, "vote")).toBe(2);
  });

  it("bounds by optionCount so it agrees with what tally counts (out-of-range votes excluded)", () => {
    // A stale vote (e.g. left under a reused data_key by an earlier trial that had more options).
    const group: GroupSessionData = {
      a: { vote: { index: 0, label: "A" } },
      b: { vote: { index: 1, label: "B" } },
      c: { vote: { index: 4, label: "stale" } }, // out of range for a 2-option trial
    };
    expect(countVoted(group, "vote")).toBe(3); // no bound: every valid-integer index counts
    expect(countVoted(group, "vote", 2)).toBe(2); // bounded: the index-4 vote is excluded
    // The bounded count matches the number of votes tally actually tallies.
    const tallied = tally(group, "vote", ["A", "B"]).reduce((s, o) => s + o.count, 0);
    expect(countVoted(group, "vote", 2)).toBe(tallied);
  });
});

describe("tally", () => {
  const labels = ["Red", "Green", "Blue"];

  it("counts votes per option and includes zero-vote options", () => {
    const group: GroupSessionData = {
      a: { vote: { index: 0, label: "Red" } },
      b: { vote: { index: 2, label: "Blue" } },
      c: { vote: { index: 0, label: "Red" } },
    };
    expect(tally(group, "vote", labels)).toEqual([
      { index: 0, label: "Red", count: 2 },
      { index: 1, label: "Green", count: 0 },
      { index: 2, label: "Blue", count: 1 },
    ]);
  });

  it("is anonymous: the tally carries counts only, no participant ids", () => {
    const group: GroupSessionData = {
      alice: { vote: { index: 1, label: "Green" } },
      bob: { vote: { index: 1, label: "Green" } },
    };
    const result = tally(group, "vote", labels);
    expect(JSON.stringify(result)).not.toContain("alice");
    expect(JSON.stringify(result)).not.toContain("bob");
    expect(result[1].count).toBe(2);
  });

  it("labels the tally from the passed choices, not from the (untrusted) pushed vote label", () => {
    const group: GroupSessionData = { a: { vote: { index: 0, label: "<evil>" } } };
    expect(tally(group, "vote", labels)[0]).toEqual({ index: 0, label: "Red", count: 1 });
  });

  it("drops votes whose index is out of range for the option list", () => {
    const group: GroupSessionData = {
      a: { vote: { index: 5, label: "off the end" } },
      b: { vote: { index: 1, label: "Green" } },
    };
    const result = tally(group, "vote", labels);
    expect(result.reduce((s, o) => s + o.count, 0)).toBe(1); // only the in-range vote counted
    expect(result[1].count).toBe(1);
  });

  it("ignores non-voters", () => {
    const group: GroupSessionData = { a: { chat: [] }, b: { vote: { index: 0, label: "Red" } } };
    expect(tally(group, "vote", labels)[0].count).toBe(1);
  });
});

describe("plurality", () => {
  const t = (counts: number[]) =>
    counts.map((count, index) => ({ index, label: `opt${index}`, count }));

  it("picks the single option with the most votes", () => {
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

  it("no votes: no winner and NOT a tie", () => {
    const result = plurality(t([0, 0, 0]));
    expect(result.winner).toBeNull();
    expect(result.isTie).toBe(false);
    expect(result.tied).toEqual([]);
    expect(result.totalVotes).toBe(0);
  });

  it("a lone vote wins outright (not treated as a tie with the zero-count options)", () => {
    const result = plurality(t([0, 1, 0]));
    expect(result.winner).toEqual({ index: 1, label: "opt1", count: 1 });
    expect(result.isTie).toBe(false);
  });
});
