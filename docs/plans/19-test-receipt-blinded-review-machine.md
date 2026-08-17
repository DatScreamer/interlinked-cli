# 19. Test-receipt + blinded-review machine

**Status:** design memo, 2026-08-14. **Not built.** No `src/` changes accompany
this document. Every type below is an **UNVERIFIED SKETCH** — proposed, never
compiled.

**Requirements source:** [`session-2026-08-11-synthesis.md`](../design/session-2026-08-11-synthesis.md)
Part 6 — the receipt field table (`:253-269`), the verification-stack table
(`:272-286`), and the blinding rules (`:288`). That section is the spec seed;
this memo turns it into a build plan bounded by what is actually in the tree.

**Companions (all verified present):**
[`adversarial-review-split-context.md`](../design/adversarial-review-split-context.md)
(the split-context contract this lane inherits — designed, not built);
[`multi-agent-pre-push-review.md`](../design/multi-agent-pre-push-review.md)
(reviewer surface, verdict shape, risk triage, unanimous-allow, cost model —
designed, not built); [`tier-2-llm-policy-gate.md`](../design/tier-2-llm-policy-gate.md)
§12 (shadow→enforce cadence) and [`tier-3-async-deep-review.md`](../design/tier-3-async-deep-review.md)
§13 (warn-only contract); [`test-oracle-integrity.md`](../design/test-oracle-integrity.md)
(the sibling test-integrity program, partly shipped);
[`equivalent-mutant-handling.md`](../design/equivalent-mutant-handling.md) and
`src/harness/mutation/disposition.ts` (typed judgments about **mutants** — a
different axis from this memo's typed judgment about **tests**).

See **Depends on / feeds** at the end for composition with the other five memos
in this planning wave.

---

## 1. Problem + evidence

### 1.1 The gap mutation score structurally cannot close

Mutation score answers one narrow question: did the selected suite distinguish
the mutations the engine generated. It does not establish that the killing
assertion belongs to the product contract, that it exercises a supported
surface, or that it survives a semantics-preserving refactor
(`session-2026-08-11-synthesis.md:240`). An agent optimizing the score can
satisfy the metric without satisfying the contract — assert on the literal the
mutant replaced, assert on private call order, copy the implementation into the
"oracle". The score cannot see any of that. Only per-test evidence plus an
independent read can.

This is not hypothetical pressure. `interlinked mutation survivors --file …`
prints an explicit instruction to the writer:

> `Kill one: add a test that fails under the replacement`
> (`src/commands/mutation-survivors.ts:233-236`)

That is a reward signal pointed at a named mutant. The same output already
carries the mitigation — the `test-contract:` grounding line (`:235`) — which
is precisely the static slice this memo extends. The tool asks for a
mutant-directed test and then asks the writer to justify it in prose. Today
nothing checks that the prose is true, and nothing keeps the prose after the
edit lands.

### 1.2 This repo already lived the same failure one level down

`src/harness/mutation/disposition.ts:3-8` records the precipitating incident
for the **mutant** axis verbatim: a survivor used to have "exactly two states:
untouched, or `status: "equivalent"` + `accepted_reason: <prose>`", and "prose
is auditable *text*, not evidence". `disposition.ts` replaced that with a
discriminated union carrying certificate-validity fields
(`disposition.ts:76-93`, `:115-128`).

The identical hole is still open one level up. An agent's claim that a test is
a real regression check — rather than a mutant-shaped decoration — is exactly
the kind of unfalsifiable prose `disposition.ts` exists to refuse, and there is
no typed record for it at all.

### 1.3 The campaign is the concrete near-miss

Four Sonnet fleet waves claimed ~4,529 kills across 32 files; independent
Stryker remeasurement later confirmed ~4,506 — about 99.5% aggregate agreement
(`session-2026-08-11-synthesis.md:69,82-85`). The synthesis draws the correct,
narrower conclusion:

> "aggregate agreement is not a substitute for mutant-identity reconciliation.
> A production verifier should compare stable mutant identity, location,
> replacement, enclosing-symbol hash, and selected-test scope — not merely
> before/after totals." (`:87`)

Extend that one step. A 99.5% aggregate match is fully consistent with a
handful of individually reward-hacked tests sitting *inside* the
confirmed-killed bucket. Mutation score cannot distinguish "killed by a real
assertion" from "killed by an assertion tuned to this exact mutant", and
neither can identity reconciliation — both operate on the mutant, not on the
assertion. Only a per-test, content-addressed record plus an independent
classification can.

### 1.4 The shipped slice is deliberately narrow, and says so

> "It does not yet prove that every newly added ordinary test is grounded,
> detect copied implementation logic, measure branch partitions, perturb
> internals, run stability trials, or issue an independent review result."
> (`session-2026-08-11-synthesis.md:253`)

That sentence is this memo's scope statement.

### 1.5 Why the answer cannot be another check

Two house constraints bind, and both point the same way:

1. **Harness checks are deterministic-only.** "Was this test reward-hacked" is
   neither a compiler verdict nor a regex shape. `CheckPhase` is
   `pre_block | pre_warn | post` (`src/harness/check-registry/types.ts:31`),
   and all three are PreToolUse/PostToolUse-**synchronous** by construction
   (`:14-28`). A review lane cannot be a registry entry — not as a cost
   compromise, but structurally.
2. **`pre_block` demands ~zero false positives** (`check-registry/types.ts:16-18`:
   "Reserved for fully-deterministic, zero-FP errors"). A model classification
   never clears that bar *categorically*, so this is not a threshold to earn
   later.

The conclusion is the one Tier 2/3 already reached for policy and prose review:
keep the model off the per-edit path, run it at stop/pre-push cadence, and keep
its output warn-only until shadow data earns enforcement.

---

## 2. Current state (verified, file:line)

Everything in this section was read this session. Nothing is inherited from a
prior doc.

### 2.1 The shipped static slice

`src/harness/checks/test-legitimacy.ts:114-136` (`checkTestLegitimacy`) is a
pure `(content, filePath) => InlineMatch[]` function gated to JS/TS test files
(`:115`, via `isStrictTestFile` + `JS_TS_EXTS` from `./shared.js`;
`isStrictTestFile` itself is `checks/shared.ts:267`).

| Element | Line | Behavior |
|---|---|---|
| `MUTATION_DIRECTED_PATH` | `:13` | file counts as mutation-directed when its path matches `.mutation-kill.` / `.mutation-hardening.` / `.survivor(s).` |
| `CONTRACT_MARKER` | `:16-17` | grammar is `// test-contract: <public-api\|invariant\|bug\|security\|boundary> — <rationale>` |
| `isSpecificContractMarker` | `:50-55` | rationale must be ≥12 chars and not match `GENERIC_RATIONALE` (`:28-29`) |
| `hasAdjacentContractMarker` | `:58-70` | grounds **only the next case**: walks back ≤4 non-blank lines, allows comments/decorators, stops at the first executable line |
| missing-contract finding | `:126-129` | fires only when `mutationDirected` — ordinary test files are never required to carry a marker |
| `BROAD_TRUTHINESS` / `CALL_ORDER` | `:18-21`, `:130-132` | flagged in **any** JS/TS test file |
| `pushPrivateImports` | `:72-107` | flags private module paths (`:25`) and private named imports (`:26-27`) |

Registration: `src/harness/check-registry/entries-warnings/test-and-demo.ts:191-193`
— id `test_legitimacy`, `phase: "pre_warn"`. Metadata:
`src/harness/check-metadata/generic-test-hygiene.ts:74-77` (`tier: 2`,
`determinism: "heuristic"`). Advisory: listed in `DEFAULT_ADVISORY_SKIPS`
(`src/commands/verify/advisory.ts:254`, with the rationale comment at `:251-253`)
and in `src/harness/advisory-check-ids.ts:98`.

**The existing hard rails around it** (for contrast — these are what a
deterministic zero-FP test check looks like):
`assertion_free_test` (`check-registry/entries-taste.ts:32-33`,
`phase: "pre_block"`), `tautological_assertion` (`:46`), `mocking_the_sut`
(`:60`).

### 2.2 What does not exist (grep-confirmed, not assumed)

`rg -n "test-receipt|test_receipt|TestReceipt|blinded" src/ --type ts` returns
**zero hits**. Concretely:

- **No persistence.** `checkTestLegitimacy` returns an ephemeral
  `InlineMatch[]`. A marker validated on one edit leaves no artifact any later
  tool, session, or reviewer can read.
- **No evidence attachment.** The check reads one file's raw text and nothing
  else — not the manifest, not a coverage report.
- **No blinded payload, no reviewer dispatch, no verdict store, no verdict
  consumption.**
- `scratch/evidence-tier-census.mts`, cited by `CLAUDE.md`, is **absent** from
  the working tree (`scratch/` is gitignored and does not travel). Verification
  steps below use `src/harness/check-evidence/contract.test.ts` — the committed
  pin — rather than that script.

### 2.3 Infrastructure to reuse, not duplicate

**Per-case walking already exists.**
`src/harness/check-evidence/case-parser.ts:113` (`parseLabeledCases`) walks a
test file with a describe-frame stack and returns `LabeledCase`
(`check-evidence/types.ts:24-30`: `direction`, `title`, `line`). It keeps only
cases carrying a direction label. The walker underneath it is exactly the
per-case iteration receipt emission needs — extracting it is M0.

**A per-file kill-delta signal already exists.**
`src/harness/mutation/test-edit-effect.ts:90-105` (`testEditEffectWarning`)
compares surviving-mutant counts before/after a test edit for one
`(testFile, sourceFile)` pair. Its zero-delta message is the closest thing in
the tree to this memo's thesis:

> "The new test runs, but nothing it asserts would fail if that code were
> wrong." (`test-edit-effect.ts:98-101`)

It is **file-level**, not per-`it()`.

**Per-test kill attribution does not exist.** `MutantRecord`
(`src/harness/mutation/types.ts:63-85`) carries `mutantId`, `siteId`,
`mutator`, `originalLexeme`, `replacement`, `status`, `disposition` — and no
test-attribution field. `AdaptedMutant` (`mutation/stryker-adapter.ts:12-15`)
is `{ raw, status }` only. `mutationEvidence` therefore has **no ready data
source**; closing that is its own milestone (M2), not an assumption.

**The survivor invariant lives in `manifest.ts`, not `gate.ts`.**
`computeNewSurvivors` is `src/harness/mutation/manifest.ts:347`, called from
`src/harness/mutation/evaluate.ts:123`. That call site — not the manifest
schema — is the consumption point for a disputed-kill exclusion (§3.6).

**`MutationReceipt` is edit-level and already owns a filename.**
`mutation/types.ts:178-187` is keyed by `overlayHash` with a `sites[]` array;
`mutation/manifest.ts:459` names the file `mutation-receipts.jsonl` and `:463`
is `appendReceipt`. This memo's `TestReceipt` is **test-case level** and must
not share a name or a file with it.

**An append-only obligation/discharge ledger is already the house pattern.**
`src/harness/coverage-obligation-ledger.ts` owns
`.interlinked/coverage-obligations.jsonl`: `CoverageObligation` (`:61-74`),
`CoverageDischarge` (`:235-240`), `recordCoverageObligation` (`:218`),
`recordCoverageDischarge` (`:243`), `readOpenCoverageObligations` (`:304`), all
best-effort and never throwing. The receipt store copies this shape.

**Stability evidence has a partial local producer already — this corrects a
natural assumption.** `per_edit_coverage.flake_check`
(`src/harness/types/config.ts:387`, opt-in, default off) drives
`src/harness/server/post-tool-flake-phase.ts`, which re-runs an edited test
file's affected scoped suite twice via
`src/harness/evaluator/test-flake-guard.ts:81` (`runFlakeDoubleCheck`) and
emits `[interlinked:flake]` on divergence (`:40-52`). Divergence outcomes feed
`src/harness/calibration/flake-calibrator.ts` (an anytime-valid e-process,
`FLAKE_CFG = { p0: 0.05, p1: 0.3, alpha: 0.01 }` at `:31`, state at
`.interlinked/flake-eprocess.json`). What exists is **2 boots, one ordering, no
seed matrix, suite-scoped not case-scoped**. The synthesis's
`stabilityEvidence` field (`:266`) wants boots + orderings + seeds + leak
findings; this is the first of five dimensions.

**A cloud transport exists, with a security contract this lane must not
violate.** `src/harness/sandbox-jobs/types.ts` defines
`SandboxJobKind = "mutation" | "leak" | "flake" | "asan" | "miri"` (`:21`) and
`SandboxRiskTier = "trivial" | "lite" | "full"` (`:33`). Its header states the
binding rule: **no `argv`/`command` on the wire** — "the client sends a KIND
DISCRIMINANT; the Worker owns the command table", because a command field
"would turn the bearer token … into general remote code execution against every
warm sandbox". Note `"flake"` is already a declared kind: the cloud producer
for stability evidence is designed, not built.

**A cloud verdict path is already wired into PreToolUse — opt-in, tighten-only,
fail-open.** `src/harness/server-event-loop.ts:20` imports
`forwardCloudPreToolUse`; `src/harness/cloud-forward.ts:77` calls
`evaluateRemote` (`src/lib/cloud-governor.ts:23`) with
`DEFAULT_TIMEOUT_MS = 2000` (`:18`) and fail-open on any error;
`src/harness/cloud-escalation.ts:26` (`mergeCloudVerdict`) takes the **stricter**
of local and cloud (`deny > ask > allow`). Config is
`cloud_governor.{enabled,url,timeout_ms}` in `config.local.json`
(`cloud-forward.ts:22-40`), default absent.

> This matters for the determinism-policy reconciliation in §3.4: "no remote
> call on the hot path" is already **not** the repo's literal rule. The actual
> shipped rule is narrower and better — a remote verdict may only *tighten*, is
> opt-in, is time-boxed, and fails open. This memo's lane is stricter still: it
> is not on the hot path at all.

**The split-context contract is designed and documented.**
`docs/design/adversarial-review-split-context.md` (207 lines, status "Plan /
amendment, 2026-07-09, not built") is the dedicated treatment. Its §1 names
four places where Tier 3 leaked the implementer's trajectory into the reviewer
and states the reason precisely: a reviewer handed that record "does not
evaluate the code; it evaluates the *argument for* the code." It also names a
second leak — repo-wide read access as a contamination channel.

**A reviewer surface and verdict shape are designed.**
`docs/design/multi-agent-pre-push-review.md` §2 specifies vendor-CLI reviewers
(`claude -p … --output-format json --json-schema`, `codex exec … --json`) and a
verdict JSON shape (`verdict`, `confidence`, `findings[]`, `reviewer`, `model`,
`elapsed_ms`); §3 a **deterministic** risk-tier classifier ("Not an LLM call;
the LLM call is the expensive part we're trying to amortize"); §4
unanimous-allow aggregation; §10 config keys (`interlinked.review.always_full`,
`.skip_trivial`, `.cohort.<tier>`).

**Baselines and protection primitives.**
`src/harness/evaluator/baseline-integrity-gate.ts:35-44` defines nine
`BaselineKind`s (`coverage`, `coverage-edit`, `mutation`, `large-files`,
`untested-files`, `metric-caps`, `mutation-manifest`, `skipped-tests`,
`check-evidence`), matched by a JSON-file regex at `:46-47`. It is a
whole-file, numeric-direction diff — it does not fit an append-only JSONL.
`DEFAULT_PROTECTED_FILES` (`src/harness/rules/default-config-resolvers.ts:74-94`)
is a declarative `{glob, operations, reason}` list; no entry covers any
`.interlinked/*.jsonl` path today.

**Gitignore needs no edit.** `.gitignore:171` is `.interlinked/*`, and the
comment immediately above it states the policy: "New harness state files added
by future features are gitignored automatically — no .gitignore update
required" (`:169-170`). Carve-outs are the exception, each with a written
rationale (`:172-201`).

**Determinism tagging.** `PROVEN_TOOL_CHECKS`
(`src/harness/quality-checks/instructions.ts:28-38`) already contains
`"per-edit-mutation"` — "a measured survivor/kill is proven, not a regex
shape". By the same rule a model classification must never be tagged
`[proven]`.

**Command-surface facts.** Top-level `interlinked review` does **not** exist.
The only `.command("review")` in the tree is
`src/registrars/harness.ts:194` — `interlinked harness scanner review`, the
unrelated PII-scanner adjudication verb. Registrars are wired in
`src/index.ts:84-106`; `src/registrars/quality.ts` is 452 lines and already
hosts the whole `mutation` subcommand tree (`:317-436`).

**Pre-push infrastructure exists.** `scripts/git-hooks/pre-push` (installed via
`package.json:87,89` → `scripts/setup-git-hooks.mjs` → `core.hooksPath`) already
implements branch filtering and a docs-only fast path. `verify-changeset`'s exit
contract is `EXIT_USAGE = 2` / `EXIT_GATE_FAIL = 1`
(`src/commands/verify-changeset.ts:44-45,144,162`).

**Check Evidence Contract.** `ObligationTier`
(`src/harness/check-evidence/types.ts:39-56`) carries `min_positive`,
`min_negative`, `min_branch_coverage`, `requires_corpus`, `requires_mutation`,
`requires_adversarial`; staged enforcement is the baseline's `enforced` field
(`:156`). The pin is `check-evidence/contract.test.ts`.

---

## 3. Design

### 3.0 The layering claim, stated once

Three layers, each doing only what it can do soundly:

| Layer | Determinism | What it establishes | What it cannot |
|---|---|---|---|
| Static (shipped + §3.8) | deterministic, heuristic-tagged | a grounding marker is present, well-formed, specific, and adjacent | that the marker is **true** |
| Receipt (§3.1–3.3) | deterministic | which surfaces the case reaches, what it observes, which mutants/branches it moved, whether it is stable | that the assertion is *meaningful* |
| Blinded review (§3.4–3.6) | model judgment, off the hot path | an independent classification of the assertion | anything provable; it is never `[proven]` |

Shipping the first two alone must not read as "done". They are the cheap filter
and the evidence packet; the third is the only layer that addresses the actual
threat.

### 3.1 Data shapes

**UNVERIFIED SKETCH.** Proposed for review; not written, not type-checked.

```typescript
// src/harness/test-receipts/types.ts — PROPOSED

/** The five grounding kinds the shipped marker grammar already accepts
 *  (checks/test-legitimacy.ts:16-17). Reused verbatim, not re-invented. */
export type ContractKind = "public-api" | "invariant" | "bug" | "security" | "boundary";

export interface TestContractRef {
	kind: ContractKind;
	/** Rationale text, already validated ≥12 chars and non-generic by the
	 *  shared parser (test-legitimacy.ts:50-55). */
	summary: string;
	/** 1-based line of the marker, so a reviewer finding can anchor. */
	line: number;
}

/** The observation channels the synthesis enumerates (:220, :261). "Full
 *  output" is meaningless until these are named. */
export type ObservationChannel =
	| "return" | "thrown" | "state" | "fs" | "network" | "event" | "log" | "timing";

export interface ObservationRecord {
	channel: ObservationChannel;
	/** True when the asserted exact string/shape is itself a documented
	 *  CLI/help/policy contract (:261). Unpromised internal formatting is not. */
	contractual: boolean;
}

export type PartitionKind =
	| "lt" | "eq" | "gt" | "malformed" | "empty" | "maximum" | "failure";

export interface SurfaceEvidence {
	/** Exported symbols the case's import/call graph actually reaches, resolved
	 *  through ProjectGraph (project-graph.ts:94) — never self-reported. */
	entrypoints: string[];
	/** Mirrors the shipped private-import detector (test-legitimacy.ts:72-107). */
	touchesPrivateSurface: boolean;
}

/** Credits this receipt with specific mutant kills. NEVER crosses the review
 *  boundary (§3.5) — it is the exact channel by which a reward-hacked test
 *  would look legitimate by construction. */
export interface MutationEvidence {
	killedMutantIds: string[];
	/** Manifest generation at attach time, for staleness (mutation/types.ts). */
	manifestGeneration: number;
	engine: string;
	engineVersion: string;
}

export interface CoverageEvidence {
	branchDelta: number;
	conditionDelta: number;
	/** Content hash of the lcov artifact — not merely "a run happened". */
	artifactHash: string;
}

export interface PropertyEvidence {
	property: string;
	generator: string;
	seed: string;
	cases: number;
	oracle: string;
	result: "pass" | "fail";
}

/** Partially producible today: flake_check gives boots=2, orderings=1, no seed
 *  matrix (§2.3). Absent fields make NO claim; they never read as "checked". */
export interface StabilityEvidence {
	boots: number;
	orderings: number;
	seeds: string[];
	leaksFound: boolean;
	failures: number;
	/** Which producer filled this in — "flake_check" today, a repeat-matrix
	 *  runner later. Two producers with different rigor must be tellable apart. */
	producer: string;
}

export interface RefactorEvidence {
	perturbationsTried: string[];
	survivedAll: boolean;
}

/** The four-way classification the synthesis mandates (:284). */
export type ReviewClassification =
	| "contract" | "useful_characterization" | "brittle_characterization" | "reward_hack";

export interface ReviewEvidence {
	reviewer: string;          // "claude-code" | "codex" — multi-agent-pre-push-review.md §2
	reviewerModel: string;
	reviewerVersion: string;
	classification: ReviewClassification;
	confidence: number;
	findings: string[];
	/** sha256 of the exact serialized allow-listed payload (§3.5). The audit
	 *  mechanism: reconstruct and recompute to confirm blinding actually held,
	 *  rather than trusting a claim that it did. */
	payloadHash: string;
	/** The receipt's testHash at review time. If the case is later edited, the
	 *  verdict is STALE and cannot discharge — certificateHolds, generalized
	 *  (disposition.ts:160-166). */
	reviewedTestHash: string;
	reviewedAt: string;
}

export interface TestReceipt {
	version: 1;
	/** sha256(file + describe-path + case title). Stable across body edits. */
	testId: string;
	/** sha256 of the case BODY. A rename outside the body does not invalidate;
	 *  rewriting the assertions does. */
	testHash: string;
	/** Hash of the SUT state the evidence was gathered against. */
	sourceHash: string;
	file: string;
	line: number;
	/** null for an ordinary (non-mutation-directed) test — grounding is only
	 *  REQUIRED where the shipped check requires it (test-legitimacy.ts:126). */
	contract: TestContractRef | null;
	mutationDirected: boolean;
	surface: SurfaceEvidence;
	observations: ObservationRecord[];
	partitions: PartitionKind[];
	mutationEvidence?: MutationEvidence;
	coverageEvidence?: CoverageEvidence;
	propertyEvidence?: PropertyEvidence;
	stabilityEvidence?: StabilityEvidence;
	refactorEvidence?: RefactorEvidence;
	reviewEvidence?: ReviewEvidence;
	emittedAt: string;
}
```

Two shape rules, both load-bearing:

1. **Every evidence field is optional and absence makes no claim.** The
   synthesis's whole complaint about the saved manifest was weak fingerprints
   presented as strong (`:104`). An absent `stabilityEvidence` must never read
   as "stable"; `interlinked verify` output and the reviewer payload both
   render absent as `not measured`.
2. **`producer` / `engine` / `artifactHash` are mandatory inside each evidence
   block.** "A run happened" is not evidence; "this named tool at this version
   produced this artifact" is.

### 3.2 Module layout

```
src/harness/test-receipts/
  types.ts             # §3.1 — data only
  contract-marker.ts   # EXTRACTED from checks/test-legitimacy.ts: parseContractMarker(line)
                       #   + findAdjacentContractMarker(lines, idx) → TestContractRef | null.
                       #   test-legitimacy.ts imports it instead of owning CONTRACT_MARKER /
                       #   isSpecificContractMarker / hasAdjacentContractMarker. (M0)
  identity.ts          # testId / testHash derivation
  emit.ts              # (filePath, content) → TestReceipt[]; contract/surface/observations/
                       #   partitions filled, evidence fields undefined. No fs.
  surface-check.ts     # entrypoint resolution via ProjectGraph (project-graph.ts:94)
  store.ts             # JSONL append + latest-by-testId fold; copies
                       #   coverage-obligation-ledger.ts's best-effort, never-throw shape
  attach-mutation.ts   # manifest + per-test kill attribution → mutationEvidence (M2)
  attach-coverage.ts   # coverage report → coverageEvidence (M2)
  attach-stability.ts  # thin adapter over flake_check today; repeat-matrix later (M2)
  review/
    payload.ts         # buildReviewPayload(...) → ReviewPayload; the ALLOW-LIST (§3.5)
    triage.ts          # DETERMINISTIC risk tier (mirrors multi-agent-pre-push-review.md §3)
    dispatch.ts        # reviewer invocation; fail-open; no verdict on error
    verdict-store.ts   # append-only test-review-verdicts.jsonl
  gate.ts              # disputedKills() + the consumption points (§3.6)
src/harness/checks/test-receipt-checks.ts   # the two static checks (§3.8)
src/commands/test-receipts.ts               # CLI handlers
src/registrars/test-receipts.ts             # registerTestReceiptCommands(program)
```

Sizing: every file is single-responsibility and well under the 500-line cap;
the largest comparable sibling read for this memo, `disposition.ts`, is 447
lines for a bigger type surface. `quality.ts` is already 452 lines, so the CLI
lands as a **new sibling registrar**, not as growth there.

### 3.3 CLI surface

```
interlinked test-receipts show <file> [--test <name>] [--json]
      # receipts for a file, with evidence blocks and verdict if reviewed

interlinked test-receipts list [--unreviewed] [--ungrounded] [--json]
      # work lists: receipts with no reviewEvidence; mutation-directed cases with no contract

interlinked test-receipts verify [--json]
      # deterministic integrity pass: re-derive testHash from disk and report
      # rows whose subject drifted (stale receipts, stale verdicts). No network.

interlinked review run [--staged | --file <path>] [--json]
      # dispatch blinded review over pending receipts (§3.4 cadence)

interlinked review status [--json]
      # classification histogram, last N verdicts, cost/latency rollup

interlinked review dispute <testId> --reason <text>
      # human ack/dispute. Writes an approval-shaped record following
      # disposition.ts:99-103's HumanApproval pattern. Never auto-approves.
```

`test-receipts verify` is deliberately separate from `review run`: the
deterministic half must be runnable, and useful, with no model in the loop at
all. That is also the fallback surface if open decision 1 lands on "no cloud
spend yet".

### 3.4 Hook phases, and the determinism reconciliation

| Stage | Cadence / phase | Module | Blocks? |
|---|---|---|---|
| Contract-marker validation (existing) | PreToolUse `pre_warn` | `checks/test-legitimacy.ts`, now importing `contract-marker.ts` | no |
| Receipt emission (new) | **PostToolUse** | `emit.ts` → `store.ts` | no — append side-effect |
| Receipt-quality checks (new, §3.8) | PostToolUse, advisory | `checks/test-receipt-checks.ts` | no |
| Mutation / coverage attach (new) | post-measure: mutation gate ALLOW, `mutation measure --record`, `mutation sweep`, coverage refresh | `attach-*.ts` | no |
| Stability attach (new) | wherever `flake_check` already runs (`post-tool-flake-phase.ts`), plus a later repeat-matrix producer | `attach-stability.ts` | no |
| Blinded review dispatch (new) | **Stop** (session-scoped) **and pre-push** (batched backstop) | `review/dispatch.ts` | no — warn-only until §5 M7 |
| Verdict consumption (new) | per-edit mutation gate + `verify` / `verify-changeset` | `gate.ts` | staged (§5) |

**Why PostToolUse for emission.** `pre_warn` evaluates *proposed* content, and a
sibling `pre_block` guard in the same pass (cognitive-write-guard,
baseline-integrity-gate, the cyclomatic ratchet) can still refuse the write.
Emitting at `pre_warn` risks receipts for content that never reached disk.
PostToolUse observes bytes the daemon reconciles against real disk state
(`session-2026-08-11-synthesis.md` Part 6A's `filesystem-observation`
ChangeSet), which is the correct evidence boundary for "this content exists".
Emission must honor `event.dry_run` — `CLAUDE.md`'s "A dry run must not move the
gate" rule binds every evaluator that persists.

**Why Stop + pre-push for review, and how that squares with the shipped cloud
governor.** The repo's real rule is not "never call out on the hot path" —
`cloud-forward.ts` already does, opt-in, 2s-boxed, tighten-only, fail-open
(§2.3). The rule that actually binds is: *a non-deterministic verdict may never
be the thing that blocks, and may never be tagged proven.* This lane takes the
stricter position anyway, for three independent reasons:

1. **Latency class.** Classifying reward-hacking needs real code reasoning —
   Tier 3's Sonnet-class default (`tier-3-async-deep-review.md` §5), not Tier
   2's 2s policy classifier. It does not fit any per-edit budget.
2. **Cost.** Tier 2 models ~$0.001–0.002 per call on a small policy model
   (§11); a per-mutation-directed-test-edit call on a reasoning model multiplies
   that by both a bigger model and a high edit rate.
3. **Evidence completeness.** A receipt is not worth reviewing until its
   mutation/coverage/stability evidence has attached, and those attach
   *after* the edit — post-measure, not at write time. Reviewing at edit time
   would review a strictly weaker packet.

Stop gives a fast session-scoped pass over this session's receipts; pre-push
gives the backstop for sessions that never reached a clean Stop and for
receipts whose content drifted after a session-time review.

### 3.5 The blinded payload as an information-flow boundary

An **allow-list**, never a deny-list: an unknown field defaults to excluded, so
a future `TestReceipt` field cannot silently leak by omission from a
maintenance list.

**Crosses the boundary**

- `contract` (kind + summary) — the declared grounding, so the reviewer can
  judge whether the assertion matches the claim.
- The **public signatures** of the entrypoints the case reaches — types and
  exports only, never implementation bodies.
- The test case's own source (setup + assertions).
- `observations` (channel + `contractual`), `partitions`.
- `coverageEvidence` / `stabilityEvidence` / `propertyEvidence` /
  `refactorEvidence` as pass/fail summaries plus producer identity — not raw
  tool output. Absent renders explicitly as `not measured`.

**Never crosses the boundary**

| Withheld | Why |
|---|---|
| `mutationEvidence` — mutant ids, mutator names, original↔replacement lexemes | This is the single easiest channel for a reward-hacked test to look legitimate *because* it was written by staring at the mutant. A reviewer that knows the mutant grades "does this look mutant-shaped" instead of "does this assertion mean something". |
| Author reasoning, commit message, PR text, session trajectory | `adversarial-review-split-context.md` §1: a reviewer given that record "does not evaluate the code; it evaluates the *argument for* the code." |
| The claimed outcome ("this kills survivor X") | Telling the reviewer its expected conclusion anchors the verdict toward confirming it. |
| Which gates already fired on this file | The same anchoring in the opposite direction — the amendment names this leak explicitly (§1, the `[step 12] BLOCKED by Tier 1` row). |
| The SUT implementation body | Withholding it is deliberate: it pushes the reviewer from "does this match what was written" toward "does this assertion mean something independent of any one implementation". |
| Repo-wide read access | `adversarial-review-split-context.md` §1 names unrestricted repo read as a second contamination channel. The payload is a closed packet, not a repo handle. |

`reviewEvidence.payloadHash` is sha256 over the exact serialized payload.
Anyone disputing a verdict reconstructs the payload from the receipt and
recomputes — the blinding is auditable rather than asserted. This is the same
discipline `disposition.ts:76-93` applies to proof certificates, applied to
blinding instead of proof.

Per `session-2026-08-11-synthesis.md:288`: writer and reviewer may share a model
family, "but that is still correlated evidence and must not be described as
independent in the statistical sense." Every verdict records `reviewer`,
`reviewerModel`, `reviewerVersion` for exactly that reason, and no surfaced text
may call a verdict "independent" or "verified" without naming which sense.

**Triage before dispatch is deterministic.** `review/triage.ts` selects which
receipts get reviewed using path/diff heuristics only — mirroring
`multi-agent-pre-push-review.md` §3's explicit note that the classifier is "Not
an LLM call; the LLM call is the expensive part we're trying to amortize."
Default cohort: mutation-directed receipts first, then receipts whose
`surface.touchesPrivateSurface` is true, then the rest.

### 3.6 Verdict → consumption

| Classification | Discharges mutation debt? | Rationale |
|---|---|---|
| `contract` | yes | grounded in a real obligation |
| `useful_characterization` | yes | pins real current behavior |
| `brittle_characterization` | yes, flagged | "may be retained as documentation" (`:347`); weak evidence is still evidence |
| `reward_hack` | **no** | the mutant is treated as still surviving for gate purposes |

Mechanism, at the verified call site:

```typescript
// src/harness/test-receipts/gate.ts — PROPOSED
/** Mutant ids whose ONLY crediting receipts currently carry a non-stale
 *  `reward_hack` verdict. A verdict is stale (and therefore ignored) when
 *  reviewedTestHash !== the receipt's current testHash. */
export function disputedKills(
	receipts: readonly TestReceipt[],
	manifestGeneration: number,
): ReadonlySet<string>;
```

`evaluate.ts:123` calls `computeNewSurvivors` (`manifest.ts:347`). The disputed
set is applied **there**, as an extra input: a mutant in `disputedKills` is
added back to `newSurvivors` even though the raw run reported it killed.
`mutation-manifest.json`'s schema and version are unchanged, so no
generation bump and no new `BaselineKind` are required.

Three conditions must all hold for a verdict to dispute a kill:

1. `classification === "reward_hack"`;
2. `reviewedTestHash === receipt.testHash` (the case has not been edited since
   review — the `certificateHolds` discipline);
3. no later verdict for the same `testId` supersedes it (the store is
   append-only; the fold takes the newest row per `testId`).

The same exclusion applies wherever `verify` / `verify-changeset` report
mutation completeness and debt, per the synthesis's Round 5 rule: "enforce …
ratchets only over qualified measurements" (`:349`).

**Unreviewed receipts discharge exactly as today.** That is the shadow-safe
default and the honest one: unreviewed is the status quo, not a regression.
Whether it stays true at the terminal stage is open decision 2.

### 3.7 Storage and carve-out policy

| Path | Contents | Git | Protection |
|---|---|---|---|
| `.interlinked/test-receipts.jsonl` | receipt rows, all evidence except review | gitignored by `.gitignore:171`; **no carve-out** | `DEFAULT_PROTECTED_FILES` entry, `operations: ["Write","Edit"]` |
| `.interlinked/test-review-verdicts.jsonl` | review verdict rows | gitignored; **no carve-out** | same |

**No `.gitignore` edit is needed** — `.interlinked/*` blanket-ignores and the
comment at `:169-170` states that new harness state files are covered
automatically. Carve-outs exist only for committed *policy* (`:172-201`); a
receipt is a local measurement, not policy.

**Why not commit the verdicts, given they cost a model call?** Because the
durability answer for expensive derived state in this repo is content-addressed
caching, not a git diff — the same position `mutation-manifest.json` and
`mutation-receipts.jsonl` already occupy (neither is carved out). A verdict is
keyed by `payloadHash`; identical content anywhere should hit the same cached
verdict. Building that shared cache is a named seam (M5) and an open decision
(4), not an assumption.

**Why `protected_files` and not `baseline_integrity_gate`.** The gate's
mechanism is whole-file JSON before/after numeric-direction diffing
(`baseline-integrity-gate.ts:35-47`); an append-only JSONL has no numeric
direction to protect. More importantly, `protected_files` is *strictly stronger*
here: the baselines exist because the harness legitimately rewrites them through
internal `fs` calls, so the gate must permit tightening writes. There is **no**
legitimate agent-authored edit to a receipt or verdict row at all, so an
unconditional block is exactly right.

**The bash hole must close in the same milestone.** A `protected_files` entry
governs Write/Edit; `echo '{...}' >> .interlinked/test-review-verdicts.jsonl`
does not go through those tools. `evaluator/scratchpad-write-guard.ts` already
solves this exact class — bash redirect/tee target resolution through
same-command `VAR=` assignments and `cd` hops (`resolveBashWriteTarget`, per
`CLAUDE.md`'s scratchpad-governance table). Extending that resolver to cover
these two paths is an M1 sub-requirement, not a v2 nice-to-have.

### 3.8 The two static checks

Both are deterministic, both are `post`/advisory, and both exist to make the
receipt layer *self-checking* without pretending to judge meaning.

**`test_receipt_missing`** — a mutation-directed test case exists on disk with
no corresponding receipt row, or with a receipt whose `testHash` no longer
matches the file. Catches the ledger falling behind reality (dropped PostToolUse
delivery, an out-of-band write, a bulk edit). Detector reads the file plus the
receipt store, so — like `gitignored_written_config` — it cannot satisfy the
registry's `(content, filePath) => InlineMatch[]` contract and belongs in
`VERIFY_ONLY_CHECKS` rather than `CHECK_REGISTRY`.

**`test_contract_surface_mismatch`** — a case whose `contract.kind` is
`public-api` while `surface.entrypoints` is empty and
`surface.touchesPrivateSurface` is true. This is the one *cheap, deterministic*
lie the marker grammar allows: claiming a public-API contract while importing
only private symbols. It is a pure function of the emitted receipt plus the
file, so it can be a real registry entry at `phase: "post"`,
`determinism: "heuristic"`, advisory.

Deliberately **not** built as checks: "is the rationale true", "does this
assertion matter", "is this copied implementation logic". Those are the review
lane's job, and a regex that pretended to answer them would be exactly the kind
of taste-as-rail this repo's `pre_block` bar exists to prevent.

Both stay advisory until cross-repo FP data exists — the same rationale already
written for `test_legitimacy` at `advisory.ts:251-253`. A quiet check here is
not a dead check: in a repo where agents ground every case honestly, both should
fire ~never, and that measures the agent.

---

## 4. Integration points

- **Registrar.** New `src/registrars/test-receipts.ts`, wired into
  `src/index.ts` alongside `:84-106`. Not added to `quality.ts` (452 lines).
- **Check registry.** `test_contract_surface_mismatch` follows `CLAUDE.md`'s
  seven-step recipe: detector in `checks/`, entry in
  `check-registry/entries-warnings/` (a new `test-receipts.ts` entries file or
  `test-and-demo.ts`), metadata in `check-metadata/`, `DEFAULT_ADVISORY_SKIPS`
  + its regression test, `advisory-check-ids.ts`, `AGGREGATED_IN_JSON` in
  `__tests__/check-pipeline-parity.test.ts`, labeled cases per the Evidence
  Contract. `test_receipt_missing` goes to `VERIFY_ONLY_CHECKS` instead.
- **Count gates.** Adding a registry entry moves `getCheckInventory()`
  (`check-inventory.ts`) and the gen-markered counts. Per
  `reference_docfreshness_count_gate_ordering`: regenerate generated counts
  (`npm run docs:build`) in the same change, or the docs-freshness test fails.
- **`.interlinked/` files.** Two new JSONL files, both auto-gitignored (§3.7).
  `DEFAULT_PROTECTED_FILES` (`default-config-resolvers.ts:74`) gains two
  entries; `resolveBashWriteTarget` coverage extends to both paths.
- **Baseline-integrity implications: none, deliberately.** Neither artifact is
  a water-line; `BaselineKind` (`baseline-integrity-gate.ts:35-44`) is **not**
  extended. Stated explicitly so the omission does not later read as an
  oversight. The gaming defense is `protected_files` + hash-bound staleness,
  not direction-diffing.
- **Mutation path.** `evaluate.ts:123`'s call to `computeNewSurvivors`
  (`manifest.ts:347`) gains the disputed-kill input (§3.6).
  `mutation/types.ts` gains **one** optional field on `MutantRecord`:
  `killedByTests?: string[]` (M2), populated from Stryker's per-mutant test
  ids. That is a manifest-schema addition and does need the usual additive
  care (older manifests simply lack it).
- **Verify pipeline.** A section in `src/commands/verify/tool-results.ts` (or a
  sibling) reporting classification histogram + unreviewed count, following the
  `section-table.ts` / `streaming-output.ts` pattern.
- **Stop path.** A new `string | null` formatter in the
  `verification-stop-checks.ts` style (that module has nine such formatters,
  `:121-438`), called from the server's Stop branch. Never blocks.
- **Pre-push.** `scripts/git-hooks/pre-push` gains an opt-in stage invoking
  `interlinked review run --staged`, reusing the hook's existing branch filter
  and docs-only fast path. Warn-only by default per
  `tier-3-async-deep-review.md` §13, which is binding and inherited without
  relitigation.
- **Determinism tagging.** No new id is added to `PROVEN_TOOL_CHECKS`
  (`quality-checks/instructions.ts:28-38`). Review output carries no
  determinism tag at all rather than a guessed one — matching
  `classifyDeterminism`'s existing rule for unknown ids.

---

## 5. Milestones

Each milestone lands independently, verifies independently, and leaves the tree
committable. Risk and cost ramp across the sequence; every model-involving step
is behind M4.

### M0 — Extract the two parsers; emit receipts as a pure function

**The smallest independently-landable, independently-verifiable spike.**

Lands `types.ts`, `contract-marker.ts`, `identity.ts`, `emit.ts`. Two
behavior-preserving extractions:

1. `contract-marker.ts` takes `CONTRACT_MARKER`, `isSpecificContractMarker`,
   `GENERIC_RATIONALE`, and `hasAdjacentContractMarker` out of
   `checks/test-legitimacy.ts:16-70`; that file imports them.
2. `check-evidence/case-parser.ts:113` (`parseLabeledCases`) is refactored to
   sit on a newly exported `walkTestCases(source) → { title, describePath[],
   line, endLine }[]`; `parseLabeledCases` becomes a filter over it. Receipt
   emission consumes the same walker, so per-case identity and the Evidence
   Contract's case counting can never disagree about what a case is.

`emit.ts` composes them into `(filePath, content) => TestReceipt[]` with
`contract`, `surface` (import-shape only at M0), `observations`, `partitions`
filled and every evidence field undefined. No fs, no network, no CLI, no hook
wiring.

*Verify:* `npx vitest run src/harness/test-receipts/` green;
`npx vitest run src/harness/checks/test-legitimacy.test.ts` **and**
`src/harness/check-evidence/case-parser.test.ts` still green unmodified — that
is the regression proof that both extractions changed nothing observable;
`npm run typecheck` clean.

### M1 — Storage, PostToolUse wiring, tamper protection

Lands `store.ts`, the PostToolUse emit→append call (honoring `event.dry_run`),
the two `DEFAULT_PROTECTED_FILES` entries, and `resolveBashWriteTarget`
coverage for both JSONL paths.

*Verify:* an e2e probe in the `.interlinked/e2e-mutation-gate.mts` style that
(a) writes a `*.mutation-kill.*` file with a valid marker through the real
PostToolUse path and asserts a receipt row appears; (b) asserts a direct Edit
targeting `test-receipts.jsonl` is blocked; (c) asserts
`echo … >> .interlinked/test-review-verdicts.jsonl` is blocked; (d) asserts a
`harness test --write` dry run appends **nothing**.

### M2 — Evidence attachment, including per-test kill attribution

Lands `attach-mutation.ts`, `attach-coverage.ts`, `attach-stability.ts`, plus
the plumbing that closes the §2.3 gap: thread Stryker's per-mutant test-id array
through `stryker-adapter.ts` → `MutantRecord.killedByTests?` →
`attach-mutation.ts`. `attach-stability.ts` reads what `flake_check` already
produces and records `producer: "flake_check"`, `boots: 2`, `orderings: 1` —
honestly partial, never rendered as "stable".

*Verify:* a fixture source+test pair with a known mutant run through the
adapter; the receipt's `mutationEvidence.killedMutantIds` contains exactly the
expected id, and a second test in the same file that does **not** kill it gets
an empty list. Re-run `.interlinked/e2e-mutation-gate.mts` unmodified to
confirm no regression on the existing path.

### M3 — The two static checks

`test_contract_surface_mismatch` registered; `test_receipt_missing` in
`VERIFY_ONLY_CHECKS`. Docs counts regenerated in the same change.

*Verify:* Evidence Contract obligation met at the `post`/advisory tier — labeled
MUST-FIRE / MUST-NOT-FIRE cases, no grandfathering ("New checks get no
grandfathering", `CLAUDE.md`); confirm with
`npx vitest run src/harness/check-evidence/contract.test.ts` and
`npx vitest run src/harness/__tests__/docs-freshness.test.ts`.

### M4 — Blinded payload + shadow-mode dispatch (Stop only)

Lands `review/payload.ts`, `review/triage.ts`, `review/dispatch.ts`,
`review/verdict-store.ts`, and a Stop formatter that reports a verdict
histogram and nothing else. **No consumption, no CLI, no blocking.**

*Verify:* an adversarial fixture set (§6) containing at least one deliberately
reward-hacked case and one clean case per classification; confirm verdicts land
with the expected classification, and that recomputing `payloadHash` from a
reconstructed payload matches — the blinding audit. A negative test asserts the
serialized payload contains **no** substring from `mutationEvidence`, the
commit message, or the SUT body. Record cost and latency; these numbers do not
exist before this milestone.

### M5 — CLI + pre-push + verdict-cache seam

Lands `src/commands/test-receipts.ts`, `src/registrars/test-receipts.ts`, and
the opt-in pre-push stage. Still shadow/warn end-to-end.

*Verify:* `interlinked test-receipts verify` runs with no network and reports
stale rows on a deliberately drifted fixture; `interlinked review run --staged`
exits 0 by construction at this stage; a findings artifact lands under
`.interlinked/reviews/` in the shape `tier-3-async-deep-review.md` §7.1
documents, for continuity with whatever else lands there.

### M6 — Verdict consumption at `mode: "warn"`

Lands `gate.ts::disputedKills` and its wiring at `evaluate.ts:123`, plus
verify's debt reporting. A reward-hack-tainted kill surfaces as a warning
naming the disputed test — not yet a reopened block. Same `mode: "warn"`
convention `per_edit_mutation` already uses.

*Verify:* a fixture manifest with a mutant credited to a `reward_hack` receipt
— assert exclusion, warning text, and the three gating conditions (§3.6):
staleness suppresses the dispute, a newer superseding verdict wins,
`brittle_characterization` does **not** dispute. Re-run
`.interlinked/e2e-mutation-gate.mts` unmodified.

### M7 — Gate mode (terminal)

`reward_hack` reopens the mutant as a live survivor at the per-edit gate; an
opt-in pre-push `block_on_reward_hack` mirrors Tier 3 §13's `block_on_critical`
contract. Mode flip is config-gated with `allow_agent_override: false`, the
governance lock `per_edit_mutation` already uses.

*Verify:* full round trip — a session writes a reward-hacked test; the mutation
gate allows it (mechanically killed, unreviewed); a Stop-cadence review returns
`reward_hack`; a later edit to the same region sees the mutant as a live
survivor and is blocked, with the disputed-test explanation in the reason text.
Gate flip additionally requires the measured shadow FP rate from §6.

---

## 6. Evidence obligations

- **M0** — unit coverage in the MUST-FIRE / MUST-NOT-FIRE spirit
  `test-legitimacy.test.ts` already uses, even though these are not registry
  checks. Must pin: a marker directly above a case grounds it; a marker
  separated by executable code does **not** (regression-pins the existing stop
  rule at `test-legitimacy.ts:67`); `walkTestCases` returns unlabeled cases that
  `parseLabeledCases` drops.
- **M2** — attachment tests must include a **negative attribution** case (a
  test in the same file that killed nothing gets an empty list). Crediting the
  wrong test is the failure mode that would make every downstream verdict
  meaningless.
- **M3** — `post`/advisory tier per `check-evidence/types.ts:39-56`; labeled
  positive and negative cases, no grandfathering. Corpus dogfood run over this
  repo's existing mutation-directed files (`search.mutation-hardening.test.ts`,
  `inline-language-checks.mutation-kill.test.ts`,
  `agent-laziness.mutation-kill.test.ts`, and the other untracked
  `*.mutation-kill.*` files added by the campaign) — a first real,
  non-fixture calibration, explicitly **not** a final one. `CLAUDE.md`'s own
  caveat binds: "never calibrate a threshold against this repo alone", and
  `halstead_difficulty` is the cautionary precedent (25 → 80 after the corpus
  run).
- **M4 — the review lane's own adversarial obligation.** This is the analog of
  `check-evidence/adversarial.ts` applied to a model classifier instead of a
  regex. Requires a hand-authored calibration set spanning all four
  classifications, including deliberately planted reward-hacks written to fool
  the reviewer, plus a **leaked-breadcrumb** family (§7). Run it repeatedly
  across seeds and record classification stability, not a single-run accuracy
  number. The `harness-red-team` skill's method is the right process; do not
  invent a parallel one.
- **M7 gate flip** requires a measured shadow-mode false-positive rate. Tier 2's
  own precedent is "for policies where shadow-mode FP rate is < 5%, flip to
  enforce" (`tier-2-llm-policy-gate.md` §12); this memo borrows 5% for
  consistency rather than inventing a number, pending open decision 5.
- **Standing obligation:** the corpus/adversarial numbers from this repo are
  N=1 on a hardened, single-language, agent-written tree. They may not be
  quoted as cross-repo precision. `cross-repo-validate` is the instrument for
  that claim, and it belongs after M3, not inside it.

---

## 7. Risks + anti-goals

**Goodhart — hand-edited ledger.** Closed by the unconditional
`protected_files` block plus bash-redirect resolution (§3.7, M1). Residual: a
subprocess the guard cannot resolve statically. Mitigated by the hash binding —
a forged verdict row must also carry a `reviewedTestHash` matching the live case
and a `payloadHash` that reconstructs, so a fabricated row is detectable by
`test-receipts verify` even if it is writable.

**Goodhart — gaming the marker, not the ledger.** A well-formed, 12+ character,
non-generic marker can still be a lie ("security — validates the auth boundary"
on a test asserting nothing security-relevant). M0–M3 do **not** close this;
only M4+ does. Shipping the deterministic slice alone must not be reported as
closing the reward-hacking gap — that is exactly the overclaim
`session-2026-08-11-synthesis.md:242-253` corrected once already.

**Goodhart — breadcrumbs inside the allow-list.** Even with
`mutationEvidence` withheld, an implementer can leak intent through naming
(`mutantMinusOneCase`) or a comment inside the case body, which the reviewer
must see. Not fully closable by filtering. Mitigation: the adversarial set
includes a leaked-breadcrumb family, and the reviewer prompt treats
mechanics-referencing naming as a **reviewable signal of reward-hacking**, not
noise to ignore.

**Goodhart — reviewing your own verdict.** The dispute path
(`test-receipts dispute`) must write a `HumanApproval`-shaped record
(`disposition.ts:99-103`) that refers to an artifact the coding agent cannot
manufacture. An agent-authored dispute is not an approval; it is a note.

**Determinism policy — three hard anti-goals.**
1. The review lane must never become a `CHECK_REGISTRY` entry. All three
   `CheckPhase` values are hook-synchronous by construction
   (`check-registry/types.ts:14-31`); this is structural, not a cost
   optimization that could later "graduate".
2. A review verdict must never be tagged `[proven]`
   (`quality-checks/instructions.ts:28-38`). It carries no determinism tag at
   all rather than a guessed one.
3. The review lane must **not** be added as a `SandboxJobKind`
   (`sandbox-jobs/types.ts:21`). That wire's security contract is that the
   Worker owns a fixed command table for **deterministic oracles**; folding a
   model call into it blurs a boundary that exists to bound a stolen bearer
   token's blast radius.

**FP bar.** Both static checks stay advisory until real dogfood FP data exists.
The review verdict is never `pre_block`-eligible even after calibration — the
constraint is categorical, not a threshold.

**Anti-goal — no scoring.** The synthesis is explicit: "The layers are not a
point system. A high mutation delta cannot buy off a missing contract, a red
original suite, a non-hermetic test, or a reward-hack review" (`:286`).
Nothing in this design may sum evidence into a single number, because a scalar
is immediately Goodhartable and hides which layer failed.

**Anti-goal — do not merge the two typed judgments.**
`SurvivorDisposition` (is this **mutant** resolved) and `ReviewClassification`
(is this **test** legitimate) answer different questions and stay separate types
in separate files. A reward-hacked test can exist against a mutant that is also
legitimately `dead_code`; collapsing the axes loses that.

**Anti-goal — no holdout corpus in this tranche.** Per
`session-2026-08-11-synthesis.md:290`, a hidden fault corpus is deferred until
governance exists. Do not smuggle one in as "adversarial fixtures": the M4 set
is visible, in-repo, and reviewable.

**Cost/latency.** Stop dispatch is additive warn-only text and must never make
the agent's turn completion wait on a network call — a fail-open timeout
returns "no verdict", never a default verdict. Pre-push stays warn-only by
default (Tier 3 §13).

**Review-lane blind spot, named.** A reviewer that sees no implementation body
cannot catch "this assertion is right but the SUT is wrong". That is
deliberate — it is the mutation engine's and the type checker's job — but it
means a `contract` verdict is *not* a correctness claim about the SUT, and no
surfaced text may imply it is.

---

## 8. Open decisions for the user

1. **Reviewer surface and model.** `multi-agent-pre-push-review.md` §2 assumes
   vendor CLI subprocesses (`claude -p …`, `codex exec …`) reusing the
   developer's existing subscription; Tier 3 §5 assumes an API model with
   Sonnet default and Opus escalation. Subprocess reuses paid capacity and
   keeps credentials local; API gives a stable, versioned verdict and works in
   CI. Which does this lane use — and does the anti-reward-hacking stake
   justify an Opus-class default over Sonnet?
2. **Unreviewed-receipt policy at M7.** Should a grounded, mutation-directed
   test with no verdict yet block debt discharge (strict: nothing discharges
   unreviewed) or discharge with a standing warning (the repo's default-warn
   precedent)? Review lag causing false blocks trades against unreviewed being
   functionally the hole that exists today.
3. **Command name.** `interlinked review` is the natural verb but collides with
   the general Tier 3 reviewer that will also want it, and the word `review` is
   already taken one level down by `interlinked harness scanner review`
   (`registrars/harness.ts:194`). `interlinked test-review` avoids both at the
   cost of a less obvious name. Which does this lane claim?
4. **Where the verdict cache lives** (M5's seam). Local JSONL only — every
   fresh CI checkout re-pays the model cost for unchanged content — or a shared
   content-addressed cache endpoint alongside the cloud mutation runner in the
   private `interlinked-cloud` repo. This is an infrastructure and recurring-cost
   commitment, and it also drags in Tier 2 §16.1's unresolved
   per-user/per-org/global scope question.
5. **The M7 flip threshold.** 5% shadow FP is borrowed from
   `tier-2-llm-policy-gate.md` §12 for consistency. Confirm it, or set a
   different number for this lane: a false positive here disputes a test the
   agent already believes is finished, which is arguably higher-stakes than a
   general policy false positive.
6. **Whether a review verdict may enter the sibling evidence ledger at all.**
   `18-verification-evidence-ledger.md` already reserves
   `EvidenceSubjectKind = "test_case"` for this plan, but its `admitTransition`
   refuses `measured`/`proved` claims from any verifier outside a trusted
   deterministic set — "**never** an LLM or agent identity". So a verdict either
   (a) requires a new `judged` `ClaimStrength` in that memo's vocabulary, or
   (b) stays entirely in `test-review-verdicts.jsonl` and enters the ledger only
   as a `disputed` record contradicting a `measured` mutant kill. (b) is
   cheaper and keeps the ledger's determinism guarantee absolute; (a) is more
   uniform. This is a cross-plan schema commitment, so it belongs to whoever
   sequences the six memos.

---

## 9. Effort estimates per milestone

Session-equivalent, indicative, not a commitment.

| Milestone | Estimate | Driver |
|---|---|---|
| M0 | 0.5–1 | Two behavior-preserving extractions + pure composition; existing tests are the proof |
| M1 | 1 | Plumbing against a known template (`coverage-obligation-ledger.ts`), plus the bash-redirect extension and four probe assertions |
| M2 | 1.5–2 | The real new surface: threading an external tool's per-mutant test ids through the adapter and adding a manifest field |
| M3 | 0.5–1 | Mechanical; seven-step recipe + count-gate ordering are well-trodden |
| M4 | 2–3 | First blinded-dispatch code; only designed-not-built docs to draw on; the adversarial calibration set is most of the cost |
| M5 | 1–1.5 | CLI + pre-push follow existing shapes; the cache is an interface, not a backing store |
| M6 | 1 | Small exclusion function; the care is the three gating conditions and not regressing the e2e probe |
| M7 | 1 | Mode flip + governance lock, following `per_edit_mutation`'s precedent |

**Total: roughly 9–11 sessions.** Risk is front-loaded at M2 (external report
format) and M4 (first blinded dispatch + calibration). M0–M3 (~3.5–5 sessions)
are the deterministic half and are independently valuable: they produce a
queryable per-test evidence ledger and a no-network integrity command even if
open decisions 1 and 4 land on "no cloud spend yet".

---

## Depends on / feeds

**Depends on**

- **The evidence-substrate memo** (`18-verification-evidence-ledger.md`) —
  reserves `EvidenceSubjectKind = "test_case"` for this plan and explicitly
  defers building it. `TestReceipt` is designed to project cleanly onto its
  `EvidenceRecord` envelope: `subjectId = testId`, `subject.sourceHash`,
  `subject.testsHash = testHash`, `subject.engineHash` from
  `mutationEvidence.engine`, `invalidatedBy = ["sourceHash","testsHash"]`.
  **Unresolved between the two memos:** its `admitTransition` bars non-
  deterministic verifiers from `measured`/`proved`, so a review verdict needs
  either a new strength or a non-claim role — open decision 6. Sequencing is
  not blocking either way: M0–M3 store receipts in their own JSONL and migrate
  later as a storage-layer swap, not a schema rewrite.
- **Stability evidence** — *partially available today*, which corrects the
  natural assumption. `per_edit_coverage.flake_check` +
  `test-flake-guard.ts` + `flake-calibrator.ts` already produce a 2-boot
  divergence signal (§2.3); `attach-stability.ts` (M2) adapts it and labels its
  `producer` honestly. The full boots × orderings × seeds matrix the synthesis
  wants (`:266`, `:282`) belongs to whichever sibling memo owns Round 5's
  hermetic repeat matrix — and note `SandboxJobKind` already declares `"flake"`
  (`sandbox-jobs/types.ts:21`), so its cloud transport is designed.
- **Property / differential / refactor-resistance producers** — attach points
  only. Shapes are defined in §3.1; the producers belong to whichever memo owns
  Round 3's adversarial-residue mechanisms.
- **Owned here, not by a sibling:** per-test mutant attribution (M2). No other
  item in this wave was described as owning it, and `mutationEvidence` is
  unusable without it.

**Feeds**

- **The dispositions memo** (`18-mutation-disposition-registration.md`). A
  `reward_hack` verdict is an input a future certificate issuer must weigh: a
  `proved_equivalent` or `proved_unreachable` certificate should not rest on a
  counterexample sourced from a receipt whose review verdict is `reward_hack`.
  That is an integration point for that plan to consume `reviewEvidence`; it is
  not built here.
- **The per-edit mutation gate** — via `disputedKills` at `evaluate.ts:123`
  (§3.6). This is the memo's load-bearing output: `reward_hack` cannot
  discharge mutation debt.
- **`interlinked verify` / `verify-changeset`** — the existing gating surface,
  via §4's reporting wiring.
- **Tier 2 / Tier 3, and the split-context amendment** — all three are designed
  and unbuilt, so this lane is the first concrete draw against them. It
  deliberately reuses their contracts (allow-list blinding, deterministic
  triage, unanimous-allow shape, warn-only pre-push, shadow→enforce cadence)
  rather than inventing parallel ones. A later general Tier 2/3 build should
  reconcile config and naming with whatever lands here first — which is exactly
  what open decision 3 is about.
