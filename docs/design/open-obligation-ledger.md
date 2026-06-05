# Open-Obligation Ledger — Reconciling Transient Mid-Plan Violations

**Status:** Designed (2026-05-29). Not built. Prototype deferred by request.

**Related:** `multi-edit-atomic-coordinated-edits.md` (the *within-one-call* atomic sibling — see "Relationship to MultiEdit" below), `incremental-posttooluse.md` (the stays-synchronous constraint this doc honors), `session-state.ts` (where the ledger lives), `verification-stop-checks.ts` + `stop-event-checks.md` (the backstop), `trajectory-sequence-detectors.md` + `trajectories-as-primitive.md` (trajectory-distance signal), `types/rules.ts` (`requires_prior` / `forbids_after` — the declarative special-case), `evaluator/post-tool.ts` (where deferrable findings are raised). Philosophy guardrails: `feedback_taste_enforcement.md`, `feedback_posttooluse_stays_sync.md`, `feedback_reluctance_to_push.md`. Originates from `docs/external-pulse/cursor-classifier.md` (the intent-alignment thread).

## The problem

Most PostToolUse checks assume **every edit must leave the tree green**. But the
real unit of correctness is the **edit-group / plan**, not the individual edit. An
intermediate state that is "wrong" in isolation is often correct progress toward a
state a *later* edit reconciles. Firing a hard block — or even a loud warning — on
that intermediate is a false positive against the **plan**, not against the artifact.

We want a temporal scope **between** the two we already have: per-tool-call checks
(too eager — they judge an incomplete tree) and end-of-session / Stop / pre-commit
checks (too late — the agent has moved on and the reminder loses its referent).

### What this is and isn't

- It is **not** diff-aware filtering. That suppresses *pre-existing* findings (old
  vs newly-introduced). Different axis.
- It is **not** the manual `// interlinked: defer <check> -- reason` directive. That
  is a *permanent, human-asserted* suppression. The ledger is *automatic,
  time-bound, and self-discharging*.
- It is **not diff-aware FP suppression**, which the project explicitly rejects
  (`feedback_taste_enforcement.md`). **Nothing is hidden.** A deferrable finding is
  still reported synchronously at the edit that introduces it; it merely becomes a
  **tracked obligation with a hard commit/stop deadline** instead of a terminal
  block. Unreconciled obligations get *louder over time*, not quieter. The lever is
  **deadline, not suppression.**

## Examples — when a transient violation is legitimate

| # | Pattern | Per-edit check that misfires | Resolved by |
|---|---------|------------------------------|-------------|
| 1 | **Use-before-def** — add a call to `foo()` not yet defined | undefined-symbol / no-undef | the next edit defines `foo` |
| 2 | **Two-step move/rename** — delete `oldName` from A, re-add as `newName` in B | broken-import / dangling-ref | the B edit adds the symbol |
| 3 | **Extract-function** — paste a block into a new helper | duplicate-code / complexity | the next edit deletes the original |
| 4 | **Type-then-implement** — add a required interface field | tsc explodes across all consumers | subsequent edits update each consumer |
| 5 | **Red-green TDD** — write the failing test first | test-suite red | the implementation edit turns it green |
| 6 | **Manifest-then-reconcile** — add a dep to `package.json` | `manifest-edit-guard` blocks (unapproved dep) | the next step runs `allowlist snapshot` |
| 7 | **Stub-then-fill** — scaffold `throw new Error("not implemented")` / `TODO` | stub detector / `verification-stop-checks` | subsequent edits fill the body |
| 8 | **Surviving mutant** — a deliberate source change goes undetected by the covering tests | mutation gate (a survivor) | a later edit to the **test** (assert it), the **source** (remove dead/redundant code), **both** (refactor for observability + assert), or an **equivalent-mutant annotation** |

Unifying property: **#1–5 and #7 are "wrongness as a *static* property of an
incomplete tree" — reversible by a later edit.** #6 straddles: the manifest *edit*
is reversible, but the *install* it implies is not — see "Deferrable vs never."
**#8 (mutation) is the *dynamic* variant** — "wrongness" is a behavioral property
of the (source, test) *pair*, reversible by editing *either* side, and uniquely
*expensive/async to evaluate* (see "Mutation — the expensive/async obligation" below).

## The latent principle (it's half-built already)

Our PreToolUse-block vs PostToolUse-feedback split already encodes the right
distinction; we just don't exploit it across edits:

- **PreToolUse blocks describe an irreversible *action*** (`rm -rf`, force push,
  secret exfil, `curl | sh`) — blast radius realized at execution. **Never
  deferrable.**
- **PostToolUse checks describe the *artifact*** (undefined symbol, duplicate, stub,
  type error) — and the artifact is mid-construction. **Inherently deferrable.**

The gap is that PostToolUse checks fire per-edit as if each edit were terminal. The
fix is a new **temporal scope**, not a new severity.

## The three-scope ladder

| Scope | Fires on | Owns | Blocks? |
|-------|----------|------|---------|
| **Per-edit** | each PreToolUse | irreversible-action safety | yes (PreToolUse) |
| **Per-plan (NEW — the ledger)** | each PostToolUse + discharge sweep | artifact-correctness across an edit-group | no; deadline = commit/stop |
| **Per-session** | Stop / SessionEnd / pre-commit | cadence, verification, unreconciled obligations | warn (Stop) / gate (pre-commit) |

The middle rung is the new thing. The bottom rung already exists
(`verification-stop-checks.ts`) and becomes the ledger's hard wall.

## Relationship to MultiEdit (same problem, two time-scales)

`multi-edit-atomic-coordinated-edits.md` solves the *same* false-positive-on-the-
intermediate problem — its worked examples (import+use, type-widen+caller,
interface+registry) are this doc's #1 / #2 / #4 — but with a different mechanism at a
different time-scale:

- **MultiEdit = reconcile *within one tool call*.** The agent bundles all coordinated
  sites into one atomic batch; the gate runs once on the final combined content;
  all-or-nothing. Requires the agent to *know and declare the full edit-set up front*.
- **Open-obligation ledger = reconcile *across tool calls*.** The agent makes edit A
  now and edit B several calls later (after intervening reads, thinking, other edits);
  the obligation is tracked until discharged, deadline = commit/stop. Tolerates the
  agent *spreading the plan across calls* — the realistic case, since Claude Code's
  `Edit` is single-shot and the agent rarely pre-bundles.

They compose: prefer MultiEdit when the agent *can* bundle (cheaper — one synchronous
gate, no ledger entry); fall back to the ledger when it can't. Neither moves a warning
to an async channel (`incremental-posttooluse.md`): MultiEdit runs the gate once-sync
on the batch; the ledger keeps the per-edit warning sync and only *adds* longitudinal
tracking.

## Mechanism

A self-discharging, deadline-bound ledger in `session-state` (per-session, like
trajectory signals):

1. **Record, don't block.** When a *deferrable-class* check fires, record an
   `OpenObligation { kind, symbol/file, introduced_at_step, discharge_predicate,
   deadline }` and emit the normal synchronous PostToolUse note — *not* a block.
   (Correctness checks should never be `pre_block` anyway; per the phase contract in
   `check-registry/types.ts`, `pre_block` is reserved for zero-FP irreversible
   errors.)
2. **Later edits discharge it.** After each edit, re-run the **same checker** that
   raised the obligation (never a less-precise proxy — the Supermodel lesson) to test
   whether `foo` now resolves / the duplicate is gone / the stub is filled → mark
   discharged, optional quiet "✓ resolved `foo`".
3. **Escalate by trajectory distance, not immediate severity.** An obligation is
   *cheap when fresh and same-file*, and gets *louder* as steps accumulate, the agent
   drifts to other files, or user-intent shifts. `severity = f(steps_open,
   file_distance, intent_drift)` — all already computable from `session-state` + the
   trajectory detectors.
4. **Stop/commit is the hard wall.** `verification-stop-checks` consumes
   `openObligations()`: *"Before you stop: 2 intermediate states never reconciled —
   `foo` undefined since step 12, duplicate block in `bar.ts` since step 8."* This is
   where a *genuinely forgotten* reconciliation is caught — and it's pre-push, so the
   blast radius is contained.

### Stays deterministic, stays synchronous

The mechanism is pure bookkeeping over `session-state` — no model in the loop
(`feedback_harness_deterministic_only.md`). The per-edit warning still fires
**synchronously** as it does today; the ledger *adds* a sync-computed longitudinal
track plus a Stop backstop. **Nothing moves to an async/next-turn channel for
performance** (`feedback_posttooluse_stays_sync.md`) — the only behavioral change is
block→tracked-obligation for deferrable classes.

## Deferrable vs never-deferrable

The decision rule: **if the action's blast radius is realized at execution time and
cannot be undone by a later edit, it is not deferrable.**

- **Never deferrable (block now):** destructive irreversibles (`rm -rf`, force push,
  `DROP TABLE` prod), secret *exfiltration*, package *installs* of unapproved deps
  (the install is the irreversible act).
- **Deferrable (record obligation):** anything whose "wrongness" is a static
  property of a not-yet-complete tree — undefined symbols, broken imports,
  intermediate duplication, stubs, type errors, unupdated consumers, dead exports,
  missing companion/structure files, tests of code not yet written.

Example #6 is the instructive edge: editing `package.json` to add a dep is
deferrable (reversible text), but the `npm install` is not. So the *manifest edit*
records an obligation ("dep added; run `allowlist snapshot` before commit"); the
*install* still hits the supply-chain block. This is exactly what the declarative
`requires_prior` / `forbids_after` predicates express for known pairs — the ledger
is the general runtime form of that idea.

## Mutation — the expensive/async obligation

Mutation testing is the obligation type that most needs this ledger, and the one
that bends its rules. A surviving mutant (a deliberate source change the covering
tests fail to catch) is **example #8** above — but unlike #1–7 it has two
distinguishing properties.

**It indicts the *(source, test) pair*, not one file — so discharge is four-way.**
"Mutation tests the tests" is the common case, not the invariant. A survivor is
resolved by editing the **test** (assert the behavior), the **source** (remove
dead/redundant code no test *can* kill), **both** (refactor source so the behavior
is observable, then assert), or **neither** — an **equivalent mutant** (semantically
identical, unkillable) discharged by a justification annotation (the existing
suppression-with-reason pattern). The harness reports the deterministic fact
(mutant X survived at `foo.ts:42`, `>=`→`>`, covered by these tests); the agent
diagnoses which — **present, not prescribe** (detection/decision split). The
"edit the source" case means a survivor doubles as a **dead-code / over-complexity**
signal — the same finding `complexity` / `crap` / `dead_exports` chase from the
other side. The cluster (source + its covering tests) is bootstrapped for free from
Stryker's `perTest` analysis; staleness is keyed on **both** the source and the
test hashes, since either side can be the fix.

**Its *evaluation* is async/expensive — the one documented exception to "stays
synchronous."** Every other obligation discharges via a *cheap* re-run of its
checker (`tsc`, import-resolution) — synchronous, per "Stays … synchronous" above.
Mutation genuinely costs ~30–60s, so its finding is produced by a **debounced,
bridged (Pre→Post), `--incremental`** cloud run (one in-flight run per cluster,
coalesced; re-checks cost only the changed mutants). This is
**async-because-genuinely-expensive, not async-to-dodge-the-latency-budget** — the
distinction `feedback_posttooluse_stays_sync.md` draws. The ledger *bookkeeping*
(record / discharge / escalate) stays deterministic and synchronous; only the
finding's *production* is off-process.

**Enforcement points** (full execution-mode detail in `harness-system-diagrams.md` §4a):
- **PostToolUse** — report survivors as `additionalContext` (present-not-prescribe)
  and record/refresh the cluster's obligation. Never hidden ("deadline, not suppression").
- **Stop** — nag; on Claude/Codex/Gemini, *block-to-continue* if obligations are open
  (a survivor is under-verification — the sanctioned Stop category,
  `feedback_reluctance_to_push.md`). Copilot Stop can't block → advisory.
- **commit** (the hard wall) — `git commit`'s PreToolUse runs all touched clusters'
  mutation **synchronously in-band (~25s, fanned out, ∃-survivor early-exit)** and
  **blocks the commit** if any obligation is open, full survivor list in the **block
  reason** (a Pre-block fires no Post, so the reason must carry it — verified in §4a).
  This is where the synchronous ~25s cloud block lives — relocated from per-edit to
  the boundary where "done" is unambiguous.

## The intent layer (optional, Tier 2 — advisory only)

Deciding *whether an obligation will be reconciled* is an **intent-prediction**
problem, and we already capture the signal: the agent's stated plan / thinking
(`project_thinking_capture_full_fidelity.md`) usually says "add the call site now,
define `foo` next."

- The **deterministic layer** owns the mechanism (detect → record → discharge →
  escalate → backstop). No LLM required.
- The **Tier-2 classifier** (gpt-oss-safeguard, `tier-2-llm-policy-gate.md`) can read
  *plan + open obligations* and label each "transient-expected" vs "likely-forgotten
  / genuine-error" to tune loudness. This is the ECHO **predict / reveal / reconcile**
  pattern applied to the agent's own plan: predict that step N+1 discharges step N's
  obligation; reveal at the next edit; reconcile against the prediction. It stays
  **advisory** — it can soften a warning's volume, never unblock a safety gate.

## Codebase shape (when built)

- New `src/harness/obligations.ts` (or fold into `session-state.ts`):
  `OpenObligation` type + `recordObligation` / `dischargeObligation(predicate)` /
  `openObligations()`, persisted per-session alongside trajectory signals.
- Discharge detection **reuses existing checkers** (import-resolution in
  `structural-checks.ts`, dead-exports, the stub detector, the duplicate detector,
  tsc) — we diff "was-open → now-resolved," not build new detectors.
- `verification-stop-checks.ts` gains an `unreconciledObligations` nudge.
- The `requires_prior` / `forbids_after` `GuardRule` predicates are the hand-authored
  declarative form for known pairs; the ledger generalizes them at runtime.

## Failure modes & mitigations

| Risk | Mitigation |
|------|------------|
| "I'll reconcile later" forever | The deadline (commit/stop) is a hard wall; obligations cannot be silently dropped. |
| False discharge (thinks it's resolved, isn't) | Discharge must use the **same** deterministic checker that raised it. |
| Over-deferral hides a real break | The Stop wall surfaces it pre-push; an unreconciled obligation **is** under-verification (`feedback_reluctance_to_push.md`). |
| Intentional mid-refactor pause (resume tomorrow) | Allow a "park" ack; scope the *hard* gate to commit/push, not every Stop, so an honest pause isn't nagged. |
| Looks like the rejected FP suppression | It isn't — the finding is reported sync and re-surfaced at Stop; only block→deadline changes. Document loudly. |

## Smallest spike (≤1 day, when greenlit)

Pick **one** deferrable class — broken-import from a two-step move (#2): record the
obligation on the producing edit, discharge it when the symbol resolves on a later
edit, and surface survivors in the Stop hook. If the feel is right, generalize the
ledger to #1, #3, #7.

## Open questions

- **Deadline granularity:** commit vs push vs Stop. Pre-commit is the natural hard
  wall, but not every runner exposes a pre-commit hook — Stop may have to double as
  the gate on some runners (see `project_copilot_cursor_status.md`).
- **Cross-session obligations:** does a parked obligation survive a session boundary,
  or reset? Leaning reset (a new session is a new plan) with an opt-in carry.
- **Intent-drift metric:** what concretely counts as "the user changed topic" — a new
  user turn, a semantic shift in the request, or a file-cluster jump? Reuse whatever
  the trajectory detectors already compute before inventing a new signal.
