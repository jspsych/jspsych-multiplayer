/**
 * The real `FirebaseBackend`, talking to the Firebase modular SDK. This file is the ONLY one that
 * imports `firebase/*`; the adapter and its unit tests depend on `firebase-backend.ts` (the pure
 * interface) instead, so the whole adapter is unit-tested with zero Firebase credentials and the SDK
 * is only loaded when a real deployment actually constructs this backend.
 */

import { FirebaseApp, FirebaseOptions, deleteApp, initializeApp } from "firebase/app";
import {
  Auth,
  browserSessionPersistence,
  getAuth,
  setPersistence,
  signInAnonymously,
} from "firebase/auth";
import {
  Database,
  getDatabase,
  goOffline,
  off,
  onDisconnect,
  onValue,
  ref,
  remove,
  set,
} from "firebase/database";

import { FirebaseBackend, RawSessionSnapshot, Unsubscribe } from "./firebase-backend";

/**
 * Build a real backend. Exactly one of `firebaseConfig` / `database` is used:
 * - `database` given → we do NOT own the app (skip persistence + goOffline; the caller owns auth).
 * - `firebaseConfig` given → we initialize a dedicated app, set per-tab auth persistence, and own it.
 */
export async function createRealBackend(options: {
  firebaseConfig?: FirebaseOptions;
  database?: Database;
}): Promise<FirebaseBackend> {
  if (options.database) {
    return new RealBackend(options.database, getAuth(options.database.app), false);
  }
  if (!options.firebaseConfig) {
    throw new Error(
      "FirebaseAdapter: provide either `firebaseConfig` (to initialize a Firebase app) or an " +
        "already-initialized `database` instance."
    );
  }
  // A dedicated, named app so we never collide with a host page's default Firebase app.
  const appName = `jspsych-multiplayer-${Math.random().toString(36).slice(2, 10)}`;
  const app = initializeApp(options.firebaseConfig, appName);
  const auth = getAuth(app);
  // Per-tab persistence: two tabs on one origin would otherwise share one anonymous uid, silently
  // collapsing them into a single participant under uid-as-key mode. The design never relies on the
  // uid surviving a full page reload (the reconnect re-push is a same-connection blip), so per-tab is
  // free. Only meaningful for an app WE own — a caller-injected app owns its own persistence.
  await setPersistence(auth, browserSessionPersistence);
  return new RealBackend(getDatabase(app), auth, true, app);
}

class RealBackend implements FirebaseBackend {
  constructor(
    private readonly db: Database,
    private readonly auth: Auth,
    public readonly ownsApp: boolean,
    private readonly app?: FirebaseApp
  ) {}

  async signIn(): Promise<string> {
    const cred = await signInAnonymously(this.auth);
    return cred.user.uid;
  }

  set(path: string, value: string): Promise<void> {
    return set(ref(this.db, path), value);
  }

  remove(path: string): Promise<void> {
    return remove(ref(this.db, path));
  }

  onValue(
    path: string,
    onData: (snapshot: RawSessionSnapshot | null) => void,
    onError: (error: Error) => void
  ): Unsubscribe {
    const nodeRef = ref(this.db, path);
    const listener = onValue(
      nodeRef,
      (snap) => onData((snap.val() as RawSessionSnapshot | null) ?? null),
      (error) => onError(error)
    );
    return () => off(nodeRef, "value", listener);
  }

  onDisconnectRemove(path: string): Promise<void> {
    return onDisconnect(ref(this.db, path)).remove();
  }

  cancelOnDisconnect(path: string): Promise<void> {
    return onDisconnect(ref(this.db, path)).cancel();
  }

  onConnectedChange(cb: (connected: boolean) => void): Unsubscribe {
    const infoRef = ref(this.db, ".info/connected");
    const listener = onValue(infoRef, (snap) => cb(snap.val() === true));
    return () => off(infoRef, "value", listener);
  }

  goOffline(): void {
    goOffline(this.db);
    // Tear down the dedicated app we created so a re-connect can cleanly re-initialize.
    if (this.app) {
      void deleteApp(this.app).catch(() => {
        // App teardown is best-effort cleanup; a failure here shouldn't reject disconnect().
      });
    }
  }
}
