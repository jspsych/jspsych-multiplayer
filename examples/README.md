# Examples

End-to-end demos that compose the multiplayer packages in this repo.

## `chat-room.html`

A real-time **chat room**: participants pick a display name, wait in a lobby until enough people have
joined, then chat in a shared room for a fixed time. It is the demo for the real-time side of the
multiplayer API (`subscribe`), and — because it runs on the local adapter — the one example you can
drive **entirely from two browser tabs**, no server.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-local` | The network backend — `localStorage` + cross-tab signalling. Connected once, before `jsPsych.run`. **Dev/demo only.**   |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | The lobby: one declarative barrier — push your name, wait until at least `MIN_PLAYERS` participants are present.         |
| `@jspsych-multiplayer/plugin-multiplayer-chat`   | The room: a continuously-open trial that renders the merged transcript and lets this participant send messages.         |

Two small composition details are worth copying:

1. **Names are published in the lobby and reused by the chat.** The lobby's `push_data` writes
   `{ name, joinedAt }` into the participant's slot. The chat plugin preserves it: when it sends a
   message it reads its own slot and rewrites only the chat key, so `name` stays available. The chat
   trial's `sender_label` then labels each message by name (and this client's own messages as "You",
   by comparing `senderId` against the adapter's `participantId`).
2. **The lobby counts only entries that carry a name.** `wait_for` filters on `entry.name` rather
   than a bare head-count, so a peer still mid-handshake — present in the group session but without a
   published name yet — doesn't tip the room over its threshold before it can be labelled.

### Swapping in a real backend

The demo connects `adapter-multiplayer-local` because it needs no infrastructure. To run a real,
cross-device study, change the one adapter line to `adapter-multiplayer-jatos` (and load `jatos.js` /
wrap `jsPsych.run` in `jatos.onLoad`, as in `ultimatum-game.html`). Nothing else in the timeline is
backend-specific — the lobby and chat trials are identical either way.

### Running it

Unlike the JATOS demos, this example needs **no server infrastructure** — but connecting any adapter
still requires the multiplayer API from [jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694),
which hasn't merged/released yet. Two ways to get that API today:

#### Running it today (pre-#3694): jsDelivr preview build

jsPsych's PR bot publishes a preview build of every commit on #3694, hosted on jsDelivr — no release,
no vendoring #3694's types locally. `chat-room.html` is wired to use it already:

1. Find the current preview link: open [#3694](https://github.com/jspsych/jsPsych/pull/3694), find the
   pinned bot comment titled "📦 Preview build ready," and copy the `jspsych` URL under "All package
   URLs" (plus the matching `jspsych.css` URL). **This link is pinned to a commit SHA and goes stale on
   every new PR commit** — `chat-room.html`'s `<script>`/`<link>` tags carry the SHA that was current
   when this was last verified; if the demo stops loading, this is the first thing to check and
   re-pin. Don't commit-and-forget a pinned URL into every example — this one recipe, re-run as needed,
   is the durable fix.

2. Build the multiplayer packages from the repo root (their `dist/` is gitignored, not checked in):

   ```sh
   npm install && npm run build
   ```

   **If a package's `dist/` already exists and you're not sure it's current**, rebuild anyway — a
   stale `dist/` built before a since-merged fix silently reproduces bugs that were already fixed
   upstream (this bit us once: `plugin-multiplayer-chat`'s `dist/` predated its own "make `trial()`
   synchronous" fix by two hours, and the symptom looked like a jsPsych-core race condition rather
   than a stale artifact).

3. Serve the repo over http(s) — **don't** open the file from a `file://` URL, where `localStorage`
   origin behavior varies by browser:

   ```sh
   npx http-server .
   ```

4. Open the printed URL to `examples/chat-room.html` in one tab. On first load the local adapter mints
   a fresh session and writes it into the URL as `?mp_session=…`. **Copy that full URL** (including
   `?mp_session=…`) into a second tab to bring another player into the same room. Opening the bare
   URL again would start a different session.

Verified working end-to-end this way: name entry → lobby → live chat → message delivery across two
tabs, zero console errors.

#### Running it after #3694 merges

Once #3694 releases, swap `chat-room.html`'s jsPsych `<script>`/`<link>` tags back to the published
`jspsych` package (e.g. `https://unpkg.com/jspsych`) and repeat steps 2–4 above — nothing else in the
timeline changes.

Because the local adapter is same-origin, same-browser, same-machine, this is a development and demo
tool only — not for data collection. For real, multi-participant data use JATOS or another networked
adapter.

## `ultimatum-game.html`

A turn-based **ultimatum game** (Güth, Schmittberger & Schwarze, 1982): two players split a $10 pot.
The **proposer** offers the **responder** some amount; the responder accepts (both keep the split) or
rejects (both get nothing). It is the flagship demo for the multiplayer packages, and shows how an
experiment can carry almost no synchronization or coordination code of its own.

### What it demonstrates

| Package                                          | Role in the demo                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `@jspsych-multiplayer/adapter-multiplayer-jatos` | The network backend — JATOS group session + channel. Connected once, before `jsPsych.run`.                           |
| `@jspsych-multiplayer/plugin-multiplayer-role`   | Assigns proposer/responder by **deterministic consensus**, with a `spectator` overflow role for extra arrivals.      |
| `@jspsych-multiplayer/plugin-multiplayer-sync`   | Each "wait for the other player" point — the lobby, the offer, the decision — is a single declarative barrier trial. |

See the `ultimatum-game.html` header comment for the full walkthrough of its role-assignment,
mid-game `joinedAt` preservation, population model, and abandonment handling. It is **illustrative** —
it requires jsPsych#3694, the JATOS environment, and at least two real participants in the same group.
