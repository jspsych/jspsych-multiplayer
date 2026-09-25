import { generateId, sessionIdFromUrl, tabId, validateId } from "@jspsych-multiplayer/utils";
import type { FirebaseOptions } from "firebase/app";
import type { Database } from "firebase/database";
import type {
  AdapterConnectOptions,
  GroupState,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";

import { DbNode, FirebaseBackend, TransactionValue, Unsubscribe } from "./firebase-backend";
import { createRealBackend } from "./real-backend";

const ADAPTER_NAME = "FirebaseAdapter";
const DEFAULT_NAMESPACE = "mp-sessions";

/** Prefix of the sessionStorage keys that keep this tab's participant id and matchmaking group. */
const STORAGE_PREFIX = "jspsych-multiplayer-firebase";

/** The value written to a presence node. Only its existence matters. */
const PRESENT = "1";

/** How many times connect() looks for a group with room before giving up. */
const MAX_CLAIM_ATTEMPTS = 50;

/** How long connect() waits before looking again when the filling group is full but not yet sealed. */
const FULL_GROUP_RETRY_MS = 250;

/** How many times sealGroup() retries when the seats change while it seals. */
const MAX_SEAL_ATTEMPTS = 5;

export interface FirebaseAdapterOptions {
  /** A Firebase app config object (the adapter initializes + owns a dedicated app per connection). */
  firebaseConfig?: FirebaseOptions;
  /** An already-initialized RTDB `Database` instance (the caller owns the app + auth). */
  database?: Database;

  /**
   * The group's session. All participant slots live under `<namespace>/<sessionId>`. Defaults to
   * the `?mp_session=` URL parameter, or a fresh random id written into the URL so the link can be
   * shared with the other players. Incompatible with `matchmaking`.
   */
  sessionId?: string;
  /**
   * This participant's id. Defaults to an id kept for this browser tab (see `persistParticipant`).
   * Incompatible with `useUidAsParticipantId`.
   */
  participantId?: string;
  /**
   * Keep the default participant id in this tab's sessionStorage, so a reload of the tab comes back
   * as the same participant (in the same matchmaking group), and jsPsych reports it as a restart.
   * With `false`, every page load is a new participant. Ignored when `participantId` is given or
   * `useUidAsParticipantId` is set. Default `true`.
   */
  persistParticipant?: boolean;
  /**
   * Use the anonymous-auth uid as this participant's id. An adapter that owns its Firebase app
   * keeps the uid per tab, so this also survives a reload. Incompatible with a supplied
   * `participantId`. Default `false`.
   */
  useUidAsParticipantId?: boolean;
  /**
   * Register a `<namespace>-memberships/<uid> = sessionId` record during `connect()`, before the
   * session listener attaches. The recommended rules make that record first-write-wins and require
   * it for every read and write of the session, which locks each anonymous identity to the one
   * session it first joined. The quick-start rules allow the record too, so the default works with
   * both rule sets. Set `false` only with custom rules that have no memberships node. Default `true`.
   */
  sessionBinding?: boolean;

  /**
   * Put participants who open the same link into groups as they arrive, instead of grouping them
   * by `?mp_session=` link. Each arriving participant takes a place in the group that is filling,
   * or starts a new one; the group is sealed when its last place is taken. Incompatible with
   * `sessionId`.
   */
  matchmaking?: MatchmakingOptions;

  /** Names the adapter's RTDB nodes (see the README's rules). Defaults to `"mp-sessions"`. */
  namespace?: string;

  /** Inject a `FirebaseBackend` (for tests). Defaults to the real `firebase/*` implementation. */
  backend?: FirebaseBackend;
}

export interface MatchmakingOptions {
  /**
   * Names the lobby. Everyone who connects with the same lobby is grouped together, so use one
   * lobby per study (or per condition, to group each condition separately).
   */
  lobby: string;
  /** How many participants each group holds. The group is sealed once it has this many. */
  groupSize: number;
}

/** Options from earlier versions, and what replaced them. */
const REMOVED_OPTIONS: Record<string, string> = {
  pathPrefix: "it was renamed to `namespace`",
  connectTimeoutMs:
    "pass `connectTimeout` to jsPsych.multiplayer.connect() instead, which covers the whole connection",
};

/**
 * A Firebase Realtime Database multiplayer adapter: real cross-device multiplayer with essentially no
 * backend to write or host. Sits between `adapter-multiplayer-local` (same-browser dev/demo) and
 * `adapter-multiplayer-jatos` (self-hosted research server).
 *
 *   const jsPsych = initJsPsych();
 *   await jsPsych.multiplayer.connect(new FirebaseAdapter({ firebaseConfig }));
 *   await jsPsych.run(timeline);
 *
 * The adapter holds configuration only. Each `connect()` opens a new connection with its own
 * Firebase app (or the injected database), listeners, and mirrors, so reconnecting with the same
 * adapter object never shares state with an earlier connection.
 *
 * @author Hannah Tsukamoto
 */
export default class FirebaseAdapter implements MultiplayerAdapter {
  private readonly config: ConnectionConfig;

  constructor(options: FirebaseAdapterOptions = {}) {
    for (const [name, replacement] of Object.entries(REMOVED_OPTIONS)) {
      if (name in options) {
        throw new Error(`${ADAPTER_NAME}: the \`${name}\` option was removed; ${replacement}.`);
      }
    }
    if (options.useUidAsParticipantId && options.participantId !== undefined) {
      throw new Error(
        `${ADAPTER_NAME}: \`useUidAsParticipantId\` is incompatible with a supplied ` +
          "`participantId` — the uid becomes the id in that mode. Pass one or the other, not both.",
      );
    }

    const { matchmaking } = options;
    if (matchmaking) {
      if (options.sessionId !== undefined) {
        throw new Error(
          `${ADAPTER_NAME}: \`matchmaking\` assigns each participant's session, so it can't be ` +
            "combined with `sessionId`.",
        );
      }
      validateId(ADAPTER_NAME, "matchmaking.lobby", matchmaking.lobby);
      if (!Number.isInteger(matchmaking.groupSize) || matchmaking.groupSize < 1) {
        throw new Error(
          `${ADAPTER_NAME}: matchmaking.groupSize must be a positive integer (got ${matchmaking.groupSize}).`,
        );
      }
    }

    const namespace = validateId(ADAPTER_NAME, "namespace", options.namespace ?? DEFAULT_NAMESPACE);
    const persist = options.persistParticipant ?? true;
    // With matchmaking, connect() gets the session from the lobby instead
    const sessionId = matchmaking
      ? null
      : validateId(ADAPTER_NAME, "sessionId", options.sessionId ?? sessionIdFromUrl());
    // Resolved once, so every connection made with this adapter reuses the same id. In uid mode the
    // id comes from sign-in instead.
    let participantId: string | null = null;
    if (!options.useUidAsParticipantId) {
      participantId = validateId(
        ADAPTER_NAME,
        "participantId",
        options.participantId ??
          (persist ? tabId(`${STORAGE_PREFIX}:${namespace}:participant`) : generateId()),
      );
    }

    const injected = options.backend;
    this.config = {
      sessionId,
      matchmaking: matchmaking
        ? { lobby: matchmaking.lobby, groupSize: matchmaking.groupSize }
        : null,
      namespace,
      participantId,
      sessionBinding: options.sessionBinding ?? true,
      groupStorageKey:
        matchmaking && persist ? `${STORAGE_PREFIX}:${namespace}:lobby:${matchmaking.lobby}` : null,
      // Build the real backend per connection (not at construction) so each connection gets a fresh
      // app — goOffline() tears the old one down. Unit tests inject a fake and never reach this
      // path, so the firebase SDK is never loaded under test.
      backendFactory: injected
        ? () => Promise.resolve(injected)
        : () =>
            createRealBackend({
              firebaseConfig: options.firebaseConfig,
              database: options.database,
            }),
    };
  }

  async connect(options: AdapterConnectOptions): Promise<MultiplayerConnection> {
    const connection = new FirebaseConnection(this.config, options);
    try {
      await connection.open();
    } catch (err) {
      // A failed connect() hands the caller nothing to disconnect, so release everything here
      await connection.disconnect();
      throw err;
    }
    return connection;
  }
}

interface ConnectionConfig {
  /** Null with matchmaking, where connect() gets it from the lobby. */
  sessionId: string | null;
  matchmaking: MatchmakingOptions | null;
  namespace: string;
  /** Null in uid-as-key mode, where the id is the auth uid. */
  participantId: string | null;
  sessionBinding: boolean;
  /** Where this tab remembers its matchmaking group, or null when it doesn't. */
  groupStorageKey: string | null;
  backendFactory: () => Promise<FirebaseBackend>;
}

type OwnStatus = "connected" | "reconnecting" | "closed";

/** A place in a matchmaking group: who holds it (auth uid) and as which participant. */
interface Seat {
  uid: string;
  id: string;
}

/** A matchmaking group node, parsed. `roster` is the sealed roster, or null while it fills. */
interface GroupNode {
  seats: Map<number, Seat>;
  roster: Map<number, Seat> | null;
}

const EMPTY_GROUP: GroupNode = { seats: new Map(), roster: null };

/**
 * One open connection to a Firebase session. The core's reads are synchronous but every Firebase read
 * is async, so the connection keeps in-memory mirrors of the session node (everyone's data) and the
 * presence node (who is connected), each kept live by one `onValue` listener.
 */
class FirebaseConnection implements MultiplayerConnection {
  participantId = "";
  sessionId = "";

  /** Present only with matchmaking, since only then does the adapter form groups. */
  group?: () => GroupState;
  sealGroup?: () => Promise<void>;

  /** The matchmaking group node, mirrored. */
  private groupNode: GroupNode = EMPTY_GROUP;
  /** Our seat in a group that is still filling, so disconnect() knows to free it. */
  private seat: number | null = null;
  /** Whether this connection has handled the seal (cancelled its seat's removal). */
  private sealHandled = false;
  /** A seal in progress, so overlapping calls share it. */
  private sealing: Promise<void> | null = null;

  private backend: FirebaseBackend | null = null;
  private uid = "";
  private mirror: Record<string, unknown> = {};
  private present = new Set<string>();

  /** Set by disconnect(); after it, no callback reaches the core. */
  private closed = false;
  /** Whether open() has finished; before then, failures reject connect() instead. */
  private opened = false;
  /** A listener failure that arrived after the first snapshots but before open() finished. */
  private openError: Error | null = null;
  /** Whether our presence node may exist, so disconnect() knows to remove it. */
  private presenceWritten = false;
  /** Whether `.info/connected` has been true at least once since connecting. */
  private hadFirstConnection = false;
  private status: OwnStatus = "connected";
  /** A restore of our presence (and seat) in progress, so overlapping triggers share it. */
  private restoring: Promise<boolean> | null = null;

  private readonly unsubscribes: Unsubscribe[] = [];

  constructor(
    private readonly config: ConnectionConfig,
    private readonly options: AdapterConnectOptions,
  ) {
    this.sessionId = config.sessionId ?? "";
    const { matchmaking } = config;
    if (matchmaking) {
      this.group = () => ({
        size: matchmaking.groupSize,
        ...readGroup(this.groupNode, matchmaking.groupSize),
      });
      this.sealGroup = () => this.seal();
    }
  }

  /** Connect, sign in, find the group, bind the session, load the nodes, and announce presence. */
  async open(): Promise<void> {
    const check = () => {
      if (this.openError) throw this.openError;
      this.throwIfCancelled();
    };
    check();

    const backend = await this.config.backendFactory();
    this.backend = backend;
    check();

    const uid = await backend.signIn();
    check();
    this.uid = uid;
    this.participantId =
      this.config.participantId ?? validateId(ADAPTER_NAME, "participantId (auth uid)", uid);

    if (this.config.matchmaking) {
      this.sessionId = await this.claimPlace(backend);
      check();
    }

    // Session binding: claim (or re-assert) this uid's membership BEFORE the session listener
    // attaches — under the recommended rules, reading the session already requires a matching
    // membership record. The record is first-write-wins server-side, so re-asserting the SAME
    // session on a reload succeeds and claiming a DIFFERENT one is denied. Never removed on
    // disconnect: the binding IS the security property.
    if (this.config.sessionBinding) {
      try {
        await backend.set(this.membershipPath(), this.sessionId);
      } catch (err) {
        throw new Error(
          `${ADAPTER_NAME}: registering session membership failed — either this client's anonymous ` +
            `identity is already bound to a different session (joining "${this.sessionId}" from a ` +
            "tab or browser profile that first joined another session; use a fresh tab or clear " +
            "site data), or the security rules are missing the memberships node (see the README's " +
            `rules). Underlying error: ${errorMessage(err)}`,
        );
      }
      check();
    }

    // Slot claim: record which uid owns this participant id in this session. The recommended
    // rules make it first-write-wins and require it for writes to the participant's data slot and
    // presence node, so nobody else can write them.
    try {
      await backend.set(this.ownerPath(), uid);
    } catch (err) {
      throw new Error(
        `${ADAPTER_NAME}: claiming participant "${this.participantId}" in session ` +
          `"${this.sessionId}" failed — either another browser identity already claimed this ` +
          "participant id (a supplied id reused on another device, or a reload that lost its " +
          "anonymous sign-in), or the security rules are missing the owners node (see the " +
          `README's rules). Underlying error: ${errorMessage(err)}`,
      );
    }
    check();

    await this.loadNodes(backend);
    check();

    // Arm the server-side removal before writing, so a drop between the two can't leave a ghost
    this.presenceWritten = true;
    await backend.onDisconnectRemove(this.presencePath());
    check();
    await backend.set(this.presencePath(), PRESENT);
    check();

    this.unsubscribes.push(
      backend.onConnectedChange((isConnected) => {
        void this.handleConnectionChange(isConnected);
      }),
    );
    check();
    this.opened = true;
    if (this.config.matchmaking) this.handleGroupChange();
  }

  /**
   * Attach the session, presence, and (with matchmaking) group listeners, and wait until each has
   * delivered a first snapshot, so the core never reads an empty mirror. A rules denial or an abort
   * settles the wait; connect()'s cleanup then removes whatever listeners were attached. The core's
   * `connectTimeout` aborts the signal when connecting takes too long.
   */
  private loadNodes(backend: FirebaseBackend): Promise<void> {
    const { signal } = this.options;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let sessionLoaded = false;
      let presenceLoaded = false;
      let groupLoaded = !this.config.matchmaking;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const fail = (error: Error) => finish(() => reject(error));
      const onAbort = () => fail(cancelledError());
      const maybeResolve = () => {
        if (sessionLoaded && presenceLoaded && groupLoaded) finish(resolve);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // A cancelled listener means we can no longer see the session. Before the first snapshots it
      // rejects connect(); once connected, it closes the connection.
      const onListenerError = (node: string) => (error: Error) => {
        const wrapped = new Error(
          `${ADAPTER_NAME}: the ${node} listener was cancelled — this is almost always a ` +
            `security-rules denial. Grant read access to this session's ${node} node (see the ` +
            `README's rules). Underlying error: ${error.message}`,
        );
        if (!settled) {
          fail(wrapped);
        } else if (!this.opened) {
          this.openError = wrapped;
        } else {
          console.error(wrapped);
          this.reportStatus("closed");
        }
      };

      this.unsubscribes.push(
        backend.onValue(
          this.sessionPath(),
          (value) => {
            if (this.closed) return;
            this.mirror = decodeSession(value);
            sessionLoaded = true;
            maybeResolve();
            this.options.onChange();
          },
          onListenerError("session"),
        ),
      );
      if (settled) return; // a synchronous denial already rejected
      this.unsubscribes.push(
        backend.onValue(
          this.presenceRootPath(),
          (value) => {
            if (this.closed) return;
            this.present = new Set(childKeys(value));
            presenceLoaded = true;
            maybeResolve();
            this.options.onChange();
            this.checkOwnPresence();
          },
          onListenerError("presence"),
        ),
      );
      if (settled || !this.config.matchmaking) return;
      this.unsubscribes.push(
        backend.onValue(
          this.groupPath(),
          (value) => {
            if (this.closed) return;
            this.groupNode = parseGroup(value);
            groupLoaded = true;
            maybeResolve();
            this.options.onChange();
            this.handleGroupChange();
          },
          onListenerError("group"),
        ),
      );
    });
  }

  // ---------------------------------------------------------------- matchmaking

  /**
   * Get a place in a group and return its session id. A participant already bound to a session
   * (session binding), or whose tab remembers a group (`persistParticipant`), goes back to that
   * group. Otherwise the lobby names the group that is filling; once that group is sealed, the
   * lobby moves on to a new group. Seats are taken with transactions, so the server settles who
   * gets the last place.
   */
  private async claimPlace(backend: FirebaseBackend): Promise<string> {
    if (this.config.sessionBinding) {
      const bound = await backend.get(this.membershipPath());
      this.throwIfCancelled();
      if (typeof bound === "string" && bound !== "") {
        if (await this.claimIn(backend, bound)) return this.remember(bound);
        throw new Error(
          `${ADAPTER_NAME}: this participant's group ("${bound}") filled up without them, and ` +
            "the session-locked rules don't let them join another. Open the study in a new tab.",
        );
      }
    }
    const remembered = this.rememberedGroup();
    if (remembered !== null && (await this.claimIn(backend, remembered))) {
      return remembered;
    }

    const lobby = this.lobbyPath();
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      this.throwIfCancelled();
      // Point an empty lobby at a new group; otherwise just read where it points
      const pointer = await backend.transaction(lobby, (current) =>
        typeof current === "string" && current !== "" ? undefined : generateId(),
      );
      const sessionId = pointer.value;
      if (typeof sessionId !== "string") {
        throw new Error(`${ADAPTER_NAME}: the lobby node doesn't hold a session id.`);
      }
      if (await this.claimIn(backend, sessionId)) return this.remember(sessionId);

      const group = parseGroup(await backend.get(this.groupPath(sessionId)));
      if (group.roster) {
        // Sealed: point the lobby at a new group, unless someone already has. The rules only
        // allow moving the lobby off a sealed group.
        await backend
          .transaction(lobby, (current) => (current === sessionId ? generateId() : undefined))
          .catch(() => {});
      } else {
        // Full but not sealed yet: its members seal it in a moment
        await sleep(FULL_GROUP_RETRY_MS, this.options.signal);
      }
    }
    throw new Error(
      `${ADAPTER_NAME}: couldn't find a group with room after ${MAX_CLAIM_ATTEMPTS} tries.`,
    );
  }

  /**
   * Take a seat in the group `sessionId`, or confirm we already have one. Returns false if the
   * group is full, or was sealed without us.
   */
  private async claimIn(backend: FirebaseBackend, sessionId: string): Promise<boolean> {
    const { groupSize } = this.config.matchmaking!;
    const groupPath = this.groupPath(sessionId);
    const node = parseGroup(await backend.get(groupPath));
    this.throwIfCancelled();
    if (node.roster) return this.onRoster(node.roster);

    const own = findSeat(node.seats, this.uid, this.participantId, groupSize);
    if (own !== null) return this.settleSeat(backend, sessionId, own);

    const mine: Seat = { uid: this.uid, id: this.participantId };
    for (let seat = 0; seat < groupSize; seat++) {
      if (node.seats.has(seat)) continue;
      let committed: boolean;
      try {
        ({ committed } = await backend.transaction(`${groupPath}/seats/${seat}`, (current) =>
          current === null ? { ...mine } : undefined,
        ));
      } catch (err) {
        // The rules refuse seats in a sealed group
        const now = parseGroup(await backend.get(groupPath));
        if (now.roster) return this.onRoster(now.roster);
        throw err;
      }
      this.throwIfCancelled();
      if (committed) return this.settleSeat(backend, sessionId, seat);
    }
    return false;
  }

  /**
   * After taking (or finding) our seat: arm its removal, so a drop frees the place while the group
   * fills, and seal the group if that seat was its last free one. The removal is armed after the
   * seat is taken because the rules only let a client remove a seat it holds; a tab that closes in
   * between leaves a ghost seat, which the group then seals with as a dropout.
   */
  private async settleSeat(
    backend: FirebaseBackend,
    sessionId: string,
    seat: number,
  ): Promise<boolean> {
    const { groupSize } = this.config.matchmaking!;
    const seatPath = `${this.groupPath(sessionId)}/seats/${seat}`;
    const armed = await backend.onDisconnectRemove(seatPath).then(
      () => true,
      () => false,
    );
    const node = parseGroup(await backend.get(this.groupPath(sessionId)));
    if (node.roster) {
      // Sealed meanwhile. Our seat no longer matters: the roster is final.
      if (armed) await backend.cancelOnDisconnect(seatPath).catch(() => {});
      const onRoster = this.onRoster(node.roster);
      if (!onRoster) await backend.remove(seatPath).catch(() => {});
      return onRoster;
    }
    if (!armed) {
      throw new Error(`${ADAPTER_NAME}: couldn't arm the removal of this participant's seat.`);
    }
    this.seat = seat;
    if (occupied(node.seats, groupSize) >= groupSize) {
      await this.sealIn(backend, sessionId);
    }
    return true;
  }

  /** Whether we're on a sealed roster. A sealed roster needs no seat of ours to free. */
  private onRoster(roster: Map<number, Seat>): boolean {
    this.seat = null;
    return [...roster.values()].some((seat) => seat.id === this.participantId);
  }

  /** Seal the group with the members it has now. Sealing a sealed group succeeds. */
  private seal(): Promise<void> {
    const backend = this.backend;
    if (this.closed || !backend) {
      return Promise.reject(
        new Error(`${ADAPTER_NAME}: sealGroup() called on a closed connection.`),
      );
    }
    this.sealing ??= this.sealIn(backend, this.sessionId).finally(() => {
      this.sealing = null;
    });
    return this.sealing;
  }

  /**
   * Write the sealed roster: a copy of the seats, naming the seat of the member who sealed. The
   * rules accept it only from a member, only once, and only when each entry matches the seat as it
   * is on the server, so a seat that changes meanwhile makes us read again and retry.
   */
  private async sealIn(backend: FirebaseBackend, sessionId: string): Promise<void> {
    const { groupSize } = this.config.matchmaking!;
    const groupPath = this.groupPath(sessionId);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_SEAL_ATTEMPTS; attempt++) {
      const node = parseGroup(await backend.get(groupPath));
      if (node.roster) break;
      const own = findSeat(node.seats, this.uid, this.participantId, groupSize);
      if (own === null) {
        throw new Error(`${ADAPTER_NAME}: only a member of the group can seal it.`);
      }
      const seats: DbNode = {};
      for (const [index, seat] of node.seats) {
        if (index < groupSize) seats[String(index)] = { uid: seat.uid, id: seat.id };
      }
      try {
        await backend.transaction(`${groupPath}/sealed`, (current) =>
          current === null ? { by: String(own), seats } : undefined,
        );
      } catch (err) {
        lastError = err;
      }
    }
    const node = parseGroup(await backend.get(groupPath));
    if (!node.roster) {
      throw new Error(
        `${ADAPTER_NAME}: the group could not be sealed.` +
          (lastError ? ` Underlying error: ${errorMessage(lastError)}` : ""),
      );
    }
    if (sessionId === this.sessionId) await this.handleSeal(backend, node.roster);
  }

  /**
   * React to a new group snapshot: once sealed, stop our seat's armed removal (the roster is final)
   * and close if we're not on it; while filling, seal a full group whose last member didn't.
   */
  private handleGroupChange(): void {
    const backend = this.backend;
    if (!this.opened || this.closed || !backend) return;
    const { groupSize } = this.config.matchmaking!;
    const { roster, seats } = this.groupNode;
    if (roster) {
      void this.handleSeal(backend, roster);
    } else if (this.seat !== null && occupied(seats, groupSize) >= groupSize) {
      void this.seal().catch((err) => {
        console.error(`${ADAPTER_NAME}: failed to seal the full group`, err);
      });
    }
  }

  private async handleSeal(backend: FirebaseBackend, roster: Map<number, Seat>): Promise<void> {
    if (this.sealHandled) return;
    this.sealHandled = true;
    const seat = this.seat;
    const onRoster = this.onRoster(roster);
    if (seat !== null) {
      await backend.cancelOnDisconnect(this.seatPath(seat)).catch(() => {});
    }
    if (!onRoster && this.opened) {
      console.error(`${ADAPTER_NAME}: this participant's group was sealed without them.`);
      this.reportStatus("closed");
    }
  }

  /** The group this tab remembers joining in this lobby, if any. */
  private rememberedGroup(): string | null {
    const key = this.config.groupStorageKey;
    if (key === null) return null;
    try {
      const stored = sessionStorage.getItem(key);
      return stored ? validateId(ADAPTER_NAME, "stored session", stored) : null;
    } catch {
      return null;
    }
  }

  private remember(sessionId: string): string {
    const key = this.config.groupStorageKey;
    if (key !== null) {
      try {
        sessionStorage.setItem(key, sessionId);
      } catch {
        // Without sessionStorage a reload joins whichever group is filling
      }
    }
    return sessionId;
  }

  private throwIfCancelled() {
    if (this.options.signal.aborted || this.closed) throw cancelledError();
  }

  // ---------------------------------------------------------------- the connection

  getAll(): Record<string, unknown> {
    // The core copies what this returns, so the mirror can be handed over directly
    return this.mirror;
  }

  connectedParticipants(): string[] {
    return [...this.present];
  }

  async push(data: Record<string, unknown>): Promise<void> {
    const backend = this.backend;
    if (this.closed || !backend) {
      throw new Error(`${ADAPTER_NAME}: push() called on a closed connection.`);
    }
    // Store JSON-encoded so the payload survives RTDB's JSON coercion — raw, RTDB prunes empty
    // arrays/objects and coerces arrays to objects; the string round-trips those unchanged. The
    // mirror updates from the echoed onValue (RTDB fires the local listener optimistically).
    await backend.set(this.slotPath(), JSON.stringify(data));
  }

  /**
   * Close the connection: stop all callbacks, withdraw our presence, and release an owned app. The
   * data slot stays, so peers keep this participant's last data; presence is what tells them the
   * participant is gone. Safe to call more than once, and on a half-open connection.
   */
  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();

    const backend = this.backend;
    this.backend = null;
    if (!backend) return;

    if (this.seat !== null && !this.groupNode.roster) {
      // Free our place in a group that is still filling. A sealed roster keeps us on it.
      const seatPath = this.seatPath(this.seat);
      try {
        await backend.remove(seatPath);
        await backend.cancelOnDisconnect(seatPath);
      } catch {
        // Best-effort: the armed onDisconnect is the backstop
      }
    }
    if (this.presenceWritten) {
      try {
        await backend.remove(this.presencePath());
      } catch {
        // Best-effort: the armed onDisconnect is the backstop
      }
      try {
        // Cancel so the armed removal can't fire later against a reused app
        await backend.cancelOnDisconnect(this.presencePath());
      } catch {
        // Best-effort
      }
    }
    // goOffline() is app-global — only safe when the backend owns the app (never on an injected one)
    if (backend.ownsApp) backend.goOffline();
  }

  /**
   * `.info/connected` handler. The first `true` is the initial connection, which open() already
   * handled. A later `false` means our channel dropped; the server then fires our armed
   * onDisconnects. The next `true` is the recovery: restore what the server removed, then report
   * `connected`.
   */
  private async handleConnectionChange(isConnected: boolean): Promise<void> {
    if (this.closed) return;
    if (!isConnected) {
      if (this.hadFirstConnection) this.reportStatus("reconnecting");
      return;
    }
    if (!this.hadFirstConnection) {
      this.hadFirstConnection = true;
      return;
    }
    if (await this.restoreOnce()) this.reportStatus("connected");
  }

  /**
   * Our presence node vanished while our channel looked fine, e.g. the server timed the channel out
   * without the client noticing. The others saw us leave, so restore it and tell the core, which
   * re-announces this participant.
   */
  private checkOwnPresence(): void {
    if (!this.opened || this.closed || this.status !== "connected") return;
    if (this.present.has(this.participantId)) return;
    void this.restoreOnce().then((kept) => {
      if (kept && !this.closed && this.status === "connected") this.options.onResumed();
    });
  }

  private restoreOnce(): Promise<boolean> {
    this.restoring ??= this.restore().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  /**
   * Re-arm and re-write our presence (re-arming FIRST: writing before arming leaves a window where
   * another drop orphans it), and with matchmaking take back our seat. Resolves false when the
   * connection can't continue.
   */
  private async restore(): Promise<boolean> {
    const backend = this.backend;
    if (!backend || this.closed) return false;
    try {
      await backend.onDisconnectRemove(this.presencePath());
      if (this.closed) return false;
      await backend.set(this.presencePath(), PRESENT);
      if (this.closed) return false;
    } catch (err) {
      console.error(`${ADAPTER_NAME}: failed to restore presence after reconnecting`, err);
    }
    if (this.config.matchmaking) {
      // While the group was filling, the server removed our seat when we dropped: take one back.
      // If it was sealed meanwhile, we're in only if we made the roster.
      const { roster } = this.groupNode;
      let kept = roster ? this.onRoster(roster) : false;
      if (!roster) {
        try {
          kept = await this.claimIn(backend, this.sessionId);
        } catch (err) {
          console.error(`${ADAPTER_NAME}: failed to take back our place after reconnecting`, err);
        }
      }
      if (this.closed) return false;
      if (!kept) {
        console.error(
          `${ADAPTER_NAME}: this participant's group filled up while they were disconnected.`,
        );
        this.reportStatus("closed");
        return false;
      }
    }
    return true;
  }

  private reportStatus(status: OwnStatus): void {
    if (this.closed || this.status === "closed" || this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  // ---------------------------------------------------------------- paths

  private sessionPath(): string {
    return `${this.config.namespace}/${this.sessionId}`;
  }

  private slotPath(): string {
    return `${this.sessionPath()}/${this.participantId}`;
  }

  /**
   * The presence node: a SIBLING namespace of the sessions node, so the per-session slot rules never
   * govern it and it never shows up as a slot. Holds one child per connected participant, removed by
   * the server when that participant's connection drops.
   */
  private presenceRootPath(): string {
    return `${this.config.namespace}-presence/${this.sessionId}`;
  }

  private presencePath(): string {
    return `${this.presenceRootPath()}/${this.participantId}`;
  }

  /** The slot claim: which auth uid owns this participant id in this session. */
  private ownerPath(): string {
    return `${this.config.namespace}-owners/${this.sessionId}/${this.participantId}`;
  }

  /**
   * The membership record's path, keyed by auth uid. The stored value is the raw sessionId string
   * — the rules compare it with `=== $session`, so it must not be JSON-quoted.
   */
  private membershipPath(): string {
    return `${this.config.namespace}-memberships/${this.uid}`;
  }

  /** The lobby's pointer to the group that is filling, holding that group's session id. */
  private lobbyPath(): string {
    return `${this.config.namespace}-lobby/${this.config.matchmaking!.lobby}`;
  }

  /** A matchmaking group node: `seats/<n>` per place, plus `sealed` once the roster is final. */
  private groupPath(sessionId = this.sessionId): string {
    return `${this.config.namespace}-groups/${sessionId}`;
  }

  private seatPath(seat: number): string {
    return `${this.groupPath()}/seats/${seat}`;
  }
}

function cancelledError(): Error {
  return new Error(`${ADAPTER_NAME}: connect() was cancelled.`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve after `ms`, or reject at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelledError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The keys of a node's children. RTDB returns a node with numeric keys as an array. */
function childKeys(value: TransactionValue): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.keys(value).filter((key) => (value as DbNode)[key] != null);
}

/** Parse a map of seats. Anything that isn't a seat is skipped. */
function parseSeats(value: unknown): Map<number, Seat> {
  const seats = new Map<number, Seat>();
  if (value === null || typeof value !== "object") return seats;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || raw === null || typeof raw !== "object") continue;
    const { uid, id } = raw as Record<string, unknown>;
    if (typeof uid === "string" && typeof id === "string") seats.set(index, { uid, id });
  }
  return seats;
}

/** Parse a matchmaking group node. Any `sealed` child means sealed, even a malformed one. */
function parseGroup(value: TransactionValue): GroupNode {
  if (value === null || typeof value !== "object") return EMPTY_GROUP;
  const sealed = value.sealed;
  return {
    seats: parseSeats(value.seats),
    roster:
      sealed === undefined || sealed === null
        ? null
        : parseSeats(typeof sealed === "object" ? sealed.seats : null),
  };
}

/** How many of the group's seats are taken. */
function occupied(seats: Map<number, Seat>, groupSize: number): number {
  return [...seats.keys()].filter((index) => index < groupSize).length;
}

/** The seat held by this uid as this participant, or null. */
function findSeat(
  seats: Map<number, Seat>,
  uid: string,
  id: string,
  groupSize: number,
): number | null {
  for (const [index, seat] of seats) {
    if (index < groupSize && seat.uid === uid && seat.id === id) return index;
  }
  return null;
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** The members of a group node and whether it is sealed. A sealed group's members are its roster. */
function readGroup(node: GroupNode, groupSize: number): { members: string[]; sealed: boolean } {
  if (node.roster) {
    return { members: sortedIds([...node.roster.values()].map((seat) => seat.id)), sealed: true };
  }
  const members = [...node.seats].filter(([index]) => index < groupSize).map(([, s]) => s.id);
  return { members: sortedIds(members), sealed: false };
}

/**
 * Decode a session snapshot: each slot is the core's payload, stored as a JSON string, and is
 * handed back exactly as it was pushed.
 */
function decodeSession(value: TransactionValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== "object") return out;
  for (const [id, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue; // defensive: our writes are always encoded strings
    try {
      out[id] = JSON.parse(raw);
    } catch {
      // Skip a slot that isn't valid JSON rather than failing the whole snapshot.
    }
  }
  return out;
}
