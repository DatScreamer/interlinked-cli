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

### 6.3 Status (2026-08-01) — registry-wide liveness sweep + generated property harness

Every registered check shares one signature (`(content, filePath) => InlineMatch[]`),
so six properties were built ONCE and run against the whole ~252-check registry
instead of hand-written per detector. Liveness ran first, as a standalone sweep;
the other five are a generated vitest file.

**Liveness — the headline.** `scratch/registry-properties/liveness-sweep.mts`
(`npx tsx`, wall clock ~13s) tries to make each check fire using (a) real
fixtures harvested from the check's OWN test file(s) via a small TS-AST walker
(`scratch/registry-properties/harvest-fixtures.mts` — resolves thin
one-hop wrapper helpers, `[...].join()`, `Array.from({length},...)`, spread
elements, and scope-aware `const`/`let` lookup so `const code = …` redeclared
across sibling `it()` blocks resolves to the right one) and (b) a bounded
fallback scan of the repo's own 2147 source files. The sweep's first pass
found 112 "unresolved" checks; three harvester bugs (recursion-depth cap,
missing `Array.from`/spread handling, whole-file-first-match identifier
resolution instead of scope-aware) accounted for all but 27 of those once
fixed. Every one of the remaining 27 was individually verified by hand against
its own source and test file — this is the part that took the effort, and
it mattered: **21 of the 27 were false positives of the sweep method**, not
dead checks (harvester still can't fold `String.fromCharCode(n)` into a
control byte, resolve `for (const x of positives)` loop bindings, or satisfy
filesystem-coupled checks like `package_json_publish_invariants` /
`tsconfig_strictness` / the endpoint-security adapters without real files on
disk — all confirmed alive by direct hand-built-fixture calls).

**Confirmed dead: 6 of 252 registered checks (2.4%).**

| id | Cause | Precedent |
|---|---|---|
| `self_import` | `checkSelfImport` regexes the import specifier against `stripCommentsAndStrings(content)`, which blanks every quoted string to `''`/`""` before the specifier-matching regex runs — the specifier is always quoted, so it can never survive stripping. **New finding.** | Same class as `checkExtraneousDependencies` below |
| `extraneous_deps` | `checkExtraneousDependencies` — identical bug: `fromMatch` regexes a quoted specifier against stripped content. This is the task's own seed example, independently reproduced by the sweep. | — |
| `test_importing_test` | `checkTestImportingTest` — same class again (fourth instance in the registry). **Already self-documented as dead in its own test file's comment** (`testing.test.ts`, "BEHAVIORAL REALITY: … The detector therefore returns [] for ALL inputs that reach the scan") — not a new discovery, but the sweep independently reproduced it with no prior knowledge of that comment. | — |
| `migration_ordering` | `checkMigrationOrdering` in `checks/compat-stubs.ts` is a literal `return [];` stub, alongside two siblings below. File header: "Compatibility stubs — referenced by check-registry but their full implementations live in other modules (or are pending refactor). Returning an empty match list keeps the registry build green." Deliberate, but still fully registered with real severity/phase/fix_instruction as if live — `interlinked harness checks` counts it as one of the working checks. | — |
| `sql_schema_consistency` | Same file, same stub pattern. | — |
| `visibility_filter_missing` | Same file, same stub pattern. | — |

The stripped-quoted-specifier bug is now a confirmed **recurring class**
(4 instances: `extraneous_deps`, `self_import`, `test_importing_test`, and by
extension any future import-specifier detector built on
`stripCommentsAndStrings`) — worth a `detector-scans-stripped-specifier`
meta-check candidate for `docs/plans/16` §11.2's backlog, not built this pass.

Also surfaced, not fixed: three registry entries (`circular_imports`,
`dead_exports`, `untested_inverse_pair`, plus `untested_idempotent`) are
registered via an inline arrow `fn: (content, filePath) => checkX(content,
filePath, process.cwd())` — the object-literal-key name-inference rule gives
that arrow the literal name `"fn"`, which breaks `check-evidence/resolve.ts`'s
name-based detector→test-file resolution (0 test files reported) even though
the underlying detectors are real, substantial, project-graph-aware
implementations. Cosmetic/tooling gap, not a check defect — worth a follow-up
so `check-evidence` doesn't misreport these four as untested.

**The generated five-property harness** ships at
`src/harness/__tests__/check-registry-properties.test.ts` (1010 test cases
over 252 checks + 6 strip-helper idempotence checks, ~6.4s wall clock,
`npx vitest run` verified green, `npm run typecheck` clean):
- **Totality** — `fc.string({ unit: "binary" })` (full code-unit range incl.
  lone surrogates) plus fixed edge cases (empty, NUL, lone surrogates, a
  20k-char single line, 500 unclosed `{`, all-blank-lines). Zero throws.
- **Determinism** — same `(content, filePath)` called twice, `toEqual`.
- **Output well-formedness** — every `InlineMatch.line` is a finite integer
  within `[1, lineCount]`; `text` is a string.
- **Termination** — the repo's own calibrated coarse-ratio pattern from
  `checks/reinterpret-alignment.test.ts` (2KB control vs 64KB/32x subject,
  min-of-N timing, ratio `< 150`), NOT an absolute-ms bound (see §11.2's
  `absolute_ms_assertion_in_test` — this is deliberately the fix already
  applied elsewhere, reused rather than re-invented). Skipped only for the
  four `process.cwd()`-coupled checks above, to keep the whole file in
  seconds rather than re-walking the project graph 252×32×.
- **Idempotence** — `stripComments` / `stripStrings` / `stripCommentsAndStrings`
  / `stripAllLiterals` / `stripTemplateLiterals` (the genuinely idempotent
  shared helpers actually used by the check families) — applying twice equals
  once, for all of them.

All 1010 cases pass; nothing threw or produced non-deterministic output during
this run. Not built: fuzz/negative-boundary generation from types (§6.2 item
3), differential fuzzing against the prior revision (item 4), and bounded
exhaustive comparison (item 5) — those still need a per-symbol "what changed"
hook this task didn't build. This section's harness is a session-scoped
verifier, per the task's scope discipline: not wired into any blocking path.

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

### 10.5 Model-perceived complexity, and where learned signals may live

Raised 2026-08-01 from *"Rethinking Code Complexity Through the Lens of Large
Language Models"* (arXiv 2602.07882, ICML 2026). Its two claims that bear on this
plan:

1. Classical complexity metrics show **no consistent correlation with LLM
   performance** — a mismatch between what we cap and what a model finds hard.
2. **Semantics-preserving reductions in their metric (LM-CC) consistently improve
   downstream task performance.** That is a causal claim about precisely the
   activity this repo just spent a campaign on — 49 semantics-preserving
   decompositions — except we optimised cyclomatic and cognitive.

**Why LM-CC cannot be a gate here.** It is entropy-guided: it needs a next-token
distribution to measure "cumulative uncertainty", so computing it requires causal
LM inference. That breaks two invariants at once — `feedback_harness_deterministic_only`
(no LLM in the check pipeline) and the T1 budget (§3). Worse for a ratchet: a
nondeterministic verdict means two agents editing one function can disagree, and a
re-run can unblock a previously-blocked edit. **A metric you cannot reproduce
cannot be a water-line.**

**Where it fits instead:** T3 / cloud, reported and never enforced — the same slot
as the fuzzing ladder (§6), where inference is affordable and latency blocks nobody.

**The experiment worth running first.** We have an unusually clean natural
experiment already on disk: 49 functions decomposed 2026-08-01, semantics-preserving,
with verified before/after on both control-flow metrics and zero regressions. Run
LM-CC over those 49 pairs. If it barely moves, we optimised the wrong target and the
caps are theatre for model-facing work. If it drops in step, the cheap deterministic
metrics are adequate proxies and nothing was lost. Either answer is worth having, and
it costs compute rather than design.

Note we already carry one non-control-flow metric: `halstead_difficulty`
(verify-only, calibrated to 80 against a 9023-function corpus) — vocabulary and
operand density, "the dimension the control-flow metrics cannot see". Closer in
spirit to cumulative uncertainty than branch counting, and deterministic.

### 10.6 Local embedding models — three uses, and one trap

Assessed 2026-08-01. **Embeddings cannot compute LM-CC** — that needs a token
distribution; an embedding model yields a fixed vector and no distribution at all.
It is a model-class mismatch, not a size one. But three uses stand on their own,
each derived from a failure this campaign actually hit:

1. **Seam quality — is an extraction cohesive or cosmetic?** Every decomposition
   audit had to judge "real or cosmetic" by hand. Embed the statements of a
   function and measure variance: low variance = one job, high variance = several.
   This converts a judgement call into a measurement — the same conversion that let
   decomposition run 22/22 while mutation hardening was refuted repeatedly.
2. **Defect-pattern propagation — the highest-value one.** The recurring shape all
   session was *"fixed here, the same defect exists in N places nobody looked"*:
   three checks sharing the strip-then-match bug (`self_import`, `extraneous_deps`,
   `test_importing_test`), three test-file predicates, two path spellings, two
   daemon argv builders. Embed check/function bodies; when one is found broken,
   retrieve its nearest neighbours and inspect them. We found the third dead check
   by luck. This is the mechanism that replaces luck.
3. **Corpus dedup** for the fuzz/counterexample corpus (§6), so near-duplicate
   counterexamples do not consume replay budget.

**The trap: do NOT use embedding similarity to check behaviour preservation.** It is
backwards — a good semantics-preserving refactor SHOULD change the text
substantially, so similarity penalises the best decompositions while passing a
subtly broken one that happens to read alike. Behavioural equivalence needs
differential execution, which is what the auditors actually did (one ran 20,038
differential cases).

**Determinism, carefully.** A fixed local embedding model with fixed weights is
deterministic — same input, same vector — so this does NOT violate the no-LLM-in-the-
pipeline rule the way sampling would. But the model VERSION becomes a baseline
dependency: upgrade it and every stored score shifts, silently invalidating any
ratchet built on it. Survivable for advisory and retrieval use; disqualifying for a
water-line. Note also that no embedding infrastructure exists today — CLAUDE.md
describes `error-history.ts` as having "optional embeddings support", but there is
no implementation and no dependency in `package.json`.

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

### 11.2 Detector backlog — classes this repo keeps re-committing

Each of these is a defect class observed MORE THAN ONCE in this codebase, which
is the bar for turning a lesson into a write-time check. A lesson that lives only
in a comment gets re-learned; the `/proc` hazard was documented in 2026-06 and
still cost three CI runs and a month-long bogus quarantine in 2026-07 because
nothing enforced it.

| Detector | Fires on | Message must say | Evidence |
|---|---|---|---|
| `procfs_probe_in_test` | **SHIPPED 2026-07-31** — a `/proc/...` path used as an unwritable-path fixture in a test | nest under a regular FILE → ENOTDIR on every platform | 4 probe sites, 3 hung CI runs |
| `absolute_ms_assertion_in_test` | `toBeLessThan(<ms literal>)` on a measured duration | use a same-process ratio against a control (pattern: commit `80eaf2b`); an absolute ms bound passes alone and fails under load, then gets "fixed" by raising the constant, which destroys the signal. **A ratio is necessary but not sufficient — its threshold must be coarse relative to the instrument's noise.** A 2×-vs-4× ratio at ~25ms samples is still flaky (measured: 3.13, 4.26 against a 3× threshold); the same test with a 32×-vs-1024× separation runs at ±1.5%. Size the question to the instrument, and remember the regression you are guarding is usually orders of magnitude, not factors | **4 instances**: ReDoS linearity, `out-of-tree-guard`, property-budget floor, `reinterpret-alignment` (below) |
| `startup_error_vs_test_failure` | non-zero verifier exit with NO runner summary in stdout | classify as `verifier_did_not_run`, never as a test failure or as evidence | `vitest --reporter=basic` (no such reporter in v4) exited 1 having run nothing |

Also queued, from the same session's measurements:

- **Manifest key normalization + test-file exclusion.** The gate uses the
  runner's ABSOLUTE `file_path` as the manifest key while sweeps use
  repo-relative, so one file can hold two records and its ratchet splits across
  them. 17 such keys plus 2 `.test.ts` targets were purged 2026-07-31; the
  normalization belongs at the gate's manifest boundary so they cannot return.
- **Runner concurrency is a hard limit of one job per worktree.** Each endpoint
  answers `503 busy` while a run is in flight, so N parallel agents need
  fail-over + backoff or they silently record "unmeasurable" when they mean
  "busy". Fixed in the local probe 2026-07-31; the same contract belongs in any
  shipped measurement client.
- **`normalizeManifestKey` is not canonical for RELATIVE inputs** (measured
  2026-07-31, correcting the bullet above). It converts absolute → relative but
  leaves `.` / `..` / `//` / a trailing slash intact, so `src/a.ts`,
  `src/./a.ts`, `src//a.ts`, `src/../src/a.ts` and `src/a.ts/` are FIVE manifest
  keys for one file — the split-history defect the absolute-key purge fixed, one
  spelling class over. Fix: resolve before normalizing
  (`normalizeManifestKey(resolve(cwd, f), cwd)`), which is idempotent and
  collapses all five. Audited and NOT a defect in the pending-registry
  key-space, which already resolves — see 11.3.

### 11.3 Path-domain predicates — one question, N answers

Two audits on 2026-07-31 asked the same question of two different key-spaces.
Both are instances of the class this section exists for, and the second one is
the more expensive because it is still open.

**Audit A — the pending-registry key (closed, no change).** The `onPending`
callback in `server/pre-tool-coverage-gates.ts` hand-rolls
`relative(cwd, resolve(cwd, file))` and was suspected of being a third instance
of the two-producers/two-spellings/one-map bug. It is not, and the reason is
worth recording so the audit is not repeated:

- There is exactly ONE producer (`onPending`) and ONE consumer
  (`post-tool-mutation-harvest.ts::writtenFile`, feeding `takePending` and
  `unmatchedPendingWarning`).
- Both derive the key from the SAME source string, `tool_input.file_path`,
  threaded verbatim — the writer through `normalizeChangeSet` (which stores
  `str(input.file_path)` unchanged) → `changedPaths` → `primaryCodeFile` →
  `onPending`; the reader straight off the event. Both apply the SAME expression
  with the same `ctx.cwd` (one daemon, one `ServerRuntime`, both call sites take
  it). They cannot disagree.
- `relative ∘ resolve` is canonical over the POSIX lexical equivalence class:
  across 13 spellings, writer-vs-reader disagreements = 0 and 11 collapse onto
  one key.

Routing it through `normalizeManifestKey` — the obvious "use the canonical
helper" refactor — is a **regression**, not a cleanup: the canonical helper is
strictly weaker here (previous bullet), producing 6 distinct keys over the same
13 spellings where the hand-rolled expression produces 3. Verified by applying
the refactor and watching the new 8×8 write-spelling × read-spelling matrix in
`server/mutation-pending-key-parity.test.ts` fail on 24 of 64 pairs. That matrix
is now the pin: it asserts claimability end-to-end rather than inspecting the
key string, so it fails when EITHER side is changed alone.

**Audit B — "is this a test file?" (open).** `CLAUDE.md` names `isCappableFile`
the one product-code domain definition, added after two gates disagreed about
`scratch/`. That consolidation stopped at the composite and never reached the
predicates underneath it. Measured over 2521 tracked files plus a synthetic
convention corpus:

| Predicate | Home | true on (rel / abs) |
|---|---|---|
| `isTestPath` | `coverage-test-selector.ts` | 1101 / 1101 |
| `isTestOrSpecPath` | `large-file-policy.ts` | 1109 / 1109 |
| `isStrictTestFile` | `checks/shared.ts` | 1100 / 1101 |
| `isTestFile` | `checks/shared.ts` | 1100 / 1318 |
| `isVendoredOrFixturePath` | `checks/shared.ts` | (separate question, already named correctly) |

**Three distinct questions are being asked, not three copies of one.**

1. **Is this file a TEST — an oracle the runner executes?** Answered THREE times
   (`isTestPath`, `isTestOrSpecPath`, `isStrictTestFile`) with three convention
   lists grown independently. None of the divergences is documented as
   deliberate; each is an omission.
2. **Is this file PRODUCT CODE, in the domain of product-code policy?**
   `isCappableFile`. Correctly one function — but its test clause is a private
   copy of question 1 rather than a call to it.
3. **Does this file hold detection patterns as DATA, so a regex content scan can
   only false-positive on it?** `isTestFile` = `isStrictTestFile ∪
   isHarnessInternalDataFile`. Deliberately different and correctly so. Its
   defect is the NAME: "isTestFile" is what makes it read as a third copy of
   question 1, and what would invite a future cleanup to merge it — which would
   make every test-hygiene check fire on 217 detector files (the
   `duplicate_test_names`-on-`verification-stop-checks` false positive its own
   docstring already records).

A fourth question, "did we author this file?", is already separated and named
(`isVendoredOrFixturePath`) — proof the codebase knows how to do this.

Where questions 1's three answers actually diverge (synthetic corpus; the real
tree exercises only 10 three-way disagreements, so the tree is weak evidence and
the convention lists are the real exposure):

| Path | `isTestPath` | `isTestOrSpecPath` | `isStrictTestFile` | Consequence |
|---|---|---|---|---|
| `src/a.test.rb`, `src/a.test.py`, `src/a.spec.rb` | true | false | false | oracle to the mutation gate and the manifest; product code to the line cap and to every test-hygiene check |
| `tests/thing.ts`, `test/thing.ts` (repo-relative) | false | true | false | exempt from the line cap, yet a mutation target, and invisible to test-hygiene checks |
| `src/FooTest.java`, `src/FooTests.swift`, `src/test_foo.swift` | false | true | true | invisible to the affected-test selector |
| `test/agent-driven/run-scenario.ts` (real file) | false | true | — | line-cap exempt AND mutation-eligible |

Two latent defects surfaced while measuring, both the same shape:

- **`isStrictTestFile` matches directories by substring with a leading slash**
  (`normalized.includes("/tests/")`), so a TOP-LEVEL `tests/` directory
  addressed by a repo-relative path does not match. `isTestOrSpecPath` anchors
  correctly with `(?:^|\/)`. Measured: `tests/README.md` flips purely on
  absolute-vs-relative spelling. In a repo whose tests live in a top-level
  `tests/`, every test-hygiene check silently stops firing for relative callers.
- **`isTestFile`'s data-file half only fires for ABSOLUTE paths** —
  `isHarnessInternalDataFile` prefix-matches the resolved package root. Over the
  tracked tree: 217 files exempt when addressed absolutely, **0** when addressed
  relatively. A content scan handed a relative path loses the entire exemption.

**Recommendation — one named predicate per real question. Do not merge the
third.**

1. `isTestSourcePath(path)` — question 1, ONE implementation, the UNION of the
   three convention lists, with directory matching anchored `(?:^|\/)` rather
   than `includes`. The union is safe in both directions here, which is not
   automatic and was checked: every convention in it genuinely names a test file
   (widening question 1 excludes more files from mutation/baselining — the safe
   direction for an oracle; widening question 2's test clause exempts more files
   from the line cap, and each added convention is a real test file, so no
   product code escapes). The segment anchoring keeps `latest/`, `contest/` and
   `src/testing/` out — verified against the corpus. `isTestPath` and
   `isTestOrSpecPath` become thin re-exports, then are deleted at the call sites.
2. `isCappableFile` stays the canonical product-code domain, but its test clause
   CALLS `isTestSourcePath` instead of holding a private copy. This is the step
   the `scratch/` consolidation stopped short of.
3. Rename `isTestFile` → `isPatternDataFile` (or `isContentScanExempt`), defined
   as `isTestSourcePath(p) || isHarnessInternalDataFile(p)`, and make
   `isHarnessInternalDataFile` resolve its input before prefix-matching so the
   exemption no longer depends on the caller's spelling. The rename IS the fix
   for question 3 — it is the only thing preventing the merge that would break
   the checks the split exists to protect.
4. Pin it with **predicate parity**, not prose: extend the shipped
   `registry-parity.json` mechanism (`harness/registry-parity.ts`, already a
   configurable drift detector for paired registries) to declare a set of
   predicates that must agree, run them over a committed convention corpus
   during `interlinked verify`, and report any disagreement. Deterministic, no
   LLM, no new machinery — and it fails the moment a fifth answer to an existing
   question is added, which is the actual recurrence being defended against.

**Status (2026-08-01) — items 1–2 landed; item 3 landed with one deliberate
deviation from the letter of the recommendation; item 4 NOT built.**

- Item 1 shipped as `checks/shared.ts::isTestSourcePath` — the union,
  correctly anchored. `coverage-test-selector.ts::isTestPath` and
  `large-file-policy.ts::isTestOrSpecPath` are now one-line delegates to it
  (both had exactly one external consumer set each — mutation/evaluator/server
  call sites for the former, none besides `isCappableFile` for the latter —
  so re-pointing them cost zero call-site churn). `isCappableFile`'s test
  clause now calls `isTestSourcePath` directly (item 2), not through the
  `isTestOrSpecPath` indirection.
- Item 3 shipped as `isPatternDataFile` (real implementation) with `isTestFile`
  kept as an unchanged-behavior compat alias, **not** a tree-wide rename.
  `isTestFile` has ~100 call sites (almost all content-scan checks under
  `checks/*.ts`); mechanically renaming all of them was out of scope for one
  consolidation pass. More importantly: the recommendation's literal
  definition — `isTestSourcePath(p) || isHarnessInternalDataFile(p)` — was
  **not** implemented as written. It stayed
  `isStrictTestFile(p) || isHarnessInternalDataFile(p)` (i.e., `isPatternDataFile`
  is behavior-identical to the pre-consolidation `isTestFile`, modulo the
  latent-defect-2 fix below). Reason: unlike question 1 (test discovery) or
  question 2 (line-cap exemption), question 3 is a **security-relevant
  "skip this file" predicate** — widening it is the dangerous direction, not
  the safe one. Concretely, unioning would have newly exempted
  `test/agent-driven/run-scenario.ts` (a real file, verified via `wc -l` and
  `rg` against the tracked tree) from ~100 content-scan checks, and any future
  top-level `test/`/`tests/`-directory source file with it. Auditing all ~100
  callers to confirm that's safe was not attempted. Left as an explicit,
  tracked follow-up, not folded in.
  - Latent defect 2 (the absolute-vs-relative-path gap in
    `isHarnessInternalDataFile`) WAS fixed — it resolves a relative input
    against `cwd` before the package-root prefix match now. This is narrower
    and independently safe: it only changes behavior for a caller that (a)
    passes a relative path AND (b) that path resolves under this package's
    own root. Both of `verify`'s and PostToolUse's live call paths already
    pass absolute paths (checked: `discoverFiles` in
    `commands/verify/file-discovery.ts` maps every entry through
    `join(root, f)` before handing it to the checks), so this fix closes a
    gap that was latent for the two paths that matter today, not a live
    regression risk.
  - The `isStrictTestFile` directory-anchor bug (top-level `tests/`/`test/`
    addressed via a relative path) was **not** fixed. It has ~9 consumers,
    all test-hygiene checks, outside the three predicates' home files; fixing
    it changes which files those checks fire on repo-wide, which is a
    separate, larger, not-yet-audited change. Left as a documented, open gap
    (not pinned as "intended" in any test — a bug fixed later shouldn't have
    to fight a regression test asserting the bug).
- Item 4 (registry-parity predicate-agreement check) was not built. In its
  place: `src/harness/__tests__/predicate-consolidation.test.ts` pins (a) the
  three convention lists' union behavior directly, (b) that `isTestPath` /
  `isTestOrSpecPath` never again drift from `isTestSourcePath` (a battery
  parity test), and (c) the deliberate three-way split — the same detector
  file (`checks/shared.ts` itself) is `isPatternDataFile`-true,
  `isStrictTestFile`-false, and `isTestSourcePath`-false, all three asserted
  side by side — so a future drive-by merge is caught by a normal test run,
  not just by `verify`.
- Verified: `npm run typecheck` (one unrelated pre-existing error in
  `trajectory/helpers-commands.ts`, part of a concurrent in-flight edit —
  zero references to any of these predicates); the three predicates' own test
  files plus every real external consumer test file found via `rg` (mutation/
  manifest, gate, measure, evaluate, adopt, manifest-heal; evaluator
  coverage-edit-targets, pre-tool-test-integrity; server post-tool-flake-phase;
  coverage-runner-failing-tests; checks test-hygiene-quality, test-portability,
  over-mocking, procfs-probe, esm-cjs, test-hygiene-isolation, introverted-test;
  untested-exports-stop-check; write-content-guards ×2;
  cli-spec-surface; all five generic-checks-extended files) — all pass
  unchanged.

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
| 2026-07-31 | **A module with NO functions records NOTHING** — far worse than "13 missing mutants" | `rules/builtin-rules-processes.ts` has 0 function-like nodes (one module-scope `GuardRule[]` table): manifest held 0 symbols / 0 mutants vs 397/398 measured. `check-engine/tool-catalog.ts`: 35 recorded vs 513 measured. The worst and most security-critical campaign targets are DATA TABLES, so they were entirely invisible to the ratchet |
| 2026-07-31 | Identity fix verified on the extreme case | after landing, `computeSymbolHashes` emits `(module)` for the zero-function file (0 symbols → 1); `codex-feature-flag.ts` 5 → 6 symbols |
| 2026-07-31 | Manifest keys are not normalized | 17 keys were ABSOLUTE paths duplicating repo-relative entries — the gate uses Claude Code's absolute `file_path` as the key while sweeps use repo-relative, so one file gets two records. 2 further keys were `.test.ts` files, violating the never-mutate-tests invariant |
| 2026-07-31 | Mutation testing found a real user-visible bug | CRLF `config.toml`: `split("\n")` leaves `\r`, and JS `.` excludes all four line terminators, so `/#.*$/` never matches. A commented-out `# hooks = true` reads as ENABLED — `interlinked enable --clients codex` reports success while Codex hooks stay OFF; plus a duplicate `[features]` table that makes Codex reject the config |
| 2026-07-31 | Adversarial prosecution refuted 6 of 13 "unkillable" claims | 3 killed outright, 3 were source defects, 7 genuinely unkillable. One rested on the false premise "JSON.parse tolerates surrounding whitespace" |
| 2026-07-31 | Prosecutors correctly DECLINED two available kills | stubbing `Object.entries` / `JSON.parse` would have pinned implementation choices and states unreachable in production — the restraint the anti-gaming design depends on, exhibited without being caught |
| 2026-07-31 | Absolute-millisecond assertions keep recurring | third instance: `out-of-tree-guard` asserted a 6ms ceiling, hit 7ms/11ms under fleet load, passed 7/7 in isolation. Fixed with the same same-process ratio pattern commit `80eaf2b` used for the ReDoS test. **Worth a detector** — see backlog below |
| 2026-07-31 | A verification command that fails to START looks identical to one that FAILED | `vitest --reporter=basic` does not exist in v4; the run never started and exited 1, which reads as a red suite. Non-zero exit with no test summary in stdout is a startup error, not a test failure |
| 2026-07-31 | **A stale daemon silently UNDER-ENFORCES — the one failure mode a guard must not have** | Live A/B: an `Edit` raising `max_cyclomatic` 22→40 in `.interlinked/metric-caps.json` was **allowed** by the running daemon; the identical edit **blocked** immediately after `harness restart`. Source was never wrong — `evaluateBaselineIntegrityForEvent` blocks both the Edit and Write form and allows the tightening (probe: `scratch/probe-baseline-gate.mts`). The daemon started 11:19 against a dist rebuilt 13:21. Nothing in the block path announces "these gates are from an old build" |
| 2026-07-31 | The build-refresh handover **starves under load** — the cause of the above | `shouldHandOver` required `now - lastActivity >= 10s`, sampled every 60s. A busy multi-agent session never goes 10s idle, so the handover cannot fire exactly when stale gates matter most. Daemon ledger over 400 rows: **38 `rss-ceiling` handovers vs 2 `build-refresh`** (most recent two days old) while a 2-hour-stale daemon served every gate. Fixed by escalating past a 10-minute staleness deadline regardless of activity — a brief fail-CLOSED window is strictly safer than gates that quietly do not fire |
| 2026-07-31 | A scoped `--coverage` run silently poisons the shared report the gate decides from | A concurrent `npx vitest run --coverage <3 files>` overwrote `coverage/coverage-{final,summary}.json`. `all: true` keeps all 1043 files listed so the report looks complete, but total lines read **3.27%** and well-covered files (`commands/activity.ts`, baseline 98.98) read 0/0. `interlinked coverage check` returned 3748 findings, every one an artifact. The gate must fail to UNMEASURED, never to REGRESSED |
| 2026-07-31 | The coverage ratchet's own precision produced ~88% false findings | Baseline stores full float precision (`98.9795918367347`); istanbul FLOORS the report to 2dp (`98.97`) — confirmed at source in `istanbul-lib-coverage/lib/percent.js` (`Math.floor(tmp/10)/100`) and empirically 876/876 against floor, 0/876 against round. With `allow_decrease_pct: 0` every such file read as a permanent −0.009pp regression: of 1075 findings, **1131 identical / 841 phantom / 114 genuine** |
| 2026-07-31 | **The fix for the timing test was ALSO flaky — a noisy instrument cannot answer a fine question** | Replacing the absolute ceiling with a 64KB-vs-128KB ratio (linear ≈2× vs quadratic ≈4×, threshold 3×) failed the full suite at **3.13 and 4.26**. Separating 2× from 4× demands timing PRECISION, and at ~25ms per sample JIT warm-up and scheduler noise exceed the gap. Refixed by asking the instrument a COARSE question instead: a 16KB control against a 32×-larger subject in the same process — linear lands near 32×, quadratic near 1024×. Measured over 6 rounds: **33.6–34.6, ±1.5% variance**, against a 150× threshold — 4.3× headroom over the worst observation and 6.8× below where quadratic would land. **The generalizable rule is not "prefer ratios" but "match the resolution you demand to the resolution the instrument has"**; the regression being guarded was ~78×, so no fine distinction was ever needed |
| 2026-07-31 | **The measurement apparatus itself broke a timing test** — 4th instance of the absolute-ms class | `reinterpret-alignment.test.ts` asserted `elapsed < 2500ms`; identical work under v8 coverage instrumentation took **3284ms and 2643ms**, so the suite was green bare and RED under `--coverage`. Turning on the measurement is a load source like any other. Fixed by asserting the property the code actually delivers — linear scaling, via a 64KB-vs-128KB ratio in the same process (linear ≈2×, quadratic ≈4×, threshold 3×) — so instrumentation, CPU speed and load all cancel. Raising the constant would have destroyed the signal the test exists for |
| 2026-07-31 | The coverage ratchet compared every file TWICE — a second, independent inflation hiding under the first | After the precision fix cut 1075 findings to 234, the residue was still 2× the truth: every `(file, metric)` pair appeared exactly twice and `files_checked` read 2088 for a 1044-file report. `loadMergedReport` merges an LCOV source and an istanbul source, and the two spell keys differently — LCOV's reader emits repo-relative POSIX paths, istanbul's emits ABSOLUTE. Keys were normalized at COMPARISON time but not at MERGE time, so each file entered the map twice. Fixed by normalizing before insertion via the existing `normalizePath`. Final: **1075 → 117 genuine, 0 duplicated**. Same root class as the mutation-manifest absolute-key defect — *two producers, two path spellings, one map* |
| 2026-07-31 | The coverage baseline survived the double-count uncorrupted, for a knowable reason | `--update-baseline` was run while the duplication was live. It wrote **0 absolute-path keys** because `compareCoverage` normalizes per-entry when building `nextBaseline`, so both spellings collapsed to one record written twice with the same value. Verified: 7 raised, 1197 unchanged, 1 new, **0 genuine lowerings** — the 916 apparent drops were each exactly `floor(x*100)/100`. Worth noting the ORDER of luck: normalization at the write boundary saved the durable artifact while its absence at the read boundary corrupted only the ephemeral report |
| 2026-07-31 | **Adversarial verification refuted 7 of 7 agent-hardened units — and the failure mode was OVERCLAIMING, not cheating** | A 7-file coverage/CRAP hardening wave, each unit audited by an independent agent told to DISPROVE it. Every unit was refuted: 28 problems total. But **0 mock-only tests and 0 weakened/deleted/skipped tests** — the agents did not game the metric, they overstated what their tests established. The recurring shapes: (a) a test that covers a branch but still passes when the branch is DELETED — coverage without verification; (b) `expect(xs.every(p)).toBe(true)` with no assertion on `xs.length`, vacuously true on an empty array; (c) branches declared "unreachable" that a verifier reached, in three separate units; (d) a source defect PINNED AS INTENDED BEHAVIOUR, which cements the bug; (e) test titles promising more than their assertions delivered. **The lesson for the harness: a coverage number cannot distinguish any of these from real tests — only an adversary can.** |
| 2026-07-31 | Agent-written tests inherit ambient machine state the agent thinks it isolated | `metrics-rework.test.ts` isolated `GIT_CONFIG_GLOBAL/SYSTEM` for its FIXTURE-building git calls, and its own comment claimed "full isolation from the developer's global/system git config". But the SUT runs its own `git log`/`diff`/`blame` through `execFileSync`, which inherits `process.env` — so the host's `~/.gitconfig` governed the code under test. Measured: `core.quotePath=false` alone flips **11 of 27** assertions. The same agent had already written `process.env.GIT_CEILING_DIRECTORIES = …` elsewhere in the file *because* "the command inherits process.env", so it knew the mechanism and still missed the case. Fixed by pinning the env the SUT sees; verified 27/27 under both clean and hostile config. **Generalizes: any test asserting on a subprocess's output must pin that subprocess's environment, not just its own.** |
| 2026-07-31 | Cyclomatic has far more ratchet headroom than assumed | 9270 functions across 1037 cappable files: max 56, **p99 18**, p95 12, p90 9, p50 3. Cost grid — cap 25 → 3 over, 24 → 10, 23 → 15, 22 → 23, 21 → 34, 20 → 53. Ratcheted 25 → 22. Cognitive measured p99 28 against a cap of 30, i.e. already correctly placed, so it was left alone |
