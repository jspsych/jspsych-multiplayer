import htmlKeyboardResponse from "@jspsych/plugin-html-keyboard-response";
import { startTimeline } from "@jspsych/test-utils";
import { initJsPsych } from "jspsych";

import PresenceCheckExtension, { PresenceInput } from ".";

const P = "jspsych-extension-presence-check";

/**
 * Marks an event trusted, as the browser does for real input. jsdom's dispatchEvent() resets the
 * flag on its internal event object, so pin it there.
 */
function trusted<E extends Event>(event: E): E {
  const impl = Object.getOwnPropertySymbols(event).find((s) => s.description === "impl")!;
  Object.defineProperty((event as any)[impl], "isTrusted", { get: () => true, set() {} });
  return event;
}

const EVENTS: Record<PresenceInput, () => Event> = {
  mouse_move: () => new MouseEvent("mousemove", { bubbles: true }),
  pointer_down: () => new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  keyboard: () => new KeyboardEvent("keydown", { key: "h", bubbles: true, cancelable: true }),
  wheel: () => new WheelEvent("wheel", { bubbles: true, cancelable: true }),
  touch: () => new Event("touchstart", { bubbles: true, cancelable: true }),
};
const INPUTS = Object.keys(EVENTS) as PresenceInput[];
const only = (input: PresenceInput | null) =>
  Object.fromEntries(INPUTS.map((i) => [i, i === input])) as Record<PresenceInput, boolean>;

/** Dispatches a trusted input of this kind at the focused element (or `target`). */
const fire = (input: PresenceInput, target: Element = document.activeElement ?? document.body) => {
  const event = trusted(EVENTS[input]());
  target.dispatchEvent(event);
  return event;
};

const overlay = () => document.querySelector(`.${P}`) as HTMLElement | null;
const button = () => document.querySelector(`.${P}-button`) as HTMLButtonElement | null;

async function start(params: Record<string, unknown> = {}, ext?: PresenceCheckExtension) {
  const extension = ext ?? new PresenceCheckExtension({} as never);
  if (!ext) await extension.initialize();
  extension.on_start();
  extension.on_load({ prompt_after: 30000, respond_within: 30000, ...params });
  return extension;
}

describe("presence-check extension (DOM)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.innerHTML = "";
  });

  it("shows the warning after prompt_after and counts it down", async () => {
    const ext = await start();
    jest.advanceTimersByTime(29750);
    expect(overlay()).toBeNull();
    jest.advanceTimersByTime(250);
    expect(overlay()).not.toBeNull();
    expect(overlay()!.textContent).toContain("Are you still with us?");
    expect(overlay()!.textContent).toContain("This message closes in 30s.");
    jest.advanceTimersByTime(10000);
    expect(overlay()!.textContent).toContain("This message closes in 20s.");
    ext.on_finish();
  });

  describe.each(INPUTS)("dismissal by %s", (input) => {
    it("dismisses when enabled in dismiss_inputs", async () => {
      const ext = await start({ dismiss_inputs: only(input) });
      jest.advanceTimersByTime(30000);
      expect(overlay()).not.toBeNull();
      const event = fire(input);
      expect(event.defaultPrevented).toBe(false);
      expect(overlay()).toBeNull();
      const data = ext.on_finish();
      expect(data.presence_responded).toBe(1);
      expect(data.presence_events![0]).toMatchObject({ outcome: "responded", dismissed_by: input });
    });

    it("does not dismiss when disabled, even with every other input enabled", async () => {
      const dismiss = { ...only(null), ...Object.fromEntries(INPUTS.map((i) => [i, i !== input])) };
      const ext = await start({ dismiss_inputs: dismiss });
      jest.advanceTimersByTime(30000);
      fire(input);
      expect(overlay()).not.toBeNull();
      const data = ext.on_finish();
      expect(data.presence_responded).toBe(0);
      expect(data.presence_interrupted).toBe(1);
    });
  });

  it("only counts inputs enabled in activity_inputs as activity", async () => {
    const ext = await start({ activity_inputs: { ...only(null), keyboard: true } });
    jest.advanceTimersByTime(20000);
    fire("mouse_move");
    jest.advanceTimersByTime(10000);
    expect(overlay()).not.toBeNull(); // mouse movement did not restart the clock
    fire("keyboard"); // dismisses
    jest.advanceTimersByTime(20000);
    fire("keyboard"); // activity: restarts the clock
    jest.advanceTimersByTime(29750);
    expect(overlay()).toBeNull();
    jest.advanceTimersByTime(250);
    expect(overlay()).not.toBeNull();
    ext.on_finish();
  });

  it("button-only mode keeps the modal: backdrop, focus trap, backdrop clicks, focus restore", async () => {
    const field = document.createElement("input");
    const outside = document.createElement("button");
    document.body.append(field, outside);
    // jsdom has no layout; focus is only restored to an element that is rendered.
    field.getClientRects = () => [{}] as unknown as DOMRectList;
    field.focus();
    const ext = await start({ dismiss_inputs: only(null) });
    jest.advanceTimersByTime(30000);
    const card = overlay()!.firstElementChild as HTMLElement;
    expect(overlay()!.classList.contains("is-passthrough")).toBe(false);
    expect(card.getAttribute("role")).toBe("alertdialog");
    expect(card.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(button());

    const tab = trusted(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    button()!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button());
    outside.focus();
    expect(document.activeElement).toBe(button());

    for (const input of INPUTS) fire(input);
    expect(overlay()).not.toBeNull();
    overlay()!.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
    overlay()!.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
    card.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true }))); // the card is not backdrop
    button()!.click();
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(field);
    const data = ext.on_finish();
    expect(data.presence_events).toEqual([
      { shown_at: 30000, outcome: "responded", rt: 0, dismissed_by: "button", backdrop_clicks: 2 },
    ]);
    expect(data.presence_backdrop_clicks).toBe(2);
  });

  it.each(["pointerdown", "touchstart"])(
    "leaves a button %s to its click handler",
    async (type) => {
      const ext = await start();
      jest.advanceTimersByTime(30000);
      const target = button()!;
      const event = new Event(type, { bubbles: true });
      if (type === "pointerdown") {
        Object.defineProperty(event, "pointerType", { value: "touch" });
      }
      target.dispatchEvent(trusted(event));
      expect(button()).toBe(target);
      target.click();
      expect(overlay()).toBeNull();
      expect(ext.on_finish().presence_events![0].dismissed_by).toBe("button");
    },
  );

  it.each(["keyboard", "button", "touch"])(
    "interrupts a newly paused warning before handling %s",
    async (input) => {
      let paused = false;
      const ext = await start({ paused: () => paused });
      jest.advanceTimersByTime(90000); // one miss, then another warning
      paused = true; // no timer poll has observed the pause yet
      if (input === "button") button()!.click();
      else fire(input as PresenceInput);
      expect(overlay()).toBeNull();
      expect(ext.on_finish()).toMatchObject({
        presence_consecutive_misses: 1,
        presence_interrupted: 1,
        presence_responded: 0,
      });
    },
  );

  it("preserves misses when input arrives between warnings during a pause", async () => {
    let paused = false;
    const ext = await start({ paused: () => paused });
    jest.advanceTimersByTime(60000);
    paused = true;
    fire("keyboard");
    expect(ext.consecutiveMisses).toBe(1);
    paused = false;
    fire("keyboard");
    expect(ext.consecutiveMisses).toBe(0);
    ext.on_finish();
  });

  it("the button always dismisses", async () => {
    const ext = await start();
    jest.advanceTimersByTime(30000);
    button()!.click();
    expect(overlay()).toBeNull();
    expect(ext.on_finish().presence_events![0].dismissed_by).toBe("button");
  });

  it("a dismissing keystroke still reaches the focused text input, which keeps focus", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const received: KeyboardEvent[] = [];
    field.addEventListener("keydown", (e) => received.push(e));
    const ext = await start();
    jest.advanceTimersByTime(30000);
    const card = overlay()!.firstElementChild as HTMLElement;
    expect(card.getAttribute("role")).toBe("alert");
    expect(overlay()!.classList.contains("is-passthrough")).toBe(true);
    expect(document.activeElement).toBe(field);
    const event = fire("keyboard", field);
    expect(received).toEqual([event]);
    expect(event.defaultPrevented).toBe(false);
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(ext.on_finish().presence_events![0].dismissed_by).toBe("keyboard");
  });

  it("keyboard-only mode blocks pointer input but does not take focus", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const ext = await start({ dismiss_inputs: only("keyboard") });
    jest.advanceTimersByTime(30000);
    expect(overlay()!.classList.contains("is-passthrough")).toBe(false);
    expect(document.activeElement).toBe(field);
    fire("keyboard", field);
    expect(overlay()).toBeNull();
    ext.on_finish();
  });

  it("a dismissing click reaches what was clicked", async () => {
    const target = document.createElement("button");
    document.body.append(target);
    const clicks: Event[] = [];
    target.addEventListener("pointerdown", (e) => clicks.push(e));
    const ext = await start();
    jest.advanceTimersByTime(30000);
    const event = fire("pointer_down", target);
    expect(clicks).toEqual([event]);
    expect(overlay()).toBeNull();
    ext.on_finish();
  });

  it("ignores untrusted events, for activity and for dismissal", async () => {
    const ext = await start();
    jest.advanceTimersByTime(20000);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    jest.advanceTimersByTime(10000);
    expect(overlay()).not.toBeNull();
    for (const input of INPUTS) document.body.dispatchEvent(EVENTS[input]());
    overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay()).not.toBeNull();
    const data = ext.on_finish();
    expect(data.presence_responded).toBe(0);
  });

  it("removes its listeners and DOM on on_finish", async () => {
    const added = jest.spyOn(document, "addEventListener");
    const removed = jest.spyOn(document, "removeEventListener");
    try {
      const ext = await start();
      jest.advanceTimersByTime(30000);
      expect(overlay()).not.toBeNull();
      const data = ext.on_finish();
      expect(overlay()).toBeNull();
      expect(removed.mock.calls.length).toBe(added.mock.calls.length);
      for (const [type, listener] of added.mock.calls) {
        expect(removed.mock.calls.some(([t, l]) => t === type && l === listener)).toBe(true);
      }
      expect(data).toMatchObject({
        presence_prompts: 1,
        presence_interrupted: 1,
        presence_consecutive_misses: 0,
        presence_expired: false,
      });
      jest.advanceTimersByTime(120000);
      expect(overlay()).toBeNull();
      expect(ext.on_finish()).toEqual({});
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });

  it("expires once, closes the warning, and stops prompting for the trial", async () => {
    const on_expire = jest.fn();
    const ext = await start({ on_expire });
    jest.advanceTimersByTime(119750);
    expect(on_expire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(250);
    expect(on_expire).toHaveBeenCalledTimes(1);
    expect(on_expire.mock.calls[0][0]).toMatchObject({
      presence_expired: true,
      presence_missed: 2,
    });
    expect(overlay()).toBeNull();
    jest.advanceTimersByTime(300000);
    expect(overlay()).toBeNull();
    expect(on_expire).toHaveBeenCalledTimes(1);
    expect(ext.on_finish()).toMatchObject({ presence_expired: true, presence_prompts: 2 });
  });

  it("carries misses across trials past a paused phase, and reset() clears them", async () => {
    let paused = false;
    const on_expire = jest.fn();
    const params = { paused: () => paused, on_expire };
    const ext = await start(params);
    jest.advanceTimersByTime(60000); // one miss
    jest.advanceTimersByTime(30000); // a second warning...
    paused = true; // ...interrupted by feedback
    jest.advanceTimersByTime(60000);
    expect(overlay()).toBeNull();
    expect(ext.on_finish()).toMatchObject({
      presence_missed: 1,
      presence_interrupted: 1,
      presence_consecutive_misses: 1,
    });
    paused = false;
    await start(params, ext);
    jest.advanceTimersByTime(60000);
    expect(on_expire).toHaveBeenCalledTimes(1);
    ext.on_finish();

    ext.reset();
    expect(ext.consecutiveMisses).toBe(0);
    await start(params, ext);
    jest.advanceTimersByTime(60000);
    expect(on_expire).toHaveBeenCalledTimes(1);
    expect(ext.on_finish().presence_consecutive_misses).toBe(1);
  });

  it("starts each trial from zero with count_across_trials: false", async () => {
    const on_expire = jest.fn();
    const ext = await start({ on_expire, count_across_trials: false });
    jest.advanceTimersByTime(60000);
    ext.on_finish();
    await start({ on_expire, count_across_trials: false }, ext);
    jest.advanceTimersByTime(60000);
    expect(on_expire).not.toHaveBeenCalled();
    ext.on_finish();
  });

  it("uses initialize params as experiment-wide defaults and validates them", async () => {
    const ext = new PresenceCheckExtension({} as never);
    await ext.initialize({ prompt_after: 1000, title: "Still there?" });
    ext.on_load({ respond_within: 500 });
    jest.advanceTimersByTime(1000);
    expect(overlay()!.textContent).toContain("Still there?");
    jest.advanceTimersByTime(500);
    expect(overlay()).toBeNull();
    ext.on_finish();
    expect(() => new PresenceCheckExtension({} as never).initialize({ prompt_after: 0 })).toThrow(
      /prompt_after/,
    );
  });
});

describe("presence-check extension in a real timeline", () => {
  it("adds its data to the trial and lets on_expire end it", async () => {
    const jsPsych = initJsPsych({ extensions: [{ type: PresenceCheckExtension }] });
    const { expectFinished, getData } = await startTimeline(
      [
        {
          type: htmlKeyboardResponse,
          stimulus: "Waiting",
          extensions: [
            {
              type: PresenceCheckExtension,
              params: {
                prompt_after: 40,
                respond_within: 40,
                max_consecutive_misses: 1,
                on_expire: () => jsPsych.finishTrial({ removed: true }),
              },
            },
          ],
        },
      ],
      jsPsych,
    );
    // Warnings are checked every 250 ms.
    await new Promise((r) => setTimeout(r, 1000));
    await expectFinished();
    expect(getData().values()[0]).toMatchObject({
      removed: true,
      presence_prompts: 1,
      presence_missed: 1,
      presence_expired: true,
      presence_events: [{ outcome: "expired", dismissed_by: null }],
    });
  });
});
