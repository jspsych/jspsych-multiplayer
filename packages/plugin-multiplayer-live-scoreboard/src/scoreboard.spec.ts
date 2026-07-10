import { GroupSessionData, buildLeaderboard, countReported, readScoreEntry } from "./scoreboard";

// A snapshot where each participant stored their entry under the default data_key "score".
const snap = (
  entries: Record<string, { score?: unknown; label?: string } | Record<string, unknown>>
) =>
  Object.fromEntries(
    Object.entries(entries).map(([id, e]) => [id, { score: e }])
  ) as GroupSessionData;

describe("readScoreEntry", () => {
  it("pulls a finite numeric score (and optional label)", () => {
    expect(readScoreEntry({ score: { score: 42, label: "Al" } }, "score")).toEqual({
      score: 42,
      label: "Al",
    });
    expect(readScoreEntry({ score: { score: 0 } }, "score")).toEqual({
      score: 0,
      label: undefined,
    });
  });

  it("treats a missing slot, missing key, or non-numeric/non-finite score as 'not reported'", () => {
    expect(readScoreEntry(undefined, "score")).toBeNull();
    expect(readScoreEntry({}, "score")).toBeNull();
    expect(readScoreEntry({ score: { label: "no score" } }, "score")).toBeNull();
    expect(readScoreEntry({ score: { score: "10" } }, "score")).toBeNull(); // string, not number
    expect(readScoreEntry({ score: { score: NaN } }, "score")).toBeNull();
    expect(readScoreEntry({ score: { score: Infinity } }, "score")).toBeNull();
  });

  it("reads from the configured data_key, not a hard-coded one", () => {
    expect(readScoreEntry({ points: { score: 7 } }, "points")).toEqual({
      score: 7,
      label: undefined,
    });
    expect(readScoreEntry({ points: { score: 7 } }, "score")).toBeNull();
  });
});

describe("countReported", () => {
  it("counts only participants with a valid score", () => {
    const group: GroupSessionData = {
      a: { score: { score: 1 } },
      b: { score: { score: 2 } },
      c: { other: "no score here" }, // present but not a reporter
      d: { score: { score: NaN } }, // invalid score, not a reporter
    };
    expect(countReported(group, "score")).toBe(2);
  });
});

describe("buildLeaderboard", () => {
  it("ranks highest-first by default and flags the viewer's own row", () => {
    const rows = buildLeaderboard(snap({ a: { score: 10 }, b: { score: 30 }, c: { score: 20 } }), {
      dataKey: "score",
      self: "c",
    });
    expect(rows.map((r) => [r.participantId, r.rank])).toEqual([
      ["b", 1],
      ["c", 2],
      ["a", 3],
    ]);
    expect(rows.find((r) => r.participantId === "c")!.isSelf).toBe(true);
    expect(rows.filter((r) => r.isSelf)).toHaveLength(1);
  });

  it("sort: 'asc' ranks lowest-first (e.g. reaction time)", () => {
    const rows = buildLeaderboard(snap({ a: { score: 10 }, b: { score: 30 }, c: { score: 20 } }), {
      dataKey: "score",
      sort: "asc",
    });
    expect(rows.map((r) => r.participantId)).toEqual(["a", "c", "b"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("standard tie ranking shares a rank and leaves a gap (1,2,2,4)", () => {
    const rows = buildLeaderboard(
      snap({ a: { score: 50 }, b: { score: 30 }, c: { score: 30 }, d: { score: 10 } }),
      { dataKey: "score", tieMethod: "standard" }
    );
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
  });

  it("dense tie ranking shares a rank with no gap (1,2,2,3)", () => {
    const rows = buildLeaderboard(
      snap({ a: { score: 50 }, b: { score: 30 }, c: { score: 30 }, d: { score: 10 } }),
      { dataKey: "score", tieMethod: "dense" }
    );
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 2, 3]);
  });

  it("orders tied scores deterministically by participantId, independent of snapshot order", () => {
    const forward = buildLeaderboard(snap({ x: { score: 5 }, y: { score: 5 }, z: { score: 5 } }), {
      dataKey: "score",
    });
    // Same scores, but the snapshot enumerates ids in the opposite order.
    const reversed = buildLeaderboard(snap({ z: { score: 5 }, y: { score: 5 }, x: { score: 5 } }), {
      dataKey: "score",
    });
    expect(forward.map((r) => r.participantId)).toEqual(["x", "y", "z"]);
    expect(reversed.map((r) => r.participantId)).toEqual(["x", "y", "z"]); // identical, order-independent
  });

  it("drops participants who never reported a valid score (absent != scored zero)", () => {
    const group: GroupSessionData = {
      a: { score: { score: 9 } },
      b: { chat: [] }, // in the session but no score
      c: { score: { score: NaN } }, // invalid score
    };
    const rows = buildLeaderboard(group, { dataKey: "score" });
    expect(rows.map((r) => r.participantId)).toEqual(["a"]);
  });

  it("uses the pushed label, falling back to the participantId", () => {
    const rows = buildLeaderboard(
      { a: { score: { score: 1, label: "Alice" } }, b: { score: { score: 2 } } },
      { dataKey: "score" }
    );
    expect(rows.find((r) => r.participantId === "a")!.label).toBe("Alice");
    expect(rows.find((r) => r.participantId === "b")!.label).toBe("b");
  });

  it("returns an empty board when no one reported", () => {
    expect(buildLeaderboard({ a: { other: 1 } }, { dataKey: "score" })).toEqual([]);
  });
});
