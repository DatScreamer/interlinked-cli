# Test-Category Adoption From the Wild — Jeff Emanuel (`Dicklesworthstone`) Taxonomy → Interlinked Harness

**Status:** research record + adoption proposal. 2026-06-06.

**Companion to** (read these for the canonical design; this doc is the *empirical
witness* + the *generic / inference-time filter* that feeds them):
- `docs/design/test-quality-harness-local-first.md` — the canonical four-lane
  (A test-adequacy / B correctness / C security / D runtime-resilience)
  local-first design. Coverage, mutation, CRAP, smart test-selection (§13),
  acceptance-as-first-class (§12) all live there.
- `docs/design/maximal-local-enforcement-roadmap.md` — status / sequencing of the
  "make the product fully opinionated" campaign (coverage keystone shipped).
- `docs/design/stop-event-checks.md` — the Tier 2/3 Stop-event backlog
  (diff-mutation, property tests, patch-level cloud review already queued there).
- `docs/design/proof-of-enforcement.md` + `docs/design/open-obligation-ledger.md`
  — where the "claim-gate" meta-category (§6.4) lands.

**Source:** survey of `github.com/Dicklesworthstone` (Jeff Emanuel, "doodlestein"),
179 public repos (174 own, 5 forks), conducted 2026-06-05/06. Method: recursive
git-tree fetch of all 174 own repos (309,942 paths) + direct reads of config files
and CI workflows. GitHub's legacy code-search API under-indexes large repos, so all
findings below are from file trees + file contents, not search.

> One-file note: the external-pulse convention (`docs/external-pulse/<slug>.md`)
> would also fit the *research* half of this doc. It is kept here as a single design
> document per the request that prompted it; the §2–§3 research section can be lifted
> into `docs/external-pulse/jeff-emanuel.md` and cross-linked if the intake index
> should point at it.

---

## 0. TL;DR

Jeff Emanuel's 2026 Rust systems repos run one of the most exhaustive test
taxonomies observable on public GitHub — ~30 distinct categories. **Most are
bespoke-per-repo** (property suites, fuzz targets, conformance crates, Loom models,
Lean proofs) and cannot be authored generically at agent-inference time without an
LLM synthesizing oracles — which our deterministic-only rule
(`feedback_harness_deterministic_only.md`) forbids in the check pipeline.

The categories that are **both broadly generic AND inference-time-runnable on a
hook** are a short list, and **we already own the metrics for most of them**
(`cyclomatic.ts`, `crap.ts`, `coverage-ratchet.ts`, `mutation-gate.ts`,
`behavioral-checks-tdd.ts`). The load-bearing gap is **execution**: those ratchets
*consume* externally-produced reports and run from CLI/verify, and **nothing in the
harness runs the (scoped) test suite at inference time**. So the highest-value work
is an execution engine wired to hooks, plus a handful of genuinely net-new generic
runners (doctest, flake-rerun, snapshot-hygiene).

The reframe that matters: **generic *execution* is cheap to add; generic *authoring*
is not.** Run what a repo already has (scoped to the diff); nudge for what it lacks;
only the metric-style categories generalize as net-new checks.

---

## 1. Why this doc exists

`test-quality-harness-local-first.md` reasons about the verification stack from
first principles + Supermodel. This doc adds the missing input: **an empirical
witness** — a prolific practitioner who actually runs the full gauntlet across 174
repos — and then **filters that taxonomy** by the two constraints that matter for us:

1. **Broadly applicable to any codebase** (zero bespoke per-project test code), and
2. **Runnable at agent-inference time** on a Claude Code hook
   (PreToolUse / PostToolUse / Stop / SubagentStop / SessionEnd / SessionStart —
   see https://code.claude.com/docs/en/hooks).

Everything that survives both filters is a candidate harness check. Everything that
fails the first filter is "run-if-exists / nudge-if-missing." Everything that fails
the second goes to cloud or is dropped.

---

## 2. The source: Jeff Emanuel / `Dicklesworthstone`

- **Who:** Jeff Emanuel ("doodlestein"), NY. 179 public repos, 2.7k followers.
- **Shape of the corpus:** famous older Python utilities (`llm_aided_ocr` ⭐2,929,
  `swiss_army_llama` ⭐1,053, `bulk_transcribe_youtube` ⭐674) — essentially
  single-purpose scripts with little/no test infra — versus a large 2026 push of
  Rust systems projects (the `franken*` family reimplementing SQLite/NumPy/SciPy/
  PyTorch/etc., `asupersync`, `flywheel_connectors`, `beads_rust`, `pi_agent_rust`,
  `eidetic_engine_cli`) carrying extreme verification rigor.
- **Provenance:** the rigorous repos are visibly products of an **agentic coding
  flywheel** — bead-tracking IDs (`bd-3jh.22`), agent authorship
  (`Deciders: SwiftOwl (agent)`). So the rigor is the output of a *methodology +
  agent fleet*, at a scale/consistency hard to hand-author. (Directly relevant: this
  is interlinked-cli's own genre — `agentic_coding_flywheel_setup` ⭐1,502.)

### Two caveats that bound every count below

- **Bimodal distribution.** All rigor lives in the 2026 Rust repos with CI
  (95/174 repos have CI; 79 have none). The high-star Python repos have ~none.
  "Across all his repos" is misleading; "across his serious systems repos" is right.
- **Vendored ≠ his.** `franken_numpy` vendors NumPy source, `frankenterm` vendors
  HarfBuzz; their `codeql.yml` / `coverity-scan.yml` / `cifuzz.yml` are *upstream's*
  CI, not his practice. Excluded from "his own" claims below.

Headline scale: **463 CI workflow files across 95 repos**; path-counted test files
(Rust inline `#[cfg(test)]` excluded, so undercounted): **Rust 11,954, Go 1,571,
TS/JS 1,354, Python 1,008**.

---

## 3. The observed test taxonomy (full)

### 3.1 The six originally-asked practices

| Practice | Verdict | Evidence (repo: path) |
|---|---|---|
| **Unit testing** | ✅ pervasive | ~16k+ test files; ADR cites "335 tests in 5.6s" for one crate |
| **Coverage analysis** | ✅ formal, gated | `frankensqlite: docs/adr/0001-coverage-toolchain-selection.md` (cargo-llvm-cov chosen over tarpaulin/grcov w/ measured 85% line / 82% branch); `frankenscipy: quality_gates.toml` (per-crate line/branch thresholds + flake budget); `coding_agent_session_search: .github/workflows/coverage.yml` (phased ratchet 60→70→80→90% across 2026 quarters → Codecov) |
| **Mutation testing** | ✅ advanced | `franken_node: .cargo-mutants.toml` + `.github/workflows/mutants-gate.yml` (installs `cargo-mutants 27.0.0`, **enforces exit code**); `franken_engine: …/MUTATION_TESTING_MANIFEST.md` (operator catalog, survivor analysis, evidence-gated equivalent-mutant filter) |
| **Acceptance testing** | ✅ as conformance/E2E | 34 repos with `*-conformance` crates testing reimpls vs reference behavior (frankensqlite vs real SQLite); `conformance.yml`, `e2e.yml`, `live-conformance-gates.yml`. **No** Cucumber/behave/Gherkin. |
| **Cyclomatic complexity** | ⚠️ not as a tool | No lizard/radon/gocyclo/xenon/mccabe anywhere; `clippy.toml` files enforce *determinism* + import hygiene, **not** cognitive-complexity thresholds. What he does is **algorithmic (Big-O)** complexity, documented + gated (`franken_networkx: …/doc_pass05_complexity_perf_memory_gate.rs`). |
| **CRAP analysis** | ❌ absent | Zero markers across 174 repos. He tracks complexity + coverage separately but never the composite (a Java/PHP `crap4j` metric). |

### 3.2 The extended taxonomy (~25 more categories)

Grouped by *role in the test*. Repo counts are marker-based (tree path or CI
workflow); de-contaminated where noted.

**A. Input-generation strategies**
| Category | Repos | Marquee receipt |
|---|---|---|
| Property-based (proptest/quickcheck/hypothesis) | 29 | `beads_rust: tests/proptest_hash.rs` |
| Fuzzing — incl. *differential* fuzz, fuzz-under-TSan, nightly, corpus-minimize | 27 | `asupersync_ansi_c: tests/fuzz/fuzz_differential.c`; `fuzz-tsan.yml`, `fuzz_nightly.yml`, `fuzz-minimize.yml` |
| Metamorphic | 19 | `coding_agent_session_search: tests/golden/metamorphic/` |
| Adversarial | 21 | `beads_viewer_rust: tests/testdata/adversarial_parity.jsonl` |
| Multi-seed / determinism replay | 26–37 | `lab-runtime-multi-seed-nightly.yml`; `replay-gates.yml` |

**B. Oracles (how correctness is judged)**
| Category | Repos | Marquee receipt |
|---|---|---|
| Snapshot/golden (`insta` + golden fixtures) | 29 | `beads_rust: tests/snapshots/golden_beads_init__….snap` |
| Differential / parity vs reference impl | 30 | `wezterm-render-differential.yml`; `tokio_parity_dashboard_drift.yml` |
| Invariant assertions | 27 | `asupersync_ansi_c: docs/INVARIANT_SCHEMA.md` |
| Contract ("no-contract-no-merge") | 32 | `no-contract-no-merge-gate.yml`; `contract-families-matrix.yml` |
| Round-trip / serialization | 25 | `beads_rust: tests/e2e_scripts/slug_round_trip.sh` |

**C. Non-functional / robustness**
| Category | Repos | Marquee receipt |
|---|---|---|
| Concurrency interleaving (**Loom**) | 2 | `frankensqlite: crates/fsqlite-mvcc/tests/loom/MODEL.md`; `frankenterm/.github/workflows/loom.yml` |
| Sanitizers (ASan/MSan/TSan/Miri) | ~19 | `asupersync_ansi_c: build_asan.sh`; `compiler_sanitizers.yml`, `fuzz-tsan.yml` |
| Soak / stress / load / endurance | 31 | `…/stress-10k-tasks.json`; `nightly-differential-stress.yml` |
| Chaos / fault-injection | 19 | `…/chaos-sendpermit-ack.json` |
| Benchmark / perf-regression (criterion/divan) incl. **competitor-bench** | 47 | `competitor-bench.yml`, `perf_regression_gate.yml`, `headline-claims-bench.yml` |
| Cross-platform / cross-arch | many | `linux-ppc64le.yml` (**big-endian**), `linux_qemu.yml` (cross-arch), `musl-test.yml`, `msvc-ci.yml`/`msys2-ci.yml`/`cygwin.yml`, `wasm.yml`/`emscripten.yml`, `windows-vfs-interop.yml` |

**D. Formal methods (rare — most teams never touch these)**
| Category | Repos | Marquee receipt |
|---|---|---|
| **Lean 4** machine-checked proofs | 5 | `asupersync: formal/lean/Asupersync.lean`; `eidetic_engine_cli: proofs/lean4/pack_determinism.lean`; `lean-verify.yml` |
| **TLA+** specifications | — | `eidetic_engine_cli: proofs/tla/agent_mail_coordination.tla` |
| Bounded model checking | 7 | `asupersync_ansi_c: tests/invariant/model_check/test_bounded_model.c`; `formal-models.yml` |

**E. Static analysis & supply chain**
| Category | Repos | Notes |
|---|---|---|
| Type-checking as a gate (mypy, `mypy_primer`, stubtest, pyright, tsc strict) | 17 | `ascii_art_mini_transformer: mypy.ini`; `stubtest.yml` |
| SAST / secret / dep audit (cargo-audit, **cargo-deny**, gitleaks, supply-chain-audit) | 12 | `coding_agent_session_search: deny.toml`; `audit.yml`, `dcg-scan.yml`, `compromise-reduction-gate.yml` |
| CodeQL | 1 own | `swiss_army_llama/.github/workflows/codeql.yml` (others are vendored upstream) |

**F. Release & operational**
| Category | Repos | Marquee receipt |
|---|---|---|
| Smoke (prod + docs-example) | 43 | `production-smoke.yml`, `readme-quick-example-smoke.yml` |
| Installation / packaging tests | many | `installer-canary-strict.yml`, `cargo-install-validation.yml`, `fresh-clone-build.yml`, `build-wheels.yml` |
| Semver / API-compat | — | `semver-check.yml`, `cli-version-audit.yml` |
| Doctests (Rust `--doc`, Python `--doctest-modules`) | pervasive | path-invisible, undercounted |
| PTY/terminal & browser/UI | — | `pty-tests.yml`; `playwright.yml`, `browser-tests.yml`, `lighthouse.yml` (perf + a11y) |

**G. Claim / reality-check gates — the distinctive one**
A meta-category not seen elsewhere: CI that treats the project's **own README/marketing
claims as falsifiable** and emits certification verdicts. `headline-claims-bench.yml`,
`independent-replication-gate.yml`, `reality-check-drumbeat.yml`/`-cadence.yml`,
`vef-claim-gate.yml`/`dgis-claim-gate.yml`/`bpet-claim-gate.yml`,
`compatibility-threat-evidence-gate.yml`, `weekly-certification-verdict.yml`,
`proof-carrying-execution-ledger-gate.yml`, `readme-cli-drift-gate.yml`.

**H. Domain-specific (excluded from adoption — not generic)**
PTY/terminal-emulator, browser/Lighthouse, GPU/ML-training validation
(`train_gpu.yml`), bounds-checks for numeric kernels (`lindley-bounds-check.yml`).

---

## 4. Gap analysis — what the interlinked harness already has

Verified against the codebase 2026-06-06. **We own the metrics; we are missing the
inference-time execution engine.**

| Capability | Module | Wired to | Inference-time live? |
|---|---|---|---|
| Cyclomatic complexity (multi-lang, per-function) | `src/harness/checks/cyclomatic.ts` | feeds `crap.ts` + `dry.ts` | metric yes |
| **CRAP** (`comp²·(1−cov)³+comp`) | `src/harness/checks/crap.ts` (+ `crap-telemetry.ts`, `crap-baseline.ts`) | **`interlinked verify` only** (`src/commands/verify/file-checks-agent-safety.ts`) | **no** — verify-time, not on a hook |
| Coverage ratchet (per-file) | `src/harness/coverage-ratchet.ts` | **CLI** `src/commands/coverage.ts`; consumes `coverage-summary.json` | **no** — nothing runs the coverage at edit time |
| Mutation gate (per-file ratchet) | `src/harness/mutation-gate.ts` | **CLI** `src/commands/mutation.ts`; consumes Stryker/mutmut/cosmic-ray report; "weekly/scheduled" | **no** — periodic; `cargo-mutants` not in supported report set |
| TDD cycle / assertion density / commit gates | `src/harness/behavioral-checks-tdd.ts` | PostToolUse (Layer 1) | **yes** |
| DRY / duplication | `src/harness/checks/dry.ts` | PostToolUse / verify | yes |
| Static nondeterminism (Date.now/Math.random in tests) | `taste-checks.ts::checkNonDeterministicTest` | PostToolUse | yes (static only) |
| Test-impact classification | `src/harness/impact-analysis.ts` | — | **classifies, does not run** |
| Type-check / SAST / secrets / dep-audit | quality-checks + package-allowlist | PostToolUse | yes |

**Three confirmed holes** (and they're the same hole three ways):
1. **No live test-suite execution.** The PostToolUse pipeline runs tsc/lint/compilers
   — never `vitest`/`pytest`/`cargo test`. (`test-quality-harness-local-first.md`
   §1.2 says it outright: coverage/mutation/CRAP "exist as primitives … not wired
   into the live loop.")
2. **CRAP/coverage are verify/CLI-bound,** not on a hook with a live coverage feed.
3. **Mutation is periodic + report-consuming,** not diff-scoped + cloud at commit.

---

## 5. The adoption filter

### Axis 1 — generic *authoring* vs generic *execution*
- **Generic execution:** the harness can *run* a project's existing tests of any
  category if they exist (impact-scoped). Cheap to add. Applies to **all** of Jeff's
  categories via the smart-selection substrate (`local-first.md` §13).
- **Generic authoring:** the harness can produce the *signal itself* on any repo with
  no bespoke test code. Only **metric-shaped** categories qualify: complexity,
  coverage, CRAP, mutation (needs a suite), doctest, flake-rerun, snapshot-hygiene.
  Property/fuzz/conformance/metamorphic/Loom/formal cannot — they need
  human/agent-authored oracles, and synthesizing those at check time is LLM work,
  barred from the deterministic pipeline.

### Axis 2 — inference-time hook-fit
- **PreToolUse:** cheap gate, or a synchronous cloud fan-out ≤~25s
  (`feedback_pretooluse_cloud_synchronous_block.md`). Mutation-on-commit lives here.
- **PostToolUse:** per-edit, must stay sync (`feedback_posttooluse_stays_sync.md`) →
  scope-limited + content-hash cached.
- **Stop / SubagentStop:** turn-level reflection, non-blocking, hundreds-of-ms OK.
- **SessionEnd:** fire heavy cloud async; write evidence summary.

**Categories that survive both axes** = the §6 shortlist. The rest = §7.

---

## 6. Recommendation — ranked shortlist

| # | Category | Generic? | Best hook | Local/Cloud | Status | Lane |
|---|---|---|---|---|---|---|
| 1 | **Diff-scoped test runner → patch coverage** | ✅ | PostToolUse (scoped) + Stop (aggregate) | Local small / Cloud full | ratchet+CRAP exist; **runner missing** | A |
| 2 | **Regression via impacted-test selection** | ✅ | PostToolUse / Stop | Local / Cloud | `impact-analysis.ts` classifies; **doesn't run** | A |
| 3 | **Mutation on the diff** | ✅ (needs tests) | PreToolUse on `git commit`/`push` (sync ~25s, ∃-survivor) + SessionEnd async | Cloud | gate exists (weekly/Stryker); **diff-scoped cloud + `cargo-mutants` missing** | A |
| 4 | **CRAP, live** | ✅ | Stop (needs coverage+complexity) | Local | metric exists; **live wiring + coverage feed missing** | A |
| 5 | **Doctest execution** | ✅ Rust/Py first-class | PostToolUse (touched module) | Local | **new** | A/B |
| 6 | **Flake / nondeterminism rerun** | ✅ | Stop / SessionEnd | Local / Cloud | static checks only; **rerun runner new** | D |
| 7 | **Snapshot hygiene** (pending/obsolete) | ✅ | PostToolUse / Stop | Local | **new** | A |
| 8 | **Sanitizers/UB** (ASan/TSan/Miri) | compiled langs | SessionEnd / pre-push | Cloud | **new** | D |
| 9 | **Cross-platform/arch matrix** | ✅ (libs) | pre-push / SessionEnd | Cloud | **new, opt-in** | D |

### 6.1 The spine (1–4) — mostly wiring, not greenfield

Coverage **local** ("executed"), mutation **cloud** ("asserted"), on the **same
diff**, prioritized by **CRAP**:
- **Select** impacted tests with `impact-analysis.ts` (the dep graph exists). Run the
  tiny impacted subset on PostToolUse (content-hash cached); aggregate the full
  impacted set at **Stop**. Whole-suite never runs per-edit (`local-first.md` §4 cost
  table: hub-file whole-suite won't fit the 25s window; §13 substrate routes it).
- **Patch coverage** feeds `coverage-ratchet.ts` → at Stop: *"you wrote 38 lines this
  turn; 11 are unexecuted by any test."* This upgrades `verification-stop-checks.ts`
  from "did you run tests?" (process) to "**your new lines aren't tested**" (outcome)
  — closing the gap between "the agent ran something" and "the agent's specific code
  is verified."
- **Mutation on the diff** (`cargo-mutants --in-diff` / Stryker `--since`,
  ∃-survivor short-circuit) is the commit/push gate. Coverage says executed; mutation
  says the test would actually fail if the code were wrong. **Add `cargo-mutants` to
  `mutation-gate.ts`'s supported set** (currently Stryker/mutmut/cosmic-ray only).
- **CRAP** ranks touched functions so we surface the 2 risky (complex **and**
  undertested) ones, not 30 noisy ones — it's the prioritizer for which gaps/mutants
  to even mention.

### 6.2 Net-new generic runners (5–7)

- **Doctest execution** — `cargo test --doc`, `pytest --doctest-modules` for the
  touched module. Cheap, PostToolUse. Catches the thing agents do constantly: edit a
  function, leave its docstring example stale. (Jeff's `readme-quick-example-smoke`,
  generalized + zero-config.) Not named in `local-first.md`'s lanes — genuinely net-new.
- **Flake / nondeterminism rerun** — rerun the *newly-added/affected* tests 3× (Jeff's
  `rerun_count=3` from `quality_gates.toml`) + run-twice-output-diff. We have *static*
  detection; this is the *dynamic* confirmation (Lane D "flakiness", runner unbuilt).
  Stop or cloud (N× cost).
- **Snapshot hygiene** — flag `*.snap.new` / `cargo insta pending` / jest-obsolete
  introduced *this turn*. Catches an agent blind-accepting snapshots. Trivial,
  PostToolUse. (Complements the existing static "snapshot overuse" shape check.)

### 6.3 Cloud-only (8–9)

Sanitizers (ASan/TSan/Miri on touched compiled-lang tests) and the OS/arch matrix
(musl, MSVC, wasm, big-endian ppc64le) are generic for the right project types but
heavy and need other machines → SessionEnd / pre-push cloud, opt-in per repo. Lane D.

### 6.4 The claim-gate meta-category (§3.2-G) — maps to our proof-of-enforcement work

Jeff's `headline-claims-bench` / `independent-replication-gate` /
`weekly-certification-verdict` / `proof-carrying-execution-ledger-gate` are the
external analog of `docs/design/proof-of-enforcement.md` and
`open-obligation-ledger.md`: CI that proves the project's *claims* held under
adversarial check. Not a per-edit test category — it's a **session/pre-push evidence
artifact**. Adoption: when the spine (§6.1) runs, emit a signed
coverage+mutation+regression **evidence bundle** at SessionEnd (the "certification
verdict"), and let the obligation ledger track unmet claims. This is where "did the
agent govern its own tool-use loop" becomes provable — the R0/R1 rungs in
`project_proof_of_enforcement_bft_extensibility`.

---

## 7. What to keep bespoke (don't genericize)

Property-based, fuzzing, conformance/acceptance, metamorphic, differential/parity,
Loom, formal (Lean/TLA+/model-checking), chaos/soak — all need **bespoke
per-project artifacts**. Pattern, in three tiers:

1. **Run-if-exists** — if the repo *has* proptest / a fuzz corpus / a conformance
   crate, run the impacted subset via §6.1's runner. (Generic execution, bespoke
   authoring.)
2. **Nudge-if-missing** — Stop nudge: "you added a parser but no fuzz target /
   property test." Deterministic detection, no generation.
3. **Detect-asymmetry** (the one generic slice of property testing) — deterministically
   spot inverse pairs (`serialize`/`deserialize`, `encode`/`decode`, `to_json`/
   `from_json`) and fire when the agent changes one side without the other or without a
   round-trip test. Pure AST, no input synthesis.

**Hard boundary:** generic property-test *generation* (input/oracle synthesis) is LLM
work and stays **out** of the deterministic check pipeline
(`feedback_harness_deterministic_only.md`). If we ever do it, it's a cloud surface
(Guardrails/Agent CI), not a local hook.

---

## 8. Hook placement map

Per https://code.claude.com/docs/en/hooks. Matchers in parens.

| Hook | What runs | Blocking? |
|---|---|---|
| **PreToolUse** (`Bash` ∧ `git commit\|push`) | cloud spine: diff mutation + full impacted coverage, sync ≤~25s, block on survivor | yes — but **fail-open** if the runner itself errors (quality, not safety; a broken runner must never wedge the agent) |
| **PostToolUse** (`Edit\|Write`) | scoped + content-hash-cached: complexity/CRAP delta, impacted-unit-test run, doctest of touched module, snapshot-pending | sync, sub-second via scoping |
| **Stop** | per-turn patch-coverage summary, CRAP hotspots touched, full impacted-test result, flake reruns | non-blocking reflection — frame as under-verification, **never "push"** (`feedback_reluctance_to_push.md`) |
| **SubagentStop** | same as Stop, so a subagent's uncovered/broken code is caught *before* it reports up | non-blocking |
| **SessionEnd** | heavy cloud async (full-diff mutation, sanitizers, matrix); write evidence/certification bundle (§6.4) | n/a |
| **SessionStart** | warm caches: coverage baseline, impact graph (we already refresh the trigram index here) | n/a |

---

## 9. Design guardrails (all consistent with existing patterns)

- **Everything is a ratchet** — block growth, allow hold/shrink, like
  `checkLargeFileLineCountWrite` (pure before/after delta) and the non-null-assertion
  ratchet. New gates flag *new* debt, not pre-existing. (Note: this is delta-as-perf/
  relevance, **not** the diff-aware FP-suppression we explicitly don't want —
  `feedback_taste_enforcement.md`.)
- **Sync hooks are scope-limited + cached;** heavy work is diff-scoped + short-circuited
  to cloud (`feedback_posttooluse_stays_sync.md`, `feedback_pretooluse_cloud_synchronous_block.md`).
- **The runner fails open** on infra errors (missing test command, timeout, OOM) — it
  is a quality layer, but a quality layer that wedges the agent is worse than silence.
  (Distinct from safety layers per `feedback_safety_continuity.md`.)
- **Stop = reflect, not ship** (`feedback_reluctance_to_push.md`,
  `stop-event-checks.md` design principle).
- **Dogfood first** — promote a runner to default gate only once the harness's own
  repo is clean for it (`project_maximal_local_enforcement`).

---

## 10. Sequencing / next steps

Two independent entry points, lowest-risk first:

1. **Doctest-execution PostToolUse check** (smallest, net-new, generic) — fits the
   existing `checks/<family>.ts` + `check-registry/entries-warnings.ts` +
   `check-metadata.ts` pattern; ships with ≥3 positive / ≥3 negative cases per the
   agent-quality convention in CLAUDE.md.
2. **Diff-scoped test+coverage runner** wiring `impact-analysis.ts` →
   `coverage-ratchet.ts` → `crap.ts` into the **Stop** hook (the spine's first leg).
   This is the keystone; §6.1. Then add `cargo-mutants` to `mutation-gate.ts` and the
   commit-time cloud leg.

Both slot into `test-quality-harness-local-first.md` §9 (Lane A ship-now) and §13
(smart-selection substrate); this doc supplies the *which categories* and the
*empirical justification*, that doc supplies the *cost model* and *selection
algorithm*.

---

## Appendix A — receipts (verified 2026-06-05/06)

Coverage: `frankensqlite/docs/adr/0001-coverage-toolchain-selection.md`,
`frankenscipy/quality_gates.toml`, `coding_agent_session_search/.github/workflows/coverage.yml`.
Mutation: `franken_node/.cargo-mutants.toml`, `franken_node/.github/workflows/mutants-gate.yml`,
`franken_engine/crates/franken-engine/docs/MUTATION_TESTING_MANIFEST.md`.
Conformance/acceptance: `asupersync`/`beads_rust`/`pi_agent_rust` `conformance.yml`; 34 `*-conformance` crates.
Property: `beads_rust/tests/proptest_hash.rs`. Fuzz: `asupersync_ansi_c/tests/fuzz/fuzz_differential.c`.
Loom: `frankensqlite/crates/fsqlite-mvcc/tests/loom/MODEL.md`, `frankenterm/.github/workflows/loom.yml`.
Formal: `asupersync/formal/lean/Asupersync.lean`, `eidetic_engine_cli/proofs/tla/agent_mail_coordination.tla`,
`asupersync_ansi_c/tests/invariant/model_check/test_bounded_model.c`.
Snapshot: `beads_rust/tests/snapshots/*.snap`. Determinism config: the two `clippy.toml`
files ban `thread_rng`/`Uuid::new_v4`. CRAP: **none** (zero markers across 174 repos).

## Appendix B — references

- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Existing harness modules: `src/harness/checks/{cyclomatic,crap,dry}.ts`,
  `src/harness/{coverage-ratchet,mutation-gate,behavioral-checks-tdd,impact-analysis,
  verification-stop-checks,coverage-final-reader}.ts`,
  `src/commands/{coverage,mutation}.ts`, `src/commands/verify/file-checks-agent-safety.ts`.
- Companion design docs: `test-quality-harness-local-first.md` (canonical),
  `maximal-local-enforcement-roadmap.md`, `stop-event-checks.md`,
  `proof-of-enforcement.md`, `open-obligation-ledger.md`,
  `docs/external-pulse/INTAKE.md` (six-lane rubric).
- Relevant memories: `feedback_harness_deterministic_only`,
  `feedback_posttooluse_stays_sync`, `feedback_pretooluse_cloud_synchronous_block`,
  `feedback_reluctance_to_push`, `feedback_taste_enforcement`,
  `feedback_safety_continuity`, `project_maximal_local_enforcement`,
  `project_proof_of_enforcement_bft_extensibility`.
