import type {
  GroupSessionData,
  JsPsych,
  MultiplayerError,
  MultiplayerErrorCode,
  PresenceData,
} from "jspsych";

/** jsPsych's multiplayer module: `jsPsych.multiplayer`. */
export type Multiplayer = JsPsych["multiplayer"];

// ------------------------------------------------------------------ for plugins

/**
 * Return `jsPsych.multiplayer`, or throw a clear error, naming `packageName`, on a jsPsych build
 * that doesn't have the multiplayer API.
 */
export function getMultiplayer(jsPsych: JsPsych, packageName: string): Multiplayer {
  const multiplayer = (jsPsych as Partial<Pick<JsPsych, "multiplayer">>).multiplayer;
  if (!multiplayer) {
    throw new Error(
      `${packageName}: this plugin needs a version of jsPsych with the multiplayer API ` +
        "(jsPsych.multiplayer). See https://multiplayer.jspsych.org.",
    );
  }
  return multiplayer;
}

/**
 * True when `e` is an error from the multiplayer API, with the given code if one is passed.
 * Matches on `error.name`, not instanceof, which fails when a page loads two copies of jsPsych.
 */
export function isMultiplayerError(e: unknown, code?: MultiplayerErrorCode): e is MultiplayerError {
  return (
    e instanceof Error &&
    e.name === "MultiplayerError" &&
    (code === undefined || (e as MultiplayerError).code === code)
  );
}

/**
 * How a multiplayer trial ended, as plugins record it in the `multiplayer_outcome` data field.
 * - `completed`: the trial finished normally.
 * - `timeout`: the trial's timeout ran out while it waited for the group.
 * - `participant_left`: a participant the trial depended on left; `left_participant` says who.
 * - `connection_lost`: this participant's connection was lost for good.
 * - `cancelled`: the experiment ended while the trial waited.
 */
export type MultiplayerOutcome =
  "completed" | "timeout" | "participant_left" | "connection_lost" | "cancelled";

/**
 * The outcome a trial records when a multiplayer wait fails with `e`, or null when `e` isn't a
 * failure the trial should report as an outcome, e.g. a bug in a condition; rethrow those.
 */
export function outcomeOf(e: unknown): Exclude<MultiplayerOutcome, "completed"> | null {
  if (!isMultiplayerError(e)) return null;
  switch (e.code) {
    case "timeout":
    case "participant_left":
    case "connection_lost":
    case "cancelled":
      return e.code;
    default:
      return null;
  }
}

/**
 * A plugin's `timeout` parameter as milliseconds, or null for no limit. Plugins treat null, 0,
 * and negative values as "no limit", while `jsPsych.multiplayer.wait()` only accepts null for
 * that, so pass the parameter through this first.
 */
export function pluginTimeout(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/** The IDs in `ids` whose participants haven't left. */
export function withoutLeft(ids: readonly string[], presence: PresenceData): string[] {
  return ids.filter((id) => presence[id] !== "left");
}

/**
 * The other participants this participant waits on. In a sealed group (see
 * `jsPsych.multiplayer.group()`), that is the rest of the roster, except members who have already
 * left: a member who is only `away` may come back, so a wait still depends on them. Otherwise it
 * is the others who are connected right now. Participants who are only `away` are left out then:
 * data left over from members who left earlier starts out `away` and becomes `left` a few seconds
 * later, which would otherwise end a wait that starts right after joining.
 */
export function remainingParticipants(multiplayer: Multiplayer): string[] {
  const presence = multiplayer.presence();
  const isOther = (id: string) => id !== multiplayer.participantId;
  const group = multiplayer.group();
  if (group.sealed) {
    return withoutLeft(group.members, presence).filter(isOther);
  }
  return Object.keys(presence).filter((id) => isOther(id) && presence[id] === "connected");
}

/**
 * How many members of a sealed group haven't left, counting this participant, or null when the
 * group isn't sealed. Plugins use it as the default number of players.
 */
export function sealedGroupSize(multiplayer: Multiplayer): number | null {
  const group = multiplayer.group();
  return group.sealed ? withoutLeft(group.members, multiplayer.presence()).length : null;
}

export interface WaitForAllOptions {
  /**
   * How many participants, counting this one, must have written the key. Defaults to the
   * members of a sealed group who haven't left; without a sealed group it must be given.
   */
  count?: number | null;

  /**
   * Participants the wait depends on: if one of them leaves first, the wait rejects with a
   * `participant_left` error. Defaults to remainingParticipants(). Pass [] to ignore departures.
   */
  participants?: string[] | null;

  /** Maximum time to wait, in ms. Anything but a positive number means no limit. */
  timeout?: number | null;

  /** Aborting this signal cancels the wait. */
  signal?: AbortSignal;
}

/**
 * The barrier most turn-based paradigms reduce to: resolve once `count` participants, counting
 * this one, have a value under `key` in the current trial's data. Participants who have left
 * don't count. Write your own value first, e.g. with `multiplayer.update({ [key]: value })`.
 *
 * The trial's own scope keeps each trial's data apart, so the same key can be used in every
 * trial without an earlier trial's values satisfying a later wait.
 */
export async function waitForAll(
  multiplayer: Multiplayer,
  key: string,
  options: WaitForAllOptions = {},
): Promise<GroupSessionData> {
  const count = options.count ?? sealedGroupSize(multiplayer);
  if (count === null || !Number.isInteger(count) || count < 1) {
    throw new TypeError(
      "waitForAll: pass a positive whole-number `count`, or seal the group so it can be " +
        "worked out from the group's members.",
    );
  }
  return multiplayer.wait(
    (data, presence) =>
      Object.keys(data).filter((id) => data[id][key] !== undefined && presence[id] !== "left")
        .length >= count,
    {
      participants: options.participants ?? remainingParticipants(multiplayer),
      timeout: pluginTimeout(options.timeout),
      signal: options.signal,
    },
  );
}

// ------------------------------------------------------------------ for adapters

/** The URL parameter adapters read a group's session ID from by default. */
export const SESSION_PARAM = "mp_session";

/** A random, unguessable ID: a UUID where the browser supports it. */
export function generateId(): string {
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  // Fallback for older or embedded runtimes without crypto.randomUUID
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read the session ID from the page's `?mp_session=` parameter (or `param`). When it is missing,
 * mint one and write it into the URL without reloading, so the link can be copied to the rest of
 * the group.
 */
export function sessionIdFromUrl(param: string = SESSION_PARAM): string {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    return generateId();
  }
  try {
    const url = new URL(window.location.href);
    const existing = url.searchParams.get(param);
    if (existing) return existing;
    const fresh = generateId();
    url.searchParams.set(param, fresh);
    window.history?.replaceState?.(window.history.state, "", url.toString());
    return fresh;
  } catch {
    return generateId();
  }
}

/**
 * An ID that stays the same for this browser tab across reloads, kept in sessionStorage under
 * `storageKey`. A new tab gets a new ID. Falls back to a fresh ID where sessionStorage is
 * unavailable.
 */
export function tabId(storageKey: string): string {
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh = generateId();
    sessionStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    return generateId();
  }
}

/** Characters no ID may contain, so every adapter can use it as a storage key or path segment. */
const UNSAFE_ID_CHARACTERS = /[:/.#$[\]]/;

/**
 * Throw a clear error, prefixed with `adapterName`, unless `value` can be used as an ID by every
 * adapter: a non-empty string without `: / . # $ [ ]`.
 */
export function validateId(adapterName: string, label: string, value: unknown): string {
  if (typeof value !== "string" || value === "" || UNSAFE_ID_CHARACTERS.test(value)) {
    throw new Error(
      `${adapterName}: ${label} must be a non-empty string without any of : / . # $ [ ] ` +
        `(got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}
