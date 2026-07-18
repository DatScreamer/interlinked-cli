# Plan (deferred): the cloud/remote remainder of the DW test gauntlet

**Status: authored, NOT built (P5 of `dw-test-adoption-local-first.md`).**
This is the seed the local-first plan hands off to. Everything here is a test
TYPE from `test-category-adoption-from-the-wild.md` §13 that **cannot fit a
local single-device timeout window** (per the §0 table: 180s edit / 220s
commit / unbounded-but-idle SessionEnd) and so is deferred wholesale. Nothing
here blocks any local value; build only after the local phases (P0–P4) land and
the cloud substrate exists.

## 1. Why these are cloud-only (the boundary test)

A category lands here if ANY of:
- **Wall-clock > the deliverable window.** Even the SessionEnd idle batch is
  bounded by "before the next session starts"; a 24h fuzz soak or a 480s
  performance gauntlet cannot run there.
- **Needs machines the developer's laptop isn't.** Cross-arch (ppc64le
  big-endian, aarch64), a pinned-hardware bench baseline, a clean isolated env
  per agent.
- **Needs an instrumented rebuild the warm worktree can't cheaply hold.** ASan/
  TSan/MSan, Miri, coverage-instrumented + sanitizer-instrumented variants.
- **Needs a heavy reference environment.** `pip install numpy/pandas/scipy` +
  a live oracle subprocess for differential testing at scale.
- **Needs an LLM judge.** The holistic "would a tech-lead merge this whole PR"
  verdict is explicitly out of the deterministic pipeline
  (`feedback_harness_deterministic_only`).

## 2. The deferred categories (from §13) and what each needs

| Category | DW evidence | Cloud requirement |
|---|---|---|
| Fuzz **campaigns** (hours, corpus-minimize, nightly ASan/TSan) | frankenlibc 66 targets/360m; scipy nightly 900s/target; pandas weekly TSan | long wall-clock + sanitizer rebuild; corpus persistence |
| Sanitizer matrices (ASan/TSan/MSan/Miri) | asupersync `compiler_sanitizers.yml`; fastapi_rust Miri nightly | instrumented rebuild per sanitizer |
| Exhaustive interleaving (Loom/DPOR full) | frankensqlite loom MODEL; asupersync DPOR explorer | state-space explosion → minutes-to-hours |
| Soak / stress / 24h | frankenterm 24h fuzz; mcp_mail 30-agent gauntlet | sustained isolated runtime |
| Live-oracle **differential at scale** | numpy→NumPy, pandas→pandas, redis→redis-server byte-for-byte | reference env install + subprocess oracle per case |
| Cross-platform / cross-arch matrix | frankenlibc aarch64 QEMU; frankensqlite ppc64le big-endian, musl, msvc, wasm | other machines / emulators |
| Competitor / headline-claim benches on pinned HW | frankenterm competitor-bench; atp "only vs rsync, SHA-256 verify" | stable hardware for valid numbers |
| Formal-proof CI | asupersync Lean+TLA+; ee Lean4+TLA+; frankenterm Stateright | proof-assistant toolchains, minutes |
| Whole-suite / whole-file **mutation campaigns** | (revived from June `cargo-mutants`; now meta-mutation only) | N mutants × suite runtime, embarrassingly parallel |
| CVE regression arena | frankenlibc real glibc CVEs in Docker | Docker + vendored vulnerable builds |
| LLM window-review judge (Tier 2/3) | — (our trajectory §8) | model inference; flag-triggered only |
| Type/taint-dependent static detectors (`go_unchecked_error`, SSRF-to-tainted-host) | UBS ships regex forms; we defer these two to avoid a noisy local gate | Go's unchecked-error needs the callee's return type (is the discarded value an `error`?); SSRF needs taint flow from request input to the outbound URL. Pure-regex FP is too high for a continuity-safe local warning — both want the cloud's type/taint pass. (Local breadth already covers the sibling static classes: naive-datetime, ReDoS, weak-random, archive-traversal, assert-tautology, and `except:pass` via `error-handling.ts`.) |

## 3. Substrate (already designed; reuse, don't reinvent)

Anchors in `test-category-adoption-from-the-wild.md` §5.4 / §6 / §8 and
`cloud-governor-architecture.md`:
- **Warm Artifacts fork per session** (Cloudflare Artifacts — git-compatible
  versioned storage). On a check, `git apply` the proposed patch to a fork
  branch.
- **Sandbox fan-out** — parallel isolated execution; `wall-clock ≈ warmup +
  slowest_single_shard`. Mutation = all mutants concurrent (constant in mutant
  count); differential = cases sharded; matrix = arches concurrent.
- **∃-short-circuit** — return `deny` on first failure/surviving mutant, usually
  well under any ceiling.
- **Content-hash cache** keyed on `{tree, proposed patch}`.
- **RCH as the proven prior art** — DW's `remote_compilation_helper` is exactly
  this pattern in production (a PreToolUse hook classifying build/test commands
  in ms, executing on an 8-VPS fleet, artifacts returned as if local; fail-open
  normally, `RCH_REQUIRE_REMOTE=1` for proof lanes where a local fallback is
  recorded as *degraded*, never green). Our cloud offload is RCH generalized to
  the whole gauntlet, and its "degraded ≠ green" honesty rule is mandatory.

## 4. Non-negotiables carried from local

1. **Parity or bust.** Author each check ONCE as a pure function of
   `{proposed patch, tree, config}` with the substrate (local worktree vs
   Artifacts fork) as a parameter; pin with a parity test (the
   `registry-parity.ts` / `command-guard-parity.test.ts` pattern). Two
   implementations drifting is the trust-killer.
2. **Static lane stays local always.** Even a full-offload customer runs the
   Group-A checks on-device (instant, free, private); only execution egresses.
3. **Fail-open** on infra error / over-budget → defer or degrade, never wedge.
4. **Degraded ≠ green** (RCH's rule): a proof lane that fell back to a weaker
   substrate is recorded `degraded`/`blocked`, never counted as a pass.
5. **Offload is a toggle, not a scheduler** (`cloud_governor.offload`), default
   off; single-agent-local stays fully private/offline.

## 5. Sequencing (when this plan activates)

1. Cloud substrate MVP: warm Artifacts fork + one Sandbox + content-hash cache +
   the parity harness. Prove with ONE category (diff-scoped mutation — the
   embarrassingly-parallel win).
2. Add categories by parallelism-payoff: mutation → differential-at-scale →
   sanitizers → cross-arch → soak/campaigns.
3. LLM window-judge (trajectory Tier 2/3) as a separate flag-gated surface,
   never in the deterministic pipeline.
4. The commit/push outflow gate (now delivering a verdict up to ~220s locally)
   escalates its OVER-220s suites here — the honest handoff the §0 boundary
   note calls out.

## 6. Explicit non-goals

- A local multi-agent scheduler (rejected in the adoption doc §8 — the cloud's
  per-agent isolation solves it better).
- Porting DW's bespoke per-project artifacts (his Lean proofs, his conformance
  crates) as generic checks — we RUN them if a repo has them (run-if-exists),
  we never synthesize them (that's LLM authoring, a separate advisory surface).
