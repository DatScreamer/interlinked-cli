# Rewriting Bun in Rust

- **Source:** https://bun.com/blog/bun-in-rust — Jarred Sumner, 2026-07-08
- **Encountered:** 2026-07-09, operator paste ("most information-dense post we could use to improve the harness")
- **Verdict:** compound — **PR** (5 detectors + test-integrity ratchet + cohort git discipline), **RFC** (generic sandbox job runner), **design amendment** (Tier 3 split-context), **reject** (nothing wholesale)
- **Implementation plan:** `docs/plans/14-bun-in-rust-harness-improvements.md`

## 1. Core idea (one sentence, my words)

Bun replaced 535,496 lines of Zig with Rust in 11 days by running ~64 Claude Code agents in 4 worktrees, choosing a language whose *compiler* turns their dominant bug classes (use-after-free, double-free, forgot-to-free-on-error-path) into build errors, and holding the port honest with an unchanged language-independent test suite plus split-context adversarial review.

## 2. Load-bearing claims

1. **"Compiler errors are a better feedback loop than a style guide."** The whole rewrite is an argument that enforcement must live in a mechanism the author cannot skip. This is our thesis, stated by someone who paid $165k to act on it.
2. **Earliest-possible feedback is the axis.** *"Fuzzing happens after code is merged. CI happens when code is pushed. Runtime safety checks & ASAN happen when code is run."* Every stability tool Bun had fired **after** the bytes landed. Bun's fix was to change languages; ours is to move the tools earlier — to `tool_input`.
3. **Split-context adversarial review.** 1 implementer : 2+ reviewers : 1 fixer. *"The Claude that wrote the code wants the code to get accepted. The Claude that reviews wants to find issues."* The reviewer's context is **only the diff** — never the implementer's reasoning — and it is told to assume the code is wrong. The implementer never reviews; the reviewer never implements.
4. **Fix the process, not the artifact.** Twice, Claude misbehaved at scale (stubbing out functions to make `cargo check` pass; writing long comments to excuse workarounds). Both times Jarred edited the *workflow prompt*, not the code. The rule he added is directly mechanizable: *"If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong — fix the code."*
5. **Invariants beat exhortation.** `0 tests skipped or deleted`, and he *manually verified the tests were in fact running and not being skipped* before merging. The test suite is written in TypeScript precisely so it is independent of the language under test — an oracle the rewrite cannot edit.
6. **Parallelism forces coordination rules.** At 64 agents, one ran `git stash`, another `git stash pop`, another `git reset --hard`. The fix was a hard rule: *never run `git stash` or `git reset` or any git command that doesn't commit a specific file at once. No `cargo` either. No slow commands.*
7. **The residual bugs are semantic, not syntactic.** 19 known regressions, *"most from code that's syntactically identical in both languages but semantically different."*

## 3. Deterministic or agentic?

**Hybrid, and the split is exactly our lane boundary.** The *enforcement primitives* — borrow checker, ASAN, LeakSanitizer, Miri, coverage-guided fuzzers, the test suite — are fully deterministic and produce `[proven]`-grade verdicts (they ran the code). The *loop* around them — implementer/reviewer/fixer — is agentic. Bun's contribution is not the LLM loop; it is the observation that the loop is only trustworthy because deterministic oracles backstop it.

License: prose blog post. Nothing to borrow as code. No license constraint.

## 3b. Role in its native architecture — and does it transfer?

| Element | Native role at Bun | Role it must take here |
|---|---|---|
| Rust compiler / borrow checker | the **boundary** | no analog — we cannot swap a user's language. Our boundary must be the PreToolUse gate. |
| ASAN / LSan / Miri / fuzzers | the **oracle** (deterministic, post-hoc) | same oracle, moved earlier: run against the proposed-edit overlay, not the merged tree. |
| Adversarial review | the **escalation** | Tier 3 — and it stays **warn-only**. |
| The TS test suite | the **anchor** (unchanged by the rewrite) | per-edit coverage + mutation, plus a *ratcheted* skip/delete water-line so the anchor can't drift. |

**The transplant hazard.** Adversarial review is safe-as-a-merge-gate at Bun because a million-assertion suite runs behind it. Transplanted into our stack it would sit at pre-push with no such backstop, and `feedback_reluctance_to_push` says local push-gating creates exactly the wrong pressure. So: adopt the *review contract* (split context, adversarial framing, implementer≠reviewer), reject the *gate strength* (unanimous-block). This matches `tier-3-async-deep-review.md` §13's existing warn-only stance.

## 4. Substrate vs. surface

N/A — prose source, no code to borrow.

## 5. Lane

**Lane 2 (detection technique)** primary — seven concrete detectors fall out of §2.4–2.7 and the four named regressions. **Lane 4 (pattern)** for the review contract. **Lane 5** for the sanitizer/fuzz execution tier.

## 6. Dependency & displacement

- **Deps:** none for the detectors. The execution tier is **invoke-as-subprocess** (`node --expose-gc`, `cargo miri test`, an existing fuzz target) — no runtime dependency. Executing *synthesized* property tests would require `fast-check`; avoid it by running the repo's own tests under instrumentation instead.
- **Displacement:** heavy, and mostly in our favor. `test-category-adoption-from-the-wild.md` §6's cost router **already assigns** *Sanitizers (ASan/TSan/Miri)* and *bounded fuzz-smoke* to PreToolUse-escalating-to-cloud. `harness-firefox-bug-class-checks-plan.md` **already designed** the Tier 3 `verify --dynamic` surface and its open questions. `src/harness/mutation/cloud-runner.ts` already ships the daemon-side mutation cloud client; the checked-in CLI repo does **not** contain a generic Sandbox Worker, so the right next step is a typed `SandboxJobRunner` contract plus a local overlay-runner spike, not pretending the server-side executor is done.
- **Equivalence (capability-by-capability):**

| Bun capability | Ours | Status |
|---|---|---|
| Deterministic gate that can't be skipped | PreToolUse block pipeline | **shipped** |
| Test suite as unchangeable oracle | `assertion_free_test`, `tautological_assertion` (pre_block); `disabled_test_delta` (commit-block) | **shipped, incomplete** — deletion only *warns*; no committed skip water-line |
| ASAN / LSan on every commit | — | **absent** |
| 24/7 coverage-guided parser fuzzing | `scaffold-fuzz.ts` emits property-test source as a *suggestion string*; never executes | **absent** |
| Sanitizers at edit time | `test-category-adoption-from-the-wild.md` §6 row | **designed** |
| Sandbox to run instrumented builds | daemon client exists at `src/harness/mutation/cloud-runner.ts`; server-side Worker/Sandbox executor is a separate workstream | **partial, mutation-specific client only** |
| Split-context adversarial review | `tier-3-async-deep-review.md` | **designed — and specifies the opposite** (see Notes) |
| Multi-agent git discipline | reservations + 16 git guard rules | **shipped, insufficient** (see Notes) |
| `unsafe` density + single-line-scope discipline | `rust_unsafe_blocks` (warn-only, existence not span) | **shipped, incomplete** |
| Compiler errors as a work queue | `verify --json` | **shipped** (no fan-out partitioner) |

## 7. Smallest spike (≤1 day)

**Prove a non-test command can run against the existing proposed-edit overlay inside the 25s budget.** The detectors in §8 have no viability risk — we know regexes work. The open question is whether the *shift-left execution* thesis survives contact with the budget.

`createCoverageOverlay(projectRoot, editedRelPath, proposedContent, extraFiles)` (`src/harness/coverage-overlay.ts`) already materializes a full shadow tree with `node_modules` symlinked, and `runOverlayAndDecide` (`evaluator/coverage-write-guard.ts`) already spawns a bounded command against `overlay.overlayRoot` with `timeoutMs: ctx.budgetMs`. `CoverageRunOpts.testCommand?: string[]` is already an arbitrary-argv override — only the *result contract* (`CoverageRunResult`) is coverage-shaped.

Spike: add a `run(argv, overlayRoot, budgetMs) → {exitCode, stdout, stderr}` runner beside `CoverageRunner`, and use it to run the affected tests under `node --expose-gc` with a heap-delta assertion (the JS analog of Bun's `Bun.build()` leak table). Measure p50/p99 wall-clock on this repo across ~20 real edits. **Success = the leak probe fits in budget on a scoped-test route.** If it doesn't fit locally, the answer is the Sandbox — and the spike output is the RFC for the generic job runner.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | 5 static detectors from the 4 regressions + §2.4's comment rule; escape-hatch **span** check; skip/delete water-line under `baseline_integrity_gate`; cohort-aware git discipline | §7 is the risky one; detectors are a separate, safe PR | **now** |
| Free CLI (P1) | Bounded leak-probe / boundary-value burst against the coverage overlay | §7 | next |
| Agent CI (P4–5) | Sanitizers (ASan/Miri), coverage-guided fuzz campaigns, split-context adversarial review — all in the Sandbox the mutation worker already uses | generalize `MutationRunner` → `SandboxJobRunner` (add a `job` field + Worker `exec` branch) | next |

## 9. Artifact

**Compound.**

- **PR 1 (detectors, no viability risk).** `assert_side_effect` (generalize the existing Rust check to C `assert()`/NDEBUG, Python `assert` under `-O`, JS `console.assert`); `unaligned_reinterpret`; `placeholder_constant`; `interpolated_then_parsed`; `escape_hatch_span`. Each ships ≥3 positive + ≥3 negative cases per house rules.
- **PR 2 (the oracle).** Promote `test_block_count_regression` from `warning` to `error`; add `.interlinked/skipped-tests-baseline.json` to `BASELINE_RE`; extend skip detection to `@pytest.mark.skip` / `#[ignore]` / `t.Skip()` and stub detection to `todo!()` / `unimplemented!()` / `raise NotImplementedError`. This is Bun's `0 tests skipped or deleted` made mechanical.
- **PR 3 (cohort discipline).** Populate the *already-shipped-but-unused* `GuardRule.applies_to_roles` / `active_when` machinery so that with >1 active cohort agent, plain `git stash` / `git rebase` / `git add -A` / `git commit -a` are blocked, and a **local** reservation conflict blocks rather than warns.
- **RFC.** `SandboxJobRunner` — generalize the mutation cloud contract to carry a `job` discriminant so ASAN / Miri / fuzz bursts ride the existing ChangeSet→Sandbox transport.
- **Design amendment.** `tier-3-async-deep-review.md`: strip the implementer's trajectory from the reviewer's context.
- **Reject / carve-out.** Reject unanimous-block pre-push at the Free-CLI surface (`feedback_reluctance_to_push`). Reject executing *synthesized* property tests on the edit path — run the repo's real tests under instrumentation instead (the `harness-firefox-bug-class-checks-plan.md` §Tier-3 side-effect-on-import argument still stands).

## Notes

**The two findings that make this post worth the intake.**

1. **Tier 3 is specified backwards.** `tier-3-async-deep-review.md` §4.3 / §6 / §12 deliberately feed the reviewer the implementer's session trajectory — its tool-call log, its BLOCKED/WARNED events, and a `did_session_follow_methodology` judgment. Bun's central review finding is that this is precisely the contamination to eliminate: *"its context: only the diff. told to assume the code is wrong."* Tier 3 is unbuilt, so this correction is free today and expensive later. (Note the irony: `multi-agent-pre-push-review.md`, a *different* unbuilt doc, gets it right by accident — its reviewers see only the unified diff.)

2. **Leasing does not exist for `apply_patch` — and `apply_patch` is Codex's edit primitive.** Multi-agent-on-one-tree is the normal state, not a problem; reservations are supposed to keep two agents off the same file at the same moment. They don't. `evaluateAutoReservation` (`evaluator/pre-tool-decision-phases.ts:148-150`) passes `apply_patch` through `isFileWrite`, then reads `tool_input.file_path ?? tool_input.path` — which an `apply_patch` payload never carries (`apply-patch-content.ts:58-66`) — and silently returns `null`. **No lease, no conflict, no warning.** The coverage gate two files away already recovers the paths via `extractApplyPatchRaw` + `parseApplyPatchSections` (`pre-tool-coverage-gates.ts:53`); the reservation gate never got that fallback. Verified live during this intake: a Claude and a Codex session both wrote *this file*, `reservation-events.jsonl` recorded four grants from one session and none from the other, and the lost update surfaced only via a modified-since-read check. Secondary: even when a lease *is* taken, a conflict blocks only a **remote** holder — two local agents both get a warning and both writes land. And Bun's stomping commands (`git stash`, `git stash pop`) plus `git add -A` / `git commit -a` / `git rebase` have no guard rule; of the three he names, only `git reset --hard` is blocked. See `docs/design/cohort-git-discipline.md`.

**The false-negative calibration.** **All four** porting regressions Bun actually shipped pass the harness **as committed at HEAD** (226 inline checks, 344 total):

| Bun regression | Verdict at HEAD |
|---|---|
| side effect in `debug_assert!` | **missed** — `git grep debug_assert HEAD -- src/` returns nothing |
| `cast_slice` on odd-length bytes | **missed** — no typed-array/alignment detector exists |
| `BSS_OVERFLOW_BLOCK_SIZE = 64` stand-in | **missed** — no magic-constant-with-temporary-comment check; `index_bounds_unchecked` is taint-only |
| `comptime` format string | **missed** — sinks are enumerated (SQL/shell/eval/logger); no generic template-literal→parser check, not even `new RegExp(\`${x}\`)` |

*Working-tree caveat, 2026-07-09.* A parallel agent session landed `ubs_rust_debug_assert_side_effect` (`checks/ubs-language-specific/rust-go-checks.ts`, `.rs`-only, advisory — its v1 keys on mutating-looking verb names and `?`) **in response to this same post**, uncommitted, bumping the inline count 226 → 227. Row 1 therefore reads "caught" against the working tree and "missed" against HEAD. Treat that detector as the **base to generalize** (§9 PR 1), not as prior art. Re-derive this table against HEAD, never the tree — two drafts of this doc already got it wrong, each because an audit read a tree a concurrent agent was mutating. That is itself the §2.6 coordination lesson, observed from the inside.

Real bugs from a real port are a better FP/FN corpus than synthetic fixtures. Worth keeping as a permanent eval fixture set. Four-for-four is the strongest single argument here: these detectors are not speculative taste, they are the checks that would have caught the bugs a very good team shipped anyway.

**Corroborations, not novelties.** "Fix the process that generates the code" is `feedback_dogfood_harness_from_errors`. "Compiler errors > style guide" is the harness's founding premise. Shift-left sanitizers is `test-category-adoption-from-the-wild.md` §6. The post's value is that it *paid* for these positions at scale, and supplies the tactical detail (split context; the paragraph-comment rule; the git-command allowlist) our docs left abstract.

**One check we cannot cleanly ship: `justification_comment_smell`.** "If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong" is the most quotable rule in the post and the hardest to mechanize without false positives — Rust's `// SAFETY:` comments are *mandatory* (clippy::undocumented_unsafe_blocks) and our own `rust_unsafe_blocks` uses them as its exemption. A long comment adjacent to an escape hatch is required in one language and a smell in another. If built at all: advisory, non-Rust, and keyed on justification markers ("this is safe because", "workaround", "we can't") rather than length alone.

## Methodology notes

The determinism filter did real work here and produced a *third* answer beyond deterministic/agentic. Bun's oracles are deterministic **and** heavy — 24/7 fuzzing, instrumented builds. INTAKE.md §"dominant filter" already anticipates this ("heavy *deterministic* work can still route to a cloud surface"), and this find is the clearest instance yet: the reason sanitizers can't run on the edit path is neither determinism nor cost-per-run but **cold instrumented rebuild time**, a third constraint. Worth naming in the rubric if it recurs.
