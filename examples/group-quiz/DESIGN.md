# Group Quiz Demo — Design

The design record for `examples/group-quiz/`: a live, Kahoot-style quiz built on the multiplayer
packages. An audience opens one URL, one person picks **Host** (the presenter screen), everyone else
picks **Player** (their phone), and results appear live on the shared screen.

It is this repo's demo of the **asymmetric** coordination pattern — one authoritative driver plus
many followers — in contrast to `ultimatum-game-jatos.html`, where every client runs the same
timeline and coordination is by deterministic consensus.

---

## The core idea

Everything lives on one shared object — the **session scope** of the group's shared data, a map
keyed by participant ID. The host runs no trials, so its reads and writes use the session scope by
default; the players run a jsPsych timeline, where calls default to the running trial's own part of
the data, so they pass `{ scope: "session" }` on every protocol read and write. **Each participant
writes ONLY their own key.** There are two kinds of participant:

- **The host** (the presenter screen). Writes one key: the game state — the source of truth for what
  phase the game is in and which question is live.
- **The players** (phones). Each writes their own key: their name, answers, and running score.

Players **read** the host's entry to know what to show. The host **reads** all players' entries to
render the lobby, the live answer count, and the leaderboard. Nobody overwrites anyone else.

```
HOST key:    { role:"host", phase:"question", questionIndex:2, questionStartTime:1718…, step:9 }
PLAYER keys: { role:"player", name:"Alice", totalScore:1840, answers:{ 0:{choice:1,timeMs:1200}, … } }
             { role:"player", name:"Bob",   totalScore:2100, answers:{ 0:{choice:3,timeMs:800},  … } }
```

## The shared contract

`examples/group-quiz/protocol.js` holds it, and is loaded by **both** roles. It is deliberately
dependency-free — plain functions over the group session — because the host view is vanilla JS with
no jsPsych instance to hang a plugin off.

### Phases

`lobby` → `question` → `reveal` → `leaderboard` → (next question…) → `ended`

| phase         | host shows                                | player shows                |
| ------------- | ----------------------------------------- | --------------------------- |
| `lobby`       | joined player names, "Start" button       | name entry, then "waiting…" |
| `question`    | the question + live answer count + timer  | question + answer buttons   |
| `reveal`      | correct answer + answer distribution      | "you were right/wrong"      |
| `leaderboard` | top scores                                | their rank/score            |
| `ended`       | final podium                              | final score                 |

### Scoring

`points = correct ? base + speedBonus : 0`, with `base = 1000` and
`speedBonus = round(1000 × (1 − timeMs / questionDurationMs))`, floored at 0. A pure function
(`scoreAnswer`) so it is identical on every client.

### The answer key is host-only by design

`questions.js` carries `correct`, and the protocol keeps **correctness a host decision**: players
write only their `choice`, and the host publishes `correctChoice` at `reveal`. If players could read
the key before `reveal`, anyone could win from devtools.

The demo compromises on this for convenience: `index.html` is a single file serving both roles, so it
loads `questions.js` for **both**. That is fine for a demo and stated in the file's header. For
anything scored for real, serve the key only to the host — a separate host-only JATOS component, or
correctness scoring off the client entirely. The protocol shape already supports that; only the
`<script>` tag has to move.

---

## The monotonic step counter (the load-bearing decision)

The host advances by overwriting its `phase` field, and **JATOS does not guarantee a client observes
every intermediate snapshot** — a lagging client can receive a snapshot that has already skipped past
a phase.

That makes the obvious barrier wrong:

```js
wait_for: (group) => group[hostId]?.phase === PHASES.REVEAL   // ✗ deadlocks
```

If the client's next snapshot jumps from `question` straight to `leaderboard`, the `=== "reveal"`
test becomes **permanently unsatisfiable** and that player hangs forever.

So every host write also carries a `step`: a number that **only ever increases**
(`questionIndex × 4 + phaseOrder`). Players wait on

```js
wait_for: (group) => hostStepValue(group) >= phaseStep(lastQuestionIndex, PHASES.REVEAL)   // ✓
```

A `>=` test against a monotonic value **can never be missed** — once true, it stays true. A player
who skipped a snapshot still passes the barrier, just later and without having rendered the phase it
missed. `ENDED` is `Number.MAX_SAFE_INTEGER`, so it satisfies every barrier's `>=` and lets a
straggler fall straight through to the end screen instead of waiting on a phase that will never come.

This is the generalizable lesson from the demo: **on a snapshot-based transport, barrier predicates
must be monotone.** Anything of the form "the shared state currently equals X" is a latent deadlock;
"the shared state has reached at least X" is not.

---

## Composition: why this demo hand-rolls what plugins exist for

This repo has `scoreboard`, `countdown`, `choice`, `vote`, `ready`, and `role` plugins, and
`ultimatum-game-jatos.html` was deliberately rewritten to compose packages rather than hand-roll
coordination. This demo was **not**, and the reason is structural rather than historical:

- **The host view is not a jsPsych timeline.** It is vanilla JS calling `jsPsych.multiplayer` without
  running a timeline, because a presenter screen reacts continuously (`subscribe`) rather than
  advancing through trials. Plugins
  are trials; there is nowhere to put one. Half the game is therefore out of reach by construction.
- **`sync` waits on its own trial's data.** The host's state lives in the session scope (the host
  has no trials to scope it to), so a sync barrier's `wait_for` would never see it. Each player
  barrier is instead a small `call-function` trial around `jsPsych.multiplayer.wait(condition,
  { scope: "session", participants: [hostId] })`.
- **`countdown` resolves the consensus start as the _minimum_ start timestamp across all slots** —
  peer-to-peer agreement with no authority. This quiz's clock is **host-authoritative**: the host
  stamps `questionStartTime` and every player derives from it. Substituting min-across-slots would
  let an early-joining player's timestamp pull the deadline earlier than the host's own question, and
  the host's countdown (which drives the auto-advance to `reveal`) can't participate anyway.
- **`choice` barriers until _all_ players have chosen, then reveals.** The quiz needs a per-player
  private answer with a **host-timed** reveal, plus speed-based scoring off the individual response
  time, plus a `trial_duration` cutoff that scores a non-answer. That is `html-button-response` with
  a custom `button_html`, not a group decision primitive.
- **`scoreboard`'s `buildLeaderboard` static is the closest fit** — but it expects entries shaped
  `{ [dataKey]: { score, label } }`, while this protocol's player shape is flat
  (`{ role, name, totalScore, answers }`) and the ranking is also needed by the host page, which
  loads no plugins. Adopting it would mean reshaping the wire contract and shipping a plugin bundle
  to the host purely to get a sort — for a nine-line pure function.
- **`role` assigns by deterministic consensus.** Here the role is a **deliberate human choice**
  (the presenter clicks "I'm the Host"), which is the point of the demo.

The composition-first demos are `ultimatum-game-jatos.html`, `scoreboard-room.html`, and
`match-room.html`. This one earns its place by showing the other half: what the raw primitives
(`update` / `subscribe` / `getAll` / `wait`) look like when a demo genuinely needs them — every one of
the player's four "wait for the host" points is one call to a shared `hostBarrier()` helper around
`wait()`, rather than bespoke coordination code.

---

## Known limitations

- **A host who leaves ends the game.** The player's mid-game barriers (`revealBarrier`,
  `leaderboardBarrier`, `nextQuestionBarrier`) name the host in `participants`. If the host closes
  the presenter screen, each wait fails with a `participant_left` error once the host counts as
  `left` (after the dropout timeout, 10 s by default), and every player skips to the end screen. A
  reloaded host page counts as having left too. There is no host hand-over. The barriers have no
  `timeout`, because a presenter pausing between questions while still connected is normal.
- **Group size is unproven at audience scale.** JATOS group studies were designed for small groups,
  and the "room full of phones" premise assumes the group session stays responsive with ~20+
  members writing. That has not been load-tested. It is the demo's single biggest risk, and it is a
  property of the JATOS backend, not of these packages.
- **Single host, no election.** Whoever clicks "I'm the Host" first is the host; a second person
  clicking it produces a second `role: "host"` entry and `getHostId` picks whichever key iterates
  first. Fine for a presenter-driven demo, wrong for anything unsupervised.
- **Late joiners skip to the current question.** A player who joins mid-game passes the lobby barrier
  immediately (the host's step is already past question 0) and joins at the live question with a
  score of 0. There is no catch-up.

## Packaging

`npm run build:jatos:group-quiz` produces `dist/group-quiz-jatos.jzip` for import into JATOS — one
study, one component, one link for everyone. See `scripts/build-jatos-group-quiz.js`. Until
[jsPsych#3694](https://github.com/jspsych/jsPsych/pull/3694) ships, the bundled jsPsych core lacks
`jsPsych.multiplayer`, so the archive imports cleanly but fails at `connect()`.
