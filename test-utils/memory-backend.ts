/**
 * An in-memory multiplayer backend for tests. Connections made through
 * MemoryAdapters that share one MemoryHub form one group, and every jsPsych
 * instance connected to the hub runs the real jsPsych multiplayer session, so
 * tests see the core's actual behavior: frozen snapshots, read-your-writes,
 * coalesced sends, and presence.
 *
 * Test-only; not part of any published package.
 */

import {
  AdapterConnectOptions,
  ConnectOptions,
  GroupState,
  initJsPsych,
  JsPsych,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";

/** A participant's data as the session pushes it: bookkeeping plus the session and trial scopes. */
export interface WireSlot {
  $mp: { v: number; instance: string; epoch: number; left?: string[] };
  session?: Record<string, unknown>;
  scopes: Record<string, Record<string, unknown>>;
}

export class MemoryHub {
  /** Every connection to this hub reports this session ID. */
  sessionId = "memory-session";

  data: Record<string, unknown> = {};
  connections = new Set<MemoryConnection>();

  /** Participants with no jsPsych instance in the test who count as connected. See addPeer(). */
  peers = new Set<string>();

  /** The sealed group's roster, once seal() is called. Null while the group is forming. */
  roster: string[] | null = null;

  /**
   * Seal the group with these members, as a backend that forms groups does.
   * Until then, connections report a forming group of everyone connected.
   */
  seal(members: string[]) {
    this.roster = [...members];
    this.broadcast();
  }

  /** Tell every open connection that something changed. */
  broadcast() {
    for (const connection of [...this.connections]) {
      connection.options.onChange();
    }
  }

  /**
   * Write a participant's data directly, as if a participant with no jsPsych
   * instance in the test had pushed it. `data` goes in the session scope, or in
   * the trial scope named by `scope`. The participant isn't connected, so
   * sessions see them as `away`, like data left over from an earlier member;
   * use addPeer() for a participant who is present. Seeding the ID of a
   * participant who has a session in the test has no visible effect, because
   * that session owns its own data.
   */
  seed(participantId: string, data: Record<string, unknown>, options: { scope?: string } = {}) {
    const previous = this.data[participantId] as WireSlot | undefined;
    const slot: WireSlot = previous ?? { $mp: { v: 1, instance: "seeded", epoch: 1 }, scopes: {} };
    const next: WireSlot =
      options.scope === undefined
        ? { ...slot, session: data }
        : { ...slot, scopes: { ...slot.scopes, [options.scope]: data } };
    this.store(participantId, next as unknown as Record<string, unknown>);
  }

  /** Store a participant's pushed data exactly as given, and broadcast it. */
  store(participantId: string, payload: Record<string, unknown>) {
    this.data = { ...this.data, [participantId]: payload };
    this.broadcast();
  }

  /**
   * Add a connected participant who has no jsPsych instance in the test, and
   * optionally write their slot. removePeer() makes them drop out. Such a peer
   * has no session, so it never writes the bookkeeping a return needs: once
   * removed, it stays away or left. Use join() for a participant who rejoins.
   */
  addPeer(participantId: string, data?: Record<string, unknown>) {
    this.peers.add(participantId);
    if (data) {
      this.seed(participantId, data);
    } else {
      this.broadcast();
    }
  }

  removePeer(participantId: string) {
    this.peers.delete(participantId);
    this.broadcast();
  }

  adapter(participantId: string) {
    return new MemoryAdapter(this, participantId);
  }

  /**
   * A jsPsych instance connected to this hub as `participantId`. Pass
   * `initJsPsych` options (e.g. a display_element) in `jsPsychOptions`.
   */
  async join(
    participantId: string,
    options: { connect?: ConnectOptions; jsPsych?: Parameters<typeof initJsPsych>[0] } = {},
  ) {
    const jsPsych = initJsPsych(options.jsPsych);
    const adapter = this.adapter(participantId);
    await jsPsych.multiplayer.connect(adapter, options.connect);
    return { jsPsych, adapter, connection: adapter.connection! };
  }
}

export class MemoryConnection implements MultiplayerConnection {
  online = true;
  pushes: Record<string, unknown>[] = [];
  disconnectCalls = 0;

  /** Replace to control when and how pushes settle. Call `write(data)` to store the data. */
  pushImpl: (data: Record<string, unknown>) => Promise<void> = async (data) => this.write(data);

  readonly sessionId: string;

  constructor(
    readonly hub: MemoryHub,
    readonly participantId: string,
    readonly options: AdapterConnectOptions,
  ) {
    this.sessionId = hub.sessionId;
  }

  /** Store data on the hub and broadcast it, as a confirmed push does. */
  write(data: Record<string, unknown>) {
    this.hub.store(this.participantId, data);
  }

  getAll() {
    return this.hub.data;
  }

  group(): GroupState {
    const { roster } = this.hub;
    return roster
      ? { size: roster.length, members: roster, sealed: true }
      : { size: null, members: this.connectedParticipants(), sealed: false };
  }

  connectedParticipants() {
    const live = [...this.hub.connections].filter((c) => c.online).map((c) => c.participantId);
    return [...live, ...this.hub.peers];
  }

  push(data: Record<string, unknown>) {
    this.pushes.push(data);
    return this.pushImpl(data);
  }

  async disconnect() {
    this.disconnectCalls++;
    this.hub.connections.delete(this);
    this.hub.broadcast();
  }

  /**
   * Simulate this participant's network dropping or recovering. Like a real
   * adapter, the connection reports its own drop and recovery, which is what
   * lets a participant who comes back from the same page rejoin.
   */
  setOnline(online: boolean) {
    this.online = online;
    this.options.onStatus(online ? "connected" : "reconnecting");
    this.hub.broadcast();
  }
}

export class MemoryAdapter implements MultiplayerAdapter {
  connections: MemoryConnection[] = [];

  constructor(
    readonly hub: MemoryHub,
    readonly participantId: string,
  ) {}

  async connect(options: AdapterConnectOptions) {
    const connection = new MemoryConnection(this.hub, this.participantId, options);
    this.connections.push(connection);
    this.hub.connections.add(connection);
    this.hub.broadcast();
    return connection;
  }

  /** The most recent connection. */
  get connection(): MemoryConnection | undefined {
    return this.connections[this.connections.length - 1];
  }
}

/**
 * A participant's data in one scope as stored on the backend: the session
 * scope by default, or the trial scope named by `scope`. Use it when asserting
 * on hub.data or pushes.
 */
export function scopeData(slot: unknown, scope?: string): Record<string, unknown> | undefined {
  const wire = slot as WireSlot | undefined;
  return scope === undefined ? wire?.session : wire?.scopes?.[scope];
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending promise callbacks run. Works under fake timers, unlike setTimeout(0). */
export async function flushPromises() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

export type { JsPsych };
