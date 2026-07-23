import { JsPsych, JsPsychPlugin, ParameterType, TrialType } from "jspsych";

import { version } from "../package.json";
import { ChatMessage, appendOwnMessage, mergeMessages } from "./chat-core";
import {
  GroupSessionData,
  MultiplayerApiLike,
  Unsubscribe,
  resolveMultiplayerApi,
} from "./multiplayer-api";

const info = <const>{
  name: "multiplayer-chat",
  version: version,
  parameters: {
    /** Instructions rendered above the transcript (experimenter-authored, so HTML is allowed). */
    prompt: {
      type: ParameterType.HTML_STRING,
      default: "",
    },
    /** Placeholder text shown in the empty message input. */
    placeholder: {
      type: ParameterType.STRING,
      default: "Type a message…",
    },
    /**
     * Group-session field this trial stores its message array under. Namespacing keeps the chat log
     * from colliding with other data a participant has pushed (e.g. a role or an offer), and lets
     * two chat trials in one timeline keep separate logs.
     */
    data_key: {
      type: ParameterType.STRING,
      default: "chat_messages",
    },
    /**
     * Auto-end the trial after this many milliseconds. Null (or non-positive) means no time limit —
     * in which case you must provide `end_button_label` and/or `end_when`, or the trial can never end.
     */
    duration: {
      type: ParameterType.INT,
      default: null,
    },
    /** If set, show a button with this label that ends the trial when clicked. Null hides it. */
    end_button_label: {
      type: ParameterType.STRING,
      default: null,
    },
    /**
     * Predicate `(group) => boolean` evaluated against the full group session on every update; the
     * trial ends as soon as it returns true. Useful for "end when everyone is done" — e.g. have each
     * client push a `chat_done` flag and test `(g) => Object.values(g).every((p) => p.chat_done)`.
     */
    end_when: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /**
     * Maps a senderId to the display name shown on their messages: `(senderId, group) => string`.
     * Defaults to "You" for this participant and the raw senderId for everyone else. Lets role
     * output drive names, e.g. `(id) => jsPsychMultiplayerRole.participantsByRole()[id] ?? id`.
     */
    sender_label: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /** Optional maximum length, in characters, of a single message. Null means no limit. */
    max_length: {
      type: ParameterType.INT,
      default: null,
    },
    /** Show the list of participants currently present in the group session. */
    show_roster: {
      type: ParameterType.BOOL,
      default: false,
    },
  },
  data: {
    /** The ordered transcript (array of messages) as this client saw it when the trial ended. */
    transcript: {
      type: ParameterType.OBJECT,
      array: true,
      default: undefined,
    },
    /** Total number of distinct messages in the transcript at trial end. */
    message_count: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** How many messages this participant sent. */
    messages_sent: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** Time from trial start until the trial ended, in milliseconds. */
    chat_time: {
      type: ParameterType.INT,
      default: undefined,
    },
    /** What ended the trial: `"duration"`, `"button"`, or `"condition"`. */
    ended_by: {
      type: ParameterType.STRING,
      default: undefined,
    },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;
type EndReason = "duration" | "button" | "condition";

/**
 * **multiplayer-chat**
 *
 * A real-time chat room for multiplayer experiments. Unlike the barrier-based
 * `plugin-multiplayer-sync`, this trial stays open and re-renders on every group-session update: it
 * subscribes to the shared session, renders the merged transcript of all participants' messages, and
 * lets this participant send messages. It is the first plugin built on the multiplayer API's
 * real-time `subscribe` primitive.
 *
 * The trial ends on any configured condition: a `duration` timeout, an `end_button_label` click, or
 * an `end_when` predicate over the group session becoming true. The transcript this client saw is
 * stored in the trial data.
 *
 * Requires a connected multiplayer adapter — call `await jsPsych.multiplayer.connect(adapter)` before
 * `jsPsych.run()`.
 *
 * @author Hannah Tsukamoto
 * @see {@link https://github.com/jspsych/jspsych-multiplayer/tree/main/packages/plugin-multiplayer-chat multiplayer-chat plugin documentation}
 */
class MultiplayerChatPlugin implements JsPsychPlugin<Info> {
  static info = info;

  constructor(private jsPsych: JsPsych) {}

  // Deliberately synchronous (returns undefined, NOT a Promise): jsPsych races a returned promise
  // against `finishTrial()`, so an async `trial` that resolves after setup would end the trial
  // immediately. A sync `trial` makes jsPsych fire `on_load` itself and wait for `finishTrial()`.
  trial(display_element: HTMLElement, trial: TrialType<Info>) {
    const api = resolveMultiplayerApi(this.jsPsych);
    const me = api.participantId;
    const dataKey = trial.data_key;

    const hasDuration = typeof trial.duration === "number" && trial.duration > 0;
    if (!hasDuration && trial.end_button_label == null && typeof trial.end_when !== "function") {
      console.warn(
        "multiplayer-chat: no `duration`, `end_button_label`, or `end_when` set — the trial has no " +
          "way to end. Provide at least one end condition."
      );
    }

    // --- Base styling (injected once) ---------------------------------------------------------
    // The plugin ships no separate CSS asset (matching this repo's other plugins' convention), so
    // without this the sender/text spans render as unstyled inline text with nothing between them
    // — e.g. "AliceHello" — unreadable once more than a couple of messages arrive.
    const STYLE_ID = "jspsych-multiplayer-chat-styles";
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        .jspsych-multiplayer-chat-log {
          max-width: 30em;
          max-height: 20em;
          margin: 1em auto;
          padding: 0.5em 0.75em;
          overflow-y: auto;
          text-align: left;
          border: 1px solid #ccc;
          border-radius: 4px;
        }
        .jspsych-multiplayer-chat-message {
          display: block;
          margin-bottom: 0.4em;
        }
        .jspsych-multiplayer-chat-sender {
          font-weight: bold;
          margin-right: 0.4em;
        }
        .jspsych-multiplayer-chat-sender::after {
          content: ":";
        }
        .jspsych-multiplayer-chat-message.is-self .jspsych-multiplayer-chat-sender {
          color: #2a6;
        }
        .jspsych-multiplayer-chat-roster {
          max-width: 30em;
          margin: 0 auto 0.5em;
          font-size: 0.9em;
          color: #666;
        }
        .jspsych-multiplayer-chat-form {
          display: flex;
          gap: 0.5em;
          max-width: 30em;
          margin: 0 auto;
        }
        .jspsych-multiplayer-chat-input {
          flex: 1;
        }
        .jspsych-multiplayer-chat-error {
          max-width: 30em;
          margin: 0.3em auto 0;
          color: #c00;
          font-size: 0.9em;
        }
      `;
      document.head.appendChild(style);
    }

    // --- Render the shell ---------------------------------------------------------------------
    display_element.innerHTML = `
      <div class="jspsych-multiplayer-chat">
        ${trial.prompt ? `<div class="jspsych-multiplayer-chat-prompt">${trial.prompt}</div>` : ""}
        ${trial.show_roster ? `<div class="jspsych-multiplayer-chat-roster"></div>` : ""}
        <div class="jspsych-multiplayer-chat-log" aria-live="polite"></div>
        <form class="jspsych-multiplayer-chat-form">
          <input type="text" class="jspsych-multiplayer-chat-input"
                 placeholder="${escapeAttr(trial.placeholder)}" autocomplete="off" />
          <button type="submit" class="jspsych-multiplayer-chat-send">Send</button>
        </form>
        ${
          trial.end_button_label != null
            ? `<button type="button" class="jspsych-multiplayer-chat-end"></button>`
            : ""
        }
      </div>`;

    const log = display_element.querySelector(".jspsych-multiplayer-chat-log") as HTMLElement;
    const roster = display_element.querySelector(
      ".jspsych-multiplayer-chat-roster"
    ) as HTMLElement | null;
    const form = display_element.querySelector(".jspsych-multiplayer-chat-form") as HTMLFormElement;
    const input = display_element.querySelector(
      ".jspsych-multiplayer-chat-input"
    ) as HTMLInputElement;
    const endButton = display_element.querySelector(
      ".jspsych-multiplayer-chat-end"
    ) as HTMLButtonElement | null;
    if (endButton && trial.end_button_label != null) endButton.textContent = trial.end_button_label;

    const start = performance.now();
    // This participant's own outgoing sequence counter, seeded past the HIGHEST seq already in our
    // slot (e.g. after a reload) so ids stay unique. Seeding from the array length would collide
    // with an existing message if the array ever carried a seq gap.
    let nextSeq = readOwnMessages().reduce((max, m) => Math.max(max, m.seq), -1) + 1;
    let ended = false;
    let unsubscribe: Unsubscribe | null = null;
    // `number`, not ReturnType<typeof setTimeout>: pluginAPI.setTimeout returns a numeric handle.
    let timer: number | null = null;

    function readOwnMessages(): ChatMessage[] {
      const merged = mergeMessages({ [me]: api.get(me) ?? {} }, dataKey);
      return merged.filter((m) => m.senderId === me);
    }

    function senderLabel(senderId: string, group: GroupSessionData): string {
      if (typeof trial.sender_label === "function") {
        return String(trial.sender_label(senderId, group));
      }
      return senderId === me ? "You" : senderId;
    }

    // --- Rendering ----------------------------------------------------------------------------
    // Rebuild the transcript from scratch on each update. This is idempotent (keyed by message id
    // via mergeMessages) so a subscribe replay that re-delivers seen messages changes nothing.
    function render(group: GroupSessionData) {
      const transcript = mergeMessages(group, dataKey);
      const pinnedToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4;

      log.replaceChildren(
        ...transcript.map((m) => {
          const row = document.createElement("div");
          row.className = "jspsych-multiplayer-chat-message";
          if (m.senderId === me) row.classList.add("is-self");

          const who = document.createElement("span");
          who.className = "jspsych-multiplayer-chat-sender";
          who.textContent = senderLabel(m.senderId, group); // textContent — never innerHTML

          const body = document.createElement("span");
          body.className = "jspsych-multiplayer-chat-text";
          body.textContent = m.text; // textContent — untrusted input, must not be parsed as HTML

          row.append(who, body);
          return row;
        })
      );

      if (roster) {
        const names = Object.keys(group).map((id) => senderLabel(id, group));
        roster.textContent = names.length ? `Present: ${names.join(", ")}` : "";
      }

      // Keep the newest message visible unless the user has scrolled up to read history.
      if (pinnedToBottom) log.scrollTop = log.scrollHeight;
    }

    // --- Ending -------------------------------------------------------------------------------
    const end = (reason: EndReason) => {
      if (ended) return; // guard against a second trigger (e.g. timer racing a button)
      ended = true;
      unsubscribe?.();
      if (timer != null) clearTimeout(timer);
      form.removeEventListener("submit", onSubmit);
      endButton?.removeEventListener("click", onEndClick);

      const group = api.getAll();
      const transcript = mergeMessages(group, dataKey);
      this.jsPsych.finishTrial({
        transcript,
        message_count: transcript.length,
        messages_sent: transcript.filter((m) => m.senderId === me).length,
        chat_time: Math.round(performance.now() - start),
        ended_by: reason,
      });
    };

    // --- Sending ------------------------------------------------------------------------------
    const onSubmit = (e: Event) => {
      e.preventDefault();
      if (ended) return;
      let text = input.value.trim();
      if (text === "") return;
      if (typeof trial.max_length === "number" && trial.max_length > 0) {
        text = text.slice(0, trial.max_length);
      }
      input.value = "";

      // Read our OWN slot to derive the next message list. The push back below goes through
      // `update`, which merges only the chat key into the slot (leaving any role/offer/… intact)
      // rather than replacing it.
      const mine = api.get(me) ?? {};
      const own = mergeMessages({ [me]: mine }, dataKey).filter((m) => m.senderId === me);
      const nextMessages = appendOwnMessage(own, text, me, nextSeq++, Date.now());

      // Optimistic render: show our own message immediately instead of waiting for the adapter to
      // echo the push back through subscribe. The echo (or a replay) is harmless because render is
      // idempotent — mergeMessages de-duplicates by message id.
      render({ ...api.getAll(), [me]: { ...mine, [dataKey]: nextMessages } });

      // Best-effort send: a failed push shows an inline note rather than crashing the trial (unlike
      // sync, where a push failure is fatal — here sending is recoverable). Do NOT roll nextSeq back
      // on failure: pushes are fire-and-forget, so a later send may already have taken the next
      // number, and reusing a seq would forge a duplicate id that mergeMessages' dedup silently
      // drops. A skipped seq is harmless; a reused one loses data.
      api.update({ [dataKey]: nextMessages }).catch(() => {
        showSendError();
      });
    };

    function showSendError() {
      let note = display_element.querySelector(".jspsych-multiplayer-chat-error") as HTMLElement;
      if (!note) {
        note = document.createElement("div");
        note.className = "jspsych-multiplayer-chat-error";
        form.after(note);
      }
      note.textContent = "Couldn't send — please try again.";
    }

    const onEndClick = () => end("button");

    // --- Wire up --------------------------------------------------------------------------------
    form.addEventListener("submit", onSubmit);
    endButton?.addEventListener("click", onEndClick);

    // Seed from existing history, then subscribe. `subscribe` replays the current snapshot on
    // registration, so the seed is belt-and-suspenders — harmless because render is idempotent.
    render(api.getAll());
    if (typeof trial.end_when === "function" && trial.end_when(api.getAll())) {
      end("condition");
      return;
    }

    unsubscribe = api.subscribe((group) => {
      if (ended) return;
      try {
        render(group);
      } catch {
        // A bad render frame must not tear down the subscription or the trial.
      }
      let shouldEnd = false;
      try {
        shouldEnd = typeof trial.end_when === "function" && Boolean(trial.end_when(group));
      } catch {
        // A throwing end_when predicate must not propagate into the adapter's notify loop.
      }
      if (shouldEnd) end("condition");
    });

    if (hasDuration) {
      timer = this.jsPsych.pluginAPI.setTimeout(() => end("duration"), trial.duration as number);
    }
  }
}

/** Escape a string for safe interpolation into a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default MultiplayerChatPlugin;
