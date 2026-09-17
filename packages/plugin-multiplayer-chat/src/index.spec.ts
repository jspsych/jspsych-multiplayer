import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import MultiplayerChatPlugin from ".";

/** Deep JSON copy, as core hands out of `get`/`getAll`/`subscribe` (undefined stays undefined). */
function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the plugin codes against.
//
// This is the first package to mock `subscribe`. Semantics mirror core (jsPsych#3694) over the
// reference adapter:
//   - `push` REPLACES this participant's slot (it does NOT merge — see the JATOS adapter's
//     `groupSession.set`), then fires every subscriber. A merge mock would hide the exact bug the
//     "preserves unrelated keys" test guards against.
//   - `update` merges onto this client's LAST WRITE, not onto the session, exactly as core does —
//     so it stays correct even while the adapter's cache lags behind a confirmed write.
//   - `get`/`getAll`/subscriber arguments are JSON COPIES: mutating what a test (or the plugin)
//     reads back must not reach the session.
//   - `cacheLagMs` models the real gap between a resolved write and the cache reflecting it.
//   - `participantId` is a read-only getter that is null before connect / after disconnect.
//   - `subscribe` registers a callback, immediately replays the current snapshot (as core does), and
//     returns an unsubscribe function.
//   - `pushAs(id, data)` simulates a peer's push (also replace), firing subscribers.
// The published `jspsych` here has no multiplayer API, so this mock + a direct trial() call exercises
// the plugin without a live group session.
// ---------------------------------------------------------------------------------------------------
class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  /** When true, the next `push` rejects (send failure) without touching the session. */
  failNextPush = false;
  /** When false, `push` still writes but does NOT notify subscribers (a non-echoing adapter). */
  echoPushes = true;
  /**
   * When set, a `push` RESOLVES immediately but the session it writes only becomes visible to
   * `get`/`getAll`/subscribers this many ms later — the lag a real adapter's cache has behind a
   * write the backend has already confirmed.
   */
  cacheLagMs: number | null = null;
  /** This client's last successful write — the merge base `update` uses, as core uses `lastPushed`. */
  private lastWrite: Record<string, unknown> | null = null;
  private subs = new Set<(g: GroupSessionData) => void>();

  constructor(private id: string | null) {}

  /** Read-only, like core's getter: null until connect() resolves and after disconnect(). */
  get participantId(): string | null {
    return this.id;
  }

  get(id: string) {
    return copy(this.session[id]);
  }

  getAll() {
    return copy(this.session);
  }

  async push(data: Record<string, unknown>) {
    if (this.id == null) throw new Error("MockApi: not connected");
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new Error("network down");
    }
    const written = copy(data);
    this.lastWrite = written;
    if (this.cacheLagMs == null) this.commit(written);
    else setTimeout(() => this.commit(written), this.cacheLagMs);
  }

  update(data: Record<string, unknown>) {
    // Merge base is the last write, NOT `session[me]` — that is the whole point of core's update().
    return this.push({ ...(this.lastWrite ?? this.session[this.id!] ?? {}), ...data });
  }

  subscribe(cb: (g: GroupSessionData) => void): Unsubscribe {
    this.subs.add(cb);
    cb(this.getAll()); // replay-on-registration, like core
    return () => this.subs.delete(cb);
  }

  /** Simulate a peer pushing into their own slot. */
  pushAs(id: string, data: Record<string, unknown>) {
    this.session[id] = copy(data);
    this.fire();
  }

  /** Number of live subscriptions — 0 after a clean teardown. */
  subCount() {
    return this.subs.size;
  }

  /** Notify all subscribers with the current snapshot (e.g. a late echo of an earlier push). */
  fireNow() {
    this.fire();
  }

  private commit(data: Record<string, unknown>) {
    this.session[this.id!] = data; // REPLACE, like the real adapter
    if (this.echoPushes) this.fire();
  }

  private fire() {
    for (const cb of [...this.subs]) cb(this.getAll()); // each subscriber gets its own copy
  }
}

/** Minimal jsPsych double exposing `multiplayer` (the mock) and capturing `finishTrial` data. */
function makeJsPsych(api: MockApi) {
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    multiplayer: api,
    finishTrial: (data: Record<string, any>) => finished.push(data),
    // Passthrough double for the pluginAPI timer registry the plugin now schedules through.
    pluginAPI: {
      setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    },
  };
  return { jsPsych, finished };
}

const display = () => document.createElement("div");
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Fill the input and submit the chat form. */
function send(el: HTMLElement, text: string) {
  const input = el.querySelector(".jspsych-multiplayer-chat-input") as HTMLInputElement;
  const form = el.querySelector(".jspsych-multiplayer-chat-form") as HTMLFormElement;
  input.value = text;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

/** Rendered message rows, as `[senderLabel, text]` pairs. */
function messages(el: HTMLElement): Array<[string, string]> {
  return [...el.querySelectorAll(".jspsych-multiplayer-chat-message")].map((row) => [
    (row.querySelector(".jspsych-multiplayer-chat-sender") as HTMLElement).textContent ?? "",
    (row.querySelector(".jspsych-multiplayer-chat-text") as HTMLElement).textContent ?? "",
  ]);
}

/** Default params so each test only overrides what it cares about. */
const base = {
  prompt: "",
  placeholder: "Type…",
  data_key: "chat_messages",
  duration: null,
  end_button_label: null,
  end_when: null,
  sender_label: null,
  max_length: null,
  show_roster: false,
};

describe("multiplayer-chat plugin", () => {
  it("seeds the transcript from existing history on load", async () => {
    const api = new MockApi("me");
    api.pushAs("peer", {
      chat_messages: [{ senderId: "peer", seq: 0, text: "hi there", ts: 100 }],
    });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);

    expect(messages(el)).toEqual([["peer", "hi there"]]);
  });

  it("trial() is synchronous (returns undefined) so jsPsych waits for finishTrial", async () => {
    // jsPsych 8 races a Promise returned from trial() against finishTrial(); an async trial()
    // that resolves after setup would end the trial instantly with no data. Guard the sync-ness.
    const api = new MockApi("me");
    const { jsPsych } = makeJsPsych(api);

    const returned = new MultiplayerChatPlugin(jsPsych as never).trial(display(), {
      ...base,
    } as never);

    expect(returned).toBeUndefined();
  });

  it("sending pushes into my own slot and renders my message", async () => {
    const api = new MockApi("me");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    send(el, "hello world");
    await flush();

    expect((api.getAll().me.chat_messages as any[])[0]).toMatchObject({
      senderId: "me",
      text: "hello world",
    });
    expect(messages(el)).toEqual([["You", "hello world"]]);
  });

  it("re-renders when a peer pushes (the subscription works)", async () => {
    const api = new MockApi("me");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    expect(messages(el)).toEqual([]);

    api.pushAs("peer", { chat_messages: [{ senderId: "peer", seq: 0, text: "yo", ts: 50 }] });

    expect(messages(el)).toEqual([["peer", "yo"]]);
  });

  it("sending preserves unrelated keys in my own slot (the push-replaces-slot crux)", async () => {
    const api = new MockApi("me");
    api.pushAs("me", { role: "proposer" }); // pre-existing data in my slot
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    send(el, "first");
    await flush();

    // Both the earlier role AND the new chat log must survive the push.
    expect(api.getAll().me.role).toBe("proposer");
    expect(api.getAll().me.chat_messages).toHaveLength(1);
  });

  it("ends on duration timeout with ended_by 'duration'", async () => {
    jest.useFakeTimers();
    try {
      const api = new MockApi("me");
      const { jsPsych, finished } = makeJsPsych(api);

      await new MultiplayerChatPlugin(jsPsych as never).trial(display(), {
        ...base,
        duration: 40,
      } as never);
      expect(finished).toHaveLength(0); // still open right after setup

      jest.advanceTimersByTime(39);
      expect(finished).toHaveLength(0); // not a millisecond early
      jest.advanceTimersByTime(1);

      expect(finished).toHaveLength(1);
      expect(finished[0].ended_by).toBe("duration");
      expect(finished[0].chat_time).toEqual(expect.any(Number));
    } finally {
      jest.useRealTimers();
    }
  });

  it("ends on the end button with ended_by 'button'", async () => {
    const api = new MockApi("me");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, {
      ...base,
      end_button_label: "Leave chat",
    } as never);
    (el.querySelector(".jspsych-multiplayer-chat-end") as HTMLButtonElement).click();

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("button");
  });

  it("ends when end_when becomes true, with ended_by 'condition'", async () => {
    const api = new MockApi("me");
    const { jsPsych, finished } = makeJsPsych(api);

    await new MultiplayerChatPlugin(jsPsych as never).trial(display(), {
      ...base,
      end_when: (g: GroupSessionData) => Object.values(g).some((p) => (p as any).done),
    } as never);
    expect(finished).toHaveLength(0);

    api.pushAs("peer", { done: true });

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("condition");
  });

  it("ends immediately if end_when is already true at load", async () => {
    const api = new MockApi("me");
    api.pushAs("peer", { done: true });
    const { jsPsych, finished } = makeJsPsych(api);

    await new MultiplayerChatPlugin(jsPsych as never).trial(display(), {
      ...base,
      end_when: (g: GroupSessionData) => Object.values(g).some((p) => (p as any).done),
    } as never);

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("condition");
  });

  it("unsubscribes on finish and does not fire again (no leak, no double-finish)", async () => {
    jest.useFakeTimers();
    try {
      const api = new MockApi("me");
      const { jsPsych, finished } = makeJsPsych(api);
      const el = display();

      await new MultiplayerChatPlugin(jsPsych as never).trial(el, {
        ...base,
        end_button_label: "Done",
        duration: 30,
      } as never);
      (el.querySelector(".jspsych-multiplayer-chat-end") as HTMLButtonElement).click();

      expect(api.subCount()).toBe(0); // subscription torn down
      // A peer push after end must not re-render or re-finish; the duration timer must not fire either.
      api.pushAs("peer", { chat_messages: [{ senderId: "peer", seq: 0, text: "late", ts: 999 }] });
      jest.advanceTimersByTime(60); // well past the duration — the cleared timer must not fire

      expect(finished).toHaveLength(1);
      expect(messages(el)).toEqual([]); // no render after teardown
    } finally {
      jest.useRealTimers();
    }
  });

  it("escapes message text (does not parse it as HTML)", async () => {
    const api = new MockApi("me");
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    send(el, "<img src=x onerror=alert(1)>");
    await flush();

    expect(el.querySelector("img")).toBeNull(); // never became a real element
    expect(messages(el)).toEqual([["You", "<img src=x onerror=alert(1)>"]]);
  });

  it("is idempotent across a replaying subscription (no duplicate messages)", async () => {
    const api = new MockApi("me");
    api.pushAs("peer", { chat_messages: [{ senderId: "peer", seq: 0, text: "once", ts: 10 }] });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    // A redundant update carrying the same message must not duplicate it.
    api.pushAs("peer", { chat_messages: [{ senderId: "peer", seq: 0, text: "once", ts: 10 }] });

    expect(messages(el)).toEqual([["peer", "once"]]);
  });

  it("uses sender_label to map ids to display names", async () => {
    const api = new MockApi("me");
    api.pushAs("peer", { chat_messages: [{ senderId: "peer", seq: 0, text: "hi", ts: 10 }] });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, {
      ...base,
      sender_label: (id: string) => (id === "peer" ? "Responder" : "Proposer"),
    } as never);

    expect(messages(el)).toEqual([["Responder", "hi"]]);
  });

  it("shows the send error on a failed push and does NOT reuse the seq (no id collision)", async () => {
    const api = new MockApi("me");
    api.failNextPush = true;
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    send(el, "lost"); // this push rejects
    await flush();

    const note = el.querySelector(".jspsych-multiplayer-chat-error") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/try again/i);

    send(el, "second"); // writes are fire-and-forget, so this may race the failure callback
    await flush();

    // "second" must take a FRESH seq. Rolling the counter back on failure would give it the same id
    // as the optimistically-rendered "lost", and mergeMessages' dedup would silently drop one of
    // them. The write is self-healing, so "lost" — which the participant has already seen on screen
    // — rides along on the next send rather than being stranded in this client's view forever.
    const mine = api.getAll().me.chat_messages as any[];
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ text: "lost", seq: 0 });
    expect(mine[1]).toMatchObject({ text: "second", seq: 1 });
  });

  it("does not lose a message when two sends beat the session read (the cache-lag crux)", async () => {
    // The adapter's cache can still be empty when the SECOND send happens, even though the first
    // write already resolved. Deriving the outgoing array from `api.get(me)` per send would build
    // ["second"] and drop "first"; the local own-message array cannot. Core's update() coalescing
    // does not cover this — the array is built before update() is ever called.
    const api = new MockApi("me");
    api.cacheLagMs = 5;
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    send(el, "first");
    send(el, "second"); // sent while get(me) still shows nothing
    expect(api.getAll().me).toBeUndefined(); // the cache really has not caught up yet

    await new Promise((r) => setTimeout(r, 20));

    const mine = api.getAll().me.chat_messages as any[];
    expect(mine.map((m) => m.text)).toEqual(["first", "second"]);
    expect(messages(el)).toEqual([
      ["You", "first"],
      ["You", "second"],
    ]);
  });

  it("throws a clear error when participantId is null (adapter not connected yet)", () => {
    const api = new MockApi(null);
    const { jsPsych } = makeJsPsych(api);

    expect(() =>
      new MultiplayerChatPlugin(jsPsych as never).trial(display(), { ...base } as never),
    ).toThrow(/participantId/);
  });

  it("seeds the seq counter past a gap in the existing own-message array (no id collision)", async () => {
    const api = new MockApi("me");
    api.pushAs("me", {
      chat_messages: [
        { senderId: "me", seq: 0, text: "a", ts: 10 },
        { senderId: "me", seq: 2, text: "b", ts: 20 }, // gap at seq 1 (e.g. an earlier failed send)
      ],
    });
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    send(el, "fresh");
    await flush();

    // Length-based seeding would assign seq 2 → id "me#2", colliding with (and silently dropping)
    // the existing message. Max-based seeding must produce seq 3.
    const mine = api.getAll().me.chat_messages as any[];
    expect(mine).toHaveLength(3);
    expect(mine[2]).toMatchObject({ text: "fresh", seq: 3 });
    expect(messages(el)).toEqual([
      ["You", "a"],
      ["You", "b"],
      ["You", "fresh"],
    ]);
  });

  it("renders own messages optimistically, without depending on the adapter echoing the push", async () => {
    const api = new MockApi("me");
    api.echoPushes = false; // adapter that never replays our own push back through subscribe
    const { jsPsych } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, { ...base } as never);
    send(el, "instant");

    // Visible synchronously — before any subscriber callback or push resolution.
    expect(messages(el)).toEqual([["You", "instant"]]);

    // When the echo eventually arrives, the render must stay idempotent (no duplicate).
    await flush();
    api.fireNow();
    expect(messages(el)).toEqual([["You", "instant"]]);
  });

  it("a throwing end_when does not propagate into the adapter's notify loop or kill the trial", async () => {
    const api = new MockApi("me");
    const { jsPsych, finished } = makeJsPsych(api);
    const el = display();

    await new MultiplayerChatPlugin(jsPsych as never).trial(el, {
      ...base,
      end_when: (g: GroupSessionData) => {
        if (Object.keys(g).length > 0) throw new Error("boom");
        return false;
      },
    } as never);

    // The peer's push drives the subscribe callback; the predicate's throw must not escape into
    // the adapter's notify loop (here: pushAs) or finish the trial.
    expect(() =>
      api.pushAs("peer", { chat_messages: [{ senderId: "peer", seq: 0, text: "hi", ts: 5 }] }),
    ).not.toThrow();
    expect(finished).toHaveLength(0);

    // ...and the subscription is still alive: later updates keep rendering.
    api.pushAs("peer", {
      chat_messages: [
        { senderId: "peer", seq: 0, text: "hi", ts: 5 },
        { senderId: "peer", seq: 1, text: "still here", ts: 6 },
      ],
    });
    expect(messages(el)).toEqual([
      ["peer", "hi"],
      ["peer", "still here"],
    ]);
  });

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    const api = new MockApi("me");
    const jsPsych = initJsPsych();
    // Graft the multiplayer API seam onto jsPsych.multiplayer, where connect() puts it (jsPsych#3694),
    // so the plugin's single cast finds it on a REAL jsPsych instance.
    // A released jsPsych has no `multiplayer` module (jsPsych#3694 is unmerged), so create it here.
    const core = jsPsych as unknown as { multiplayer: Record<string, unknown> };
    core.multiplayer = {
      participantId: api.participantId,
      get: api.get.bind(api),
      push: api.push.bind(api),
      update: api.update.bind(api),
      getAll: api.getAll.bind(api),
      subscribe: api.subscribe.bind(api),
    };

    const { displayElement, expectFinished, getData } = await startTimeline(
      [{ type: MultiplayerChatPlugin, end_button_label: "Done" }],
      jsPsych,
    );

    send(displayElement, "through the pipeline");
    await flush();
    expect(messages(displayElement)).toEqual([["You", "through the pipeline"]]);

    (displayElement.querySelector(".jspsych-multiplayer-chat-end") as HTMLButtonElement).click();
    await expectFinished();

    const data = getData().values()[0];
    expect(data.ended_by).toBe("button");
    expect(data.message_count).toBe(1);
    expect(data.messages_sent).toBe(1);
    expect(data.transcript).toHaveLength(1);
  });
});
