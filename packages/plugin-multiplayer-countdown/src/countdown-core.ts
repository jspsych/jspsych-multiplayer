/**
 * Pure, framework-free core for the countdown plugin: the consensus start-time resolution and the
 * display math.
 *
 * None of this touches jsPsych, the DOM, or the multiplayer API — it is plain data in, plain data
 * out, so it can be unit-tested in isolation (mirroring `assignRoles` in `plugin-multiplayer-role`
 * and `mergeMessages` in `plugin-multiplayer-chat`). The thin `index.ts` trial wires these functions
 * to `subscribe`/`push` and the DOM, and re-exports them as statics on the default export so demos
 * (e.g. `draw-room.html`) can render their own synced display from the same logic.
 *
 * ## Consensus model: min-across-slots (no anchor)
 * `push` REPLACES a participant's whole slot, so there is no shared slot an "anchor" could own.
 * Instead every participant writes its own start timestamp under a namespaced key into its own slot,
 * and the canonical group start time is the **minimum** timestamp across all slots. Min is
 * order-independent, so every client converges on the same value with no coordination, and no single
 * participant dropping out can break the clock. As more (or lower) timestamps arrive, the min can
 * only decrease — displayed remaining time only ticks *down* while the group converges, never up.
 * See the design doc (`docs/countdown-plugin-design.md`) for the clock-skew failure analysis.
 */

/** A group-session snapshot: participantId -> that participant's pushed data. */
export type GroupSessionData = Record<string, Record<string, unknown>>;

/** Build the namespaced slot key a countdown stores its start timestamp under. */
export function startedAtKey(name: string): string {
  return `countdown_${name}_startedAt`;
}

/**
 * The canonical group start time: the MINIMUM valid timestamp stored under `key` across every
 * participant's slot. Returns `null` if no participant has pushed a valid timestamp yet.
 *
 * Slots without the key, or carrying a non-finite / non-number value, are ignored — a malformed or
 * absent entry must never poison the consensus (it simply doesn't participate in the min).
 */
export function resolveStartedAt(group: GroupSessionData, key: string): number | null {
  let min: number | null = null;
  for (const participantId of Object.keys(group)) {
    const raw = group[participantId]?.[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (min === null || raw < min) min = raw;
  }
  return min;
}

/**
 * Milliseconds remaining in a countdown: `startedAt + duration - now`, clamped to `[0, duration]`.
 *
 * The clamp is the v1 clock-skew mitigation: `startedAt` lives on another client's clock, so the raw
 * value can fall outside `[0, duration]` (a grossly-behind clock in the group, or this client's own
 * clock running ahead/behind). Clamping keeps the display sane and makes the failure direction
 * "ends early" rather than "runs negative / overshoots".
 */
export function computeRemaining(startedAt: number, duration: number, now: number): number {
  return clamp(startedAt + duration - now, 0, duration);
}

/**
 * Milliseconds elapsed since the canonical group start (count-up mode): `now - startedAt`, clamped
 * to `[0, duration]`. Equivalent to `duration - computeRemaining(...)` within range; exposed as its
 * own function so count-up display code (and the draw-room retrofit) reads directly.
 */
export function computeElapsed(startedAt: number, duration: number, now: number): number {
  return clamp(now - startedAt, 0, duration);
}

/**
 * Default `M:SS` formatter for a millisecond value.
 *
 * `rounding` picks the per-mode convention, because the two modes want opposite rounding:
 * - `"ceil"` (countdown default) shows `0:01` through the final partial second and only reaches
 *   `0:00` once truly expired.
 * - `"floor"` (count-up default) is the stopwatch convention: `0:00` for the first second, and it
 *   never displays the full duration until the timer has genuinely reached it.
 *
 * The trial selects the mode-appropriate default; callers wanting something else pass their own
 * `format` function.
 */
export function formatTime(ms: number, rounding: "ceil" | "floor" = "ceil"): string {
  const clampedSeconds = Math.max(0, ms) / 1000;
  const totalSeconds = rounding === "ceil" ? Math.ceil(clampedSeconds) : Math.floor(clampedSeconds);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Clamp `value` into the inclusive range `[lo, hi]`. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
