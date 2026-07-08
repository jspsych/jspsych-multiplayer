/**
 * Cross-tab change signal. Its only job is to tell *other* tabs "something changed — re-read the
 * store." It deliberately carries **no payload**: the `localStorage` store stays the single source of
 * truth, which sidesteps stale-message-vs-store consistency questions. Neither `BroadcastChannel` nor
 * the `storage` event fires in the tab that performed the write, so a tab's own updates are delivered
 * separately by the adapter (see `LocalAdapter`), not through here.
 *
 * The interface is injectable so tests can supply an in-memory bus that models N tabs without needing
 * a real `BroadcastChannel` (jsdom doesn't provide one).
 */
export interface ChangeSignal {
  /** Notify the other tabs that this tab changed the store. */
  post(): void;
  /** Register a handler fired when another tab signals a change. */
  onChange(handler: () => void): void;
  /** Tear down all listeners/channels. */
  close(): void;
}

/**
 * Default signal: `BroadcastChannel` for the notification plus the `storage` event as a fallback.
 *
 * With per-participant keys the `storage` event already fires in other tabs on every write, so it
 * alone can carry the signal where `BroadcastChannel` is unavailable — `post()` is then a harmless
 * no-op because the `localStorage.setItem` itself triggers the event cross-tab. Where both are
 * present they may both fire; that's fine, the adapter coalesces and the re-read is idempotent.
 */
export function createDefaultSignal(channelName: string, keyPrefix: string): ChangeSignal {
  const handlers = new Set<() => void>();
  const fire = () => {
    for (const h of handlers) h();
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(channelName);
    channel.onmessage = () => fire();
  }

  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
  const onStorage = (event: StorageEvent) => {
    // A clear() reports key === null; otherwise only react to our own keyspace.
    if (event.key === null || event.key.startsWith(keyPrefix)) fire();
  };
  if (hasWindow) window.addEventListener("storage", onStorage);

  return {
    post() {
      // Post an empty ping; the payload is intentionally meaningless.
      if (channel) channel.postMessage(0);
    },
    onChange(handler) {
      handlers.add(handler);
    },
    close() {
      handlers.clear();
      if (channel) {
        channel.onmessage = null;
        channel.close();
        channel = null;
      }
      if (hasWindow) window.removeEventListener("storage", onStorage);
    },
  };
}
