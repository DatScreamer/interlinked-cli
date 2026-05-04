# Ryan Lopopolo — body of work

- **Source (load-bearing):** OpenAI's "Harness Engineering" essay https://openai.com/index/harness-engineering/ (2026-02-11) • blog https://hyperbo.la/ (33 posts, most-relevant: `harness-engineering-the-blog-build`, `code-is-not-the-artifact`, `production-function-changed`, `lazy-prompt-rustsec`, `codex-copypasta`, `robot-vacuum-canary-tailscale`, `synthesis`, `service-mesh`) • Latent Space podcast (Apr 2026, full transcript) https://www.latent.space/p/harness-eng • AIE Europe 2026 keynote (no transcript captured) • @artichoke organization (Rust, ~30 crates, MIT) https://github.com/artichoke • personal repos https://github.com/lopopolo (7) • secondary identity https://github.com/lopopolo-openai.
- **Encountered:** 2026-05-03, user request: "Read all of the works of Ryan Lopopolo to look for opportunities to improve our Interlinked CLI harness system."
- **Verdict:** lane 4 primary (his thesis names the field we're working in) + significant lane 2 (7 concrete check additions) + lane 3 (4 portable Artichoke patterns) + lane 5 (Symphony-shaped cloud features). Half-day spike below; ~3 same-rail follow-ups; one RFC.

## 1. Core idea (one sentence, your words)

"Harness engineering" — Lopopolo's coined-and-now-public-facing term, validated at 1M LOC / 0 human-written code at OpenAI — treats the deterministic scaffold around a coding agent (custom lints, structural tests, AGENTS.md table-of-contents pointing at sharded `docs/`, scoped tool surfaces, mechanical invariant enforcement, per-worktree isolation, repo-as-system-of-record) as **the load-bearing artifact**, with the LLM downstream of it; the production function for "encode this rule as a check" collapsed when migration cost went to zero, so the right move is to encode-everything-as-check, label findings as proven-vs-heuristic, inject remediation into agent context at point of failure, and run a recurring "garbage-collect AI slop" loop.

## 2. Anatomy (load-bearing claims, your words)

Mixed prose + code corpus. The claims that survive across the OpenAI essay, the blog, the podcast, and the Artichoke crates:

1. **The harness, not the model, is the artifact.** *"Codex by itself is not a coding agent; it is another execution layer of a fully functioning large language model… Codex is the harness: the thing that wires tools, sandboxes, repos, and permissions together."* (`codex-copypasta`) Reinforces `feedback_harness_deterministic_only.md` from a different vantage point — the discipline name is now externally credentialed.
2. **Agent legibility is the binding constraint.** *"From the agent's point of view, anything it can't access in-context while running effectively doesn't exist."* (OpenAI essay) Drives the AGENTS.md-as-table-of-contents pattern (88-files-sharded-per-subsystem in their case) and the policy that *every block reason ships with a remediation snippet* injected into the agent's next turn.
3. **Production function shift: encoding a rule used to be expensive, now it's free.** *"Turn on no-await-in-loop in a human-written codebase and you just bought yourself a migration project. In an agentic codebase, it is one PR: enable the rule, fix 600 violations, land exhaustive positive and negative tests, and move on."* (`production-function-changed`) Aligns directly with `feedback_taste_enforcement.md` — both refuse to grandfather bad code via FP filtering.
4. **Mechanical enforcement over narration; conventions rot unless executable.** *"These constraints are enforced mechanically via custom linters and structural tests."* (OpenAI) *"Conventions rot unless they are executable. Code is free!"* (`harness-engineering-the-blog-build`) The harness's job is to take the most-rotted convention and turn it into a check.
5. **Suppressions require justification, not just permission.** Custom rule `hyperbola/require-eslint-disable-justification`: every disable must be followed by a reason string. (`harness-engineering-the-blog-build`) Closes the most common AI escape hatch: silent bypass of safety with no audit trail.
6. **Proof-of-work over patches.** *"I care much less about watching code appear on screen and much more about proof. Record a video. Give me screenshots. Show me the logs."* (`production-function-changed`) *"Forbid speculative bug reports. 'This looks suspicious' is not enough."* (`lazy-prompt-rustsec`) Findings should be labeled *proven* (compiler/type-check failed) vs *heuristic* (pattern-matched) so the agent knows which to escalate vs which to dismiss with justification.
7. **Slop accumulates by replication; garbage-collect on a schedule.** *"Codex replicates patterns that already exist in the repository — even uneven or suboptimal ones. Over time, this inevitably leads to drift."* (OpenAI) Plus a recurring "doc-gardening" agent that scans for stale documentation and opens fix-up PRs. The harness today catches new bad patterns at edit time but does not actively scan for *existing* replicated bad patterns to promote into rules.
8. **Layered domain architecture mechanically validated.** *"Each business domain is divided into a fixed set of layers, with strictly validated dependency directions and a limited set of permissible edges."* (OpenAI) Quoted layer order: Types → Config → Repo → Service → Runtime → UI; CI lints dependencies directionally. Single declared `Providers` interface for cross-cutting concerns.
9. **Rollback guard for transactional multi-structure updates.** `intaglio/src/rollback.rs` defines `VecEntryRollbackGuard` (Armed/Defused, panic-safe) so a hash-collision panic between `vec.push` and `map.insert` cannot leave `vec.len() != map.len()`. Filed as RUSTSEC-2026-0078 + ripgrep PR #3344 (same bug class). Bug class statement: panic between two related state mutations + `catch_unwind` resumes against inconsistent structure. Direct analog for our `reservations.ts`'s local-grant + server-confirm split (see §5 Lane 3).
10. **Anti-pattern: monolithic instruction documents rot instantly.** *"When everything is 'important,' nothing is. Agents end up pattern-matching locally instead of navigating intentionally… A monolithic manual turns into a graveyard of stale rules."* (OpenAI) AGENTS.md should be ~100 lines of pointers, not the manual itself.

## 3. Deterministic or agentic?

**Lopopolo's entire thesis is determinism.** No LLM-as-judge in the harness; the agent runs *under* the harness, the harness runs mechanical checks, results are injected back into the agent's context. Aligns to the floor with `feedback_harness_deterministic_only.md`. License: MIT across all Artichoke crates + personal repos. No gates.

The Symphony orchestrator (OpenAI internal, not public) is a different beast — recurring agentic background tasks (doc-gardening, log-walking) that *use* LLMs but operate at a different layer than the per-edit harness. Lane 5 fodder, not lane 3.

## 4. Substrate vs. surface

- **Surface — prose:** the harness-engineering thesis itself; named, externally credentialed; reframes a discipline interlinked already practices.
- **Substrate — code (Artichoke ecosystem, ~30 MIT-licensed Rust crates):** four directly portable patterns —
  (a) **Rollback guard** (`intaglio/src/rollback.rs`) — RAII for transactional multi-step state mutations under panic. TS analog uses TS 5.2 `using` + `Symbol.dispose`. Direct fit for `reservations.ts` and `error-history.ts` writes.
  (b) **Compile-time assertion crate** (`qed`) — `const_assert!`, `const_assert_size_eq!`, `lossless_cast_u32_to_usize!`. TS analog: `type _ = AssertEq<Foo, Bar>` at module top whenever a check's correctness depends on a width/slot count.
  (c) **Standardized lint preamble** — every `lib.rs` opens with the same 14-line `#![warn(…)]` block. TS analog: an `// @interlinked-pedantic` snippet at file head making opt-in policy *visible at the file boundary*.
  (d) **`BuildHasher`-agnostic API** — `intaglio` is generic over hasher, both how the unwind bug got introduced *and* how the integration test caught it. TS analog: parameterize our trigram-index hasher; pick one default; test under multiple in `__tests__/`.

Substrate code is Rust — pattern-borrow only, not direct port. The lane-2 check additions (§5) borrow ideas-as-detectors, not lines.

## 5. Lane

Multi-lane: 4 primary (thesis), 2 (concrete checks), 3 (Artichoke patterns), 5 (cloud fodder). Listed by adoption-readiness.

### Lane 4 — patterns

1. **Naming convergence is now load-bearing.** Cursor used "harness" in our exact sense; Lopopolo coined "harness engineering" as the discipline. Stop calling it internal jargon. The discipline is publicly contested terrain — interlinked is one of three named players (Cursor, OpenAI/Symphony, interlinked).
2. **Cluster bookkeeping — fifth deterministic-harness affirmation in this directory.** codewiki (counterexample), agent-ci, serena, cursor-harness, lopopolo. The thesis is no longer memory-note-worthy; it's the canonical position of the project. Lopopolo is reinforcement, not threshold-crossing — the RFC moment passed at serena.
3. **Code-is-not-the-artifact framing.** *"Once agents write most of the code, stop treating the source files as the artifact. The durable thing is everything upstream of them: the repo-owned spec, the guardrails, the typed boundaries, and the operator surface that determines what code is allowed to exist."* (`code-is-not-the-artifact`) Pin as a memory entry; load-bearing for any future "what is interlinked actually for" framing question.
4. **Production-function shift consonant with `feedback_taste_enforcement.md`.** Both refuse to grandfather bad code via FP filtering. Worth pinning the quote for drift-resistance.

### Lane 2 — concrete check additions (each ½ day except where noted)

| # | Check | Source | Where |
|---|-------|--------|-------|
| 1 | **Suppression justification required** — reject `// interlinked-disable next-line <rule>` without `: <reason>` | `harness-engineering-the-blog-build` | `src/harness/suppressions.ts` |
| 2 | **Remediation snippet on every block reason** — extend rule/check schema; plumb through evaluator output | OpenAI essay | `src/harness/rules-loader.ts`, `evaluator.ts` |
| 3 | **No-coverage-ignore-pragma ratchet** — flag `/* istanbul ignore */`, `c8 ignore`, `// @nocoverage`, `pragma: no cover`; ratchet on count (mirrors `non_null_assertion_ratchet`) | `harness-engineering-the-blog-build` | `src/harness/generic-checks.ts` + registry |
| 4 | **Proven-vs-heuristic label on findings** — every output tagged `proven` (compiler/type-checker failed) or `heuristic` (pattern-matched) | `lazy-prompt-rustsec` | `src/harness/check-metadata.ts` + formatter |
| 5 | **Synthesis formatter** — group by file, rank by severity × confidence, surface top 3 actionable instead of dumping all | `synthesis` | `src/harness/quality-checks.ts` formatter; uses existing `suggestion-scorer.ts` |
| 6 | **Banned-patterns project config** (>½ day, RFC scope) | `harness-engineering-the-blog-build` | `src/harness/structure/structure-checks.ts` |
| 7 | **Layered-architecture validator** with explicit per-project layer manifest (>½ day, RFC scope) | OpenAI essay | `src/harness/project-graph.ts` + `structure/rules/` |

Items 1-5 are immediately actionable. Items 6-7 are RFC-scope.

### Lane 3 — Artichoke substrate borrows (TS-portable patterns)

- **Rollback guard for `reservations.ts`** — TS 5.2 `using` + `Symbol.dispose` lets a local-grant fail safely if the async server-confirm rejects. Direct port of `intaglio/src/rollback.rs::VecEntryRollbackGuard`. **This overlaps directly with the bitar-decider.md spike** (cf. that file) — both intakes converge on "fix the reservation state machine"; Bitar from the single-source-of-truth angle, Lopopolo from the panic-safety RAII angle. Land them together.
- **Compile-time `AssertEq` types** at module top wherever a check's correctness depends on a width/slot count.
- **Standardized `// @interlinked-pedantic` preamble** at file head.
- **BuildHasher-parameterized trigram-index** so we can swap `xxhash3` vs `fnv1a` and benchmark.

### Lane 5 — cloud fodder

- **Doc-gardening agent** as managed feature — recurring background scan for stale `docs/`, opens fix-up PRs. Direct analog to `project_supervisor_pattern.md`'s Workspace DO scale, applied to docs maintenance. (`agency-cloud`)
- **Promote-warning-to-block-on-recurrence** based on cross-customer telemetry — when a warning fires N times across the population on the same agent-source, escalate next instance to a block. Needs cross-tenant aggregation only the server has. (`guardrails-cloud`)
- **Per-worktree isolated observability stack** — every agent task boots its own Vector / Victoria Logs / Victoria Metrics namespace. (`agency-cloud`)
- **Layered telemetry that follows the layered-architecture validator** — each layer has its own log/metric channel, not a flat firehose. (`agency-cloud`)

### Disagreements to record

**None.** Lopopolo aligns with `feedback_harness_deterministic_only.md`, `feedback_taste_enforcement.md`, `feedback_safety_continuity.md`, `project_supervisor_pattern.md`. Cursor's blog had one (knock-down-static-guardrails); Lopopolo has the opposite stance, reinforcing ours. No drift-resistance work needed.

## 6. Smallest spike

**Remediation field on every rule + check, plumbed through evaluator output — half a day.**

Why this single change among the ½-day candidates (#1, #2, #3, #4, #5):
- Cross-cutting: improves *every existing rule's* value, not one rule's.
- Directly implements Lopopolo's prescription: *"we write the error messages to inject remediation instructions into agent context."*
- Tests the harness-engineering thesis at the layer where it pays out: agent's next turn.
- If agents demonstrably ignore the remediation hints (low cite-rate in subsequent edits), we learn fast.

Spike steps:
1. Extend `RuleSchema` in `src/harness/rules-loader.ts` with optional `remediation: string` field; same in `CheckRegistration` (`check-registry/types.ts`).
2. Backfill the existing 77 guard rules + 18 quality checks + 22 structural checks + 50 generic checks with one-sentence remediations. Stub-acceptable: empty for now, fill the top-20-most-fired in this PR per the existing `error-history.ts` ranking.
3. Update `evaluator.ts` so `{decision: "block", reason}` becomes `{decision: "block", reason, remediation?}`; ditto warnings.
4. Update the hook script (`.interlinked/hooks/interlinked-activity.mjs`) to render `reason\n\nDo this instead: <remediation>` when `remediation` is present.
5. Add a doc-fresh check: `npm run docs` regenerates `docs/generated/guard-rules.md` to include remediations alongside descriptions.
6. Tests: extend `evaluator.test.ts` and `check-pipeline-parity.test.ts` to assert remediation field is preserved end-to-end.

Same-rail follow-ups (each ~½ day):
- **A:** Suppression justification required (Lane 2 #1) — closes the bypass hatch the new richer messages might tempt.
- **B:** Coverage-pragma ratchet (Lane 2 #3) — ride the existing `non_null_assertion_ratchet` rails.
- **C:** Synthesis formatter (Lane 2 #5) — once findings carry remediations, the format-as-table / top-3 grouping pays compounding interest.
- **D:** Rollback guard for `reservations.ts` (Lane 3) — land *together* with the bitar-decider.md reservation spike.

If the primary spike fails (e.g. backfilling remediations is harder than expected, or the schema change ripples wider than ½ day), record and either reduce scope to the top-5 most-fired rules or escalate to a multi-day refactor.

## 7. Artifact

Memory note (this file) + half-day primary spike + 3-4 same-rail follow-ups when prioritized + RFC for "the multi-tier promotion model" (warning → block based on recurrence count, requires telemetry that only `guardrails-cloud` has at scale; CLI-side prototype is a per-session counter in `session-state.ts`). Lane-5 entries (doc-gardening, per-worktree observability, layered telemetry) file in the sibling server repo's `docs/design/` per `reference_sibling_server_repo.md`.

## 8. Surface

- **interlinked-cli** — Lane 2 checks #1-5; Lane 3 substrate borrows including the joint reservation refactor with bitar-decider.md.
- **guardrails-cloud** — promote-warning-to-block-on-recurrence (cross-tenant telemetry), satisfaction signals (cf. cursor-harness.md cluster), doc-gardening as a managed background agent.
- **agency-cloud** — per-worktree isolated observability, layered telemetry channels, "code is not the artifact" framing for any future agent-orchestration UX.

## Notes

- **Quotes worth pinning for drift-resistance.**
  - *"Codex is the harness, not the model."* — independent affirmation that the model-vs-harness boundary is load-bearing terminology, not interlinked jargon.
  - *"Conventions rot unless they are executable. Code is free."* — directly consonant with `feedback_taste_enforcement.md`; the rationale for refusing to grandfather bad code via FP filtering.
  - *"From the agent's point of view, anything it can't access in-context while running effectively doesn't exist."* — pin for any future "should the harness inject X into the agent" design call.
  - *"Forbid speculative bug reports. 'This looks suspicious' is not enough."* — pin against the temptation to add LLM-classifier-flavored heuristic checks (the proven-vs-heuristic label is the discipline).
  - *"When everything is 'important,' nothing is."* — pin against monolithic CLAUDE.md / AGENTS.md growth; argues for table-of-contents structure with sharded depth in `docs/`.
- **Cluster bookkeeping (5th deterministic-harness affirmation).** codewiki (lane-5 counterexample), agent-ci, serena, cursor-harness, lopopolo. The thesis is canonical now; per the serena RFC-trigger, no new threshold crossing.
- **Joint spike with bitar-decider.md.** Both intakes converge on the reservation state machine. Land the rollback guard (Lopopolo) and the single-source-of-truth derivation (Bitar) together — they are complementary primitives on the same surface.
- **Symphony (OpenAI's internal harness orchestrator) is partially documented in the Latent Space transcript.** Worth a deeper read if the cloud roadmap picks up the doc-gardening / log-walking patterns. Not borrowable as code; pattern-only.
- **AIE Europe keynote videos lack accessible transcripts.** Two YouTube URLs (`am_oeAoUhew`, `CeOXx-XTYek`) — likely overlapping content. If a specific quote becomes load-bearing later, watch one manually rather than digging for transcripts.
- **Active GitHub signal: 30+ `[codex]` PRs across his Rust crates in the last 6 weeks** — he is using OpenAI Codex CLI on production Rust including for security audits (the ripgrep PR was Codex-driven). This is our exact target user; tracking his PR style is a free harness-product-research input.
- **Lopopolo-coined production-function-changed framing is the single most useful lens.** The CLAUDE.md note that "demotion to advisory should be a last resort" is the same insight from the other direction: encode the rule properly, fix all violations in one pass, don't grandfather.

## Methodology notes

- **Person-as-source rubric bend.** "One project, one file" was the rubric's design. A person's body of work spanning blog + code + talks + employer-essay doesn't fit cleanly. The compromise: one intake per *coherent body of work*, with the §5 lane analysis carrying multi-lane breakdown rather than splitting across files. Keeps the pattern-cluster bookkeeping intact and avoids 4 files for one intellectually-coherent corpus. Possible INTAKE.md edit: *"For a person's body of work or a multi-artifact corpus, treat the intellectually-coherent unit as one intake. Multi-lane breakdown in §5 absorbs the dimensional spread."*
- **Mixed-source format.** Sections 3 and 4 don't fully collapse (he ships both prose and code), so the rubric carries both — but neither dominates. Worked.
- **Three parallel research agents (blog, GitHub, external mentions) was the right deployment shape** for a corpus of this size. Sequential reads of 33 blog posts + 30 crates + Latent Space transcript + 4 conference recaps would have blown context budget. Total agent time: ~30 minutes wall-clock; total token throughput across the three: ~345k. Pattern worth reusing for any future "evaluate this person/team's body of work" intake.
- **Verify-against-codebase per `feedback_verify_against_codebase.md`** — confirmed before citing: `check-registry/builders.ts` exists, `check-pipeline-parity.test.ts` exists, `reservations.ts` is a 3-party state machine with `ServerApiClient` async-confirm, fast-check is *not* a current dep, suppressions.ts exists. The "promote-warning-to-block-on-recurrence" claim leans on `error-history.ts` + `session-state.ts` per CLAUDE.md but I did not directly read them — flag as verify-before-spiking on the RFC.
