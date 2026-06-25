import trustedPublishTest from ".";

describe("trusted-publish-test", () => {
  it("returns ok", () => {
    expect(trustedPublishTest()).toBe("ok");
  });
});
