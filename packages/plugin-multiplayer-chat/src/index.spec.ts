import { startTimeline } from "@jspsych/test-utils";
import { ConnectOptions, GroupSessionData, initJsPsych, PresenceData } from "jspsych";

import { MemoryHub, flushPromises } from "../../../test-utils/memory-backend";
import MultiplayerChatPlugin from ".";

// Every test runs the real jsPsych multiplayer session over the in-memory backend in test-utils,
// so reads are frozen snapshots, own writes show up at once, and presence is real. trial() is
// called directly with a thin jsPsych double that forwards to the real session and records
// finishTrial data.

async function setup(connect?: ConnectOptions) {
  const hub = new MemoryHub();
  const { jsPsych: real, connection } = await hub.join("me", { connect });
  const finished: Array<Record<string, any>> = [];
  const jsPsych = {
    multiplayer: real.multiplayer,
    finishTrial: (data: Record<string, any>) => finished.push(data),
    pluginAPI: { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) },
  };
  return { hub, api: real.multiplayer, jsPsych, finished, connection };
}

function run(jsPsych: unknown, params: Record<string, unknown> = {}) {
  const el = document.createElement("div");
  const returned = new MultiplayerChatPlugin(jsPsych as never).trial(el, {
    ...base,
    ...params,
  } as never);
  return { el, returned };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const peerMessage = (text: string, seq = 0, ts = 100) => ({
  chat_messages: [{ senderId: "peer", seq, text, ts }],
});

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
  end_on_participant_left: true,
};

beforeEach(() => {
  // Most tests set no end condition on purpose; the plugin warns about that
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("multiplayer-chat plugin", () => {
  it("shows existing history on load", async () => {
    const { hub, jsPsych } = await setup();
    const peer = await hub.join("peer");
    await peer.jsPsych.multiplayer.push(peerMessage("hi there"));

    const { el } = run(jsPsych);
    expect(messages(el)).toEqual([["peer", "hi there"]]);
  });

  it("trial() is synchronous (returns undefined) so jsPsych waits for finishTrial", async () => {
    // jsPsych 8 races a Promise returned from trial() against finishTrial(); an async trial()
    // that resolves after setup would end the trial instantly with no data. Guard the sync-ness.
    const { jsPsych } = await setup();
    expect(run(jsPsych).returned).toBeUndefined();
  });

  it("sending writes to my own slot and renders my message at once", async () => {
    const { api, jsPsych } = await setup();
    const { el } = run(jsPsych);

    send(el, "hello world");

    expect(messages(el)).toEqual([["You", "hello world"]]);
    expect((api.get("me")!.chat_messages as any[])[0]).toMatchObject({
      senderId: "me",
      text: "hello world",
    });
  });

  it("re-renders when a peer writes", async () => {
    const { hub, jsPsych } = await setup();
    const peer = await hub.join("peer");
    const { el } = run(jsPsych);

    await peer.jsPsych.multiplayer.push(peerMessage("hello"));
    expect(messages(el)).toEqual([["peer", "hello"]]);
  });

  it("keeps unrelated keys in my slot and every message across quick sends", async () => {
    const { api, jsPsych, connection } = await setup();
    await api.push({ role: "director" });
    const { el } = run(jsPsych);

    send(el, "one");
    send(el, "two");
    send(el, "three");
    await flushPromises();

    expect(api.get("me")!.role).toBe("director");
    expect(messages(el).map(([, text]) => text)).toEqual(["one", "two", "three"]);
    // The last push the backend received carries all three
    const last = connection.pushes[connection.pushes.length - 1];
    expect((last.chat_messages as any[]).map((m) => m.text)).toEqual(["one", "two", "three"]);
  });

  it("ends on duration timeout with ended_by 'duration'", async () => {
    jest.useFakeTimers();
    const { jsPsych, finished } = await setup();
    run(jsPsych, { duration: 50 });

    jest.advanceTimersByTime(49);
    expect(finished).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      ended_by: "duration",
      partner_left: false,
      left_participant: null,
      connection_lost: false,
    });
  });

  it("ends on the end button with ended_by 'button'", async () => {
    const { jsPsych, finished } = await setup();
    const { el } = run(jsPsych, { end_button_label: "Done" });

    (el.querySelector(".jspsych-multiplayer-chat-end") as HTMLButtonElement).click();
    expect(finished[0].ended_by).toBe("button");
  });

  it("ends when end_when becomes true, passing (group, presence)", async () => {
    const { hub, jsPsych, finished } = await setup();
    const peer = await hub.join("peer");
    const calls: Array<[GroupSessionData, PresenceData]> = [];
    run(jsPsych, {
      end_when: (g: GroupSessionData, presence: PresenceData) => {
        calls.push([g, presence]);
        return Boolean(g.peer?.done);
      },
    });

    await peer.jsPsych.multiplayer.push({ done: true });
    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("condition");
    const [group, presence] = calls[calls.length - 1];
    expect(presence).toEqual({ me: "connected", peer: "connected" });
    expect(Object.isFrozen(group)).toBe(true);
  });

  it("ends immediately if end_when is already true at load", async () => {
    const { jsPsych, finished } = await setup();
    run(jsPsych, { end_when: () => true });
    expect(finished).toHaveLength(1);
    expect(finished[0].ended_by).toBe("condition");
  });

  it("stops listening after it ends (no re-render, no second finish)", async () => {
    jest.useFakeTimers();
    const { hub, jsPsych, finished } = await setup();
    const peer = await hub.join("peer");
    const { el } = run(jsPsych, { end_button_label: "Done", duration: 30 });

    (el.querySelector(".jspsych-multiplayer-chat-end") as HTMLButtonElement).click();
    await peer.jsPsych.multiplayer.push(peerMessage("late"));
    jest.advanceTimersByTime(60); // well past the duration — the cleared timer must not fire

    expect(finished).toHaveLength(1);
    expect(messages(el)).toEqual([]);
  });

  it("escapes message text (does not parse it as HTML)", async () => {
    const { jsPsych } = await setup();
    const { el } = run(jsPsych);

    send(el, "<img src=x onerror=alert(1)>");

    expect(el.querySelector("img")).toBeNull();
    expect(messages(el)).toEqual([["You", "<img src=x onerror=alert(1)>"]]);
  });

  it("uses sender_label(senderId, group, presence) for display names", async () => {
    const { hub, jsPsych } = await setup();
    const peer = await hub.join("peer");
    await peer.jsPsych.multiplayer.push(peerMessage("yo"));
    const labels: Array<[string, PresenceData]> = [];

    const { el } = run(jsPsych, {
      sender_label: (id: string, _group: GroupSessionData, presence: PresenceData) => {
        labels.push([id, presence]);
        return id === "peer" ? "Partner" : "Me";
      },
    });

    expect(messages(el)).toEqual([["Partner", "yo"]]);
    expect(labels[0][1].peer).toBe("connected");
  });

  it("shows an error when a send fails, keeps the message, and sends it with the next one", async () => {
    const { api, jsPsych, connection } = await setup();
    const { el } = run(jsPsych);

    const send0 = connection.pushImpl;
    connection.pushImpl = async () => {
      throw new Error("conflict");
    };
    send(el, "first");
    await flushPromises();
    expect(el.querySelector(".jspsych-multiplayer-chat-error")?.textContent).toBe(
      "Couldn't send — please try again.",
    );

    connection.pushImpl = send0;
    send(el, "second");
    await flushPromises();

    const sent = (connection.pushes[connection.pushes.length - 1].chat_messages as any[]).map(
      (m) => [m.seq, m.text],
    );
    // The failed message went out with the next one, and its seq was not reused
    expect(sent).toEqual([
      [0, "first"],
      [1, "second"],
    ]);
    expect((api.get("me")!.chat_messages as any[]).length).toBe(2);
  });

  it("seeds the seq counter past a gap in the existing own-message array (no id collision)", async () => {
    const { api, jsPsych } = await setup();
    await api.push({
      chat_messages: [
        { senderId: "me", seq: 0, text: "a", ts: 1 },
        { senderId: "me", seq: 2, text: "c", ts: 3 },
      ],
    });
    const { el } = run(jsPsych);

    send(el, "d");

    const seqs = (api.get("me")!.chat_messages as any[]).map((m) => m.seq);
    expect(seqs).toEqual([0, 2, 3]);
    expect(messages(el).map(([, text]) => text)).toEqual(["a", "c", "d"]);
  });

  it("a throwing end_when does not kill the trial", async () => {
    const { hub, jsPsych, finished } = await setup();
    const peer = await hub.join("peer");
    const { el } = run(jsPsych, {
      end_when: (g: GroupSessionData) => {
        if (g.peer) throw new Error("bad predicate");
        return false;
      },
    });

    await peer.jsPsych.multiplayer.push(peerMessage("still works"));
    expect(finished).toHaveLength(0);
    expect(messages(el)).toEqual([["peer", "still works"]]);
  });

  describe("participants leaving", () => {
    it("ends with ended_by 'participant_left' when a participant who was there leaves", async () => {
      const { hub, jsPsych, finished } = await setup({ dropoutTimeout: 0 });
      const peer = await hub.join("peer");
      await peer.jsPsych.multiplayer.push(peerMessage("bye"));
      run(jsPsych);

      await peer.jsPsych.multiplayer.disconnect();
      await sleep(5);

      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({
        ended_by: "participant_left",
        partner_left: true,
        left_participant: "peer",
        connection_lost: false,
      });
      expect(finished[0].transcript.map((m: any) => m.text)).toEqual(["bye"]);
    });

    it("keeps going when end_on_participant_left is false, marking them in the roster", async () => {
      const { hub, jsPsych, finished } = await setup({ dropoutTimeout: 0 });
      const peer = await hub.join("peer");
      const { el } = run(jsPsych, { end_on_participant_left: false, show_roster: true });
      const roster = () => el.querySelector(".jspsych-multiplayer-chat-roster")!.textContent;

      expect(roster()).toBe("Participants: You, peer");
      await peer.jsPsych.multiplayer.disconnect();
      expect(roster()).toBe("Participants: You, peer (away)");
      await sleep(5);

      expect(finished).toHaveLength(0);
      expect(roster()).toBe("Participants: You, peer (left)");
    });

    it("ignores a participant who wasn't connected when the trial started", async () => {
      const { hub, jsPsych, finished } = await setup({ dropoutTimeout: 0 });
      hub.seed("ghost", peerMessage("old"));
      run(jsPsych);
      await sleep(5);
      expect(finished).toHaveLength(0);
    });
  });

  describe("losing the connection", () => {
    it("ends with ended_by 'connection_lost' and keeps the transcript", async () => {
      const { jsPsych, finished, connection } = await setup();
      const { el } = run(jsPsych);
      send(el, "before the drop");

      connection.options.onStatus("closed");

      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ ended_by: "connection_lost", connection_lost: true });
      expect(finished[0].transcript.map((m: any) => m.text)).toEqual(["before the drop"]);
    });

    it("also ends cleanly when the experiment calls disconnect() mid-trial", async () => {
      const { api, jsPsych, finished } = await setup();
      run(jsPsych);
      await api.disconnect();
      expect(finished[0].ended_by).toBe("connection_lost");
    });
  });

  it("throws a clear error when the adapter isn't connected yet", () => {
    const jsPsych = initJsPsych();
    expect(() =>
      new MultiplayerChatPlugin(jsPsych).trial(document.createElement("div"), base as never),
    ).toThrow("no participantId");
  });

  it("throws a clear error on a jsPsych without the multiplayer module", () => {
    expect(() =>
      new MultiplayerChatPlugin({} as never).trial(document.createElement("div"), base as never),
    ).toThrow("no multiplayer module");
  });

  it("runs through the real jsPsych parameter pipeline (startTimeline smoke test)", async () => {
    const hub = new MemoryHub();
    const { jsPsych } = await hub.join("me");

    const { displayElement, getData, expectFinished } = await startTimeline(
      [{ type: MultiplayerChatPlugin, end_button_label: "Done" }],
      jsPsych,
    );
    send(displayElement, "through the pipeline");
    (displayElement.querySelector(".jspsych-multiplayer-chat-end") as HTMLButtonElement).click();
    await expectFinished();

    const data = getData().values()[0];
    expect(data.ended_by).toBe("button");
    expect(data.messages_sent).toBe(1);
    expect(data.partner_left).toBe(false);
  });
});
