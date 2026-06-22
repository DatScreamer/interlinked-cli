# deintroverter (4clj)

- **Source:** https://github.com/unclebob/deintroverter4clj
- **Encountered:** 2026-06-22, sent by user ("how could we adapt this for the tests our harness enforces?")
- **Verdict:** **PR** (build the assertion→SUT provenance check) + **memory note** (per-form incremental mutation manifest → mutation gate) + **methodology adoption** (golden-corpus gating). Compound — see §9.

## 1. Core idea (one sentence, my words)

A fully deterministic static analyzer that, per test, answers *"does at least one assertion's value provably trace back to a call into the system under test?"* — and flags **introverted** tests (assertions that only touch literals, test-local data, mocks, or `clojure.core`), which pass or fail independently of production behaviour and therefore cannot kill a single mutant.

## 2. Anatomy (concrete walkthrough)

~3,100 LOC of Clojure/Babashka, MIT-ish in spirit but **no LICENSE file** (see §3). One real dep: `borkdude/edamame` (a pure Clojure reader). Pipeline (`core.clj → sut.clj → analyze.clj → walk.clj/trace.clj/provenance.clj → report.clj`):

| File | Role |
|---|---|
| `sut.clj` (79) | Infer the SUT namespace set: convention (`foo.bar-test`→`foo.bar`) + test `:require`s + `deps.edn` `:paths`, minus a denylist (`clojure.*`, test libs, external deps). |
| `assertions.clj` (105) | Recognize assertion macros (`is`/`are`, Speclj `should*`), extract the **asserted value form**. Already prefix-matches `should`/`assert`/`expect`. |
| `trace.clj` (359) | Strict reachability: desugar `->`/`->>`, collect calls, resolve each symbol's namespace, decide `:proven`/`:likely`/`:none` against the SUT set. Iterative stack walk (no recursion → no SO on deep forms). |
| `provenance.clj` (380) | **The 2026-06-22 refactor.** Every value gets `{:kind :sut-invoke|:sut-derived|:catch-derived|:literal|:unknown, :confidence :proven|:likely, :via [chain]}`, derived through `get`/destructure/`deref`/`ex-data`, depth-capped at 3. This is **taint-tracking with the SUT as source and the assertion as sink.** |
| `walk.clj` (1014) | Robustness engine: walks through transparent wrappers (`do`/`try`/`let`/`with-redefs`), inlines test-local helpers, and **flattens conditionals** (`doseq`/`dotimes`/`cond`/`case`/`when`/`if`) so table-driven and `gen/sample` (test.check) tests don't false-positive. Carries a walk-state machine (`:seen-sut?`, `:last-sut-call`, `:stub-capture-atoms`). |
| `heuristics/external.clj` (282) | Explicit, *deliberately-not-folded-into-taint* rescue rules for stub-wiring atoms and filesystem side effects. |

What the user invokes: `bb -m deintroverter.core --format edn <paths>`. Exit code is **always 0** (the report is the product, not a gate — author's choice, see §3b).

**End-to-end, the two canonical fixtures:**

```clojure
;; introverted_literal.clj  → :introverted  (asserts on a test-local literal via clojure.core/count)
(deftest only-checks-input
  (let [items [1 2 3]] (is (= 3 (count items)))))

;; extroverted_direct.clj   → :extroverted  (asserted value is a SUT call result)
(deftest calculates-total
  (is (= 2 (core/calculate-total [1 2]))))
```

The load-bearing case for *us* is `stub_capture_wiring.clj`: a test that mocks the SUT and asserts on a captured atom stays **`:introverted`** when the stub doesn't write the asserted value — green, "covers" the import, verifies nothing. That is the mock-saturated failure mode that dominates JS/TS suites.

## 3. Deterministic or agentic?

**Fully deterministic.** edamame parse → syntax-tree walk, *no macroexpansion, no `tools.analyzer`, no network, no model.* The provenance plan lists "ML or fuzzy matching" as explicitly out-of-scope. Verified by reading `trace.clj`/`provenance.clj` directly, not the README — clears the determinism filter cleanly.

**License: no LICENSE file present** → all-rights-reserved by default. **Code-borrow is blocked regardless of language.** It's Clojure anyway, so this only confirms the right move is concept/algorithm transfer, never copy.

## 3b. Role in its native architecture — and does it transfer?

Native role: an **advisory oracle for a human** — "interrogate the structure of tests… not meant to be wired into CI gates… treat verdicts as guidance, not pass/fail." Always exits 0.

Our role must differ, and the harness has the machinery to make it differ *safely*: the existing `[proven]`/`[heuristic]` determinism tag (`quality-checks.ts::classifyDeterminism`). The carve-out is the verdict lattice — `:extroverted`/`:introverted` are the proven poles (gate-able); `:likely-extroverted`/`:conditional-assertion`/`:questionable` are the heuristic middle (advisory only). So we can adopt the *signal* more aggressively than the author gates it, but only on the proven pole — exactly what the determinism tag exists to express. **Adopt the proven pole as a gate; honour the author's "don't gate heuristics" stance for the rest.**

## 4. Substrate vs. surface

- **Surface:** a standalone test-auditing CLI (Clojure-only). Not transferable.
- **Substrate (the borrowable part):** the **assertion-value→SUT provenance trace** — a one-source/one-sink taint pass over a test body. Independent of Clojure; the algorithm is ~350 lines of AST logic. Borrowable as concept; we already own the two ingredients it needs (a TS AST via the `typescript` optionalDependency that `cyclomatic-ast.ts` uses, and `taint-tracker.ts` as a flow-model precedent).

## 5. Lane (1–6)

- **Lane 2 (detection technique)** — primary. A new PostToolUse/verify check: `assertion_sut_provenance` (a.k.a. `introverted_test`).
- **Lane 3 (substrate)** — secondary. The per-form **content-hashed incremental mutation manifest** (from sibling `clj-mutate`, embedded in every file here) is a substrate pattern for our mutation gate.
- **Lane 4 (pattern)** — the "test-efficacy ladder" framing and the **verified-coverage** refinement to CRAP (§ Notes).

## 6. Dependency & displacement

- **Deps:** **No new runtime dep.** The TS path reuses the already-present `typescript` AST (degrade to a regex walker + "trace unavailable" exactly like the complexity gate when `--omit=optional`). Invoke-as-subprocess (shell out to `deintroverter` itself) is possible *only* for Clojure repos and needs Babashka — niche; skip.
- **Displacement:** overlaps three shipped checks but **replaces none** — it's the dataflow layer beneath them. `checkTestMissingSutImport` (imports the sibling?), `checkMockOnlyTest` (only mock-interaction matchers?), `checkMockingTheSutSelf` (mocked its own SUT?) are all *structural/matcher* proxies; deintroverter is the *value-provenance* proof those proxies approximate. It strengthens, not duplicates, them.
- **Equivalence (capability-by-capability):**

| deintroverter capability | Our equivalent | Status |
|---|---|---|
| SUT *identification* (convention + imports + project paths) | `checkTestMissingSutImport` (basename), `coverage-test-selector.ts` (reverse import graph), `companionTestCandidates` | **shipped** |
| Assertion macro recognition + assertion counting | `behavioral-checks-tdd-assertions.ts::countAssertions`, `checkMockOnlyTest` matcher classifier | **shipped** |
| **Assertion-value → SUT provenance trace** (the core) | — | **ABSENT ← the gap** |
| introverted (asserts on literal/test-local only) | — | **absent** |
| asserts only on a mock's return/captured value | `checkMockOnlyTest` (matcher-*kind* only, not value provenance) | **shipped but shallow** |
| cloistered (asserts via another test module) | — | **absent** |
| conditional/`doseq`/`case` flattening (FP-robustness) | diff-class / cold-file skips (different purpose) | **absent for this check** |
| Coverage ratchet (`cloverage`) | `coverage-ratchet.ts` + `coverage-baseline.json` | **shipped** |
| CRAP (`crap4clj`) | `crap.ts` — **identical** formula `c²·(1−cov)³+c` | **shipped** |
| Cyclomatic | `cyclomatic-ast.ts` | **shipped** |
| DRY (`dry4clj`) | DRY/duplication checks in `entries-warnings/code-quality.ts` | **shipped** |
| Mutation (`clj-mutate`) | `mutation-gate.ts` (baseline/score infra) | **partial** (execution deferred) |
| **Per-form content-hashed incremental mutation cache** | `mutation-baseline.json` is **per-file**, not per-form | **partial ← borrow the granularity** |
| Red/green TDD cycle | `behavioral-checks-tdd.ts` state machine | **shipped** |
| Golden-master corpus of analyzer verdicts | per-check fixtures + parity tests (no single pinned snapshot) | **partial** |

The headline lesson of the table: **we already ship every metric in Uncle Bob's suite (coverage/CRAP/cyclomatic/DRY/mutation-infra). The one thing we don't have is the introvert signal itself** — the static proof that an assertion is grounded in the SUT.

## 7. Smallest spike (≤1 day)

A `assertion_sut_provenance` check, TS/vitest/jest, advisory-first:

1. Gate on `isTestFile` (`checks/shared.ts`) **and** ≥1 in-project SUT import resolvable (reuse `companionTestCandidates` + the import scan) — i.e. only reason about *unit* tests with an identifiable SUT. Scope out integration/e2e (the tool excludes `acceptance/` for the same reason).
2. Build the SUT symbol set = symbols imported from the resolved SUT module(s).
3. For each `it()/test()` block, find assertion subjects (`expect(X)`, `assert(X)` — reuse the `countAssertions` extractor).
4. Trace `X` over the `typescript` AST: does it (a) call a SUT symbol, (b) `await`/`.member`/destructure of such, or (c) a `const r = sut.f()` binding chained into the assertion? Mirror `trace.clj`'s reach + `provenance.clj`'s 3-hop derive. Mock-return detection (`X` derives from a `vi.fn()`/`mockReturnValue`/`vi.mock`'d symbol) → **not** SUT-grounded.
5. If **no** assertion in the block traces to a SUT symbol → emit `introverted` (advisory). Ship ≥3 positive + ≥3 negative fixtures (incl. `it.each`, helper-via-SUT, snapshot, async) per the check-authoring contract; calibrate against an FP-guard corpus; ratchet proven cases to default-gate.

Wiring is the standard path: detector in `checks/`, entry in `entries-warnings/test-and-demo.ts`, `check-metadata.ts`, `content_keywords: ["expect","assert","test","it"]`. v0 covers direct/member/let-binding/mock-return; conditional-flattening + cloistered are follow-ons.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | `assertion_sut_provenance` per-edit/verify check (sub-ms, deterministic); per-form mutation-manifest granularity for the local mutation gate | §7 | **now** |
| Agent CI (P4–5) | Cloud mutation fan-out *prioritized by* introvert pre-filter — skip mutating functions whose only tests are introverted (guaranteed-survivor, no signal); reclaim the budget for functions where mutation actually discriminates | wire introvert verdict as the mutation work-list filter | next |

## 9. Artifact

Compound:
1. **PR** — `assertion_sut_provenance` check (§7). The genuinely missing layer; slots into the existing `docs/design/test-file-only-checks.md` family as its dataflow-based member (it subsumes the shallow `mock_only`/`missing_sut_import` proxies).
2. **Memory note** — adopt `clj-mutate`'s **per-form content-hashed manifest** for `mutation-gate.ts` so a per-edit/commit mutation run re-mutates only changed functions (keep our sidecar `mutation-baseline.json` location; borrow the per-form-hash *granularity*). Feeds [[project_incremental_coverage_index]] + the §"Endgame seam" mutation work.
3. **Methodology** — pin heuristic-check verdicts on a golden corpus (their `golden_findings.edn` + `check_empire_introverted.clj` real-repo zero-FP gate + `fixtures_manifest.edn` negative tagging) — the FP-guard-corpus discipline, formalized.

## Notes — impact per metric (the user's question)

The unifying frame: **a test-efficacy ladder.** Each rung is a stricter, costlier proof that a test verifies the SUT.

| Rung | Question | Cost | Our status |
|---|---|---|---|
| 1 | has assertions? | syntactic, sub-ms | shipped |
| 2 | non-tautological / not mock-only? | syntactic, sub-ms | shipped |
| **3** | **assertion *value* traces to SUT? (extroversion)** | **static dataflow, sub-ms** | **ABSENT** |
| 4 | executes SUT lines? (coverage) | 1 test run | shipped |
| 5 | detects SUT corruption? (mutation) | N test runs | designed |

- **Mutation testing (headline).** An introverted test is a **provable mutation survivor with no run** — if no assertion observes fn `F`, every mutant of `F` survives. So rung 3 is a free **pre-filter/prioritizer** for the mutation gate: don't pay to mutate functions whose only tests are introverted; spend the ≤25s fan-out budget where mutation actually discriminates. Separately, `clj-mutate`'s per-form manifest is the **incremental** design that makes a per-edit mutation gate affordable.
- **Coverage.** Coverage measures *execution*; extroversion measures *verification*. A test can call the SUT (line "covered") yet assert on a literal — covered-but-introverted = coverage theater. Extroversion is the assertion-side complement: `covered ∧ extroverted` ≈ "executed *and* checked." Cheap honesty layer over the existing ratchet.
- **CRAP.** `crap.ts` already matches `crap4clj` exactly. The refinement: CRAP's coverage term over-credits introverted tests. A **CRAP-E** variant that uses *extroverted* coverage (lines executed by an assertion that traces back to them) instead of raw coverage is strictly more honest — a complex function "covered" only by introverted tests would correctly score as high-risk. Novel, and cheap given we'd already compute extroversion.
- **Cyclomatic.** Indirect: a high-cyclo function with only introverted tests is the true worst case (complex *and* unverified). Extroversion sharpens the "unverified" half that CRAP already tries to express.
- **Red/green TDD (`behavioral-checks-tdd.ts`).** Red→green proves a test was sensitive *at one moment*. Extroversion is the **standing invariant** that moment established — later SUT refactors can silently re-introvert a test (assertion now reads a fixture/mock). Compose: red→green at birth, extroversion as the persistent guardrail.
- **Property testing.** fast-check/generative tests are extroverted by nature (the property invokes the SUT), so mostly orthogonal/safe — note `walk.clj` already *trusts* `gen/sample` collections to avoid false positives, a pattern to copy. The residual gap (a *trivial* property that runs the SUT but barely constrains it) is caught by mutation, not by extroversion.

Other carry-overs: the **provenance refactor itself** is a reusable lesson — when ≥3 ad-hoc rescue heuristics target one signal, unify them into a taint pass with a `:via` audit chain (and, tastefully, keep genuinely-external evidence like file-I/O *outside* the generic model, as they did). The harness's own `checks/` families occasionally accrete such `or`-chains.

## Methodology notes

Confirmed the marketing-vs-reality discipline pays: "DP/algorithmic" wasn't the trap here, but the README's *"don't gate on this"* stance would have mis-routed the find to lane-6-skip if taken at face value. Reading `provenance.clj` showed the proven pole is perfectly gate-able — the author's caution is about the heuristic middle, which our determinism tag already isolates. Lesson: a source's *self-imposed usage limit* is an input to §3b, not a verdict — re-derive the limit against our topology (we have a determinism tag + ratchet the standalone CLI lacks).
