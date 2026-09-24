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
  GroupSessionData,
  initJsPsych,
  JsPsych,
  MultiplayerAdapter,
  MultiplayerConnection,
} from "jspsych";

export class MemoryHub {
  data: GroupSessionData = {};
  connections = new Set<MemoryConnection>();

  /** Participants with no jsPsych instance in the test who count as connected. See addPeer(). */
  peers = new Set<string>();

  /** Tell every open connection that something changed. */
  broadcast() {
    for (const connection of [...this.connections]) {
      connection.options.onChange();
    }
  }

  /**
   * Write a participant's slot directly, as if a participant with no jsPsych
   * instance in the test had pushed it. The participant isn't connected, so
   * sessions see them as `away`, like a slot left over from an earlier member;
   * use addPeer() for a participant who is present. Seeding the ID of a
   * participant who has a session in the test has no visible effect, because
   * that session owns its own slot.
   */
  seed(participantId: string, data: Record<string, unknown>) {
    this.data = { ...this.data, [participantId]: data };
    this.broadcast();
  }

  /**
   * Add a connected participant who has no jsPsych instance in the test, and
   * optionally write their slot. removePeer() makes them drop out.
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

  constructor(
    readonly hub: MemoryHub,
    readonly participantId: string,
    readonly options: AdapterConnectOptions,
  ) {}

  /** Store data on the hub and broadcast it, as a confirmed push does. */
  write(data: Record<string, unknown>) {
    this.hub.seed(this.participantId, data);
  }

  getAll() {
    return this.hub.data;
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

  /** Simulate this participant's network dropping or recovering, as the others see it. */
  setOnline(online: boolean) {
    this.online = online;
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
