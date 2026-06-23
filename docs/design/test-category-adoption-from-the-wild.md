# Test-Category Adoption From the Wild — Jeff Emanuel (`Dicklesworthstone`) Taxonomy → Interlinked Harness

**Status:** research record + adoption architecture. v2, 2026-06-06.
**Supersedes** the first draft's "PreToolUse can't run tests" framing. v2 adds the
inference-time execution architecture (apply-before-disk dual-lane PreToolUse), the
per-edit cost router, the good-citizen resource governor, and the single-agent-local /
multi-agent-cloud product segmentation.

**Companion to** (read these for the canonical design; this doc is the *empirical
witness* + the *inference-time execution architecture* that feeds them):
- `docs/design/test-quality-harness-local-first.md` — the canonical four-lane
  (A test-adequacy / B correctness / C security / D runtime-resilience)
  local-first design. Coverage, mutation, CRAP, smart test-selection (§13),
  acceptance-as-first-class (§12) all live there. The **§4 per-tool-call cost table**
  and **§13 smart-selection substrate** are the load-bearing inputs to §6 below.
- `docs/design/maximal-local-enforcement-roadmap.md` — status / sequencing.
- `docs/design/stop-event-checks.md` — the Tier 2/3 Stop-event backlog.
- `docs/design/proof-of-enforcement.md` + `docs/design/open-obligation-ledger.md`
  — where the "claim-gate" meta-category (§3.2-G) lands.
- `docs/design/cloud-governor-architecture.md` — the cloud substrate this leans on.

**Source:** survey of `github.com/Dicklesworthstone` (Jeff Emanuel, "doodlestein"),
179 public repos (174 own, 5 forks), 2026-06-05/06. Method: recursive git-tree fetch
of all 174 own repos (309,942 paths) + direct reads of config files and CI workflows.
GitHub's legacy code-search API under-indexes large repos, so all findings are from
file trees + file contents, not search.

> One-file note: the §2–§3 research half also fits the external-pulse convention
> (`docs/external-pulse/jeff-emanuel.md`); kept here as a single design document and
> liftable if the intake index should point at it.

---

## 0. TL;DR

Jeff Emanuel's 2026 Rust systems repos run one of the most exhaustive test taxonomies
observable on public GitHub — ~30 categories (§3). Most are **bespoke-per-repo**
(property suites, fuzz targets, conformance crates, Loom models, Lean proofs); the
harness can *run* them when present but cannot *author* them generically without an
LLM, which the deterministic-only rule (`feedback_harness_deterministic_only.md`)
bars from the check pipeline. The **metric-shaped** categories — complexity, coverage,
CRAP, mutation, doctest, flake — are the ones that generalize as net-new checks, and
we already own most of the metrics (`cyclomatic.ts`, `crap.ts`, `coverage-ratchet.ts`,
`mutation-gate.ts`, `behavioral-checks-tdd.ts`).

**The execution model (v2 correction).** On an `Edit`/`Write`, the PreToolUse hook
fires with the **full proposed content** *before* it touches disk. So PreToolUse is a
**pre-disk CI** with two lanes: a **local-free static lane** (regex/AST on the proposed
bytes — instant, offline, private) and an **execution lane** that applies the proposed
patch to a copy of the tree and runs real tests/coverage/mutation/typecheck. The
execution lane runs **locally** when this edit's cost fits the machine's *spare* cycles
within 25s, and **in the cloud** (Cloudflare Artifacts fork + Sandbox fan-out) when it
overflows. The decision is a **per-edit cost router** (§6), not a per-category split.

**Two constraints shape it.** (1) A **good-citizen resource governor** (§7) bounds the
harness's own CPU so it never crowds the developer's machine — even at one agent the
machine is never idle. (2) **Product segmentation** (§8): the free local tier targets a
single (or very small number of) agent; anyone who wants a fleet — or just wants their
cores back — **offloads the execution lane to the cloud**, where each agent gets its own
isolated fork and the full 25s gauntlet, simultaneously. We deliberately **do not** build
a local multi-agent scheduler.

**Shift-left, always.** Favor the strictest/earliest hook the check's required-state and
latency permit: PreToolUse > PostToolUse > Stop > commit. Catch it before it hits disk.

---

## 1. Why this doc exists

`test-quality-harness-local-first.md` reasons from first principles + Supermodel. This
doc adds **an empirical witness** — a prolific practitioner running the full gauntlet
across 174 repos — and filters that taxonomy by two constraints:

1. **Broadly applicable to any codebase** (zero bespoke per-project test code), and
2. **Runnable at agent-inference time** on a Claude Code hook
   (PreToolUse / PostToolUse / Stop / SubagentStop / SessionEnd — see
   https://code.claude.com/docs/en/hooks).

The first draft applied filter 2 too strictly — it assumed PreToolUse couldn't run
tests. The apply-before-disk mechanism (§5) makes filter 2 far more permissive: almost
anything *executable* can run at inference time, the only questions being **which lane**
(local vs cloud) and **does it fit 25s** (§6).

---

## 2. The source: Jeff Emanuel / `Dicklesworthstone`

- **Who:** Jeff Emanuel ("doodlestein"), NY. 179 public repos, 2.7k followers.
- **Shape of the corpus:** famous older Python utilities (`llm_aided_ocr` ⭐2,929,
  `swiss_army_llama` ⭐1,053, `bulk_transcribe_youtube` ⭐674) — single-purpose scripts
  with little/no test infra — versus a large 2026 push of Rust systems projects (the
  `franken*` family reimplementing SQLite/NumPy/SciPy/PyTorch/etc., `asupersync`,
  `flywheel_connectors`, `beads_rust`, `pi_agent_rust`, `eidetic_engine_cli`) carrying
  extreme verification rigor.
- **Provenance:** the rigorous repos are visibly products of an **agentic coding
  flywheel** — bead-tracking IDs (`bd-3jh.22`), agent authorship
  (`Deciders: SwiftOwl (agent)`). The rigor is the output of a *methodology + agent
  fleet*. (Directly relevant: interlinked-cli's own genre —
  `agentic_coding_flywheel_setup` ⭐1,502.)

### Two caveats that bound every count below

- **Bimodal distribution.** All rigor lives in the 2026 Rust repos with CI (95/174
  repos have CI; 79 have none). The high-star Python repos have ~none.
- **Vendored ≠ his.** `franken_numpy` vendors NumPy source, `frankenterm` vendors
  HarfBuzz; their `codeql.yml`/`coverity-scan.yml`/`cifuzz.yml` are *upstream's* CI.

Headline scale: **463 CI workflow files across 95 repos**; path-counted test files
(Rust inline `#[cfg(test)]` excluded, so undercounted): **Rust 11,954, Go 1,571,
TS/JS 1,354, Python 1,008**.

---

## 3. The observed test taxonomy (full)

### 3.1 The six originally-asked practices

| Practice | Verdict | Evidence (repo: path) |
|---|---|---|
| **Unit testing** | ✅ pervasive | ~16k+ test files; ADR cites "335 tests in 5.6s" for one crate |
| **Coverage analysis** | ✅ formal, gated | `frankensqlite: docs/adr/0001-coverage-toolchain-selection.md` (cargo-llvm-cov over tarpaulin/grcov, measured 85% line / 82% branch); `frankenscipy: quality_gates.toml` (per-crate thresholds + flake budget); `coding_agent_session_search: .github/workflows/coverage.yml` (phased ratchet 60→90% across 2026) |
| **Mutation testing** | ✅ advanced | `franken_node: .cargo-mutants.toml` + `mutants-gate.yml` (installs `cargo-mutants 27.0.0`, **enforces exit code**); `franken_engine: …/MUTATION_TESTING_MANIFEST.md` (operator catalog, survivor analysis, equivalent-mutant filter) |
| **Acceptance testing** | ✅ as conformance/E2E | 34 repos with `*-conformance` crates vs reference behavior; `conformance.yml`, `e2e.yml`, `live-conformance-gates.yml`. **No** Gherkin. |
| **Cyclomatic complexity** | ⚠️ not as a tool | No lizard/radon/gocyclo/xenon/mccabe; `clippy.toml` enforces *determinism* + imports, not complexity thresholds. He does **algorithmic (Big-O)** complexity, gated (`franken_networkx: …/doc_pass05_complexity_perf_memory_gate.rs`). |
| **CRAP analysis** | ❌ absent | Zero markers across 174 repos. |

### 3.2 The extended taxonomy (~25 more categories)

Grouped by *role in the test*. Repo counts are marker-based, de-contaminated where noted.

**A. Input-generation strategies**
| Category | Repos | Marquee receipt |
|---|---|---|
| Property-based (proptest/quickcheck/hypothesis) | 29 | `beads_rust: tests/proptest_hash.rs` |
| Fuzzing — *differential* fuzz, fuzz-under-TSan, nightly, corpus-minimize | 27 | `asupersync_ansi_c: tests/fuzz/fuzz_differential.c`; `fuzz-tsan.yml`, `fuzz_nightly.yml` |
| Metamorphic | 19 | `coding_agent_session_search: tests/golden/metamorphic/` |
| Adversarial | 21 | `beads_viewer_rust: tests/testdata/adversarial_parity.jsonl` |
| Multi-seed / determinism replay | 26–37 | `lab-runtime-multi-seed-nightly.yml`; `replay-gates.yml` |

**B. Oracles**
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
| Concurrency interleaving (**Loom**) | 2 | `frankensqlite: crates/fsqlite-mvcc/tests/loom/MODEL.md`; `frankenterm/loom.yml` |
| Sanitizers (ASan/MSan/TSan/Miri) | ~19 | `asupersync_ansi_c: build_asan.sh`; `compiler_sanitizers.yml` |
| Soak / stress / load / endurance | 31 | `…/stress-10k-tasks.json`; `nightly-differential-stress.yml` |
| Chaos / fault-injection | 19 | `…/chaos-sendpermit-ack.json` |
| Benchmark / perf-regression incl. **competitor-bench** | 47 | `competitor-bench.yml`, `perf_regression_gate.yml` |
| Cross-platform / cross-arch | many | `linux-ppc64le.yml` (**big-endian**), `linux_qemu.yml`, `musl-test.yml`, `msvc-ci.yml`, `wasm.yml` |

**D. Formal methods (rare)**
| Category | Repos | Marquee receipt |
|---|---|---|
| **Lean 4** machine-checked proofs | 5 | `asupersync: formal/lean/Asupersync.lean`; `eidetic_engine_cli: proofs/lean4/pack_determinism.lean` |
| **TLA+** specifications | — | `eidetic_engine_cli: proofs/tla/agent_mail_coordination.tla` |
| Bounded model checking | 7 | `asupersync_ansi_c: tests/invariant/model_check/test_bounded_model.c` |

**E. Static analysis & supply chain**
| Category | Repos | Notes |
|---|---|---|
| Type-checking as a gate (mypy, stubtest, pyright, tsc strict) | 17 | `ascii_art_mini_transformer: mypy.ini`; `stubtest.yml` |
| SAST / secret / dep audit (cargo-audit, **cargo-deny**, gitleaks) | 12 | `coding_agent_session_search: deny.toml`; `audit.yml` |
| CodeQL | 1 own | `swiss_army_llama` (others vendored) |

**F. Release & operational**
| Category | Repos | Marquee receipt |
|---|---|---|
| Smoke (prod + docs-example) | 43 | `production-smoke.yml`, `readme-quick-example-smoke.yml` |
| Installation / packaging | many | `installer-canary-strict.yml`, `cargo-install-validation.yml`, `fresh-clone-build.yml` |
| Semver / API-compat | — | `semver-check.yml`, `cli-version-audit.yml` |
| Doctests (Rust `--doc`, Python `--doctest-modules`) | pervasive | path-invisible, undercounted |
| PTY/terminal & browser/UI | — | `pty-tests.yml`; `playwright.yml`, `lighthouse.yml` |

**G. Claim / reality-check gates — the distinctive one**
CI that treats the project's **own README/marketing claims as falsifiable**:
`headline-claims-bench.yml`, `independent-replication-gate.yml`,
`reality-check-drumbeat.yml`, `vef-claim-gate.yml`, `weekly-certification-verdict.yml`,
`proof-carrying-execution-ledger-gate.yml`, `readme-cli-drift-gate.yml`.

**H. Domain-specific (excluded — not generic)**
PTY/terminal-emulator, browser/Lighthouse, GPU/ML-training (`train_gpu.yml`),
numeric-kernel bounds-checks (`lindley-bounds-check.yml`).

---

## 4. Gap analysis — what the harness already has

Verified against the codebase 2026-06-06. **We own the metrics; what was missing is the
inference-time execution substrate + routing — specified in §5–§9.**

| Capability | Module | Wired to | Live on a hook? |
|---|---|---|---|
| Cyclomatic complexity (multi-lang, per-fn) | `checks/cyclomatic.ts` | feeds `crap.ts`/`dry.ts` | metric yes |
| **CRAP** | `checks/crap.ts` (+ telemetry, baseline) | `interlinked verify` only | **no** |
| Coverage ratchet (per-file) | `coverage-ratchet.ts` | CLI `commands/coverage.ts`; consumes `coverage-summary.json` | **no** |
| Mutation gate (per-file ratchet) | `mutation-gate.ts` | CLI `commands/mutation.ts`; Stryker/mutmut/cosmic-ray; weekly | **no**; `cargo-mutants` unsupported |
| TDD cycle / assertion density / commit gates | `behavioral-checks-tdd.ts` | PostToolUse | **yes** |
| Static nondeterminism, DRY, taste | `taste-checks.ts`, `checks/dry.ts` | PostToolUse | yes (static) |
| Test-impact classification | `impact-analysis.ts` | — | **classifies, doesn't run** |
| Type-check / SAST / secrets / dep-audit | quality-checks + package-allowlist | PostToolUse | yes |
| Parity enforcement (paired surfaces) | `registry-parity.ts`, `command-guard-parity.test.ts` | verify + tests | yes — **reuse for local↔cloud parity (§8)** |
| Cohort / file reservations | `cohort.ts`, `reservations.ts` | daemon | yes — **the load-sensor for §7/§8** |

**The hole, one way:** the metrics exist but nothing **executes** the (scoped) test
suite at inference time, and nothing **routes** between local and cloud. §5 builds the
execution substrate, §6 the router, §7 the governor, §8 the segmentation.

---

## 5. The execution architecture — PreToolUse is a pre-disk CI

### 5.1 Apply-before-disk

On an `Edit`/`Write`, the PreToolUse hook fires with the **full proposed content** in
`tool_input`, *before* the change is applied to the working tree. That gives a ~25s
window in which the change *exists as a patch* but the disk is untouched. We use it. If
the verdict is `deny`, **nothing was ever written**; if `allow`, the write proceeds
normally. The tree is never left in a half-mutated state.

### 5.2 The two lanes

- **Local-free static lane.** Pure functions of the proposed bytes (+ cheap local
  indices): regex/AST. Sub-second, offline, private, $0. Always runs, for everyone,
  regardless of offload settings. This is the floor (§6 Group A).
- **Execution lane.** Apply the proposed patch to a *copy* of the tree, then run real
  tests / coverage / mutation / typecheck / doctest. Runs **locally** when the edit's
  cost fits the machine's spare cycles within 25s (§7), **in the cloud** otherwise
  (§5.4). Same checks either way — see the parity obligation in §8.

### 5.3 The local execution substrate

Two mechanisms, both mostly already in reach:

1. **In-memory compiler overlays** — for typecheck/AST, run the language-service API
   with the proposed file overlaid; no disk at all. The `cyclomatic.ts` gate already
   drives the `typescript` API this way, so the substrate exists.
2. **Warm shadow worktree** — a per-session throwaway checkout (CoW-reflink clone:
   `cp -c` APFS / `--reflink` Linux) with shared build caches (`CARGO_TARGET_DIR`,
   symlinked `node_modules`, `.mypy_cache`). At a check: `git apply` the proposed patch,
   run the impacted subset, revert. Kept *warm* (incremental build state) so each run is
   incremental, not cold. This is the on-device analog of the cloud Artifacts fork.

Every local execution check is **time-boxed (~20s), ∃-short-circuited** (return on first
failure / surviving mutant / flaky rerun), and **bounded** (cap mutants, cap property N,
impacted subset only). If it would exceed the box, it returns *inconclusive-local →
escalate* rather than blocking past budget.

### 5.4 The cloud execution substrate

Per `cloud-governor-architecture.md` + the `cloudflare:artifacts`/`sandbox-sdk` stacks:
keep a **warm Artifacts fork** of the repo per session; on a check, `git apply` the
proposed patch to a fork branch and **fan out** checks across **Sandboxes** in parallel.
`wall-clock ≈ warmup + slowest_single_shard`, so: mutation = all mutants concurrent
(constant in mutant count); regression = test shards concurrent; flake = K copies
concurrent. **∃-short-circuit** returns `deny` on the first failure, usually well under
the 25s ceiling. Content-hash cache keys on `{tree, proposed patch}`. If a check can't
return in 25s, **allow-and-continue** and land the verdict as PostToolUse
`additionalContext` on the next edit (the async tail), with Stop as backstop.

### 5.5 Shift-left ordering

Push every check to the strictest/earliest hook its required-state and latency permit:

> **PreToolUse > PostToolUse > Stop > commit/pre-push.**

PreToolUse (block, pre-disk) is the goal for everything that can produce a verdict from
{proposed patch, tree}. PostToolUse demotes to the **async-tail** lane (deliver an
over-budget cloud verdict, or the rare on-disk-only check). Stop is for genuine
**turn-completion / multi-file coherence**. Commit/pre-push is the last resort.

---

## 6. The per-edit cost router

The local/cloud decision is **not** a per-category split. Every executable check has a
bounded local form and an exhaustive cloud form; the router picks per edit:

> **route = f(per-edit cost, live machine load)**
> cost = mutant-count × covering-runtime, impacted-set size, suite latency (from
> `local-first.md` §4 table + `impact-analysis.ts`). load = §7's governor reading.
> Fits the local box → run on-device, ∃-bounded. Overflows → cloud (or, if offload is
> off and the box is blown, degrade/defer — never false-block).

### Master mapping

| Category | Earliest hook | Lane | What runs / escalate-when |
|---|---|---|---|
| Cyclomatic complexity | PreToolUse | **local-free** | proposed-content delta; block on cap-growth |
| CRAP | PreToolUse | **local-free** | cyclo(proposed) × cached-coverage; stale-tolerant |
| **Test-integrity guards** (§9.1) | PreToolUse | **local-free** | block `.only`/`.skip`/`#[ignore]`, test deletion, assertion removal, baseline/threshold tampering |
| Secrets / inline SAST / type-smell ratchets / nondeterminism / DRY / line-cap / manifest-allowlist / import-resolution / export-surface delta | PreToolUse | **local-free** | proposed bytes; mostly already shipped |
| Round-trip / inverse-pair asymmetry | PreToolUse | **local-free** | AST detect-asymmetry nudge |
| Snapshot hygiene (pending/obsolete) | PreToolUse | **local-free** | detect `*.snap.new` / `insta pending` in the patch |
| Full-project type-check | PreToolUse | **local-bounded** → cloud | overlay/incremental; escalate cold huge monorepo |
| Impacted unit / regression | PreToolUse | **local-bounded** → cloud | leaf edit fits; escalate **hub file** (impacted set too big) |
| Patch / diff coverage | PreToolUse | **local-bounded** → cloud | impacted subset; escalate whole-suite |
| **Diff-scoped mutation** | PreToolUse | **local-bounded** → cloud | small diff = 2–15s leaf (§4 table), ∃-survivor, exclude property tests from covering set; escalate large/slow/whole-file/hub |
| Doctest | PreToolUse | **local-bounded** → cloud | touched + dependent modules |
| Flake / nondeterminism rerun | PreToolUse | **local-bounded** → cloud | rerun K× concurrently; escalate huge affected set |
| Run-if-exists suites (property bounded-N / metamorphic / differential / invariant / contract / conformance / golden / adversarial) | PreToolUse | **local-bounded** → cloud | impacted + bounded + time-boxed; escalate full/high-N campaigns |
| Deep dep-audit / SAST (cargo-audit/deny, pip-audit, semgrep) | PreToolUse | **local-bounded** → cloud | on diff/touched; escalate whole-repo semgrep |
| Bounded fuzz-smoke | PreToolUse | **local-bounded** → cloud | time-boxed existing target; escalate campaign |
| Sanitizers (1 test, ASan/TSan/Miri) | PreToolUse | **cloud** (local only w/ warm instrumented sidecar) | cold instrumented rebuild blows the box |
| Cross-file coherence (dead export, uncalled fn, half-done migration) | **Stop** | local | needs the whole turn's applied multi-file diff |
| Turn-aggregate coverage + CRAP hotspots; missing-test-category nudges; trajectory; "your new lines: N uncovered, M failing" | **Stop** | local | union/dedup across the turn; reflection, never "push" |
| Whole-repo/whole-file mutation campaign · Loom exhaustive · sanitizers full · soak/stress · perf-regression · **cross-arch matrix** · formal full · CodeQL · install/fresh-clone-build · **claim-gate / evidence bundle** | **SessionEnd / pre-push** | **cloud** | >25s even parallel, or needs other machines / stable isolated env / long wall-clock |

---

## 7. The good-citizen resource governor

**The premise correction.** "The PreToolUse window is free idle CPU" is true only of the
*agent's foreground*. The developer's machine is never idle — IDE, browser, a hot dev
server / watch-build, Docker, *and* any background processes the agent itself spawned run
through every hook. Even at **one agent**, burning all cores for 20s makes the laptop
janky, fights the watch-builds the work depends on, and thermal-throttles (silently
shrinking the 25s budget). An opinionated harness that tanks the machine gets disabled.

So the harness must be a **bounded, well-behaved tenant** — it self-caps so it never
approaches the developer's ceiling. This is a *self-governor*, not the cross-agent
scheduler we reject in §8; it is local-only and simple.

**The levers:**
- **Cap jobs below core count** — never `nproc`; reserve headroom (`max_jobs ≈ ceil(cores/2)`, configurable). Wire through runners: vitest `maxThreads`, pytest-xdist `-n`, `cargo --test-threads/--jobs`, `CARGO_BUILD_JOBS`.
- **Run at background priority** (the key lever — turns "spare cycles" from *assumption* into *enforced property*): macOS `taskpolicy -b` (on Apple Silicon this schedules onto **E-cores**, leaving P-cores for the human by construction); Linux `nice` + `ionice` + cgroup `cpu.weight`.
- **Sense load before the heavy lane** — cheap pre-flight read (Linux PSI `/proc/pressure/cpu`; macOS load + per-core). If busy, shrink jobs or defer/offload. (Load average lags ~1 min — prefer PSI where available.) The `cohort.ts` manager supplies the agent-count input.
- **Budget CPU-seconds, not just wall-clock** — 25s × 10 cores = 200 CPU-sec is not free. Cap total CPU cost; over-budget → degrade or offload.
- **Battery / thermal aware** — on battery or throttled, prefer the cheap lane / offload; never run mutation off a battery.

**The recalibration this forces.** Once local is properly bounded (≈half the cores,
background priority, only with headroom), fewer execution checks fit — on a busy machine
the heavy ones (full coverage, diff-mutation) won't make 25s. So the honest definition of
the free local tier is:

> **Free local tier = the static lane (always) + the execution checks that fit your
> *spare* cycles within 25s.** Quiet machine + small edit → most of the gauntlet runs
> locally. Busy machine → it degrades gracefully (defer / cheaper-signal / offload,
> **never false-block**; fail-open per `feedback_safety_continuity.md`) and nudges toward
> offload.

---

## 8. Concurrency & product segmentation

**Decision: we do not build a local multi-agent scheduler.** Core partitioning, local
test isolation, and cross-agent admission control are fragile and expensive, and the
problem they solve is better solved by the cloud. Instead:

- **Single (or very small number of) agents → local-first.** All the single-agent
  assumptions hold: one warm shadow worktree, one suite at a time (no port/DB
  collisions), the §7-bounded budget. This is the **free CLI (Phase 1)**.
- **A fleet — or a developer who just wants their cores back — → cloud-offload.** The
  **Guardrails (Phase 2–3)** upsell. The trigger generalizes from "how many agents?" to
  **"do you want to spend your cores on verification, or on your work?"**

Why the cloud wins here, stated precisely: **local execution compute is a fixed pie
shared ~1/N across agents; cloud scales per-agent with isolation.** In the cloud each
agent gets its own warm Artifacts fork + Sandbox, so all N agents get their **full 25s
gauntlet simultaneously, isolated** (own ports, own ephemeral DB) — physically impossible
on one laptop, and it kills the shared-resource test-interference failure mode for free.
So the cloud doesn't merely "free cores," it **restores the full per-agent gauntlet** that
local concurrency destroys.

**Four rules that fall out:**

1. **Offload is a toggle, not a scheduler.** Config under the existing `cloud_governor`
   block (default off): `offload: none` (single agent — all local, free, private,
   offline) vs `offload: execution` (free the cores). The developer flips it; the daemon
   never load-balances.
2. **Mirror the *execution* lane; keep the *static* lane local always.** Group-A checks
   are milliseconds on one file — they don't meaningfully contend even with many agents,
   and they're privacy-sensitive. Even a full-offload customer runs the static lane
   on-device (instant, free, private); only execution checks egress. Minimal data leaves
   the machine.
3. **Parity or bust.** If offloading changes a verdict, trust dies. Author each check
   **once** as a pure function of `{proposed patch, tree, config}`, with the substrate
   (local worktree vs Artifacts fork) as a parameter, and **pin it with a parity test** —
   exactly the pattern `registry-parity.ts` and `command-guard-parity.test.ts` already
   enforce at other boundaries. The failure mode to avoid is two implementations drifting.
4. **Keep one branch of multi-agent handling: degrade + upsell nudge.** A user running
   several agents who *hasn't* enabled cloud must not get false-blocks. The daemon already
   sees all agents via `cohort.ts`; instead of scheduling, it degrades to best-effort
   (static lane still blocks; execution defers/skips) with a *"running N agents — offload
   to cloud for full inference-time gating"* nudge. Not a scheduler — a one-branch
   fallback that doubles as the conversion prompt.

**Privacy/egress is the explicit trade.** Single-agent local = fully private/offline.
Offload = proposed code + a repo copy leave the machine (gated behind the opt-in).
Regulated shops that can't egress (`reference_cloudflare_regulated_industry_posture`) run
single-agent-local or BYOC — not a lost sale the free tier should contort to serve.

---

## 9. Hook-by-hook mechanism map

The §6 table gives each category's hook + lane. This section explains the *mechanism*
each hook affords (what action it can take), so the table's placements are legible.

### 9.0 Trajectory is a context unit, not a hook — route by future-dependence

Before the by-hook walk, one cross-cutting correction the §6 table obscures:
**session trajectory is a *context unit*, not a hook.** The ordered prefix of *landed*
tool calls is already in memory at every hook (`session-state.ts`), so
`runTrajectoryDetector(event, session, …)` runs it at **PreToolUse** (`pre-tool.ts`) —
evaluating the *proposed* event against the settled prefix — and the sequence-detector
framework tags each detector `pre_block | pre_warn | stop` (`sequence-checks/`),
dispatching the `stop` ones from `server/lifecycle-events.ts`. So trajectory analysis is
a **2×3** (the trajectory unit × {Pre, Post, Stop}), not a single Stop-bound row.

**The hook is chosen by how much of the *future* the judgment needs** — the prefix is
settled, only the future is uncertain. This is §5.5's shift-left ordering applied to the
trajectory unit:

| Future-dependence | Hook | Why | Shipped example |
|---|---|---|---|
| Prefix-sufficient, block-worthy | **PreToolUse** | judgment = f(prefix, proposed event); no later action invalidates it | `lethal_trifecta_structural` / `exfil_to_public_writeable` (`sequence-checks/injection.ts`, pre_block); `stale_read_then_write` (`cross-agent.ts`, pre_warn); `git-session-scope-gate` (proposed `git commit` vs `session.files_written`) |
| Needs the event's *result/effect* | **PostToolUse** | the test must run / the file must hit disk before the transition is observable | red→green confirmation (`checkTddGreenConfirmation`) |
| Needs to know the agent is *done* | **Stop / SessionEnd** | absence/completion claims are only true once the turn/session ends | "never came back to the stub," "edited UI, never interacted," turn-union coverage |

**The FP hazard, and its one fix.** The danger in PreToolUse-trajectory is the
**skipped-vs-not-yet ambiguity**: blocking a prod edit because no test exists *yet*
false-blocks a trajectory that was about to write the test next — the canonical
hated-TDD-gate. The fix is to **anchor trajectory *blocks* on point-of-no-return /
outflow events** — `commit`, `push`, `publish`, deploy, the exfil sink, `rm`. At an
outflow event "you haven't done X *yet*" becomes "you're *shipping* without X"; the
future is foreclosed and the FP evaporates. That is exactly why `git-session-scope-gate`
(anchored on commit/push) and the exfil detectors (anchored on the write-to-sink) are
clean Pre-blocks, while "prod-before-test" stays a Stop nudge (§9.3).

> **Rule: trajectory BLOCKS ride outflow events at PreToolUse; trajectory NUDGES for
> in-progress work wait for Stop.**

**Count vs value, and the local/cloud split.** There are *fewer* block-worthy
prefix-sufficient checks than Stop-advisories (and advisories are cheaper batched +
deduped at Stop than fired per-event), but they are disproportionately high-stakes — the
whole injection/lethal-trifecta family and cross-agent staleness live here. Indexing on
outflow events keeps the set from being tiny: push-without-green, commit-out-of-scope,
publish-without-changelog, deploy-without-tests all qualify. And trajectory-at-PreToolUse
is **cheap and local** — the prefix is in-memory; the check is pattern-matching the
proposed event against it (no execution, no model). So the local/cloud split *within* the
trajectory unit is **independent of the hook axis**: Pre/Post/Stop deterministic → local;
only the holistic "would a tech-lead merge the *whole assembled PR*" verdict → cloud LLM.
Everything prefix-deterministic shifts all the way left to a local Pre-block.

**Why this is the live-harness edge over a terminal grader.** A PR-grading benchmark
(FrontierCode — `docs/external-pulse/frontier-code.md`) is structurally *terminal*: it
scores a finished PR, so every judgment it makes is "trajectory-at-Stop" in this model —
it can only say "this isn't mergeable" *after* the un-mergeable thing exists. The live
harness takes the same trajectory-derived judgment and runs it at **PreToolUse on the
point-of-no-return**, preventing the un-mergeable action instead of grading it. We don't
just see an ordering the final diff can't — we **intervene mid-ordering, at the outflow
event.**

### 9.1 PreToolUse — three block modes

PreToolUse returns `permissionDecision: deny|ask|allow`. For tests it blocks three ways:

- **(a) Command-gate blocks** — when the tool is `Bash` running `git commit`/`push`/
  `publish`, run the execution lane on the *current tree* and block on regression. This
  is where the heavier cloud checks (full-diff mutation/coverage) gate even if they were
  too costly per-edit.
- **(b) Test-integrity guards** *(net-new, instant, local-free, zero-FP — the
  highest-value low-cost piece, not previously written down)*. When the tool is
  `Edit`/`Write` and the proposed content would **sabotage the test signal**, block it:
  - introduce `.only` / `.skip` / `xit` / `#[ignore]` / `@pytest.mark.skip`
  - delete or empty a test file while the prod change stays
  - remove assertions / drop assertion density below the file's baseline
  - lower a coverage/mutation threshold, or edit `coverage-baseline.json` /
    `mutation-baseline.json` to game the ratchet
  - grow a function past the cyclomatic/CRAP hard cap (the line-cap delta pattern)

  These are pure functions of the proposed content — the ideal `deny` material, and they
  protect every *other* signal from being trivially defeated.

- **(c) Trajectory-prefix blocks** (§9.0) — the proposed event *completes a pattern
  against the session prefix*: no execution, no content scan, pure
  f(prefix, proposed event). The test-domain member is the commit-time TDD gate
  (`checkTddCommitGate` — a commit proposed while a tracked file's cycle is
  red/regression; mode-graded `nudge|warn|enforce` up to error) and its
  push-without-green generalization; the same dispatch carries the
  exfil/lethal-trifecta and session-scope gates outside the test domain. Per §9.0's
  rule, block-grade members anchor on outflow events. (a) and (c) share that anchor
  but differ in mechanism: (a) *runs* the execution lane at the gate; (c)
  pattern-matches state the session already accumulated — which is why (c) stays
  instant and local even when (a) escalates to cloud.

### 9.2 PostToolUse — additionalContext / async-tail

Returns `hookSpecificOutput.additionalContext` (agent-visible, human-invisible per
`project_posttooluse_visibility`). In the shift-left model its role shrinks to the
**async tail**: deliver an over-25s cloud verdict that started at PreToolUse, on the next
edit. (Plus the rare check that genuinely needs the file on real disk.)

### 9.3 Stop — multi-file turn analysis

Sees every file touched this message; can `decision: block` to force the agent to
continue. Runs the **union** of impacted tests once (dedup beats per-edit re-runs),
aggregates patch-coverage + CRAP hotspots across the turn, reruns new tests for flake,
checks cross-file coherence (dead export, uncalled fn, half-done migration), and upgrades
`verification-stop-checks.ts` from "did you run tests?" to "**your new lines: N
uncovered, M failing, K survivors**" — framed as reflection, **never "push"**
(`feedback_reluctance_to_push.md`).

### 9.4 SessionEnd — heavy async + evidence

Fire-and-forget cloud for the >25s tail (whole-repo mutation, sanitizers, cross-arch
matrix, perf, formal) and write the signed coverage+mutation+regression **evidence
bundle** — the local analog of Jeff's `weekly-certification-verdict`, feeding
`proof-of-enforcement.md` / `open-obligation-ledger.md`.

---

## 10. What to keep bespoke (don't genericize)

Property-based, fuzzing, conformance/acceptance, metamorphic, differential/parity, Loom,
formal (Lean/TLA+/model-check), chaos/soak need **bespoke per-project artifacts**. Three
tiers:

1. **Run-if-exists** — when the repo *has* them, the §5 runner executes the impacted
   subset (PreToolUse-bounded, Stop-union, or commit-gate). Generic *execution*, bespoke
   *authoring*.
2. **Nudge-if-missing** — Stop nudge: "added a parser, no fuzz target / property test."
3. **Detect-asymmetry** — the generic slice: deterministically spot inverse pairs
   (`serialize`/`deserialize`, `encode`/`decode`) and fire when one side changes without
   the other. Pure AST.

**The boundary is authoring, not execution** (v2 correction). Running any in-repo suite
at inference time is fine and encouraged. What stays **out** of the deterministic pipeline
is generic *test/oracle generation* (synthesizing inputs/properties) — that's LLM work,
and if we ever do it, it's a separate advisory cloud surface, never a local gate
(`feedback_harness_deterministic_only.md`).

---

## 11. Design guardrails

- **Resource governor first (§7)** — bound the harness's own footprint (job-caps +
  background QoS + load-sensing). This is what makes "local-first" safe to ship; without
  it the harness is a bad tenant.
- **Everything is a ratchet** — block growth, allow hold/shrink, like
  `checkLargeFileLineCountWrite` and the non-null ratchet. Flag *new* debt, not
  pre-existing. (Delta-as-relevance, **not** the diff-aware FP-suppression we don't want —
  `feedback_taste_enforcement.md`.)
- **Local↔cloud parity (§8.3)** — single-source each check; pin with a parity test.
- **Fail-open** on infra error / over-budget / contention — degrade or defer, never wedge
  or tank the machine (`feedback_safety_continuity.md`). A quality gate that false-blocks
  is worse than silence.
- **Stop = reflect, not ship** (`feedback_reluctance_to_push.md`).
- **Dogfood first** — promote a runner to default gate only once the harness's own repo
  is clean for it (`project_maximal_local_enforcement`).

---

## 12. Sequencing / next steps

1. **Test-integrity guards (§9.1b)** — smallest, net-new, local-free, zero-FP, highest
   value-per-line. Pure-content `deny` checks in `checks/<family>.ts` +
   `check-registry/entries-errors.ts`; ≥3 pos / ≥3 neg cases per the agent-quality
   convention.
2. **Resource governor (§7)** — job-cap + background-QoS wrapper around any spawned
   runner, with a load pre-flight. Prerequisite for everything in §5.3.
3. **Local execution substrate (§5.3)** — in-memory overlay (have, via `typescript` API)
   + warm shadow worktree. Wire `impact-analysis.ts` → run impacted tests → feed
   `coverage-ratchet.ts` → `crap.ts`, first at **Stop**, then shift-left to PreToolUse.
   Add `cargo-mutants` to `mutation-gate.ts`.
4. **Doctest execution + flake-rerun + snapshot-hygiene** — net-new generic runners.
5. **Cloud mirror + offload toggle (§8)** — same check units behind the Artifacts-fork
   substrate; parity test; `offload` config; degrade-+-nudge fallback.

Each slots into `test-quality-harness-local-first.md` §9 (Lane A ship-now) and §13
(smart-selection substrate); this doc supplies *which categories*, *the hook/lane
routing*, and *the governor + segmentation*, that doc supplies the *cost model* and
*selection algorithm*.

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
  verification-stop-checks,coverage-final-reader,cohort,reservations,registry-parity}.ts`,
  `src/commands/{coverage,mutation}.ts`, `src/commands/verify/file-checks-agent-safety.ts`.
- Cloud substrate: `docs/design/cloud-governor-architecture.md`; Cloudflare Artifacts
  (git-compatible versioned storage), Sandboxes (isolated execution), AI Gateway
  (caching) — `reference_cloudflare_ai_substrate`, `reference_cloudflare_regulated_industry_posture`.
- Companion docs: `test-quality-harness-local-first.md` (canonical),
  `maximal-local-enforcement-roadmap.md`, `stop-event-checks.md`,
  `proof-of-enforcement.md`, `open-obligation-ledger.md`,
  `docs/external-pulse/INTAKE.md`.
- Relevant memories: `feedback_harness_deterministic_only`,
  `feedback_posttooluse_stays_sync`, `feedback_pretooluse_cloud_synchronous_block`,
  `feedback_reluctance_to_push`, `feedback_taste_enforcement`,
  `feedback_safety_continuity`, `project_maximal_local_enforcement`,
  `project_supervisor_pattern`, `project_proof_of_enforcement_bft_extensibility`,
  `project_posttooluse_visibility`, `reference_product_phase_model`.
