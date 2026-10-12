# Fixed-authority round prototype

Design recorded before coding, 2026-10-12. Base: `origin/main` at `e5a8ac9`.
Work is isolated on `prototype/matcher-round-coordination`; no merge or deployment.

## Inspection and home

The current reference-game plugin still constructs its response timers locally,
reads participant `submission` state, scores via `scoreAssignment`, and suppresses
trial cancellation while a session stays open. Current utils are a named-export
library shared by plugins and adapters: put the reusable handle there, without
scoring, DOM, adapter internals, shared clocks or a new package.

Current vendored core is preview `1e77da41966f22832ee0d133d137d81b3e50639a`,
not the experiment's `4df7fbb672806086c7e118e53aba2262f27edf68`.
Its actual bundled implementation still exposes session/trial scopes, immediate
own-write notification, backend-confirmed update promises, serialized/coalesced
pushes, immediate snapshot subscriptions, restart detection, sticky `left`
presence and cancellation of session waits when the experiment ends. Existing
Local, JATOS and Firebase adapters implement participant-slot pushes and presence;
core performs retry/coalescing. Those contracts suffice; no core/adapter changes
or vendor refresh are proposed. A session wait plus an explicit AbortSignal gives
the handle cancellation/transport cleanup without reclassifying cancellation.

The experiment's `bf82c22` report and source were inspected. Its frozen archive
SHA-256 remains `e214fa1606c65aa4c1bb04e64dfcac17993b1e6d5fa0b063a74f088ed933bec5`.
Preserve that comparison packet, the shared-clock branches, all experiment edits
and untracked evidence. The GitHub open PR check found callback-parameter PR #109;
use separate FUNCTION parameters for factories/callbacks, not nested functions.

## Public boundaries

`createRoundCoordinator<T>(multiplayer, options)` creates an opt-in fixed dyad
handle. Options freeze authorityId, members, nonnegative integer roundIndex,
positive response/preparation/receipt/feedback/write budgets, a required payload
validator and optional cancellation signal. Identity includes session, authority
and index; each participant writes one cumulative per-round session record.

The handle exposes `state`, `ready()`, `submit(value)`, `ack(stage, resultId)`,
`subscribe(callback)`, `abort(reason)` and `dispose()`. Result is one immutable
selection (validated JSON value) or timeout (null value), with authority-local RT.
Only the fixed authority activates, commits and completes. Result receipt and
feedback acknowledgments are explicit; no replacement or reload recovery.
Subscriptions deliver frozen snapshots, including failure and pending writes.
Completion is usable only once local writes have confirmed. Failure can coexist
with an accepted result. Unknown members/stale snapshots are inert; malformed or
conflicting current records fail closed. This is a cooperative protocol, not a
security boundary against an authenticated participant forging their own state.

Reference-game `round_coordinator` is an optional FUNCTION factory, invoked after
configuration validation with multiplayer, fixed matcher/members, round index and
the plugin's submission validator. It returns this handle. `on_round_state` is a
separate FUNCTION observer for local reminders/countdown. Plugin boundaries gate
interaction until active, submit directly to the handle, apply accepted results
through existing scoring/feedback, ack receipt after accepting the result, ack
feedback after local feedback ends, and call normal cleanup/finish only after
complete and local write confirmation or explicit failure. No projected reads,
intercepted transport, synthetic peer writes or intercepted finishTrial.

Independent plugin response/backstop timers are disabled when opted in. Timeout
feedback scores an empty submission through the same path; experiment-specific
null scoring/classification stays outside this library. Existing uncoordinated
behavior remains the default. Factory users must return matching configurations
on both participants and supply explicit partner identity. Sequential timeline
trials cannot enter the next round until this trial's handle completes.

## Acceptance and bounded budget

At most three passes: (1) typed handle and actual-core fault/race tests; (2) direct
plugin boundaries and paired DOM tests; (3) fixes, documentation, full tests/build.
Test readiness gating, coalesced snapshots, cumulative acknowledgments, selection
strictly before expiry delivered after expiry, exact-expiry timeout, immutable
result conflicts, bounded missing readiness/receipt/feedback/write confirmation,
departure, reference loss/reload, cancellation, transport close, accepted result
followed by failure and resource cleanup. Verify the existing plugin suite too.

Run root `npm test` and `npm run build`. Do not run browser automation, publish,
merge, alter the tested experiment or commit generated assets/data/access URLs.
Provide a reviewable prototype and describe remaining real-adapter/browser checks.
Countdown/rendering/physical onset stay local and approximate. A frozen browser
cannot enforce its own bounds until it resumes; its active peer enforces theirs.
Partitions may prevent result delivery and failure-reason agreement. No durable
row recovery from a closed page or administrative save readback is claimed.

## Verification and review handoff

The three passes are complete. `npm test -- --runInBand --silent`: **854 tests,
27 suites passed**, including 24 new actual-core protocol tests and eight public
plugin integration tests. The focused utils/reference-game suites pass 140 tests.
The full `npm run build` passed; changed packages were rebuilt after final fixes.
Inline example JavaScript parses and every referenced local asset exists.
`git diff --check` passed. Build outputs remain ignored and uncommitted.

One existing Firebase README test failed on the fresh Windows CRLF checkout: its
regex recognizes only LF code fences. The README was verified identical to
`origin/main` after line-ending normalization, normalized only in this worktree
for the passing test run, then restored to its original checkout line endings.
No Firebase source/documentation content change is included. Existing build
warnings about missing citations and Firebase browser globals remain.

Tests exercise the real vendored core over MemoryHub, including serialized and
coalesced writes; paired DOM tests call plugin paths directly, with one test using
the actual jsPsych parameter pipeline. Timer suspension and delays are controlled
simulations, not a new real-browser validation. The public prototype has not been
substituted into Hawkins, packaged/imported into JATOS, or tested on MindProbe.
The frozen Hawkins archive hash still matches the recorded comparison packet.

The example uses only local pinned assets and LocalAdapter, with existing random
role assignment. It has three rounds, a 60s response window, normal plugin scoring
and a local-download terminal screen. It has no reminder or Hawkins-specific
classification layer and performs no external data egress. Run from this worktree:

```powershell
python -m http.server 8017 --bind 127.0.0.1
```

Open this full URL in exactly two fresh tabs (paste into a new tab; do not duplicate
a tab that already owns a participant identity):
`http://127.0.0.1:8017/examples/reference-game-coordinated.html?mp_session=round-review-001`.
Use a fresh session ID for every run. No browser automation was run.

Operator checks: choose a correct and wrong shape after a director description;
verify early clicks stay gated; let a round expire and confirm normal feedback
and progression. Download both rows and compare `coordination_result`, assignment
and scoring; RT/transcripts/history remain local as documented. In a fresh dyad,
pause the matcher in devtools during active interaction past 75s: the active peer
must end with explicit coordination failure and no invented timeout. Closing,
offline/reconnect, reload, experiment cancellation and actual missing feedback
acknowledgments still require deployment checks before adopting the public API.
Repeat the frozen Hawkins comparison checks using a new experiment branch/archive
after integrating these hooks; never overwrite the tested comparison assets.
