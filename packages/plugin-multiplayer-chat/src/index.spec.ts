import { GroupSessionData, MultiplayerApiLike, Unsubscribe } from "./multiplayer-api";
import MultiplayerChatPlugin from ".";

// ---------------------------------------------------------------------------------------------------
// Mock multiplayer API implementing the same local interface the plugin codes against.
//
// This is the first package to mock `subscribe`. Semantics mirror the reference adapter:
//   - `push` REPLACES this participant's slot (it does NOT merge — see the JATOS adapter's
//     `groupSession.set`), then fires every subscriber. A merge mock would hide the exact bug the
//     "preserves unrelated keys" test guards against.
//   - `subscribe` registers a callback, immediately replays the current snapshot (as core does), and
//     returns an unsubscribe function.
//   - `pushAs(id, data)` simulates a peer's push (also replace), firing subscribers.
// The published `jspsych` here has no multiplayer API, so this mock + a direct trial() call exercises
// the plugin without a live group session.
// ---------------------------------------------------------------------------------------------------
class MockApi implements MultiplayerApiLike {
  session: GroupSessionData = {};
  private subs = new Set<(g: GroupSessionData) => void>();

  constructor(public participantId: string) {}

  get(id: string) {
    return this.session[id];
  }

  getAll() {
    return this.session;
  }

  async push(data: Record<string, unknown>) {
    this.session[this.participantId] = data; // REPLACE, like the real adapter
    this.fire();
  }

  subscribe(cb: (g: GroupSessionData) => void): Unsubscribe {
    this.subs.add(cb);
    cb(this.getAll()); // replay-on-registration, like core
    return () => this.subs.delete(cb);
  }

  /** Simulate a peer pushing into their own slot. */
  pushAs(id: string, data: Record<string, unknown>) {
    this.session[id] = data;
    this.fire();
  }

  /** Number of live subscriptions — 0 after a clean teardown. */
  subCount() {
    return this.subs.size;
  }

  private fire() {
    for (const cb of [...this.subs]) cb(this.getAll());
  }
}

/** Minimal jsPsych double exposing `pluginAPI` (the mock) and capturing `finishTrial` data. */
function makeJsPsych(api: MockApi) {
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    pluginAPI: api,
    finishTrial: (data: Record<string, any>) => finished.push(data),
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

  it("fires on_load once the screen is rendered", async () => {
    const api = new MockApi("me");
    const { jsPsych } = makeJsPsych(api);
    const on_load = jest.fn();

    await new MultiplayerChatPlugin(jsPsych as never).trial(
      display(),
      { ...base } as never,
      on_load
    );

    expect(on_load).toHaveBeenCalledTimes(1);
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
    const api = new MockApi("me");
    const { jsPsych, finished } = makeJsPsych(api);

    await new MultiplayerChatPlugin(jsPsych as never).trial(display(), {
      ...base,
      duration: 40,
    } as never);
    expect(finished).toHaveLength(0); // still open right after setup
    await new Promise((r) => setTimeout(r, 70));

    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("duration");
    expect(finished[0].chat_time).toEqual(expect.any(Number));
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
    await new Promise((r) => setTimeout(r, 50));

    expect(finished).toHaveLength(1);
    expect(messages(el)).toEqual([]); // no render after teardown
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
});
