import { resolveMultiplayerApi } from "./multiplayer-api";

/**
 * `resolveMultiplayerApi` is the single seam every plugin reaches the multiplayer API through, and
 * it is duplicated verbatim into each package's own `multiplayer-api.ts`. Testing it once here
 * covers the shared contract; the per-plugin specs cover the plugins' use of it.
 *
 * `jsPsych.multiplayer` (jsPsych#3694) is the only supported location. Preview builds that flattened
 * these methods onto `jsPsych.pluginAPI` predate the current contract, so they are not resolved.
 */
describe("resolveMultiplayerApi", () => {
  const fakeApi = { getAll: () => ({}) };

  it("resolves jsPsych.multiplayer", () => {
    expect(resolveMultiplayerApi({ multiplayer: fakeApi })).toBe(fakeApi);
  });

  it("throws a directing error when the API is absent", () => {
    // A plain released jsPsych: no `multiplayer` module at all.
    expect(() => resolveMultiplayerApi({})).toThrow(/No multiplayer API found/);
    expect(() => resolveMultiplayerApi({ multiplayer: undefined })).toThrow(
      /No multiplayer API found/,
    );
    // A `multiplayer` module that doesn't carry the members is just as unusable.
    expect(() => resolveMultiplayerApi({ multiplayer: { connect: () => {} } })).toThrow(
      /No multiplayer API found/,
    );
  });

  it("ignores the pre-#3694 pluginAPI location", () => {
    // Those builds throw synchronously, never cancel a wait, and hand out the live session object,
    // so silently resolving them would run this plugin against a contract it no longer expects.
    expect(() => resolveMultiplayerApi({ pluginAPI: fakeApi })).toThrow(/No multiplayer API found/);
  });
});
