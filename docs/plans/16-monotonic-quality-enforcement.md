# Monotonic Quality Enforcement — inference-time bumpers

**Status:** direction + build order. Parts are shipped (inventoried in §2), parts
are designed here. This is the umbrella roadmap; `docs/plans/15-survivor-elimination-campaign.md`
is the tactical campaign that runs underneath it.

## 0. The goal, stated precisely

> Never make the codebase worse on any dimension we can measure. Enforce maximum
> quality per tool call. Spend more time between tool calls running deeper
> verification — negative boundary testing, fuzzing, property testing — as
> guardrails that steer the agent at inference time.

Restated as engineering requirements:

1. **Monotonicity.** For every metric the harness can compute, an edit may hold
   or improve it, never regress it. Regression is refused at the edit, not
   discovered at review.
2. **Per-edit enforcement.** The verdict arrives while the agent can still act on
   it — a block with a reason, not a report someone reads later.
3. **Deeper verification between calls.** The budget between tool calls is
   available for real falsification work, not just linters.
4. **Guardrails, not gates alone.** The output must steer: name the failing
   behavior and the smallest action that fixes it.

The end state is *proof-carrying change*: a session ends with content-addressed
claims, counterexamples, certificates, unresolved obligations and authorized
waivers — not merely a green suite.

## 1. Why this is not just "add more checks"

Two blind spots found in a single day (2026-07-29/30), both silent, both in
systems that were reporting success:

- The mutation manifest **omits every mutant that does not anchor to a function
  symbol.** Verified on `src/lib/codex-feature-flag.ts` (unchanged in git since
  June): manifest records 5 symbols / 104 mutants; a live measurement of the
  identical source reports **117**. The 13 missing belong to module-scope
  constants — regexes and key names, several security-relevant. Those survivors
  can never be recorded, ratcheted, blocked, or annotated.
- **`per_edit_coverage` was disabled entirely**, because `coverage-overlay.ts`
  `cpSync`-mirrors every top-level entry except `.git`/`.interlinked`/
  `node_modules` (~3.2GB per edit). The per-edit affected-test run — the thing
  everyone assumed was happening — was not running at all.

A harness that promises "never worse on any measurable dimension" while silently
not measuring parts of the tree produces **false confidence**, which is strictly
worse than a harness that admits its scope. Hence §4 is the first build item:
measure the measurement before adding new measurements.

## 2. Inventory — what already exists (do not rebuild)

Verified present as of 2026-07-30.

### 2.1 The ratchet layer (this IS "never worse", for these dimensions)

Eight water-line files under `.interlinked/`, each with a per-file direction rule
enforced by `evaluator/baseline-integrity-gate.ts` (PreToolUse block) plus a
commit-gate backstop:

| Water-line | Direction |
|---|---|
| `coverage-baseline.json` | percentages may only rise |
| `coverage-edit-baseline.json` | fraction may only rise |
| `mutation-baseline.json` | score/killed may only rise |
| `mutation-manifest.json` | accepted-survivor set may only shrink |
| `large-files-baseline.json` | cap may only fall; grandfather counts only shrink |
| `untested-files-baseline.json` | exemption list may only shrink |
| `metric-caps.json` | caps only tighten; `min_coverage` only rises |
| `skipped-tests-baseline.json` | cap only tightens |

Ratcheted metrics with per-edit enforcement: line cap (500), cyclomatic (cap 25 +
**+2/edit slew limit**), CRAP (30), per-edit coverage (currently off, §1),
per-edit mutation survivors (block mode), plus non-null-assertion / `as any` /
suppression-directive count ratchets.

### 2.2 Per-edit blocking verifiers

`tsc` and `biome` **diff-overlays** (only newly-introduced findings block),
`pre_block` registry checks (introduced-only, zero-FP tier), secret detection on
both Pre and Post, the supply-chain allowlist (shell installs + manifest edits),
and the mutation survivor gate.

### 2.3 The two-window harvest — the most reusable asset here

`mutation/pending-registry.ts` (`pendingRegistry`, `overlayHash`),
`mutation/harvest.ts` (`harvestPending`, `HarvestResult`, `formatHarvestWarning`).

PreToolUse starts a long-running verifier and records a handle keyed by
`(file, overlayHash)`; PostToolUse claims whatever finished and reports it to the
agent in the same turn. **This is the mechanism that lets verification exceed a
single hook's budget without blocking the agent** — and its shape is
verifier-agnostic even though its types are mutation-specific today (§5).

### 2.4 Property / fuzz substrate (partial)

- `fast-check` is used in **19 files** (e.g. the reservations state-machine
  property tests).
- `server/fuzz-targets.ts::detectFuzzTargets(cwd)` — **detection only.** It
  returns paths that look like fuzz targets; nothing executes them.
- `property_test_candidate` — a **verify-only advisory** check
  (`commands/verify/file-checks-agent-safety.ts`) that flags pure algorithmic
  functions with no property test. It identifies the work; it does not require it.

### 2.5 Trajectory layer

23 shipped trajectory detectors, block-fingerprint/workaround observation, and
Stop-event reflection (commit cadence, unverified-code, stub introduction). This
is where "the agent is gaming the metric" signals live (§8).

## 3. The three-tier verification budget

Verification must be sorted by *latency tolerance*, not by importance. Three
tiers, mapped to surfaces that already exist:

| Tier | Budget | Surface | Contents |
|---|---|---|---|
| **T1 blocking-fast** | < ~2s | PreToolUse | deterministic, near-zero-FP: types, lint, secrets, caps/slew, pre_block registry, allowlist |
| **T2 start-now-harvest-later** | 30-60s wall, non-blocking | PreToolUse start → PostToolUse claim (§2.3) | mutation (built), property campaigns, bounded fuzz, differential runs |
| **T3 session/commit** | minutes | Stop, commit gate, pre-push | full suite, cross-file structural, adversarial campaigns, conformance corpus |

**The design rule:** a verifier that cannot produce a verdict inside T1 must not
be made to block T1. Put it in T2 and let the harvest deliver it. Blocking on a
slow verifier is how gates get disabled (exactly what happened to
`per_edit_coverage`).

## 4. Build item 1 — measure the measurement (meta-metrics)

**Problem.** Every ratchet silently defines its own scope, and nothing reports
what fell outside it. Both §1 blind spots were invisible for this reason.

**Deliverable.** Each gate emits a per-session coverage-of-itself figure:

```
gate=mutation      eligible_files=1013 measured=679 skipped_no_tests=290 unmeasured=44
gate=cyclomatic    eligible_fns=8121  analyzed=8121 skipped_no_parser=0
gate=coverage      eligible_files=1013 measured=0   disabled=true
```

Requirements:
- Derive `eligible` from the ONE product-code domain definition
  (`large-file-policy.ts::isCappableFile`) so gates cannot disagree about scope.
- Record per session to `.interlinked/`; surface at Stop and in `interlinked verify`.
- **Ratchet the meta-metric itself**: measured-fraction may only rise. A change
  that shrinks a gate's reach is a regression even if every other number improves.
- A gate reporting `disabled=true` must say so loudly at Stop. Silent disablement
  is the failure this item exists to prevent.

**Why first:** cheapest item on the list, and it converts unknown-unknowns into a
number. Every later item's claims are only as good as this one.

## 5. Build item 2 — generalize the harvest to any verifier

**Problem.** T2 is the tier that makes "more time between tool calls" possible,
and it currently only carries mutation. Its types (`HarvestedSurvivor`) bind it
to one verifier; its *protocol* (start → handle → claim → format) is generic.

**Deliverable.** Extract a verifier-agnostic job protocol:

```ts
interface DeferredVerifier<TFinding> {
  id: string;                                     // "mutation" | "property" | "fuzz" | ...
  start(ctx: EditContext): Promise<JobHandle>;    // PreToolUse
  claim(handle: JobHandle, budgetMs: number): Promise<VerdictOrPending<TFinding>>;
  format(findings: TFinding[]): string | null;    // agent-facing guardrail text
  disposition(f: TFinding): SurvivorDisposition;  // §7
}
```

Keep the existing `(file, overlayHash)` keying — it is what makes a claim valid
only against the exact content measured. Mutation becomes instance one with no
behavior change; property and fuzz campaigns become instances two and three
without new plumbing.

**Acceptance:** mutation still behaves identically through the generic path
(existing harvest tests pass unchanged), and a trivial second verifier can be
registered in under ~50 lines.

## 6. Build item 3 — property, fuzz, and negative-boundary as runtime verifiers

### 6.1 Why properties are the highest-value verifier

A property is a **language-neutral behavioral statement**. `reverse(reverse(x)) === x`
ports to any implementation; `expect(mockFoo).toHaveBeenCalled()` ports to none.
So promoting properties from advisory to enforced serves monotonic quality *and*
produces the portable specification the conformance goal needs (§9). Examples pin
a point; properties pin a region.

### 6.2 The ladder, in cost order

1. **Promote `property_test_candidate` to a tracked obligation.** It already
   identifies pure algorithmic functions lacking properties. Route it through the
   existing debt ledger (pair-scoped, like coverage debt) rather than a hard
   block — the obligation is discharged by adding the property.
2. **Run existing properties as a T2 verifier** with a larger `numRuns` budget
   than the inline suite uses. The suite runs properties cheaply for speed; T2
   can afford a deeper campaign on *changed* symbols only.
3. **Negative-boundary generation.** For a changed function, derive boundary
   inputs from its types and guards (empty, null/undefined, zero, negative, max,
   unicode, very long, malformed) and run original-vs-expectation. This is where
   most real defects in this repo's parsers and detectors live.
4. **Differential fuzzing** against the previous revision of the same function:
   generate inputs, compare old vs new behavior, and report *unintended* diffs.
   This is the strongest available "did this edit change something you didn't
   mean to change" signal, and it needs no oracle beyond the prior revision.
5. **Bounded exhaustive comparison** where the input domain is genuinely small
   (enum × enum, small tagged unions). Real proof over the enumerated domain.

### 6.3 The asymmetry that must be encoded

> Counterexample search can prove a mutant/edit **wrong**. Failing to find a
> counterexample proves **nothing**.

Verdicts must therefore distinguish:

```
counterexample found        → killable / regression; produce the failing input as a test
no counterexample in budget → UNRESOLVED, with evidence recorded (N runs, seed, budget)
formal certificate obtained → justified (§7)
```

"Eight million fuzz cases passed" is useful evidence and must never silently
become `equivalent` or `verified`.

## 7. Build item 4 — typed dispositions instead of prose

**Problem.** A surviving mutant is currently resolved by `status: "equivalent"` +
`accepted_reason: string`. That is auditable prose, not evidence. And the binary
justified/not framing has no home for the classes we actually measured.

**Deliverable.** Replace the free-text field with a typed disposition:

```ts
type SurvivorDisposition =
  | { kind: "killed" }
  | { kind: "dead_code"; resolution: "delete" | "implement"; issueRef?: string }
  | { kind: "proved_equivalent"; method: RewriteLemma | BoundedExhaustive | SmtRelational; certificate: ProofCertificate }
  | { kind: "proved_unreachable"; invariantRef: string; certificate: ProofCertificate }
  | { kind: "duplicate"; representativeMutantId: string; certificate: ProofCertificate }
  | { kind: "outside_contract"; contractHash: string; observationModelHash: string; approval: HumanApproval }
  | { kind: "accepted_risk"; owner: string; issue: string; expiresAt: string; approval: HumanApproval }
  | { kind: "unresolved"; evidence?: CounterexampleSearchEvidence };
```

Two additions to the classic taxonomy, both forced by measured data:

- **`dead_code`** — the mutant is unkillable because the code *should not exist*
  (verified case: `structure/adoption.ts`, where `hasConfigFile` cannot alter any
  return value; 14 mutants). This is NOT `proved_equivalent` — the code is wrong,
  and the resolution is a source change. Accepting it would seal dead code in as
  "reviewed" and bury an unimplemented intent.
- **`unresolved` as a first-class state** — today an un-accepted survivor is
  indistinguishable from an unexamined one. Most survivors should sit here
  honestly rather than be forced into a binary.

**Certificates carry invalidation inputs.** A certificate is valid only while
`sourceSymbolHash`, mutant identity, contract hash, verifier version,
`environmentHash` and `dependencyGraphVersion` all hold — the manifest already
records most of these. Measured motivation: the *defensive-guard* equivalence
class (`replay/sse-reassembly.ts`, 6 mutants) is equivalent **only while** the
guarded call stays last and the catch stays a pure swallow. Add one statement
after the call and the mutants become killable again — silently, because prose
has no invalidation inputs.

**Sequencing caveat (deliberate).** The heavier rungs — SMT relational proofs,
symbolic execution — are **not** worth building yet. Measured population: of
~38,000 non-killed mutants, ~25,300 are covered-but-unasserted (need tests) and
~12,800 are uncovered (need tests to exist). True semantic equivalents requiring
a solver are a thin tail. Build cheap rungs (rewrite lemmas, duplicate detection,
bounded exhaustive) and drain the killable backlog first. Note also that
"trivial compiler equivalence" yields far less for TypeScript than for C: the
TS→JS pipeline performs almost no semantic optimization, so it collapses to
roughly normalized-AST identity.

## 8. Build item 5 — authority separation and anti-gaming

### 8.1 The hole, stated plainly

`interlinked mutation accept` was shipped 2026-07-29 as "the sanctioned path,"
with the integrity gate blocking hand-edits to the manifest. **An agent with
shell access can simply run the command.** The campaign's rule ("agents must not
accept, only report candidates") is currently enforced *in a prompt* — that is a
convention, not an authority boundary.

**Deliverable.** Non-provable dispositions (`outside_contract`, `accepted_risk`)
must require approval the coding agent cannot manufacture: an approval artifact
written by a separate process/identity, a signed review, a protected label, or a
policy file outside the agent's write scope. Provable dispositions
(`proved_*`, `duplicate`) need no human because the judge validates the
certificate mechanically.

**Judge is code, not prose.** It verifies: certificate references the exact
original+mutant hashes; declared domain was actually enumerated; the solver
actually returned UNSAT; assumptions are permitted by the contract; nothing is
stale; a required human approval genuinely exists.

### 8.2 Verification-integrity trajectory family (new detectors)

High-confidence sequences to detect, most already expressible with existing
trajectory machinery:

```
survivor → assertion removed or loosened → green
survivor → mutation operator/config disabled, or file excluded from mutation
survivor → test timeout increased
survivor → source special-cased on an exact test literal
survivor → mock replaces the behavior under test
survivor → report/baseline file edited directly
verifier command repeatedly cancelled or bypassed
```

**Mutant-witness requirement** (extends the existing RED-witness): a test claimed
to fix a survivor must (1) pass on the repaired source, (2) **fail against that
exact mutant**, and (3) run without modified verifier configuration. This is a
highly verifiable reward and the machinery to check it already exists.

### 8.3 Verifier saturation — the constraint on the whole program

A fixed verifier becomes part of the agent's effective environment and gets
optimized against. Mitigations that must be designed in, not retrofitted:

- Do not expose every generated property/fuzz seed to the coding agent.
- Generate some verifiers *after* the coding phase.
- Rotate seeds, operator subsets, and fuzz strategies.
- Use independently generated oracle families; separate the model that writes
  code from the models that design attacks.
- Record which verifier signals the agent actually saw.

## 9. Build item 6 — risk-proportional budgets

Uniform slowness makes agents unusable; uniform speed makes dangerous edits cheap.
Score each edit and map to a tier:

```
risk = novelty + changed behavioral surface + blast radius + privilege
     + statefulness + concurrency + irreversibility + verifier uncertainty
```

Inputs that already exist: blast-radius/impact analysis, the project graph,
taint/sensitivity classification, route map, and the change-propagation tracker.

| Risk | Budget |
|---|---|
| low (types, docs, generated) | T1 only, seconds |
| moderate | T1 + one T2 verifier |
| high (auth, persistence, concurrency, public API) | T1 + full T2 portfolio, minutes |
| critical (irreversible, security boundary) | certificate or human review required |

A six-line authorization change deserves more verification than 500 lines of
generated type declarations. Today the budget is uniform, which means it is
simultaneously too slow for the trivial case and far too fast for the dangerous one.

## 10. The endgame — tests as a portable specification

Long-term goal: **a test suite so complete that an agent given only the tests,
with no source access, could reimplement the system in another language.**

That artifact is a **conformance suite** — the pattern used by CommonMark, JSON
Schema, WebAssembly, Unicode, protobuf and HTTP/2. Its architecture:

- behavior expressed as **data** (`input → expected output`), not as code
- a thin per-language runner feeds the corpus
- the corpus *is* the specification; prose is commentary
- what is deliberately unspecified is **declared**, so implementations stay free

**Mutation score is the completeness metric for exactly this.** A surviving
mutant means the tests permit two behaviors — precisely a degree of freedom where
a reimplementer could diverge and still pass. The survivor campaign (plan 15) is
therefore already the right work aimed at the right number.

**The tension to design around:** maximizing mutation score pushes toward
*over*-specification — pinning error message text, iteration order, tie-breaking
that a valid reimplementation should be free to differ on. The resolution is the
same **observation contract** that §7 needs for `outside_contract`: one document
per area declaring what is specified versus implementation-defined. The two goals
converge on one artifact.

**Current distance from the goal (measured 2026-07-30):** 1,040 test files, of
which **183 use `vi.mock`** and therefore assert *how* rather than *what*. The
rest still bind to TypeScript directly (import by symbol, `undefined` vs `null`,
structural `toEqual`). Portable scope is the pure core — detectors
(`content, filePath → findings`), guard evaluation (`command → decision`, already
largely data), parsers, metrics. Explicitly out of scope: daemon lifecycle, hook
installation, file I/O, CLI plumbing.

**Cheap falsification of the whole idea:** extract one detector's cases to a JSON
corpus with a declared schema and observation contract, hand it to an agent with
no source access, have it implement in another language, run the corpus. Every
behavior it gets wrong that the corpus permitted is a specification hole, located
precisely. Do this once per area as an audit — not as a gate.

## 11. Build order and rationale

| # | Item | Why here |
|---|---|---|
| 1 | Meta-metrics (§4) | Cheapest; every other claim depends on knowing what is measured. Closes the §1 blind-spot class. |
| 2 | Fix identity anchoring for module-scope declarations (§11.1) | A ratchet blind to part of the tree cannot enforce there; also un-floors every count in plan 15. |
| 3 | Generalize the harvest (§5) | Infrastructure that makes items 4-6 cheap instead of bespoke. |
| 4 | Typed dispositions + `unresolved` + `dead_code` (§7) | Schema change; unblocks honest reporting immediately. No solver needed. |
| 5 | Trim `coverage-overlay` SKIP_ENTRIES | Small fix that re-enables the per-edit affected-test run (~3.2GB → small). |
| 6 | Property obligation + T2 property/fuzz verifiers (§6) | Highest-value new verification; doubles as conformance groundwork. |
| 7 | Mutant-witness + verification-integrity trajectory rules (§8.2) | Anti-gaming, cheap, uses existing machinery. |
| 8 | Authority separation for non-provable dispositions (§8.1) | Needed before any fleet-scale delegation with accept rights. |
| 9 | Risk-proportional budgets (§9) | Makes deep verification affordable where it matters. |
| 10 | Conformance corpus pilot (§10) | After 6; one area, as an audit. |

Deferred deliberately: SMT/symbolic equivalence, whole-repo formal methods,
adaptive multi-hour Stop phases (not affordable on the current dev box).

### 11.1 Design note — item 2, module-scope identity anchoring

Root cause traced 2026-07-30. It is **not** in the anchoring step, which already
handles module scope:

- `mutation/identity.ts::resolveSite` calls `enclosingFunction`, and when there
  is none it falls back to the qualified name `"(module)"` with arity 0. So a
  module-scope mutant *does* receive a valid, stable `symbolId`.
- The loss happens on persist. `mutation/identity.ts::computeSymbolHashes` walks
  the AST and emits a hash entry **only** for nodes where
  `isFunctionLike(node) && node.body !== undefined`. There is no entry for the
  `(module)` pseudo-symbol.
- `mutation/manifest.ts::applyMeasuredRun` then builds the next snapshot by
  iterating `overlayHashes` — *not* the measured mutants:
  ```ts
  for (const [symbolId, entry] of overlayHashes) nextFile[symbolId] = refreshSymbol({...});
  ```
  Any measured mutant whose `symbolId` is absent from `overlayHashes` is silently
  discarded. That is the 13 missing mutants in `codex-feature-flag.ts`.

**Two candidate fixes, not equivalent:**

1. **Emit a `(module)` hash entry** from `computeSymbolHashes` covering
   top-level statements — i.e. the source file's text minus the function-like
   subtrees already hashed, normalized the same way. Preserves the invariant that
   `overlayHashes` is the complete symbol universe, so `applyMeasuredRun` needs no
   change. **Caveat:** one hash over all module scope means *any* top-level edit
   changes it, so every module-scope mutant re-measures on every such edit — a
   coarse-grained but safe invalidation.
2. **Make `applyMeasuredRun` tolerate unknown symbols** by deriving a record from
   the measured mutants themselves when `overlayHashes` lacks the id. Finer
   grained, but it weakens the "hash decides staleness" invariant — a symbol with
   no hash can never be detected as changed, so its survivors would persist
   across edits that actually altered them.

**Recommendation: fix 1**, optionally refined later to per-declaration hashing
(one entry per top-level `const`/`let`/`class` initializer rather than one for
all of module scope), which restores fine-grained invalidation without touching
the invariant.

**Acceptance criteria:**
- `computeSymbolHashes` returns an entry whose qualified name is `(module)` for
  any file with top-level mutable tokens.
- A live measurement and the persisted manifest agree on total mutant count for
  `src/lib/codex-feature-flag.ts` (**117**, the currently-verified live figure).
- A regression test pins the agreement for a fixture with both a function and a
  module-scope constant.
- After landing, **re-sweep**: every per-file count in plan 15's work list is a
  floor until this ships, so the campaign's numbers should be re-derived before a
  large push (see the sequencing note in plan 15's TL;DR).

## 12. Non-goals

- **Blocking on slow verifiers.** Anything that cannot verdict in T1 goes to T2.
  A gate that makes editing painful gets disabled, and a disabled gate is worth
  less than no gate because it lies about coverage.
- **LLM-as-judge in the check pipeline.** Models may generate properties,
  attacks, and proof strategies; deterministic code adjudicates. (Repo policy.)
- **Replacing tests with metrics.** Every metric here exists to make tests better,
  not to substitute for them.

## 13. Evidence log

Findings that motivated this plan, each verified rather than assumed:

| Date | Finding | Evidence |
|---|---|---|
| 2026-07-29 | Manifest omits non-function-symbol mutants | `codex-feature-flag.ts` unchanged since June: 104 recorded vs 117 live |
| 2026-07-29 | `per_edit_coverage` silently disabled | `enabled: false`; `coverage-overlay.ts` mirrors ~3.2GB per edit |
| 2026-07-29 | Test-only edits trigger no mutation measurement | `primaryCodeFile` skips test paths by design |
| 2026-07-29 | A degraded runner reports `no_tests`, not an error | same file: `no_tests` on one endpoint, 71 mutants on another |
| 2026-07-30 | Mutation status split | 63,167 killed / 25,305 survived / 12,844 uncovered / 678 timeout |
| 2026-07-30 | Coverage is already near-max where measurable | 1,013 files, median 96.6%, 636 ≥90%, **340 at 0%** — yet 25,305 covered mutants survive |
| 2026-07-30 | Test suite is implementation-coupled | 183 of 1,040 test files use `vi.mock` |
| 2026-07-30 | `accept` has no authority boundary | CLI is runnable by any agent with shell access |
