# Design: `plugin-multiplayer-chat` (real-time chat room)

**Status:** draft for review · **Author:** design pass with Hannah · **Date:** 2026-07-07

This is the first plugin in the repo built on the **real-time** side of the multiplayer API
(`subscribe`), as opposed to the barrier-based `push → wait` model that `plugin-multiplayer-role`
and `plugin-multiplayer-sync` use. It is the "something real-time" roadmap item.

---

## 1. What makes this different from sync

| | role / sync | chat |
|---|---|---|
| Shape | one-shot barrier | continuously-open trial |
| API used | `push` / `getAll` / `wait` | `push` / `getAll` / **`subscribe`** |
| Ends when | a condition resolves once | a timer, a button, or a group condition |
| Re-renders | no | on **every** group-session update |

Nothing we've shipped exercises `subscribe` yet, so this plugin is also where we first prove out a
**mock-`subscribe` test harness** (see §7). That harness is the main thing to de-risk early.

---

## 2. Data model — the crux

`push(data)` writes into **this participant's own slot** in the group session
(`participantId → data`), and it **REPLACES the whole slot** — it does *not* merge.
**✅ VERIFIED (2026-07-07):** the JATOS adapter does `jatos.groupSession.set(participantId, data)`
(a whole-slot set, `index.ts:170`); the sync mock documents the same (`index.spec.ts:30`,
"overwrite-per-participant, like the real adapter"). The earlier "ultimatum pushes offer then
decision" reasoning was a misreading — those come from *different* participants, so no slot ever
merges two pushes. **The workaround already lives in our own role plugin** (`index.ts:156–165`):
read your own slot first, then push the whole thing back with only your key changed.

A chat needs *history*, but a participant only owns one slot. So each participant keeps an
**append-only array of their own messages** under a namespaced key, and the view is the **merge of
everyone's arrays**:

```
groupSession = {
  "p1": { chat_messages: [ {id, text, ts, seq}, {…} ], /* offer, role, … untouched */ },
  "p2": { chat_messages: [ {…} ] },
}
```

- **Send** = read my **whole** slot, append to my `chat_messages`, and push the whole slot back so
  push's replace doesn't wipe my role/offer data (the role plugin's pattern):
  ```ts
  const mine = api.get(myId) ?? {};                 // my current slot
  const arr  = appendOwnMessage(mine[data_key] ?? [], text, myId, seq, Date.now());
  await api.push({ ...mine, [data_key]: arr });      // spread the slot, replace only my key
  ```
- **View** = flatten every participant's `chat_messages`, sort, dedup, render.

### Message shape

```ts
interface ChatMessage {
  id: string;      // `${senderId}#${seq}` — stable, for dedup + idempotent render
  senderId: string;
  seq: number;     // per-sender monotonic counter (0,1,2,…)
  text: string;
  ts: number;      // Date.now() on the SENDER's clock
}
```

### Ordering (known limitation)

`ts` comes from each sender's wall clock, which is **not synchronized across clients**, so strict
global order is impossible without a server timestamp. For a demo we sort by
**`(ts, senderId, seq)`** — deterministic and tie-broken, good enough that messages from one sender
never reorder among themselves. **Open question:** accept clock-skew ordering for the demo, or is
this worth a Lamport-style counter? (Recommend: accept it, document it.)

---

## 3. Public API (`info`)

Mirrors sync's declarative style — the goal is "almost no chat code in the experiment."

### Parameters

| param | type | default | purpose |
|---|---|---|---|
| `prompt` | HTML_STRING | `""` | instructions rendered above the transcript |
| `placeholder` | STRING | `"Type a message…"` | input placeholder |
| `data_key` | STRING | `"chat_messages"` | group-session field this trial owns (namespacing) |
| `duration` | INT | `null` | auto-end after N ms (null = no time limit) |
| `end_button_label` | STRING | `null` | show a "leave/done" button; null = no button |
| `end_when` | FUNCTION | `null` | predicate over group session; end when it returns true (e.g. everyone pressed done). Evaluated on each update. |
| `sender_label` | FUNCTION | `null` | `(senderId, group) => string` display name; default renders "You" for self, senderId otherwise. Lets the ultimatum-style role output drive names. |
| `max_length` | INT | `null` | optional per-message char cap |
| `show_roster` | BOOL | `false` | render the list of participants who have a slot |

At least one end condition (`duration`, `end_button_label`, or `end_when`) **should** be set;
if none is, warn (like role's group_size/ready warning) — otherwise the trial can never end.

### Trial data (output)

| field | type | meaning |
|---|---|---|
| `transcript` | OBJECT | ordered `ChatMessage[]` at trial end |
| `message_count` | INT | total messages seen |
| `messages_sent` | INT | how many this participant sent |
| `chat_time` | INT | ms from trial start to end |
| `ended_by` | STRING | `"duration"` \| `"button"` \| `"condition"` |

---

## 4. Lifecycle (`trial()`)

```
1. api = pluginAPI as unknown as MultiplayerApiLike   // the one cast, as in sync
2. render shell: prompt · transcript container · [roster] · input + send · [end button]
3. on_load?.()                                        // Promise trial → fire manually
4. seed transcript from mergeMessages(api.getAll())   // replay of existing history
5. unsubscribe = api.subscribe((group) => {
       renderTranscript(mergeMessages(group))          // dedup + sort, idempotent
       if (end_when?.(group)) end("condition")
   })
6. input handlers:
     - send: build ChatMessage(seq++), append to own array, api.push({[data_key]: arr})
              (optimistic local render; escape text — see §6)
     - Enter submits, Shift+Enter newline
7. if duration: timer = setTimeout(() => end("duration"), duration)
8. if end_button: click → end("button")

end(reason):
   - unsubscribe(); clearTimeout(timer); detach listeners   // no leaks, every path
   - finishTrial({ transcript, message_count, messages_sent, chat_time, ended_by: reason })
```

`subscribe` replays current state on registration (core does this on top of the future-only
adapter), so step 4's manual seed is belt-and-suspenders — harmless if it double-fires because
render is **idempotent** (keyed by message `id`).

---

## 5. Internal structure — pure core + thin wrapper

Same discipline that earned the `assignRoles` extraction. Keep the logic pure and unit-testable,
keep the DOM/API glue thin. **Not** extracting a generic "real-time plugin" yet — that abstraction
gets earned when a *second* consumer (scoreboard / real-time example) shows up.

> **Corollary (note, don't act yet):** chat is now the *third* consumer of "update my own slot
> without destroying its other keys" — the role plugin already does it, chat needs it, and sync
> arguably should offer it. A shared read-before-push helper (or a documented convention) may
> eventually be worth it, but per the discipline above, earn it later. Also worth one sentence in
> the ultimatum demo's notes: a sync-plugin push mid-game already wipes role metadata from the slot;
> it's harmless there (join_order falls back to `joinedAt ?? 0` + `byId`, spectator never reads peer
> roles), but it confirms the replace-semantics footgun is live in the codebase today.

```
src/
  chat-core.ts     # PURE, no jsPsych, no DOM — fully unit-tested
  index.ts         # the JsPsychPlugin wrapper (DOM + api glue)
  multiplayer-api.ts  # local interface mirror (extends sync's with subscribe)
  index.spec.ts    # trial-level tests against the mock API (§7)
```

`chat-core.ts`:

```ts
export function mergeMessages(group: GroupSessionData, dataKey: string): ChatMessage[]
export function appendOwnMessage(own: ChatMessage[], text: string, senderId, seq, now): ChatMessage[]
export function makeMessageId(senderId: string, seq: number): string
```

`multiplayer-api.ts` extends the sync mirror:

```ts
export type Unsubscribe = () => void;
export interface MultiplayerApiLike {
  /** This participant's stable id (set by connect()); needed for senderId and reading own slot. */
  readonly participantId: string;
  /** Read one participant's slot — used to read-before-push so a send doesn't clobber other keys. */
  get(participantId: string): Record<string, unknown> | undefined;
  push(data: Record<string, unknown>): Promise<void>;
  getAll(): GroupSessionData;
  subscribe(callback: (data: GroupSessionData) => void): Unsubscribe;
}
```
(No `wait` — `end_when` is checked inside the single subscription, so we don't need a second
mechanism. `participantId` + `get` are what make the read-before-push in §2 possible, mirroring the
role plugin's local interface.)

---

## 6. Robustness (pre-empting the review round)

- **XSS — render with `textContent`, never `innerHTML`, for message text.** Chat renders untrusted
  user input; this is non-negotiable. `prompt`/`placeholder` are experimenter-authored so
  HTML_STRING is fine there.
- **Defensive subscribe callback** — wrap render in try/catch so one bad frame can't tear down the
  subscription.
- **Send failure** — a rejected `push` shows an inline "couldn't send" note and re-enables the
  input; it does **not** crash the trial (unlike sync, where a push failure is fatal — here sending
  is best-effort and recoverable).
- **Render coalescing** — bursts of updates coalesce via one `requestAnimationFrame` to avoid
  thrash. (Optional; note it.)
- **Cleanup on every exit path** — `unsubscribe()` + `clearTimeout` + listener removal, or we leak a
  live subscription into the next trial.
- **Autoscroll** — pin to bottom on new messages unless the user has scrolled up.
- **Payload growth** — each send re-pushes the *entire* history array (plus the whole slot,
  post-fix), so bytes-on-the-wire grow ~quadratically with message count, and JATOS group sessions
  have a size cap. Fine for a demo; add an optional `max_messages` history cap and/or a README
  caveat.
- **Transcript divergence** — `duration` timers start at slightly different moments per client (the
  same per-client-timeout tradeoff documented for the ultimatum demo in commit `86edfef`), so
  transcripts saved by different participants can differ at the tail. Document in the trial-data
  docs: *"transcript is this client's view at its own trial end."*

---

## 7. Test harness — the genuinely new part

No existing package mocks `subscribe`. Build a `MockMultiplayerApi`:

```ts
class MockMultiplayerApi implements MultiplayerApiLike {
  store: GroupSessionData = {};
  subs = new Set<(g) => void>();
  constructor(public selfId = "self") {}

  get(id) { return this.store[id]; }
  async push(data) {                       // REPLACE self's slot, then notify — like the real adapter
    this.store[this.selfId] = data;        // NOT a merge; the plugin must spread its own slot itself
    this.fire();
  }
  getAll() { return this.store; }
  subscribe(cb) { this.subs.add(cb); cb(this.getAll()); return () => this.subs.delete(cb); }

  // test helper: simulate a peer (also replace, matching real semantics)
  pushAs(id, data) {
    this.store[id] = data;
    this.fire();
  }
  private fire() { for (const cb of this.subs) cb(this.getAll()); }
}
```

### Test cases

- **core** (`chat-core.spec.ts`): merge across participants; sort by `(ts, senderId, seq)`; dedup by
  id; append increments seq; empty/malformed slots ignored.
- **trial** (`index.spec.ts`):
  - seeds transcript from pre-existing history on load
  - typing + send pushes `{chat_messages}` and renders own message
  - `pushAs("peer", …)` re-renders with the peer's message (proves the subscription)
  - ends on `duration` (jest fake timers) → `ended_by:"duration"`
  - ends on `end_button_label` click → `ended_by:"button"`
  - ends on `end_when` becoming true → `ended_by:"condition"`
  - **sending preserves unrelated keys in my own slot** — pre-seed self's slot with `{role:"…"}`,
    send a message, assert both `role` and `chat_messages` survive. (With a *replace* mock, this is
    the test that catches the crux; a merge mock would hide it.)
  - `unsubscribe` called + timer cleared on finish (no leak)
  - message text is escaped (inject `<img onerror>` → asserted as text, not a node)
  - idempotent: a duplicate replay frame doesn't double-render

---

## 8. Package scaffold & branching

- **Branch `plugin-multiplayer-chat` off `origin/main`** — its own PR, mirroring #15–#17. No
  stacking.
- Files mirror sync exactly: `package.json` (`@jspsych-multiplayer/plugin-multiplayer-chat`,
  jspsych peerDep `>=8.0.0`), `tsconfig` (extends `@jspsych/config/tsconfig.contrib.json`),
  `rollup.config.mjs` (`makeRollupConfig("jsPsychMultiplayerChat")`), `jest.config.cjs`, `README`,
  `CITATION.cff` (placeholder), a minor changeset. `dist/` gitignored.
- Public API = **statics on the default export** (named re-exports break the contrib rollup's
  `output.exports:"default"`).
- **Chat-room example** comes later on a *separate* branch off `origin/main`, referencing
  `../packages/plugin-multiplayer-chat/dist/index.browser.js` by relative path (the #18 pattern) —
  no git coupling; merge order (plugin → example) is social.

---

## 9. Open questions for review

1. **Ordering:** accept `ts`-based sort with its clock-skew caveat for the demo? — **RESOLVED: yes.**
   (If ever needed, a Lamport-ish `seq = maxSeqSeen + 1` is ~3 lines in chat-core; not worth it now.)
2. **`push` semantics:** ~~confirm shallow-merge~~ — **RESOLVED: push REPLACES the slot** (verified,
   §2). Adopt the role plugin's read-before-push. Whole data model updated accordingly.
3. **End conditions:** — **RESOLVED: keep the trio, don't add "host ends for everyone."** It's
   already expressible as a README recipe: `end_when: (g) => Object.values(g).some(p => p.chat_done)`
   plus a pushed `chat_done` flag. Fewer params, same power.
4. **Display names:** — **RESOLVED: `sender_label(id, group)` is enough**; keep packages decoupled.
   The chat-room example is where we show `sender_label` driven by
   `jsPsychMultiplayerRole.participantsByRole()` — composition demo beats a hard dependency.
5. **Monolithic now, extract later** — **RESOLVED: yes.** The scoreboard plugin is the natural
   second consumer that will earn the shared real-time-primitive extraction.
```
