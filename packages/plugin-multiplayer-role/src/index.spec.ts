import MultiplayerRolePlugin from ".";

describe("plugin-multiplayer-role — package surface", () => {
  it("exposes the pure assignment core and the role accessors as statics", () => {
    expect(typeof MultiplayerRolePlugin.assignRoles).toBe("function");
    expect(typeof MultiplayerRolePlugin.getMyRole).toBe("function");
    expect(typeof MultiplayerRolePlugin.getMyAssignment).toBe("function");
    expect(typeof MultiplayerRolePlugin.getRoleMap).toBe("function");
    expect(typeof MultiplayerRolePlugin.participantsByRole).toBe("function");
  });

  it("accessors are empty before any assignment has run", () => {
    expect(MultiplayerRolePlugin.getMyRole()).toBeUndefined();
    expect(MultiplayerRolePlugin.getMyAssignment()).toBeUndefined();
    expect(MultiplayerRolePlugin.getRoleMap()).toBeUndefined();
    expect(MultiplayerRolePlugin.participantsByRole()).toEqual({});
  });

  it("the static assignRoles actually works (sanity check of the public path)", () => {
    const map = MultiplayerRolePlugin.assignRoles(
      { b: {}, a: {} },
      { roles: ["first", "second"], strategy: "join_order" }
    );
    expect(map.a.role).toBe("first");
    expect(map.b.role).toBe("second");
  });
});

describe("plugin-multiplayer-role — trial wrapper (deferred)", () => {
  it("throws a clear deferral error until the jsPsych multiplayer API lands", () => {
    const plugin = new MultiplayerRolePlugin({} as never);
    expect(() => plugin.trial(document.createElement("div"), {} as never)).toThrow(
      /not implemented yet/i
    );
  });
});
