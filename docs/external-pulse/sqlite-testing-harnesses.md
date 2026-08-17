# SQLite Testing — Third-Party Harnesses & Technique → Gate Mapping

- **Source:** https://sqlite.org/testing.html (primary, Q2) · https://github.com/sqlancer/sqlancer · https://github.com/risinglightdb/sqllogictest-rs · https://sqlite.org/sqllogictest · https://github.com/PSU-Security-Universe/sqlright · https://github.com/anse1/sqlsmith · https://github.com/google/oss-fuzz/tree/master/projects/sqlite3 · https://github.com/tursodatabase/turso (Q1)
- **Encountered:** 2026-08-12, direct research task; seeded by `docs/design/session-2026-08-11-synthesis.md` Part 7 ("The SQLite idea" — mutation-checked test suite / rewrite-verification showcase using interlinked)
- **Verdict:** compound — memory note (Q1, the harness landscape) + gate backlog / RFC (Q2, the technique→gate mapping is Appendix B and is the deliverable a downstream agent should build from)

## 1. Core idea (one sentence)

SQLite's own testing doctrine (`testing.html`) is a checklist of ~20 discrete, mostly-language-agnostic testing TECHNIQUES (fault injection, boundary forcing, mutation testing, assert-density, sanitizers, differential builds) layered on top of four independent harnesses and a constellation of third-party fuzzers/oracles (SQLancer, SQLRight, sqlsmith, OSS-Fuzz, sqllogictest, Turso) that test SQLite (or, in Turso's case, a rewrite of it) from the outside; this document verifies which of those third-party tools actually exist and what they cover (Q1), then walks every technique named in `testing.html` and states whether interlinked already has a deterministic gate for its generalized form, has one designed-but-unbuilt, should get a new one, or cannot enforce it without a human/model judgment call (Q2, Appendix B).

## 2. Anatomy

### 2a. Q1 — the third-party harness landscape (verified, not README-summarized)

Six candidates named in the task, all confirmed to exist as real, independent projects (`gh api` metadata + direct source reads, not marketing pages). Full per-project detail — what each tests, what it explicitly does NOT cover, license, maintenance state — is **Appendix A**. Headline correction to the naive reading: these are **not six variations on one idea**. They split into three genuinely different mechanisms:

1. **Differential/metamorphic oracles over the live SQL interface** (SQLancer, SQLRight) — generate queries, transform them, check the transformed result matches. Black-box; never touches the VFS/storage layer.
2. **Result-correctness-only comparison harnesses** (sqllogictest and its independent ports) — run the same statements against several engines, diff results. Explicitly disclaims performance, concurrency, and locking.
3. **Pure crash-oracle generators** (sqlsmith, OSS-Fuzz's wrapping of SQLite's own `test/ossfuzz.c`) — no logic-bug oracle at all; the only signal is "did it crash/ASan-trip."

Turso (`tursodatabase/turso`, formerly Limbo) is a fourth, distinct category: not a harness **for** SQLite at all, but a from-scratch Rust reimplementation that built its own deterministic-simulation-testing (DST) framework, using real SQLite only as a differential oracle for its own rewrite.

### 2b. Q2 — sqlite.org/testing.html's taxonomy (fetched via `curl -H "Accept: text/markdown"`, 1268-line doc, full TOC walked)

Twelve numbered sections; the technique-bearing ones (3–4, 5–9, 11) are what Appendix B maps. Section 2 (the four harnesses: TCL/TH3/SLT/dbsqlfuzz) and 12 (Summary) are architecture/framing, not individually gateable techniques, so they inform the doc but get no table row. Section 10 (release Checklists) is the one section whose *point* is that it resists automation — SQLite's own text: *"It is important to have a human reviewing the test output at the highest level, and constantly asking 'Is this really right?'"* — carried into Appendix B as the doc's cleanest **not-enforceable** example.

## 3. Deterministic or agentic?

**Deterministic, entirely.** Every technique in `testing.html` — malloc-fail loops, VFS fault injection, `testcase()`/`ALWAYS()`/`NEVER()` macros, gcov branch measurement, mutation testing, assert density, sanitizer runs — is a mechanical, non-LLM procedure. This is exactly the shape the interlinked harness is built to host (`feedback_harness_deterministic_only.md`); no part of this intake routes to lane 5. License notes are per-project in Appendix A; the one that matters for the dependency-cost filter is **sqlsmith: GPL-3.0** (copyleft — blocks code-borrow regardless of usefulness, per `INTAKE.md` §"dependency & supply-chain cost"). Every other project checked (SQLancer, sqllogictest-rs, SQLRight, Turso) is MIT or Apache-2.0.

## 3b. Role in its native architecture — and does it transfer?

In SQLite, these techniques are the **product's core reliability claim**, not a convenience layer — SQLite's own framing: *"the reliability and robustness of SQLite is achieved in part by thorough and careful testing"* backed by 590× as much test code as production code. The role transfers cleanly to interlinked's thesis (ratchet the quality of whatever codebase it runs in) with one structural difference: SQLite's techniques are **hand-built once, for one C codebase, by the people who own the code being tested**. Interlinked's job is the opposite — **detect, generically and per-edit, whether an ARBITRARY codebase has (or lacks) the *shape* of these techniques**, never author them. That reframing is what makes most of Appendix B "presence + quality detection," not "run this technique."

## 4. Substrate vs. surface

- **Surface (SQLite's):** a specific C library's release-gating test suite.
- **Substrate (transferable):** the technique taxonomy itself — fault-injection-test shape, boundary-forcing-test shape, mutation-testing shape, assert-density, differential-build testing — all of which are patterns detectable by static/structural analysis of *any* codebase's test tree, independent of what the codebase does. This is precisely what Appendix B extracts.

## 5. Lane (1–6)

**Lane 2 (detection technique)** for every row in Appendix B that maps to a check. A handful of rows are **lane 4 (pattern)** — e.g., the fuzz-vs-MC/DC tension is a design-tradeoff insight with no artifact to gate, recorded as a pattern note rather than a check.

## 6. Dependency & displacement

- **Deps:** zero. Every proposed gate (Appendix B, "PROPOSE" rows) is pure static/structural analysis of proposed content, git history, or CI config — the same substrate the existing `checks/` family already reads. Nothing here needs a new runtime dependency.
- **Displacement — this is NOT a green field.** Three existing design docs already claim large parts of this territory; the contribution of this intake is filling a gap those docs share, not re-inventing them:
  - **`docs/design/test-category-adoption-from-the-wild.md`** already inventories a ~39-category taxonomy (§13.2) including `crash-recovery (WAL truncation at every byte, SIGKILL, bit-flip)`, `chaos/fault-injection incl. LDFI`, `fuzzing`, `sanitizer campaigns`, and `differential vs live reference impl`, and assigns each a **run-if-exists / nudge-if-missing / detect-asymmetry** tier (§10, §13.4). **What it does not specify is how the harness recognizes that such a suite exists in the first place.** That is exactly the gap Appendix B's "detection signal" column fills for the subset `testing.html` names — this document is the missing presence-detection layer for categories that doc already named, not a competing taxonomy.
  - **`docs/design/local-gate-catalog.md`** already designs (not built) the execution-tier escalations several Appendix-B rows need once presence is confirmed: Tier B #8 "Boundary battery," Tier C #12 "Fault-injection error-path witness," #13 "Effect-trace diff," #17 "Growing fuzz corpus," #19 "Leak slope." Appendix B cites these by number rather than re-proposing them.
  - **`docs/design/equivalent-mutant-handling.md`** is the direct, more-rigorous answer to SQLite's manual `OPTIMIZATION-IF-TRUE`/`OPTIMIZATION-IF-FALSE` comment convention (§7.6) — see Appendix B row "Mutation testing" for the **ahead** verdict.
- **Equivalence table (capability-by-capability), rolled up from Appendix B:**

  | Capability | Status | Where |
  |---|---|---|
  | Mutation testing (branch-kill verification) | **shipped**, and the equivalent-mutant handling is **ahead** of SQLite's own (proof via TCE vs. a manual comment) | `src/harness/mutation/`, `per_edit_mutation`, `docs/design/equivalent-mutant-handling.md` |
  | Assert side-effect stripped-in-release trap | **shipped**, 4 languages | `ubs_c_assert_side_effect` / `ubs_python_assert_side_effect` / `ubs_java_assert_side_effect` / `ubs_rust_debug_assert_side_effect` |
  | Branch coverage tracking | **shipped**, narrower guarantee (high-water ratchet, not a 100% floor; no MC/DC) | `coverage-ratchet.ts` (`branches_pct`) |
  | Static analysis / compiler warnings | **shipped**, broader than SQLite's own (12 language toolchains vs `-Wall -Wextra` + one static analyzer) | `interlinked verify` default gate |
  | Round-trip / inverse-pair property tests | **shipped**, narrower (existence-only, no corrupted-input variant yet) | `untested_inverse_pair` / `untested_idempotent` |
  | Same-file schema/malformed-structure consistency | **shipped**, narrower (static same-file only, not on-disk byte corruption) | `migration_ordering` (pre_block), `sql_schema_consistency` (pre_warn) |
  | Resource-leak-on-early-exit | **shipped**, language-scoped (JS/TS timer/listener; Go goroutine-leak shape) | `cleanup-early-exit.ts`, `missing-effect-cleanup.ts`, `ubs_goroutine_no_waitgroup` |
  | OOM / I-O-error fault injection | **absent** (presence-detection); **designed** (execution-tier) | Appendix B PG1; `local-gate-catalog.md` Tier C #12 |
  | Crash / power-loss recovery tests | **absent** entirely — genuinely new | Appendix B PG2 |
  | Fuzz-harness presence | **absent** (presence); **designed** (corpus-growth tier) | Appendix B PG3; `local-gate-catalog.md` Tier C #17 |
  | Boundary-value (`testcase()`) forcing | **designed**, not built | `local-gate-catalog.md` Tier B #8 "Boundary battery" |
  | Regression-test-required-on-bugfix | **absent** entirely — genuinely new | Appendix B PG6 |
  | Defensive-code coverage-exemption justification (`ALWAYS()`/`NEVER()`) | **absent**; extends a shipped mechanism | Appendix B PG7, extends `suppressions-unjustified` |
  | Differential-build / disabled-optimization testing | **absent** entirely — genuinely new, weak signal | Appendix B PG8 |
  | Sanitizer (Valgrind/UBSan/ASan) CI presence | **absent** (presence); already routed at execution tier | Appendix B PG9; `local-gate-catalog.md` §6 master table routes sanitizers to cloud |
  | Multi-implementation differential/parity conformance | **absent** (presence); overlaps `test-category-adoption` §3.2.B | Appendix B PG10 |
  | MC/DC condition coverage | **not enforceable** — no mainstream JS/TS/Python/Go tool reports it | Appendix B, Coverage group |
  | Release checklist correctness | **not enforceable** — human judgment by design | Appendix B, Checklists group |

## 7. Smallest spike (≤1 day)

**PG7 — coverage-ignore justification.** Extend the *existing* suppression-justification mechanism (`suppressions-unjustified` / `suppressions`, `src/harness/quality-checks.ts::classifyDeterminism`) to also require a reason on `/* istanbul ignore */` / `/* c8 ignore */` coverage-exclusion comments, exactly like `@ts-ignore` and `eslint-disable` already require one. Zero new files, one pattern added to an existing list, ≤3 pos/neg cases to satisfy the Check Evidence Contract's `post`/advisory tier. It is also, by `agent-terraforming-checks.md`'s own definition, a **terraformer**: the fix (a justified ignore) makes the coverage-ratchet gate's floor honest instead of silently excluded. Second-smallest, higher-value alternative: **PG4** (corrupted-input negative test), which extends `property-testing.ts`'s existing inverse-pair scan rather than adding a new file.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | All of Appendix B's PROPOSE rows (PG1–PG10) — every one is local, deterministic, static/structural | PG7 (§7) | now (PG7, PG4) / next (PG1–3, PG6, PG9–10) |
| Guardrails (P2–3) | None — nothing here needs a classifier or central state | — | — |
| Agent CI (P4–5) | The execution-tier escalations once presence is confirmed (run the fault-injection test, grow the fuzz corpus, run the sanitizer) — already scoped in `local-gate-catalog.md` Tiers B–D, not re-scoped here | Tier C infra build-out | parked (behind the Tier C seam) |

## 9. Artifact

**Compound.** Memory note for Q1 (this file is the record; no code follows from cataloging third-party tools interlinked doesn't depend on). **RFC / gate backlog** for Q2 — Appendix B's ten PROPOSE rows (PG1–PG10) are the backlog; PG7 is ready to build as a PR-sized unit per §7. Not a single PR because the ten proposals differ in shipped-vs-new-infra needs and evidence tier.

## Notes

- **Verified vs. assumed, stated plainly.** Every license/maintenance figure in Appendix A came from `gh api repos/<org>/<repo>` (exact `pushed_at`, `stargazers_count`, `license.spdx_id`) or a direct file read (OSS-Fuzz's `build.sh`, `sqlsmith`'s README), not a summarized landing page — the CodeWiki lesson applied. One gap, disclosed rather than papered over: Turso's simulator README states Simulator Profiles "influence... I/O fault injection" and that the team "partnered with Antithesis," but direct fetches of `testing/simulator/src/profiles/mod.rs` and `.../runner/io.rs` both 404'd in this session (path likely reorganized since the README was written), so the **exact fault taxonomy** (disk-full vs. latency vs. torn-write vs. corruption) is **not independently confirmed from source** — only the README's claim of it. Flag before anyone cites Turso's fault coverage as equivalent to TH3's.
- **sqlsmith vs. SQLancer/SQLRight is a kind difference, not a degree difference.** sqlsmith has no logic-bug oracle at all (crash-only); conflating "SQL fuzzer" tools as interchangeable is the exact failure mode this rubric exists to catch.
- **OSS-Fuzz is infrastructure, not a distinct methodology** for SQLite specifically — verified via `build.sh`: it compiles `$SRC/sqlite3/test/ossfuzz.c`, i.e. SQLite's own harness code, under Google's ClusterFuzz. SQLite's own page corroborates: *"OSS Fuzz no longer finds historical bugs in SQLite... does occasionally find issues in new development check-ins"* — diminishing returns now that `dbsqlfuzz` (SQLite's proprietary structure-aware fuzzer) runs first.
- **CockroachDB and DuckDB did not adopt `sqllogictest-rs`.** Each independently reimplemented the SLT *file format* natively (CockroachDB: Go, `pkg/sql/logictest`; DuckDB: C++, later a Python runner) — a format-adoption, not a code-dependency. Worth stating precisely since a shallow read would assume all three share a library.
- **sqllogictest's own scope disclaimer is the single most load-bearing quote for Q2's framing**: *"Sqllogictest is concerned only with correct results. No attention is paid to performance, optimal use of indices, disk and memory usage, transactional behavior, or concurrency and locking issues."* Every third-party result-oracle tool inherits this same blind spot — none of Q1's six candidates cover crash/OOM/IO-fault/leak/coverage, which is exactly why `testing.html`'s techniques (Q2) are the richer source for gate design.
- SQLite's own verdict on static analysis is worth carrying forward as a caveat on interlinked's own posture: *"Static analysis has not been helpful in finding bugs in SQLite... More bugs have been introduced into SQLite while trying to get it to compile without warnings than have been found by static analysis."* Not a reason to drop the default-gate static tools (they catch a different, more mechanical class of bug than SQLite's hand-tuned C), but a reason not to oversell static analysis as a mutation/fuzz-testing substitute.

## Methodology notes

`gh api` repo-metadata calls proved far more reliable than `WebFetch`-summarized READMEs for the license/maintenance fields specifically (exact ISO timestamps, exact SPDX ids, no summarization drift) — worth defaulting to `gh api repos/<owner>/<repo> --jq '{...}'` first for any future intake's §6 dependency-cost checks, falling back to WebFetch/WebSearch only for prose claims `gh api` can't answer (what does it test, what's the mechanism).

---

## Appendix A — Third-party SQLite test harness catalog (Q1, full detail)

### SQLancer (`sqlancer/sqlancer`)

- **What it tests:** differential/metamorphic query-result oracles over the live SQL interface — TLP (Ternary Logic Partitioning), NoREC (Non-optimizing Reference Engine Construction), PQS (Pivoted Query Synthesis), plus newer additions DQP (Differential Query Plans, SIGMOD'24), CERT (ICSE'24), DQE (ICSE'23), CODDTest (SIGMOD'25). All generate/transform SQL and check that semantically-equivalent forms return the same result set; a mismatch is a logic bug. Supports 19 DBMS as of Jan 2025 including SQLite3.
- **What it does NOT cover (TH3-class gaps):** crash/power-loss recovery, OOM/I-O-error fault injection, on-disk file corruption, automatic resource-leak detection, branch/MC-DC coverage, concurrency/locking correctness. All out of scope by construction — SQLancer is black-box over the SQL API and never touches the VFS or storage layer.
- **License:** MIT (`LICENSE.md`).
- **Maintenance:** active. `pushed_at: 2026-08-12` (today, per `gh api`), 1,743 stars, 141 open issues. One caveat within the project itself: PQS is explicitly marked unmaintained in its own README — *"PQS effectively detects bugs, but requires more implementation effort than other testing approaches... it is currently unmaintained"* — superseded by TLP/NoREC as cheaper to implement per-DBMS.

### sqllogictest (SQLite's own SLT format) + `risinglightdb/sqllogictest-rs`

- **What it tests:** correctness of SQL statement *results only*, run against multiple independent engines (historically PostgreSQL, MySQL, MS SQL Server, Oracle 10g) to cross-check agreement — 7.2M queries, 1.12GB of test data in SQLite's own run. `sqllogictest-rs` is an independent Rust reimplementation of the *parser and runner* for the format, with its own extensions, used by RisingLight and other Rust DB projects (8.4M+ all-time crate downloads).
- **What it does NOT cover:** stated explicitly by the source itself — *"Sqllogictest is concerned only with correct results. No attention is paid to performance, optimal use of indices, disk and memory usage, transactional behavior, or concurrency and locking issues."* No fault injection of any kind; it is a pure result-oracle over a live connection.
- **License:** `sqlite.org/sqllogictest` states no explicit license on the page itself (unconfirmed — SQLite's own code is public domain by convention, but this specific test-data corpus's license was not independently verifiable from the fetched page). `risinglightdb/sqllogictest-rs`: **Apache-2.0**.
- **Maintenance:** `sqllogictest-rs` moderately active — `pushed_at: 2026-02-14`, 231 stars. **Correction to a plausible-but-wrong assumption:** CockroachDB and DuckDB did **not** adopt `sqllogictest-rs`. CockroachDB independently reimplemented the *format* in Go (`pkg/sql/logictest`, explicitly credited as "adapted from SQLite's logic test framework," extended with per-file "configurations"). DuckDB independently reimplemented it in C++ (`test/sql`, `.test`/`.test_slow` extension convention), later adding a separate Python runner (`duckdb/duckdb-sqllogictest-python`). Three independent ports of one file format, not one shared library.

### SQLRight (`PSU-Security-Universe/sqlright`)

- **What it tests:** coverage-guided fuzzing combined with validity-oriented mutation and a pluggable oracle interface (same oracle family as SQLancer — differential/logic-bug detection), adding AFL/libFuzzer-style structural coverage guidance on top. USENIX Security 2022 paper; found 18 logic bugs across SQLite and MySQL.
- **What it does NOT cover:** the same blind spots as SQLancer (crash/OOM/IO-fault/leak/coverage/concurrency — black-box over SQL), **plus** staleness: it has not tracked SQLite's evolution since 2022, so any dialect/feature surface added since is untested by construction.
- **License:** MIT.
- **Maintenance:** **unmaintained**. `pushed_at: 2022-10-28` (~4 years stale as of this writing), 66 stars, 2 open issues — a static academic-artifact repository (`PSU-Security-Universe/sqlright-artifact` is the separate paper-reproduction repo).

### sqlsmith (`anse1/sqlsmith`)

- **What it tests:** pure random *syntactically-valid* SQL query generation ("its paragon is Csmith" per the README) against PostgreSQL, SQLite3, and MonetDB natively (extensible to others via two implementable classes). The oracle is exclusively "did the target crash or hang" — there is **no** differential/metamorphic result-correctness oracle built in. Since 2015: 118 bugs found across the three engines plus extensions (orafce, glibc).
- **What it does NOT cover:** wrong-result (logic) bugs — a fundamentally different tool *kind* from SQLancer/SQLRight, not a lesser version of the same kind. Also, like the others: no crash-recovery, OOM/IO-fault, coverage/MC-DC.
- **License:** **GPL-3.0** (copyleft — flagged per `INTAKE.md`'s dependency-cost filter; blocks code-borrow regardless of usefulness).
- **Maintenance:** active. `pushed_at: 2026-07-15`, 856 stars, C++.

### OSS-Fuzz SQLite target (`google/oss-fuzz/projects/sqlite3`)

- **What it tests:** not an independent methodology at all — verified directly from `build.sh`: it compiles and runs `$SRC/sqlite3/test/ossfuzz.c`, which is **SQLite's own libFuzzer harness, checked into the SQLite source tree**, under Google's continuously-running ClusterFuzz infrastructure (build flags cap blob/SQL length and memory to keep OOMs meaningful: `SQLITE_MAX_LENGTH`, `SQLITE_MAX_SQL_LENGTH`, `SQLITE_MAX_MEMORY`, `SQLITE_MAX_PAGE_COUNT`). What OSS-Fuzz contributes is infrastructure — auto-download-on-checkin, dedup, bisection, developer email — not a new testing technique.
- **What it does NOT cover:** whatever `ossfuzz.c` itself doesn't exercise: no differential/logic-bug oracle (a crash/ASan-detected-UB oracle only), no crash-recovery/OOM/IO-fault simulation beyond what the harness's own build flags impose, no coverage/MC-DC measurement. SQLite's own page states the honest current value: *"OSS Fuzz no longer finds historical bugs in SQLite... does occasionally find issues in new development check-ins"* — largely superseded in practice by the proprietary `dbsqlfuzz`.
- **License:** Apache-2.0 (the `oss-fuzz` repository itself).
- **Maintenance:** actively maintained by Google's infra team; diminishing marginal bug-finding value against SQLite specifically, by SQLite's own assessment.

### Turso (`tursodatabase/turso`, formerly "Limbo")

- **What it tests:** **not SQLite** — a from-scratch Rust reimplementation, compatible at the language/file-format level, with its own deterministic-simulation-testing (DST) harness built in from day one (`testing/simulator/`: `common/`, `generation/`, `model/`, `profiles/`, `runner/`, `shrink/`). Confirmed from the simulator README: seeded RNG for reproducible runs (`--seed`), property/invariant assertions over generated interaction plans (e.g. "inserted rows appear in later SELECT queries"), and a `--differential` mode that runs the same interaction plan against both Turso and real SQLite, diffing behavior and checking for panics on either side. Team states a partnership with Antithesis (autonomous fault-injecting hypervisor testing).
- **What it does NOT cover, or that could not be confirmed:** it tests Turso's own reimplementation, not upstream SQLite's C code — not comparable to the other five candidates on "coverage of SQLite" at all. The README claims Simulator Profiles "influence... I/O fault injection," but the **exact fault taxonomy is not independently verified from source** in this session (direct fetches of the profile/IO source files 404'd — see Notes). Treat the fault-injection claim as README-level until someone reads the current source tree directly.
- **License:** MIT.
- **Maintenance:** very active — `pushed_at: 2026-08-12` (today), 23,840 stars, by far the largest and most active of the six.

---

## Appendix B — `sqlite.org/testing.html` technique → interlinked gate mapping (Q2, the core table)

Legend: **SHIPPED** = a live check today · **DESIGNED** = specified in a design doc, not built · **PROPOSE (new)** = no existing artifact, net-new · **PROPOSE (extends)** = adds to a shipped mechanism · **NOT ENFORCEABLE** = judgment-laden or tooling-absent, with the one-clause reason. Every PROPOSE row is explicitly cross-checked against `test-category-adoption-from-the-wild.md`'s taxonomy to avoid duplicating that doc — see the "Overlap" line under each group where one exists.

### §3 Anomaly Testing

| Technique (`testing.html` §) | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| OOM testing (§3.1) | Pluggable `sqlite3_config(SQLITE_CONFIG_MALLOC,...)`; loop increasing the fail-point until the operation completes without triggering the simulated failure | **PG1 — fault-injection-test presence.** Generalizes to: does a resource-acquisition call have a companion test that forces its *N*th call to fail and asserts recovery | **PROPOSE (new)**, presence tier; execution tier already **DESIGNED** — `local-gate-catalog.md` Tier C #12: *"Fault-injection error-path witness — re-run injecting one thrown error per IO site systematically; report catch blocks that never execute even under injected faults."* | JS/TS: `vi.spyOn(...).mockRejectedValueOnce` / `.mockImplementationOnce(() => { throw })` paired with a `try/catch` around the same call in source. Python: `monkeypatch`/`unittest.mock.patch(..., side_effect=...)`. Rust: `#[cfg(test)] fn failing_alloc` / injected `Result::Err` via a test-only trait impl. Go: an injected `error`-returning stub via interface substitution. |
| I/O error testing (§3.2) | Custom VFS rigged to fail after N operations; `PRAGMA integrity_check` afterward | Same mechanism as PG1, generalized to filesystem/network calls specifically; the integrity-check-afterward step generalizes to "does the test re-verify invariants post-recovery, not just that no exception escaped" | **PROPOSE (new)**, same PG1 | Same signal as above, scoped to `fs.*`/`net`/HTTP client mocks specifically; presence of a post-recovery assertion (not just "did not throw") is the quality dimension, checked separately |
| Crash / power-loss testing (§3.3) | Separate-process crash mid-write (TCL) or in-memory VFS snapshot-and-corrupt (TH3); reopen and `integrity_check` | **PG2 — crash/kill-recovery-test presence.** Does a persistence-owning module (writes to disk/DB and later reopens/replays that state) have a test that kills the writer mid-operation and asserts integrity on reopen | **PROPOSE (new)** — zero existing coverage, any language | Structural: a module exports both a write/append/commit function AND a reopen/replay/recover function operating on the same on-disk artifact. Test signal: `process.kill(pid, 'SIGKILL')` / `os.kill(pid, signal.SIGKILL)` / a Rust test harness that drops a `File` mid-write via a fault-injecting wrapper, paired with a subsequent integrity/consistency assertion. **This is the doc's cleanest fire-rate-thesis example: it fires 0 times in interlinked-cli itself (no crash-recoverable storage engine here) — that silence is correct, not a gap.** |
| Compound failure tests (§3.4) | Stack two failures (e.g. I/O error during crash recovery) | Same detection substrate as PG1/PG2, higher bar: two independent injected failures in one test | **PROPOSE (new)**, folded into PG1/PG2 as a "stacked" quality signal rather than a separate gate | A test containing two distinct fault-injection setups (per the PG1/PG2 signals) active simultaneously |

**Overlap check:** `test-category-adoption-from-the-wild.md` §13.2 already names `crash-recovery (WAL truncation at every byte, SIGKILL, bit-flip)` and `chaos/fault-injection incl. LDFI` as bespoke, run-if-exists categories (§10 tier 1). PG1/PG2 do not compete with that — they supply the concrete, per-ecosystem file/pattern signal for "does such a suite exist" that doc leaves unspecified.

### §4 Fuzz Testing

| Technique | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| AFL-style coverage-guided SQL fuzzing (§4.1.1) | Historical; superseded 2019 | **PG3 — fuzz-harness presence.** Does the repo contain a recognizable fuzz target at all | **PROPOSE (new)**, presence tier; execution tier already **DESIGNED** — `local-gate-catalog.md` Tier C #17: *"Growing fuzz corpus — 30s coverage-guided burst (deterministic seed), corpus persisted under `.interlinked/` across sessions; crash-free corpus size only grows."* | Rust: `fuzz/Cargo.toml` + `fuzz_targets/*.rs` + `libfuzzer-sys` dep (cargo-fuzz convention). C/C++: a function matching `LLVMFuzzerTestOneInput`. Go ≥1.18: `func Fuzz*(f *testing.F)`. Python: `import atheris` + `atheris.Fuzz(`. JS: `jazzer.js`/`jsfuzz` import (rare). |
| OSS-Fuzz integration (§4.1.2) | Continuous infra running SQLite's own harness (see Appendix A) | Folded into PG3 as a bonus signal, not separate | **PROPOSE (new)**, minor | `.clusterfuzzlite/` dir or an OSS-Fuzz-shaped `project.yaml`/`build.sh` pair |
| Structure-aware dual-mutation fuzzing (dbsqlfuzz, §4.1.3) | Custom mutator co-mutates SQL text AND the DB file simultaneously | The bare-presence half maps to PG3; the *sophistication* question (does the mutator respect both formats' grammar) requires running it and watching coverage grow | Presence: **PROPOSE (new)**, PG3. Quality: **DESIGNED**, execution tier — same Tier C #17 | PG3's signal, plus (quality tier only) coverage growth over repeated runs — not statically inspectable |
| Format-specific fuzzing (jfuzz, §4.1.3) | JSONB-specific fuzz target | Same as PG3, cross-referenced against a structural signal: a hand-rolled parser/deserializer with **no** companion fuzz target is the highest-value single finding | **PROPOSE (new)**, PG3 refinement | Pairs a parser/deserializer detection (already partly done by `unvalidated_json_boundary`'s boundary-scan) with absence of a matching fuzz target — this is `test-category-adoption-from-the-wild.md` §10's "Nudge-if-missing" tier, made concrete |
| Fuzz-corpus regression replay (fuzzcheck, §4.1.5) | Historical crash cases replayed on every `make test` | Same substrate as PG3's execution tier | **DESIGNED** — `local-gate-catalog.md` Tier C #17 (corpus persisted, crash-free size ratchets) already specifies exactly this | A seed/corpus directory (`fuzz/corpus/`, `testdata/fuzz/`) referenced from a regular (non-fuzz-mode) test run, not just the standalone fuzzer invocation |
| Fuzz vs. 100% MC/DC tension (§4.1.6) | Design philosophy: defensive code helps MC/DC, hurts fuzz-robustness | No artifact represents "we resolved this correctly" — it is a property of thousands of individual judgment calls across a codebase | **NOT ENFORCEABLE** — no deterministic signal distinguishes principled defensive code from dead code without running both a fuzzer and an MC/DC-capable coverage tool and reconciling by hand | — |
| Malformed database files (§4.2) | Well-formed DB corrupted byte-by-byte; `SQLITE_CORRUPT` expected, no UB | **PG4 — corrupted-input negative test.** Extends the *shipped* `untested_inverse_pair`/`untested_idempotent` checks (`src/harness/checks/property-testing.ts`, registered `src/harness/check-registry/entries-warnings/agent-clarity.ts:180-208`): when a decode/parse/deserialize/`from<X>` function is already detected (it is, today), additionally check whether any test feeds it a truncated/bit-flipped/malformed fixture | **PROPOSE (extends shipped)** | Regex over the module's own test files for a truncation pattern (`.slice(0, n)`, `.subarray(0, n)`) or a literal `corrupt`/`malformed`/`truncated`/`invalid` substring near a call to the detected decode function |
| Boundary value tests (§4.3, `testcase()` macro) | `testcase(a==b); testcase(a==b+1);` forces both sides of every boundary condition, plus switch-fallthrough and bitmask-bit coverage | **PG5.** Already fully specified, not built | **DESIGNED** — `local-gate-catalog.md` Tier B #8: *"Boundary battery — synthesize inputs from the edit's own AST (comparison literals ±1, NaN, -0, Infinity, empty/huge collections, surrogate pairs); run the edited pure functions on them. Off-by-one killer; no fuzzer randomness."* | (as designed — AST-derived, no new signal needed here) |

### §5 Regression Testing

| Technique | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| Every fixed bug ships a permanent test (§5) | "That bug is not considered fixed until new test cases... have been added" | **PG6 — bugfix-commit-without-test-delta.** A `git commit` (or `apply_patch`) whose message matches a bugfix pattern and whose staged diff touches zero test files | **PROPOSE (new)** — genuinely absent; not the same mechanism as `test-category-adoption`'s §3.2.G claim-gates (those check README-vs-reality, not commit-vs-test-delta) | Commit message regex: `\bfix(es)?\s*#\d+\b`, `\bbugfix\b`, `\bregression\b`; git diff test-file count == 0. Sits alongside `commit-baseline-gate.ts` in `pre-tool-pipeline.ts` before `runCommitGate` — same anchor point (commit is the outflow event), same pure-git-diff mechanism, no execution |

### §6 Automatic Resource Leak Detection

| Technique | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| Memory/fd/thread/mutex leak tracking on *every* run (§6) | TCL + TH3 both auto-track and fail on any leak, no config needed | **Shipped, but language-scoped and narrower than "every run."** JS/TS: `cleanup-early-exit.ts` (timer/listener/subscription leaked on a throw/return path before the matching release), `missing-effect-cleanup.ts` (React effect cleanup). Go: `ubs_goroutine_no_waitgroup` (fire-and-forget goroutine leak shape). None of these run a live leak-detector on every test the way TCL/TH3 do — they are static-pattern detectors, not runtime trackers | **SHIPPED** (narrower) + **DESIGNED** for the runtime/every-run form | `local-gate-catalog.md` Tier C #19: *"Leak slope — heap high-water across 5 repetitions of the same test; positive slope = leak at introduction time."* is the direct generalization of TCL/TH3's "track it on every run" property |

### §7 Test Coverage

| Technique | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| Statement vs. branch coverage (§7.1) | 100% branch coverage under TH3 (stricter than the common "statement coverage" default) | **Shipped**, branch-level, but a high-water ratchet, not a hard 100% floor | **SHIPPED** (narrower guarantee) | `coverage-ratchet.ts` tracks `branches_pct` per file (`CoverageMetric`, `files: Record<string, {lines_pct, branches_pct}>`); rises are kept, drops flagged — never a "must equal 100%" gate |
| `ALWAYS()`/`NEVER()` defensive-code coverage exemption (§7.2) | Marks a condition as "known always/never true"; the macro *asserts* that expectation in debug builds and is excluded from the branch-coverage denominator only with that assertion attached | **PG7 — coverage-ignore justification.** Extends the shipped suppression-justification mechanism to `/* istanbul ignore */` / `/* c8 ignore */` comments, requiring the same reason-after-marker convention `@ts-ignore`/`eslint-disable` already enforce | **PROPOSE (extends shipped)** — see §7 "Smallest spike" | `suppressions-unjustified` / `suppressions` split, `src/harness/quality-checks.ts::classifyDeterminism`; add the istanbul/c8/nyc ignore-comment vocabulary to the existing pattern list |
| `testcase()` forcing both outcomes, incl. switch-fallthrough & bitmask-bit coverage (§7.3) | See §4.3 above | Same as PG5 (Boundary battery); switch-fallthrough/bitmask-bit dual-coverage is a refinement not yet named in that design doc's text | **DESIGNED** (core) / minor refinement flagged for that doc | — |
| Branch coverage vs. MC/DC (§7.4) | MC/DC additionally requires each *condition* inside a compound decision to independently affect the outcome, not just each *branch* | No mainstream JS/TS/Python/Go coverage tool (istanbul/c8/v8, coverage.py, go test -cover) reports condition-level (MC/DC) data — only line/branch/function | **NOT ENFORCEABLE** — the underlying instrumentation this class of check would need to read simply does not exist in these ecosystems' standard toolchains; a gate here would have no measurement to check against, not a judgment call to avoid |
| Meta-test: coverage-instrumented build output == release build output (§7.5) | Runs the suite once under gcov instrumentation, once without, diffs results — verifies the *test*, not the code, and catches compiler-flag-dependent UB along the way | **PG8 — differential-build / config-matrix presence** (folded with §9 below — same technique family) | **PROPOSE (new)**, weak/advisory signal | CI matrix with a build/feature-flag axis (`matrix: { optimize: [...] }`) whose jobs feed a comparison step — semantically harder than the syntax-only `actionlint` already ships; adjacent to, not the same as, `test-category-adoption`'s "Cross-platform/cross-arch" category (§3.2.C — that's an *architecture* matrix, this is a *build-flag* matrix) |
| Mutation testing (§7.6) | Compile to assembly, flip each branch instruction to an unconditional jump or no-op, verify the suite catches it; `OPTIMIZATION-IF-TRUE`/`OPTIMIZATION-IF-FALSE` source comments manually suppress known-equivalent mutants (the hash-function example: a mutated branch that only degrades performance, never correctness) | **Shipped, and ahead on the equivalent-mutant question.** `per_edit_mutation`, `src/harness/mutation/`, `mutation-manifest.json` + receipts, ChangeSet overlays (per CLAUDE.md). SQLite's equivalent-mutant handling is a manual, trust-the-comment annotation; interlinked's is **`docs/design/equivalent-mutant-handling.md`**'s Trivial-Compiler-Equivalence proof-based classification — *proves* equivalence instead of trusting a human-authored marker, which is strictly more rigorous | **SHIPPED**, **AHEAD** on equivalent-mutant handling specifically | — |

### §8 Dynamic Analysis

| Technique | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| `assert()` density, precondition/postcondition/invariant checks stripped by `NDEBUG` (§8.1) | 6,754 `assert()` statements; disabled in release builds by design | **Shipped, and it's the exact bug class.** `ubs_c_assert_side_effect`, `ubs_python_assert_side_effect`, `ubs_java_assert_side_effect` (`src/harness/checks/assert-side-effects.ts`) and `ubs_rust_debug_assert_side_effect` (`ubs-language-specific/rust-go-checks.ts`) catch exactly "an assert argument has a side effect that silently vanishes when asserts are stripped" — the trap SQLite's own discipline avoids by convention, generalized as a gate across 4 languages | **SHIPPED** | — |
| Valgrind — simulated-CPU memory-error detection (§8.2) | Full veryquick + TH3-coverage suite run through Valgrind pre-release | **PG9 — sanitizer-CI presence** (language-conditional: C/C++/Rust/unsafe-Go only) | **PROPOSE (new)**, presence tier; execution tier already scoped elsewhere | CI/Makefile invoking ASan/MSan/TSan/UBSan flags, `valgrind --`, or `cargo miri`. **Overlap:** `test-category-adoption-from-the-wild.md` §3.2.C already counts "Sanitizers (ASan/MSan/TSan/Miri) ~19 repos" and that doc's §6 master routing table already sends sanitizer runs to the cloud execution lane — PG9 is only the missing cheap CLI-side presence check, not a new execution plan. **Fire-rate-thesis example:** correctly fires 0% in this JS/TS repo. |
| Memsys2 — fast custom malloc-debug wrapper (§8.3) | A faster, narrower Valgrind-substitute for everyday runs | Same technique family as §8.2, not a separate gate | folded into **PG9** | — |
| Mutex-held/not-held assertions (§8.4) | `sqlite3_mutex_held()`/`notheld()` embedded in `assert()`s throughout, verifying locking invariants in-line | Adjacent-but-opposite existing check: `ubs_mutex_lock_unwrap` (Rust) catches *panicking on a poisoned lock*, not *verifying a lock is held where required*. A general "assert this lock is held" detector is deeply coupled to each language's concurrency primitives (Rust `Mutex`, Go `sync.Mutex`, C pthread) with little shared shape | **NOT ENFORCEABLE** generically at reasonable build cost today — the per-ecosystem detection signal would be narrow and low-value versus the mutation-testing/sanitizer coverage that already catches most real lock bugs downstream |
| Journal / VFS write-order monitor (§8.5) | A special VFS asserts nothing is written to the DB file before the corresponding rollback-journal write is synced — a **write-ORDER** protocol invariant, not just presence of a write | Generalizes to: for a write-ahead-log / event-sourcing / two-phase-commit implementation, does a test intercept its I/O calls and assert the *order* (not just occurrence) matches the documented protocol | **PROPOSE (new)**, extends a **DESIGNED** gate — `local-gate-catalog.md` Tier C #13 "Effect-trace diff" already patches `fs`/`net`/`child_process` and diffs the capability trace; this technique asks that diff to additionally assert *ordering*, which the design doc doesn't yet call out explicitly | Structural: a module implementing a documented "write X before Y" invariant (WAL/log-then-apply shape) + a test that intercepts both calls and asserts call order |
| Undefined behavior checks — `-ftrapv`, `-fsanitize=undefined`, signed/unsigned char, endianness, 32/64-bit matrix (§8.6) | Rebuild and rerun the full suite under each instrumented/flag variant | The cross-arch/bit-width/endianness half folds into **PG9**'s sibling category; `test-category-adoption-from-the-wild.md` §3.2.C already names this exact thing: `linux-ppc64le.yml` (big-endian), `linux_qemu.yml`, `musl-test.yml`, `wasm.yml` under "Cross-platform / cross-arch." Language-level UB checks (signed overflow, etc.) have no dedicated interlinked detector today — `c-cpp.ts` covers unsafe functions/sprintf/malloc, not arithmetic overflow | Presence (cross-arch CI matrix): **overlap only, no new gate** — cite `test-category-adoption` directly, don't duplicate. Arithmetic-UB static detection: gap noted, not proposed here (too C/C++/Rust-specific to spike in ≤1 day; would need per-language overflow-checked-arithmetic idiom knowledge) | — |

### §9 Disabled Optimization Tests

| Technique | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| Run the full suite twice — optimizer on, optimizer off — diff results (§9) | Verifies optimizations never change correctness, only speed | Same technique as §7.5's meta-test; folded into **PG8** | **PROPOSE (new)** | See PG8 above. Conceptually the same shape as SQLancer's differential oracle (Q1) and interlinked's own **DESIGNED** Tier C #10 "Golden-trace differential replay — replay the last N recorded real inputs through both builds; diff outputs" (`local-gate-catalog.md`) — that entry already covers the *execution* side of PG8 once a config-matrix is detected to exist |

### §10 Checklists

| Technique | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| Human-verified ~200-item release checklist (§10) | *"It is important to have a human reviewing the test output at the highest level, and constantly asking 'Is this really right?'"* | Checklist **completion** (did every item get checked) is trackable; checklist **correctness** is definitionally a human-judgment call — SQLite's own text says so | **NOT ENFORCEABLE** — the technique's entire value proposition is a human asking a question no static analysis can answer for them. The closest interlinked analog in spirit (a pause-and-reflect moment, never a completion gate) is the Stop-event reflection family (`commit-cadence.ts`, `verification-stop-checks.ts`) — nudge-only, by design, for the same reason | — |

### §11 Static Analysis

| Technique | What SQLite does | Interlinked mapping | Verdict | Detection signal |
|---|---|---|---|---|
| Compiler warnings (`-Wall -Wextra`) + Clang Static Analyzer (§11) | Compiles warning-free on GCC/Clang/MSVC; SQLite's own verdict: *"Static analysis has not been helpful in finding bugs in SQLite... More bugs have been introduced into SQLite while trying to get it to compile without warnings than have been found by static analysis"* | **Shipped, and broader than SQLite's own setup.** The default `interlinked verify` gate already runs `typescript`, `biome_lint`/`eslint`, `cargo_check`/`cargo_clippy`, `go_build`/`golangci_lint`, `c_compile`/`clang_tidy`, `semgrep`, `gitleaks` — 12 language toolchains vs. SQLite's `-Wall -Wextra` + one analyzer | **SHIPPED** (broader) | `docs/generated/quality-checks.md` — full 33-check default/advisory split |

---

## Appendix C — detection-signal cheat sheet by language ecosystem

For the PROPOSE rows above, the concrete per-ecosystem file/invocation patterns a detector would key on:

| Ecosystem | Fuzz harness (PG3) | Fault-injection test (PG1/PG2) | Sanitizer CI (PG9) |
|---|---|---|---|
| Rust | `fuzz/Cargo.toml` + `fuzz_targets/*.rs` + `libfuzzer-sys` dep (cargo-fuzz); `#[test]` fns using `proptest`/`quickcheck` generators feeding a mock-failing allocator/IO trait | a test-only trait impl or `mockall`-style expectation returning `Err` on the Nth call, paired with a `try`/`?`-propagated call in source | `RUSTFLAGS=-Zsanitizer=address|thread|memory` in CI env, or `cargo miri test` invocation |
| C / C++ | a function matching `LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)` | a rigged allocator/VFS-equivalent function pointer substituted in a test-only build, or `errno`-forcing wrapper around a syscall | `-fsanitize=address,undefined`, `-fsanitize=thread` compiler flags in CI; `valgrind --` invocation |
| Go | `func Fuzz*(f *testing.F)` (native, Go ≥1.18) or a `go-fuzz`-tagged build | an injected `error` return via interface substitution in a table-driven test | `go test -race` in CI |
| Python | `import atheris` + `atheris.Fuzz(` | `unittest.mock.patch(..., side_effect=...)` / `monkeypatch.setattr(..., raising_stub)` | less common; `valgrind --tool=memcheck python` or `-X dev` in rare cases |
| JS / TS | `jazzer.js` / `jsfuzz` import (rare in this ecosystem) | `vi.spyOn(...).mockRejectedValueOnce(...)` / `.mockImplementationOnce(() => { throw ... })` (Vitest), `jest.spyOn` equivalent | not generally applicable (managed runtime; no memory-safety class to sanitize) |

Crash/kill-recovery (PG2) and coverage-ignore (PG7) signals are not language-specific enough to tabulate separately — see their Appendix B rows directly.
