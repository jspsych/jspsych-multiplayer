import { resolveMultiplayerApi } from "./multiplayer-api";

/**
 * `resolveMultiplayerApi` is the single seam every plugin reaches the multiplayer API through, and
 * it is duplicated verbatim into each package's own `multiplayer-api.ts`. Testing it once here
 * covers the shared contract; the per-plugin specs cover the plugins' use of it.
 *
 * The fallback exists because jsPsych#3694 moved the API from `pluginAPI` to `multiplayer` and
 * removed the old location, so a published plugin has to work against both preview builds.
 */
describe("resolveMultiplayerApi", () => {
  const fakeApi = { getAll: () => ({}) };

  it("prefers jsPsych.multiplayer when present", () => {
    const other = { getAll: () => ({ wrong: {} }) };
    expect(resolveMultiplayerApi({ multiplayer: fakeApi, pluginAPI: other })).toBe(fakeApi);
  });

  it("falls back to pluginAPI on an older build that lacks jsPsych.multiplayer", () => {
    expect(resolveMultiplayerApi({ pluginAPI: fakeApi })).toBe(fakeApi);
  });

  it("throws a directing error when neither location carries the API", () => {
    // A plain released jsPsych: pluginAPI exists but has none of the multiplayer members.
    expect(() => resolveMultiplayerApi({ pluginAPI: { clearAllTimeouts: () => {} } })).toThrow(
      /No multiplayer API found/
    );
    expect(() => resolveMultiplayerApi({})).toThrow(/No multiplayer API found/);
  });
});
