import {
  getMultiplayer,
  isMultiplayerError,
  MultiplayerOutcome,
  outcomeOf,
  remainingParticipants,
} from "@jspsych-multiplayer/utils";
import {
  GroupSessionData,
  JsPsych,
  JsPsychPlugin,
  ParameterType,
  PresenceData,
  TrialType,
} from "jspsych";

import { version } from "../package.json";
import { ChatMessage, appendOwnMessage, mergeMessages } from "./chat-core";

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
     * Predicate `(group, presence) => boolean` evaluated on every update; the trial ends as soon as
     * it returns true. Useful for "end when everyone is done" — e.g. have each client write a
     * `chat_done` flag and test
     * `(g, presence) => Object.keys(g).every((id) => g[id].chat_done || presence[id] === "left")`.
     * `group` holds this trial's data; both arguments are frozen snapshots, so don't modify them.
     */
    end_when: {
      type: ParameterType.FUNCTION,
      default: null,
    },
    /**
     * Maps a senderId to the display name shown on their messages:
     * `(senderId, group, presence) => string`. Defaults to "You" for this participant and the raw
     * senderId for everyone else. `group` holds this trial's data, so read names written by an
     * earlier trial from the session scope, e.g.
     * `(id) => jsPsych.multiplayer.get(id, { scope: "session" })?.name ?? id`.
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
    /**
     * Show the list of participants in the group session. Participants whose connection dropped
     * are marked "(away)", and those who have left the study are marked "(left)".
     */
    show_roster: {
      type: ParameterType.BOOL,
      default: false,
    },
    /**
     * End the trial when another participant leaves the study (their presence becomes `left`):
     * a member of the sealed group, or, without one, a participant who was connected when the
     * trial started. The trial then ends with `multiplayer_outcome: "participant_left"`.
     */
    end_on_participant_left: {
      type: ParameterType.BOOL,
      default: true,
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
    /**
     * How the trial ended: `"completed"` (by one of its end conditions), `"participant_left"`,
     * `"connection_lost"`, or `"cancelled"` (the experiment disconnected during the trial).
     */
    multiplayer_outcome: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /** The participant whose departure ended the trial, or null. */
    left_participant: {
      type: ParameterType.STRING,
      default: undefined,
    },
    /**
     * Which end condition completed the trial: `"duration"`, `"button"`, or `"condition"`
     * (`end_when`). Null when the trial didn't complete (see `multiplayer_outcome`).
     */
    ended_by: {
      type: ParameterType.STRING,
      default: undefined,
    },
  },
  // prettier-ignore
  citations: '__CITATIONS__',
};

type Info = typeof info;
type EndCondition = "duration" | "button" | "condition";

/** The group-session field each participant keeps their message array under. */
const MESSAGES_KEY = "chat_messages";

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
 * an `end_when` predicate over the group session becoming true. It also ends when another
 * participant leaves the study (unless `end_on_participant_left` is false) or when this
 * participant's connection is lost for good. The transcript this client saw is stored in the trial
 * data.
 *
 * Messages live in the trial's own part of the shared data, so each chat trial starts empty. Give
 * several chat trials the same `multiplayer_scope` to continue one conversation across them.
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
    const api = getMultiplayer(this.jsPsych, "multiplayer-chat");
    const me = api.participantId;
    if (me == null) {
      throw new Error(
        "multiplayer-chat: no participantId — the multiplayer adapter must be connected " +
          "(await jsPsych.multiplayer.connect(adapter)) before this trial runs.",
      );
    }

    const hasDuration = typeof trial.duration === "number" && trial.duration > 0;
    if (!hasDuration && trial.end_button_label == null && typeof trial.end_when !== "function") {
      console.warn(
        "multiplayer-chat: no `duration`, `end_button_label`, or `end_when` set — the trial has no " +
          "way to end. Provide at least one end condition.",
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
      ".jspsych-multiplayer-chat-roster",
    ) as HTMLElement | null;
    const form = display_element.querySelector(".jspsych-multiplayer-chat-form") as HTMLFormElement;
    const input = display_element.querySelector(
      ".jspsych-multiplayer-chat-input",
    ) as HTMLInputElement;
    const endButton = display_element.querySelector(
      ".jspsych-multiplayer-chat-end",
    ) as HTMLButtonElement | null;
    if (endButton && trial.end_button_label != null) endButton.textContent = trial.end_button_label;

    const start = performance.now();
    // This participant's own outgoing sequence counter, seeded past the HIGHEST seq already in our
    // slot (e.g. after a reload) so ids stay unique. Seeding from the array length would collide
    // with an existing message if the array ever carried a seq gap.
    let nextSeq = readOwnMessages().reduce((max, m) => Math.max(max, m.seq), -1) + 1;
    let ended = false;
    // `number`, not ReturnType<typeof setTimeout>: pluginAPI.setTimeout returns a numeric handle.
    let timer: number | null = null;

    /**
     * This participant's messages, read from their own slot. Writes show up in reads at once, so
     * the slot always holds every message sent so far, including any whose write failed (those go
     * out again with the next write).
     */
    function readOwnMessages(): ChatMessage[] {
      const merged = mergeMessages({ [me]: api.get(me) ?? {} }, MESSAGES_KEY);
      return merged.filter((m) => m.senderId === me);
    }

    function senderLabel(
      senderId: string,
      group: GroupSessionData,
      presence: PresenceData,
    ): string {
      if (typeof trial.sender_label === "function") {
        return String(trial.sender_label(senderId, group, presence));
      }
      return senderId === me ? "You" : senderId;
    }

    // --- Rendering ----------------------------------------------------------------------------
    // Rebuild the transcript from scratch on each update. This is idempotent (keyed by message id
    // via mergeMessages), so a notification that re-delivers seen messages changes nothing.
    function render(group: GroupSessionData, presence: PresenceData) {
      const transcript = mergeMessages(group, MESSAGES_KEY);
      const pinnedToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4;

      log.replaceChildren(
        ...transcript.map((m) => {
          const row = document.createElement("div");
          row.className = "jspsych-multiplayer-chat-message";
          if (m.senderId === me) row.classList.add("is-self");

          const who = document.createElement("span");
          who.className = "jspsych-multiplayer-chat-sender";
          who.textContent = senderLabel(m.senderId, group, presence); // textContent — never innerHTML

          const body = document.createElement("span");
          body.className = "jspsych-multiplayer-chat-text";
          body.textContent = m.text; // textContent — untrusted input, must not be parsed as HTML

          row.append(who, body);
          return row;
        }),
      );

      if (roster) {
        // This participant first, then everyone else in the session
        const ids = [...new Set([me, ...Object.keys(group), ...Object.keys(presence)])];
        const names = ids.map((id) => {
          const status = id === me ? "connected" : presence[id];
          const suffix = status === "away" ? " (away)" : status === "left" ? " (left)" : "";
          return senderLabel(id, group, presence) + suffix;
        });
        roster.textContent = names.length ? `Participants: ${names.join(", ")}` : "";
      }

      // Keep the newest message visible unless the user has scrolled up to read history.
      if (pinnedToBottom) log.scrollTop = log.scrollHeight;
    }

    // --- Ending -------------------------------------------------------------------------------
    const end = (
      outcome: MultiplayerOutcome,
      endedBy: EndCondition | null,
      leftParticipant: string | null = null,
    ) => {
      if (ended) return; // guard against a second trigger (e.g. timer racing a button)
      ended = true;
      if (timer != null) clearTimeout(timer);
      form.removeEventListener("submit", onSubmit);
      endButton?.removeEventListener("click", onEndClick);

      // Reads keep returning the last state after the session closes
      const transcript = mergeMessages(api.getAll(), MESSAGES_KEY);
      this.jsPsych.finishTrial({
        transcript,
        message_count: transcript.length,
        messages_sent: transcript.filter((m) => m.senderId === me).length,
        chat_time: Math.round(performance.now() - start),
        multiplayer_outcome: outcome,
        left_participant: leftParticipant,
        ended_by: endedBy,
      });
    };
    const complete = (endedBy: EndCondition) => end("completed", endedBy);

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

      // `update` merges only the chat key into our data (leaving anything else intact) and
      // notifies the subscriber synchronously, which renders the new message. The core retries a
      // failed write itself, and a write only rejects once the session has closed, which ends the
      // trial. Each message takes a fresh seq: a reused one would forge a duplicate id that
      // mergeMessages' dedup silently drops.
      const messages = appendOwnMessage(readOwnMessages(), text, me, nextSeq++, Date.now());
      api.update({ [MESSAGES_KEY]: messages }).catch(() => {});
    };

    const onEndClick = () => complete("button");

    // --- Wire up --------------------------------------------------------------------------------
    form.addEventListener("submit", onSubmit);
    endButton?.addEventListener("click", onEndClick);

    // subscribe() calls back at once with the current state, so this also renders the existing
    // history and checks end_when before the trial is visible. The subscription ends with the
    // trial; `ended` covers the moment between finishTrial() and then.
    api.subscribe((group, presence) => {
      if (ended) return;
      try {
        render(group, presence);
      } catch {
        // A bad render frame must not tear down the subscription or the trial.
      }
      let shouldEnd = false;
      try {
        shouldEnd =
          typeof trial.end_when === "function" && Boolean(trial.end_when(group, presence));
      } catch {
        // A throwing end_when predicate must not propagate into the session's notify loop.
      }
      if (shouldEnd) complete("condition");
    });

    // A wait that never succeeds, for how the trial can end from outside: it fails when a
    // participant it depends on leaves, or when the session closes. The trial ending cancels it too
    // (and aborting the experiment does), which must not end anything.
    if (!ended) {
      api
        .wait(() => false, {
          participants: trial.end_on_participant_left ? remainingParticipants(api) : [],
        })
        .catch((error) => {
          const outcome = outcomeOf(error);
          if (ended || outcome === null) return;
          if (outcome === "cancelled" && api.status !== "closed") return;
          end(outcome, null, isMultiplayerError(error) ? (error.participantId ?? null) : null);
        });
    }

    if (hasDuration && !ended) {
      timer = this.jsPsych.pluginAPI.setTimeout(
        () => complete("duration"),
        trial.duration as number,
      );
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
