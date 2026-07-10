import { GroupSessionData, collectChoices, countChosen, readChoice } from "./choice-core";

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
