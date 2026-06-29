# Plan: `plugin-multiplayer-role` — a role-assignment plugin for the jsPsych multiplayer API

> **Status:** design proposal, converged after five review passes — implementation-ready pending the
> external API verifications in §1.
> **Target repo:** `jspsych-multiplayer` (community plugins/adapters).
> **Depends on:** the jsPsych multiplayer API (jsPsych **PR #3694**), available in jsPsych v8+.
> *(The repo README still references the older PR #3692; #3694 is the current PR — the README should
> be updated separately.)*
>
> **Revision note (post-review):** the gate now keys on *data readiness*, not participant count
> (§7, the correctness-critical change); the wrapper builds on `api.wait()` instead of a hand-rolled
> `subscribe` loop (§7); the core output shape reserves a `group` field for future matching (§5, §8);
> a direct attribute-lookup strategy `role_from` was added (§4); overflow throws by default (§6);
> and the open questions are resolved in §9. Original design intent is unchanged — only sharpened.
>
> **Revision note (2nd pass):** the readiness gate now uses an **exact-count** check, not `>=` (§7) —
> closing a set-membership divergence where late joiners let two clients assign over different
> populations; `overflowRole` is correspondingly scoped to the utility and the `group_size == null`
> path, and that path's no-late-joiner guarantee is stated as an upstream-barrier contract the plugin
> cannot enforce. Also: added an explicit "verify the API surface (esp. `wait`) first" callout (§1),
> a `join_order` clock-skew caveat (§4), a note that the ultimatum demo must be reconstructed not
> copied (§10), and a late-joiner/over-count test case (§10).
>
> **Revision note (3rd pass):** §7 is **reframed** — membership consensus is an *upstream "capped,
> agreed set of N" contract*, not something the gate can manufacture; the prior "`===` closes the
> divergence" claim is retracted, and `===` is now justified honestly as a deliberate **fail-loud**
> choice (stall→timeout on contract violation) over `>=`'s fail-silent subset assignment. Also closed
> three concrete holes the reframing exposed: a **TOCTOU** between `wait` resolving and `getAll()`
> (now assign over the snapshot `wait` hands back — added to the §1 `wait` checklist with resolver-
> snapshot + timeout questions); a **missing timeout path** (mandatory `timeout`, default 30 s →
> `role: null, timed_out: true`); and **undefined repeated-push semantics** across rounds (first-seen
> `joinedAt`, per-round data namespaced under `rounds[round]`). Added `role_from` validation against
> declared roles, and multi-round/timeout/overshoot test cases (§10).
>
> **Revision note (verification spike):** ran the §1 `wait` verification against PR #3694's API
> reference. Findings reshaped §6: `wait(condition, timeout)` takes a **positional** timeout (not an
> options object) and **rejects** on expiry (not a `null`-resolve), so the wrapper now uses
> `.then(...).catch(handleTimeout)`; and it **resolves with the satisfying snapshot**, confirming the
> TOCTOU design. §1 records all four checks as ✅ (re-confirm against merged source); the
> `subscribe` unsubscribe handle moots the old `cancelAllSubscriptions` worry.
>
> **Revision note (4th pass):** closed the seam the round-scoping opened — `rank_by`/`role_from` now
> take a **`ctx` argument** (`{ ids, round, seed }`) so they can reach round-scoped data at
> `entry.rounds[ctx.round]`; threaded through the core call sites and the §7 predicate. Documented
> that the **default 30 s timeout means different things** in the two modes (generous slack when
> composing after a lobby; premature when self-gating — keep arrival-waiting upstream). Nits:
> `handleTimeout` now **always** `finishTrial`s even after an `on_timeout` hook; `setMyAssignment`'s
> map arg is optional; and the round-scoping's reliance on read-back-consistent local writes
> (`api.get(self)`) is flagged as an adapter contract to verify.
>
> **Revision note (5th pass):** fixed a bug the `ctx` change introduced — the readiness predicate
> calls `rank_by`/`role_from` speculatively *before* round data lands, so the natural accessor
> (`e => e.rounds[round].score`) **throws** mid-poll instead of reading falsy; the predicate now wraps
> each accessor call in `try/catch` and treats a throw as "not ready yet" (also shields `role_from`
> and custom `ready`). Synced the §4 table to the 3-arg `(entry, id, ctx)` signatures. Nits: dropped
> the unused `display` param from `handleTimeout`; added an `assigned_self` data field so
> "assigned-but-I'm-not-in-it" is distinguishable from a timeout.

## 1. Background & motivation

### The multiplayer API
jsPsych is gaining an opt-in, real-time multiplayer API via PR #3694. It has two layers:

- A backend-agnostic **`MultiplayerAPI`** on `jsPsych.pluginAPI`, exposing the primitives:
  `connect` / `disconnect`, `push(data)`, `get(key)` / `getAll()`, `subscribe(cb)`,
  `wait(predicate)`, `communicate(message)`, and a `participantId` property.
  *(Note: `subscribe` conventionally returns an unsubscribe handle; a global "cancel all
  subscriptions" call is **not** assumed by this design — see §7. Verify `subscribe`'s exact return
  contract against the merged API before implementation.)*

> **Single biggest external dependency — verify the API surface first.** The entire wrapper rests on
> `push`, `wait`, `getAll`, and `participantId` existing on `jsPsych.pluginAPI` with the assumed
> shapes. Critically, the README's **adapter** interface list (`connect`, `push`, `getAll`, `get`,
> `subscribe`, `disconnect`) does **not** include `wait` — `wait` is presumably a **high-level
> `MultiplayerAPI`** method, not an adapter method. The four facts the gate (§6/§7) depends on were
> **verified against PR #3694's `jspsych-multiplayer.md` API reference** (re-confirm against the
> merged source, since the PR can still change):
> 1. **Existence** — ✅ `wait` is on `jsPsych.pluginAPI`.
> 2. **Resolves once, on first edge** — ✅ resolves when the predicate first becomes true, with an
>    immediate fast-path if already true; "does not poll."
> 3. **Resolves *with* the satisfying snapshot** — ✅ `wait(condition, timeout)` returns
>    `Promise<GroupSessionData>` resolving with the snapshot at the moment the condition first holds.
>    The wrapper assigns over that snapshot to avoid a **TOCTOU race** (a fresh `getAll()` could have
>    drifted). Closed.
> 4. **Timeout behavior** — ✅ `timeout` is an **optional positional number (ms)**; on expiry the
>    Promise **rejects** with a timeout error (it does *not* resolve with `null`). The wrapper handles
>    this via `.catch()` (§6).
>
> Supporting facts also confirmed: `push(data) → Promise<void>` (resolves on backend confirm);
> `getAll() → GroupSessionData` (sync); `get(participantId) → entry | undefined` (sync);
> `subscribe(cb) → Unsubscribe` (fires on every update + once immediately). The earlier
> "cancelAllSubscriptions" worry is therefore moot — `subscribe` returns an unsubscribe handle.
> Were any of (2)–(4) to differ in the merged build, the gate moves from `wait` to `subscribe` —
> architecture unchanged, only the primitive underneath.
- A swappable **`MultiplayerAdapter`** implementing network I/O for a specific backend
  (the reference adapter targets JATOS group sessions).

The core repo ships one reference plugin, **`plugin-multiplayer-sync`** — a generic
*synchronization barrier*: optionally `push` data, show a waiting message, wait on a `wait_for`
predicate over the group snapshot, end the trial when it is satisfied (or on timeout). A "waiting
room" is just this plugin with a player-count predicate.

### The gap
There is **no role-assignment plugin**. In the PR's own examples
(`multiplayer-ultimatum-game.html`), role assignment is hand-rolled inside the lobby trial:

```js
const sortedIds = Object.keys(group).sort();
const activePlayers = sortedIds.slice(0, 2);
proposerId  = activePlayers[0];
responderId = activePlayers[1];
myRole = jsPsych.pluginAPI.participantId === proposerId ? "proposer" : "responder";
// then branch the timeline via conditional_function: () => myRole === "proposer"
```

This works but pushes a subtle, error-prone problem onto every researcher.

### Why this is worth a plugin: deterministic consensus
In a peer/group-session model there is **no referee**. Every client must *independently* compute the
**same** role map from shared state. If two browsers each conclude "I am the proposer" due to a race
or an unstable ordering, the study is silently broken. Getting this right generalizes cleanly and is
**independent of what the roles mean**, so it is worth packaging. The semantics of a role are
irreducible domain knowledge and are deliberately **not** generalized — the researcher supplies only
role names and counts.

> **Where consensus risk actually lives.** The pure core (§5) is deterministic by construction: same
> snapshot in, same map out — tautologically safe. The real risk is in the wrapper deciding *which
> snapshot* each client feeds the core. Two clients can each run the deterministic function on
> *different, partially-propagated* snapshots and disagree. Therefore the **readiness gate (§7) is
> the heart of this design's correctness**, not an implementation detail.

## 2. Goals & non-goals

### Goals
- Replace the hand-rolled pattern with a declarative, drop-in timeline node.
- Make the common case trivial (declare role names + counts) while keeping unusual cases possible.
- Guarantee deterministic, cross-client-consistent assignment **including the gate that decides when
  it is safe to assign**.
- Support join-order, seeded-random, rotation, attribute/outcome ranking, and direct attribute
  lookup.
- Provide an ergonomic way for later trials to read "my role".

### Non-goals (for v1)
- **Partition / matching into subgroups** (e.g. 8 players → 4 dyads) — *deferred but the output
  shape is reserved for it now* (§5, §8); this is the one deferral with a real forward-compat
  implication.
- **Self-selection** (participants claim roles first-come-first-served) — a contention problem with a
  different mechanism; candidate for a separate plugin.
- **Counterbalancing roles across the whole study** — needs global/cross-group state. *(Note:
  counterbalancing within a group across rounds is deterministic from the round number and **is** in
  scope — see `rotate` / `balanced` in §4.)*
- **Bot/confederate role-filling** — overlaps with dropout handling; defer.
- **Reconnection robustness** beyond a documented caveat (§7).

## 3. Architecture: ship two layers

Agreed approach — a pure, well-tested core plus an ergonomic wrapper:

1. **Pure utility** `assignRoles(snapshot, options) -> roleMap`. No jsPsych dependency, no I/O,
   fully unit-testable. Serves power users and outcome-based / mid-experiment assignment.
2. **Thin plugin** `plugin-multiplayer-role` that wraps the utility plus **the readiness gate**
   (§7), as the ergonomic default. Saves results to data and updates a role accessor.

Rationale: the wrapper makes the 90% case a one-liner; the utility keeps unusual cases possible
without fighting the plugin. Standard "pure core + ergonomic wrapper" pattern, and it resolves the
"too vague vs. too much researcher work" tension.

## 4. Assignment strategies

All strategies except self-selection reduce to **a pure function from a (ready) group snapshot to a
role map**, differing only in how participants are ordered or looked up:

| Strategy | Mechanism | Form | Readiness requirement (§7) |
|---|---|---|---|
| `join_order` | order by pushed `joinedAt` (falls back to id order) | built-in preset | every participant has `joinedAt` |
| `random` | shared-seeded Fisher–Yates shuffle | built-in preset | ids present (count only) |
| `rotate` | base order rotated by round (`(baseIndex + round) % n`); optional `balanced` | built-in preset; common in iterated games | ids present (count only) |
| ranking | order by a numeric key via `rank_by(entry, id, ctx)` | sugar param | every participant has a finite key |
| **lookup** | role **is** a value each participant carries, via `role_from(entry, id, ctx)` | sugar param | every participant has a defined value |
| custom | anything | `strategy: (snapshot, ctx) => roleMap` | researcher supplies `ready` predicate |

Notes:

- **`rank_by` vs. `role_from`** (both kept; they fill different holes):
  - `rank_by` produces an **ordering** → use for outcome/attribute *ranking* ("higher score → leader").
  - `role_from` is a **grouping-by-value** → use when the role *is* a field the participant already
    carries (assigned at recruitment, by condition, or a URL param: `role = entry.condition`). This
    falls between `rank_by` and `custom` and is cheap, common (pre-registered/between-subjects), and
    still benefits from the wait-and-save machinery. Both keep the researcher supplying only a key/
    value while the plugin owns ordering, tie-breaks, and consensus — unlike `custom`, which
    re-exposes that hard part.
- **`join_order` and clock skew.** `joinedAt` is each client's own `Date.now()` at push time. This
  is *consensus-consistent* (every client reads the same pushed values, so all agree on the order),
  but it means `join_order` reflects pushed-timestamp order, which can **disagree with true
  wall-clock arrival order** across clients with skewed clocks. Fine for fairness-neutral role
  labels; document it so a researcher who assumes "proposer = whoever physically arrived first" isn't
  surprised.
- **Outcome-based assignment** uses this plugin via `rank_by`: run the scoring task → it pushes the
  score → drop the role plugin afterward. The hard part (all clients agreeing) is identical to
  join-order; only *what data is ranked* and *when the trial runs* differ. The plugin is **not**
  appropriate only when there is no cross-client agreement to reach (server-assigned, or
  single-player).
- **`random` must use a shared seed.** Default: hash of the sorted ids **and the round**
  (`[...ids].sort().join("|") + "#" + round`) so all clients agree with no coordinator **and**
  re-randomization across rounds works (a seed of ids alone would reproduce the *same* shuffle every
  round). Researcher may override with an explicit `seed`.
- **`rotate` and balanced counterbalancing.** Plain `rotate` is `(baseIndex + round) % n` — correct
  when role counts are symmetric. With asymmetric counts (`{leader:1, follower:3}`) it does **not**
  guarantee everyone is leader equally often over a session; the rigorous version is a Latin-square
  rotation. Offer an opt-in `balanced: true` for the Latin-square variant and document precisely
  what plain `rotate` does and does not guarantee. Both are deterministic from the round number, so
  both are in scope.

Strategies deliberately **not** given presets (the escape hatches already cover them): stratified/
balanced random (= fixed slots + seeded shuffle, already balanced), weighted/probabilistic roles
(= repeat slots), seniority/cross-session history (needs global state — a non-goal), assortative
matching (= matching with a `rank_by` key — falls out of partitioning once it exists, §8).

## 5. Pure core sketch (`assignRoles`)

```ts
type Snapshot = Record<string, any>;          // participantId -> that player's pushed data

// Output shape reserves `group` for future partitioning/matching (§8) so adding it is non-breaking.
// v1 populates only `role`.
interface RoleAssignment { role: string; group?: number; }
type RoleMap = Record<string, RoleAssignment>;

interface AssignOptions {
  roles: string[] | Record<string, number>;   // ["proposer","responder"] or { leader: 1, follower: 3 }
  strategy?: "join_order" | "random" | "rotate" | ((s: Snapshot, ctx: Ctx) => RoleMap);
  seed?: string;        // shared seed for "random"; defaults to hash of sorted ids + round
  round?: number;       // for "rotate" / "random"
  balanced?: boolean;   // for "rotate": Latin-square variant
  // ctx is REQUIRED in the signature so round-scoped data is reachable: per-round push lives at
  // entry.rounds[ctx.round] (top-level fields like joinedAt stay on entry). The entry is passed
  // whole (not pre-sliced to rounds[r]) precisely because join_order needs the top-level joinedAt.
  rankBy?: (entry: any, id: string, ctx: Ctx) => number;  // ordering key (attribute/outcome ranking)
  roleFrom?: (entry: any, id: string, ctx: Ctx) => string;// direct lookup: role IS this value
  overflowRole?: string; // role for participants beyond declared slots; if unset, overflow throws
}
interface Ctx { ids: string[]; round: number; seed: string; }
// usage: rank_by: (e, _id, { round }) => e.rounds[round].score

function expandSlots(roles: AssignOptions["roles"]): string[] {
  if (Array.isArray(roles)) return [...roles];
  return Object.entries(roles).flatMap(([role, n]) => Array(n).fill(role));
}

// Deterministic PRNG so "random" is identical on every client (mulberry32 + string hash).
function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function orderParticipants(snapshot: Snapshot, opts: AssignOptions, ctx: Ctx): string[] {
  // CRITICAL: always start from a stable, identical base on every client.
  const ids = Object.keys(snapshot).sort();          // stable tie-break by id, always

  if (opts.rankBy) {
    return [...ids].sort((a, b) =>
      opts.rankBy!(snapshot[b], b, ctx) - opts.rankBy!(snapshot[a], a, ctx) || a.localeCompare(b));
  }
  switch (opts.strategy ?? "join_order") {
    case "join_order":
      // join order reflects pushed timestamps (subject to per-client clocks) but is
      // consensus-consistent because every client reads the same pushed joinedAt values.
      return [...ids].sort((a, b) =>
        (snapshot[a]?.joinedAt ?? 0) - (snapshot[b]?.joinedAt ?? 0) || a.localeCompare(b));
    case "rotate": {
      const base = [...ids];
      const k = (opts.round ?? 0) % base.length;
      return base.slice(k).concat(base.slice(0, k));   // `balanced` -> shift by Williams sequence (IMPLEMENTED, see roles.ts balancedRotationShift)
    }
    case "random": {
      const seed = opts.seed ?? `${ids.join("|")}#${opts.round ?? 0}`;  // shared seed, per-round
      const rnd = mulberry32(hashSeed(seed));
      const arr = [...ids];                                             // Fisher–Yates
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    default:
      return ids;
  }
}

export function assignRoles(snapshot: Snapshot, opts: AssignOptions): RoleMap {
  const ids = Object.keys(snapshot).sort();
  const ctx: Ctx = { ids, round: opts.round ?? 0, seed: opts.seed ?? "" };

  if (typeof opts.strategy === "function") {
    return opts.strategy(snapshot, ctx);
  }

  // Direct lookup: role is the value each participant carries.
  if (opts.roleFrom) {
    const declared = new Set(expandSlots(opts.roles));   // validate against declared roles
    const map: RoleMap = {};
    for (const id of ids) {
      const role = opts.roleFrom(snapshot[id], id, ctx);
      if (!declared.has(role)) {                          // loud error on a phantom/typo'd role
        throw new Error(
          `assignRoles: role_from returned "${role}" for ${id}, which is not a declared role ` +
          `(${[...declared].join(", ")}).`);
      }
      map[id] = { role };
    }
    return map;
    // NOTE: role_from does NOT enforce per-role COUNTS (unlike slot assignment). If a design needs
    // "exactly one leader", validate counts separately or use a slot-based strategy.
  }

  const ordered = orderParticipants(snapshot, opts, ctx);
  const slots = expandSlots(opts.roles);
  const map: RoleMap = {};
  ordered.forEach((id, i) => {
    if (i < slots.length) {
      map[id] = { role: slots[i] };
    } else if (opts.overflowRole != null) {
      map[id] = { role: opts.overflowRole };          // explicit overflow (e.g. "spectator")
    } else {
      throw new Error(                                 // loud by default — no silent undefined roles
        `assignRoles: ${ordered.length} participants but only ${slots.length} role slots; ` +
        `set overflowRole to handle extras.`);
    }
  });
  return map;
}
```

The consensus-critical points (flagged in comments): the **always-sorted base order**, the
**shared-seed default (now including round)**, and the **id `localeCompare` tie-break** appended to
every comparator. Overflow is **loud by default** rather than silently `undefined`.

## 6. Plugin wrapper sketch (`plugin-multiplayer-role`)

```ts
const info = {
  name: "multiplayer-role",
  parameters: {
    roles:      { type: ParameterType.OBJECT,   default: undefined },  // array or {role:count}
    group_size: { type: ParameterType.INT,      default: null },       // null => assume upstream sync gated entry
    // FUNCTION type is deliberate: it stops jsPsych's dynamic-parameter machinery from CALLING the
    // function and substituting its return value. Do NOT "fix" these to OBJECT.
    strategy:   { type: ParameterType.FUNCTION, default: "join_order" },// string preset or fn
    rank_by:    { type: ParameterType.FUNCTION, default: null },
    role_from:  { type: ParameterType.FUNCTION, default: null },
    ready:      { type: ParameterType.FUNCTION, default: null },        // override readiness (required for custom strategy)
    seed:       { type: ParameterType.STRING,   default: null },
    round:      { type: ParameterType.INT,      default: 0 },
    balanced:   { type: ParameterType.BOOL,     default: false },
    overflow_role: { type: ParameterType.STRING, default: null },     // only meaningful when group_size is null (§7); unreachable under exact-count gating
    push_data:  { type: ParameterType.OBJECT,   default: {} },          // round-scoped (see below); e.g. a task score to rank on
    save_group: { type: ParameterType.BOOL,     default: false },       // include full snapshot in data (can bloat)
    timeout:    { type: ParameterType.INT,      default: 30000 },       // ms; passed positionally to wait(); wait REJECTS on expiry. null/undefined = wait forever (discouraged)
    on_timeout: { type: ParameterType.FUNCTION, default: null },        // optional hook; default ends trial with role: null, timed_out: true
    message:    { type: ParameterType.HTML_STRING, default: "<p>Assigning roles…</p>" },
  },
};

class MultiplayerRolePlugin {
  trial(display, trial) {
    const api = this.jsPsych.pluginAPI;
    // ROUND-SCOPED push: namespace round-varying data under the round so it never overwrites the
    // stable join timestamp or a prior round's score. joinedAt is written ONCE (first-seen) so the
    // join_order base stays stable across rounds (see "Repeated push across rounds" below).
    api.push({
      joinedAt: api.get(api.participantId)?.joinedAt ?? Date.now(),   // first-seen, not re-stamped
      rounds: { ...(api.get(api.participantId)?.rounds ?? {}), [trial.round]: trial.push_data },
    });
    display.innerHTML = trial.message;

    const isReady = buildReadinessPredicate(trial);           // derived from strategy (§7)

    // Gate on the API's own wait() primitive. VERIFIED against PR #3694 (§1): wait(condition, timeout)
    // returns Promise<GroupSessionData> that resolves ONCE with the snapshot that satisfied the
    // predicate (fast-path if already true), and REJECTS on timeout. Two consequences baked in here:
    //  - assign over the RESOLVED snapshot, never a fresh getAll() — closes the TOCTOU (§7).
    //  - timeout is a POSITIONAL number (undefined = wait forever) and surfaces via .catch().
    api.wait(isReady, trial.timeout ?? undefined)
      .then((group) => {
        const roleMap = assignRoles(group, {
          roles: trial.roles, strategy: trial.strategy,
          seed: trial.seed ?? undefined, round: trial.round, balanced: trial.balanced,
          rankBy: trial.rank_by ?? undefined, roleFrom: trial.role_from ?? undefined,
          overflowRole: trial.overflow_role ?? undefined,
        });
        const mine = roleMap[api.participantId];
        setMyAssignment(mine, roleMap);                        // update accessor store (§8)
        this.jsPsych.finishTrial({
          role: mine?.role, role_map: roleMap, timed_out: false,
          // assigned_self distinguishes "assignment happened but I'm not in it" (mine == null) from a
          // timeout (role_map null too) — useful for spectators/overflow or a missing self.
          assigned_self: mine != null,
          ...(trial.save_group ? { group } : {}),             // off by default to avoid data bloat
        });
      })
      .catch(() => this.handleTimeout(trial));  // wait REJECTS on timeout (also catches backend/push errors -> fail loud)
  }

  handleTimeout(trial) {
    // Readiness never reached within `timeout`. Fail loud, don't hang on "Assigning roles…".
    setMyAssignment(undefined);                          // clear any stale assignment
    if (trial.on_timeout) trial.on_timeout(this.jsPsych); // researcher hook (e.g. custom UI/logging)
    // ALWAYS end the trial ourselves, even if on_timeout ran — otherwise a hook that forgets to end
    // the trial reintroduces the exact hang the timeout exists to prevent.
    this.jsPsych.finishTrial({ role: null, role_map: null, timed_out: true });
    // Downstream timelines should branch on `getMyRole() === undefined` / data.timed_out.
  }
}
```

Assignment is **computed locally and not written back** — determinism means every client lands on
the same `role_map` with no coordinator.

**Timeout is mandatory by default.** Without it, a group that never reaches readiness (a dropout, a
contract violation that stalls the exact-count gate per §7) leaves the participant stuck on
`Assigning roles…` forever. `wait()` **rejects** on timeout (verified, §1), so the wrapper's
`.catch()` routes to `handleTimeout`, which finishes with `role: null, timed_out: true`; downstream
timelines must handle that branch. `null`/`undefined` disables the timeout but is discouraged. Note
the single `.catch()` also captures backend/`push` rejections and reports them as `timed_out` —
acceptable for v1 (both are "fail loud"); inspect the error if a finer distinction is ever needed.

**The 30 s default means different things in the two modes — choose it per mode:**

- **`group_size == null` (compose after a sync lobby):** everyone is already through the barrier, so
  the role trial only waits for *data propagation*. 30 s is generous slack; a timeout here genuinely
  means "something broke."
- **`group_size` set (self-gating — this trial *is* the waiting room):** the trial also waits for
  humans to *arrive and click in*, which routinely takes far longer than 30 s, so the default will
  fire prematurely — and per §7 a timeout here is indistinguishable from a contract violation.
  **Recommendation:** keep the waiting-for-arrivals wait in an upstream `plugin-multiplayer-sync`
  (with its own long timeout), and let the role trial's short timeout mean only "data didn't
  propagate." If you must self-gate, raise `timeout` substantially. This tradeoff should be called
  out in the plugin docs/parameter description.

**Repeated push across rounds.** Because `rotate`/per-round `random` re-run this trial each round,
`push` semantics matter. The reference adapter's `push` writes to `groupSession[participantId]`, i.e.
it **overwrites** that participant's entry. So the sketch above (a) writes `joinedAt` **once**
(first-seen, never re-stamped — otherwise the join-order base silently drifts every round) and
(b) namespaces per-round data under `rounds[round]` so a round-2 score and the original `joinedAt`
coexist. Consequently `rank_by`/`role_from` receive a **`ctx` argument** carrying the current
`round`, and read `entry.rounds[ctx.round]` (the entry is passed whole, since `join_order` still needs
the top-level `joinedAt`). The multi-round path must be tested explicitly (see §10).

> **Adapter assumption (verify).** The first-seen `joinedAt` and the `rounds` merge both read the
> client's *own* prior push via `api.get(api.participantId)`. This assumes the local snapshot already
> reflects this client's last write by the time round *r* begins (i.e. local writes are read-back
> consistent). True for the JATOS adapter's local `groupSession` object, but it's an **adapter
> contract** the round-scoping correctness rests on — confirm it for any other adapter, and consider
> keeping `joinedAt`/`rounds` in a module-level fallback if read-back isn't guaranteed.

## 7. The readiness gate (the correctness core)

**Do not gate on `Object.keys(group).length >= group_size`.** That fires the instant the Nth
participant *key* appears, which does **not** guarantee that participant's pushed fields have
propagated. Concretely, for `join_order`: client A crosses the count threshold before the Nth
participant's `joinedAt` arrives → A ranks them `?? 0` (first); client B, a tick later, sees the real
`joinedAt` → ranks them differently. Both ran a deterministic function and **disagreed** — the exact
failure the plugin exists to prevent. `rank_by` (score not yet present → `0`/`NaN`) and `role_from`
(value `undefined`) have the same exposure.

### Membership consensus is an upstream contract — the gate cannot manufacture it

Field-readiness guarantees every *present* participant is ready; it says nothing about whether the
*set* of participants is final. And no count-based gate can supply that guarantee:

- If the population is **capped** at exactly N externally-agreed identities, then the first moment any
  client sees N ready participants it has the complete, final set — identical for everyone. Membership
  consensus holds, and `>=` and `===` are **equivalent**.
- If the population is **not capped**, neither check saves you. The N identities present when the
  count first reaches N can differ per client because propagation order differs (client A sees
  `{1,2,3,4}`, client B sees `{1,2,3,5}`). And `===` additionally **deadlocks** if a batched/coalesced
  update jumps the count from N−1 to N+1, so `=== N` never holds.

So **membership consensus is unsolvable at the gate layer.** It can only come from an upstream
"**capped, agreed set of exactly N identities**" contract — which, as noted below, this plugin cannot
enforce or verify. *Given* that contract, **field-readiness is the only thing the gate legitimately
adds.** (Correction to the prior revision: the claim that switching to `===` "closes the
set-membership divergence" was wrong — it does not. The divergence is closed by the upstream
contract, not the gate.)

### The count check is a deliberate failure-mode choice, not a fix

Under a correctly capped population, `>=` and `===` behave identically. They differ only when the
contract is **violated** (population overshoots N):

- `>=` fires at the first N that happen to be ready → **silently** assigns over an N-subset, and two
  clients may pick different subsets.
- `===` never fires (count has passed N) → **stalls until timeout**.

This is fail-silent vs. fail-loud. **v1 chooses `===` plus a mandatory timeout (§6):** on a contract
violation we would rather stall and surface a timeout error than silently emit divergent role maps
that corrupt the data. Under a correctly capped population the count rises monotonically to N and
stops, so `===` is always reached — the only way the stall manifests is as the *intended* loud
failure when the contract is broken.

```ts
const tryBool = (fn) => { try { return !!fn(); } catch { return false; } };  // throw => false ("not ready")

function buildReadinessPredicate(trial): (snapshot) => boolean {
  // Gated path assumes a CAPPED, externally-agreed population of exactly group_size identities.
  // The exact-count check does NOT create membership consensus (see above) — it only converts a
  // contract violation (overshoot) into a loud stall->timeout instead of a silent subset assignment.
  const enoughPlayers = (s) =>
    trial.group_size == null || Object.keys(s).length === trial.group_size;
  // Same ctx the core builds, so readiness reads round-scoped data exactly as assignRoles will.
  const ctx = (s) => ({ ids: Object.keys(s).sort(), round: trial.round ?? 0, seed: trial.seed ?? "" });
  // Accessors are called SPECULATIVELY during the propagation race, before round data has landed, so
  // the natural accessor (e => e.rounds[round].score) will THROW on the missing round. Treat a throw
  // as "not ready yet" — the correct semantics — so researchers need not write null-safe accessors.
  const ok = (fn) => (s) => enoughPlayers(s) && Object.keys(s).every(id => {
    try { return fn(s[id], id, ctx(s)); } catch { return false; }
  });

  if (trial.ready) return (s) => enoughPlayers(s) && tryBool(() => trial.ready(s));  // custom strategy must supply this
  if (trial.role_from) return ok((e, id, c) => trial.role_from(e, id, c) != null);
  if (trial.rank_by)   return ok((e, id, c) => Number.isFinite(trial.rank_by(e, id, c)));
  if ((trial.strategy ?? "join_order") === "join_order")
    return (s) => enoughPlayers(s) && Object.keys(s).every(id => s[id]?.joinedAt != null);
  // random / rotate need only the id set
  return (s) => enoughPlayers(s);
}
```

Consequences, stated plainly so a reader can't miss them:

- **`group_size` set → exact-count gate.** `overflowRole` is **unreachable** in this path (the gate
  only fires at exactly `group_size`). It is therefore scoped to **(a) the pure `assignRoles`
  utility** (caller controls the snapshot) and **(b) the `group_size == null` path** below.
- **`group_size == null` → assume an upstream `plugin-multiplayer-sync` barrier gated entry**, and
  assign over the satisfying snapshot once field-readiness passes. The **no-late-joiner guarantee
  comes entirely from the upstream barrier, which this plugin cannot enforce or verify** — the
  `every(...)` field check does nothing for count/membership stability here. This is a **contract the
  researcher's timeline must satisfy**, and it must be documented as such.
- **Genuine overflow *through* the gate** (open population settling to "whoever's here after N ms")
  needs a **quiescence/settling** gate — "count stable, no new joins for N ms" — which
  `api.wait(predicate)` cannot express (it is monotonic edge-triggered on first-true, not "has been
  quiet"). **Out of scope for v1**; a follow-up would need a timer-based gate, not `wait`.

This also resolves the **own-wait-vs.-assume-a-lobby** tension: `group_size` is optional — provide it
for a capped, self-gating group, or omit it to compose after a sync lobby.

A `custom` function strategy is opaque to readiness derivation, so it **must** supply a `ready`
predicate; default to the count check alone and document the requirement loudly.

## 8. Reading "my role" in later trials

Two jobs, two mechanisms (not redundant):

1. **Analysis / record:** always save `role` + `role_map` to trial data. Non-negotiable.
2. **Runtime control flow:** a small accessor from the package, backed by a module-level store the
   plugin sets in `finishTrial`:

```ts
let _assignment: RoleAssignment | undefined;
let _roleMap: RoleMap | undefined;
export function setMyAssignment(a: RoleAssignment | undefined, map?: RoleMap) { _assignment = a; _roleMap = map; }
export function getMyRole(): string | undefined { return _assignment?.role; }
export function getMyAssignment(): RoleAssignment | undefined { return _assignment; } // exposes .group when matching lands
export function getRoleMap(): RoleMap | undefined { return _roleMap; }
```

Usage — a clean replacement for the hand-rolled `myRole` global:

```js
import { getMyRole } from "@jspsych-multiplayer/plugin-multiplayer-role";

const proposerTimeline = {
  timeline: [proposerOfferTrial, proposerWaitTrial],
  conditional_function: () => getMyRole() === "proposer",
};
```

Rejected alternatives: **raw data lookup** in `conditional_function` (verbose, brittle, ambiguous
under rotation); **timeline variables** (fixed at construction — a plugin cannot set one at runtime).
For `rotate`/per-round `random`, the accessor is overwritten each round, so `getMyRole()` returns the
current round's role.

### Caveats to document
- **Reconnection:** the module store (like any in-memory state, including the data record) is lost on
  reload. Source of truth is the deterministic computation over the snapshot, so the robust path is
  "recompute via `assignRoles` on reconnect." v1 ships the store + documents the caveat;
  `getMyRole()` could later lazily recompute.
- **Single-experiment scope:** the module store assumes one experiment per page, always true for
  jsPsych.

## 9. Resolved design decisions (from review)

- **Q1 — accessor store vs. core API change:** module store is fine for v1 (same volatility class as
  the data record; reconnect caveat documented). Don't block on a core change.
- **Q2 — own wait vs. assume a sync lobby:** neither/both — implement the wait via `api.wait()` and
  make `group_size` optional (§7). No double-barrier, no fragile assumption.
- **Q3 — `rank_by` vs. just `custom`:** keep `rank_by` (and add `role_from`). They let the researcher
  supply only a key/value while the plugin owns tie-breaks/consensus; `custom` re-exposes that and is
  the genuine-edge-case escape hatch only.
- **Q4 — overflow / extra participants:** throw by default; opt-in `overflow_role` to handle extras
  explicitly. No silent `undefined`.
- **Q5 — naming:** `plugin-multiplayer-role` (singular), matching `plugin-multiplayer-sync`.

### Still open — decide before locking the API
- **Partitioning / matching into subgroups** (8 players → 4 dyads, each with proposer+responder).
  This is the one with forward-compat impact and is **decided now at the type level**: `assignRoles`
  returns `id -> { role, group? }`, so matching can populate `group` later **without a breaking
  change**. Two implementation paths remain open: (a) grow this plugin to partition + assign in one
  pass, or (b) a sibling `plugin-multiplayer-match` — but note role assignment and pairing usually
  happen together, so a sibling must *compose* with this plugin (likely sharing the same readiness
  gate and accessor). Recommendation: reserve the shape now (done), implement matching in a later
  iteration once the single-group case is solid. Assortative matching falls out of this for free.

## 10. Implementation steps (after plan approval)
0. **`wait` verification spike — DONE against PR #3694's API reference (§1).** All four facts hold:
   `wait` is on `pluginAPI`, resolves once on first edge (with fast-path), resolves **with** the
   satisfying `GroupSessionData`, and **rejects** on timeout (positional ms arg). §6/§7 updated to
   match. **Remaining:** re-confirm against the *merged* source once #3694 lands (the PR can still
   change), and verify the read-back adapter assumption (§6) for the JATOS adapter. If `wait` differs
   in the merged build, move the gate to `subscribe` (architecture unchanged) before writing the
   wrapper.
1. Scaffold: `npx @jspsych/new-plugin` (auto-uses the `@jspsych-multiplayer` scope and `/packages`
   per the repo README). Use a `-ts` template for tests.
2. Implement `assignRoles` + helpers as the pure core; unit-test each strategy, tie-breaks,
   seeded-shuffle reproducibility (incl. per-round re-randomization), `role_from` (including the
   loud error on a value outside the declared roles), and overflow throwing.
3. **Implement the readiness gate and test it as the priority** — the pure-function determinism test
   is near-free, so spend the budget here. Simulate clients crossing the threshold at different times
   and assert no divergence/liveness failures, covering: (a) **partially-propagated fields** (present
   participant missing `joinedAt`/score); (b) **set-membership / late-joiner / overshoot** — verify
   the exact-count gate stalls (→ timeout) rather than silently assigning over a subset when the
   capped-population contract is violated (§7); and (c) **timeout** — readiness never reached ends the
   trial with `role: null, timed_out: true` instead of hanging.
4. Implement the wrapper (on `api.wait`) + the role accessor. Test the **multi-round path** (§6):
   `joinedAt` stays first-seen-stable across rounds, per-round `push_data` is namespaced under
   `rounds[round]`, and `rotate`/per-round `random` read the correct round's data. Confirm the
   wrapper assigns over the **snapshot `wait` resolved with**, not a fresh `getAll()` (TOCTOU, §1/§6).
5. Write an `examples/index.html` demo. **Note:** the ultimatum-game example referenced throughout
   lives in the upstream jsPsych PR, **not in this repo** (`packages/` is currently empty), so the
   demo will be **reconstructed** from that example. **Important finding from reading the PR's
   `multiplayer-ultimatum-game.html`:** its `lobbyTrial` does two jobs — (a) role assignment (which
   this plugin replaces: `myRole` → `getMyRole()`, `proposerId`/`responderId` → inverted
   `getRoleMap()`) AND (b) *admission control over an open population* (`wait(keys >= 2)`, take sorted
   first 2, disconnect the rest via `gameIsFull`). Job (b) is the deferred open-population/overflow
   case (§7) and is really the **waiting room's** responsibility — the upstream barrier that supplies
   the capped-population contract this plugin depends on. So the faithful rewrite **splits** the
   monolithic lobby into `waiting-room (caps to N) → role plugin (assigns) → game trials`. This also
   fixes a latent membership race in the demo's `>= 2` lobby (two clients disagreeing on the "first
   two"). Consider adding a `participantsByRole()` helper, since the game logic needs role→id lookup
   (e.g. `group[responderId].decision`), not just the local role. Offer/decision/payoff trials are
   out of scope here — they map to future turn-based-decision / payoff plugins.
6. Add `README.md` (repo template), `docs/`, and a changeset (`npm run changeset`).
7. Open a PR into `main`.
