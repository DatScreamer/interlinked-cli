# Quality frontier — 2026-07 research synthesis

## Shipped from this synthesis (2026-07-06 campaign)

One-day multi-agent campaign (~25 agents; the last Fable-5 day). Everything
below landed in the working tree, full suite green (19,900+ tests, +~500 new):

- **Red debt** (`red_suite` obligation kind): the red-bar folds into a
  dischargeable pair-scoped debt — the red→green loop is legal progress;
  6 review bugs fixed; `interlinked debt list/show/resolve` CLI shipped.
- **9 new checks**: `unawaited_async_assertion` (pre_block),
  `jsdoc_param_drift`, `json_stringify_error`, `catch_rewrap_loses_cause`,
  `resource_handle_leak`, `numeric_sort_without_comparator`,
  `implicit_switch_fallthrough`, `contradictory_nullness_chain`,
  `timeout_unit_mismatch`; + `test_timeout_inflation` (9th behavioral,
  commit-gate diff check). Inline family 217→226, total 334→344.
- **~12 FP fixes** across software_version_regression (cross-block),
  private_member_test_access, ubs_division_by_variable (dominating guards),
  agent_thumbprint residuals, unvalidated_json_sibling fan-out,
  silent_demo_fallback, test_nondeterminism (antidote/purpose-aware),
  sync_io_on_hot_path, fetch-adapter, endpoint-family-on-fixtures,
  persistent_warning_escalation (no longer amplifies advisory/heuristic ids),
  TEST_FILE_RE `test.ts`, unjustified_cast on markdown.
- **Portability** (external-repo assessment): `repo-profile.ts` detection
  (runners + test layout, fail-toward-enforcement), layout-aware
  TDD-new-file gate (demotes to warn on no-test repos), suite green-baseline
  + new-failures-only commit red-bar, once-per-session runner-absent notice
  (killed a measured 70.6% noise ratio), DEFAULT-OFF doc-drift fixed.
- **`interlinked adopt`** (+ `--suite-baseline`): one-command
  ratchet-from-here bootstrap of all six water-lines + trigram index +
  doctor integration.
- **Metaharness**: `interlinked harness health` (repeat-rate + probation
  candidates from 43k recurrence rows — the demote direction now exists);
  Stop-event whole-suite red/green tracking + WIP-commit nudge; trajectory
  Family 9 (read/edit balance) + Family 3 (obligation inventory) wired.
- **Guard fix from live dogfood**: bash-write guard root-confined — only
  in-repo targets are "tracked source files" (scratchpad//tmp FP killed).
- **`interlinked reload`**: one-command dogfood loop replacing
  `npm run build && interlinked enable && interlinked harness restart` —
  locates the CLI's own checkout from any cwd (the old chain built the WRONG
  project outside it), rebuilds, refreshes hooks, restarts the daemon, and
  reports DELTAS (dist content hash before→after, hook-script hash, restart
  decision). v1 limitation: the build delta is per-run, not daemon-aware —
  after an out-of-band build, use `--force` (v2: daemon stamps its build hash
  at startup so reload can compare against the RUNNING build).

### Field-report fixes (2026-07-06, foreign-repo agent report)

- **console.log-is-the-output FP**: CLI entrypoints (shebang first line,
  nearest package.json `bin` target, `scripts/`/`bin/` path segment) are now
  exempt from the console debug-logging warnings — shared predicate
  `isCliEntrypoint` in `checks/language-agnostic.ts`, consumed by both
  `checkConsoleDebug` (`console_statements`, PostToolUse + verify) and the
  write-guard content-quality console heuristic.
- **Floating-promise FP on caller-handled chains**: the A4 content-quality
  heuristic is chain-aware across lines — a statement-position call whose own
  chain carries `.catch(`/`.finally(` on a continuation line (the
  `main()\n  .catch(...)` entrypoint shape) no longer fires; bare unhandled
  calls still do.
- **Comment-only growth on over-cap files**: the PreToolUse line-cap gate
  allows an edit whose net added lines are entirely comment/blank
  (`countCodeLines` in `large-file-policy.ts`, string-aware); code growth and
  mixed edits still block, and grandfather ceilings keep tracking RAW lines —
  never raised by the allowance.
- **Accepted but larger (design only, not built)**: demote biome
  `noUnusedImports` to a session-scoped obligation — the import-then-use
  deadlock — as the first concrete instance of the general open-obligation
  ledger described below.

### Cross-repo calibration results (2026-07-06 evening; 5 repos: zod, ky, date-fns, tinybench, +1)

Scan phase complete; judge phase partially rate-limited — remainder judged
inline from salvaged samples. Decisions:

- **Placements CONFIRMED**: `unawaited_async_assertion` — zero fires on all
  foreign code, pre_block zero-FP claim holds. `timeout_unit_mismatch`,
  `numeric_sort_without_comparator`, `json_stringify_error`,
  `catch_rewrap_loses_cause` — zero fires, default-gate stands.
- **Star of the wave**: `jsdoc_param_drift` — 8 fires (7 date-fns + 1 zod),
  judged 6 TP / 0 FP ("all real": `@param format` vs `formatStr` drift in
  date-fns' public API). Default confirmed; the catches-the-class-anywhere
  proof for this wave.
- **Fixed same-day**: `implicit_switch_fallthrough`'s single foreign fire was
  the pre-documented nested-terminating-switch FP — `switchTerminates`
  reachability added + 3 regression tests (the author's own contingency,
  triggered by exactly this calibration).
- **Advisory trio stays advisory**: `contradictory_nullness_chain`,
  `resource_handle_leak`, `readme_script_drift` — zero fires (zero noise, but
  zero measured precision; graduation needs positive samples from repos that
  exhibit the patterns).
- **FP-fix regressions HOLD**: software_version_regression, agent_thumbprint,
  sync_io_on_hot_path, unvalidated_json_sibling, silent_demo_fallback,
  endpoint-family — all silent on foreign code.
- **Correctly-advisory noise, refinement backlog**: `ubs_division_by_variable`
  judged 0 TP / 12 FP on shapes beyond the morning fix (imported nonzero unit
  constants like `millisecondsInMinute`, Welford `d / i` post-increment,
  `x === 0 ?` ternary guards) — next: named-nonzero-constant + ternary-guard
  recognition. `test_nondeterminism` 2 TP / 4 FP (Date.now-as-the-SUT, mocker
  helpers) — next: SUT-is-time exemption. `private_member_test_access` 7 zod
  fires (workflow judge died; inline read: public members accessed through
  casts are FPs, `__`-prefixed custom globals are convention-private) — next:
  public-member-through-cast exemption.

**Direction distilled from operator feedback (2026-07-06)**: make it EASY to
write the highest-quality code while still enforcing it. The next structural
step is the **general open-obligation ledger** — deferrable per-edit findings
with commit/Stop deadlines over the now-kind-generic `obligations.ts` engine —
replacing "every tool-use must be atomic" with session-scoped transients that
must reconcile at milestones (the red/coverage-debt semantics, generalized to
every deterministic finding).

Five-lane web-research sweep (2026-07-06) distilling the state of the art in
general code-quality enforcement into harness-liftable items. Each item is
deterministic (regex/AST/graph/metric — no LLM in the check path, per
`feedback_harness_deterministic_only`), general-quality (security/supply-chain
excluded by scope), and judged against both the harness's ~334 existing check
ids and the tools already wrapped (tsc/biome/oxlint/ruff…). Companion recon of
this repo's own surface (same day, 9-lane gap-scan) grounded the dedupe.

Lanes: (1) empirical LLM-defect taxonomies, (2) linter frontier, (3) test
quality, (4) agent-harness competitor scan, (5) ratchets/adoption at scale.

## Headline evidence (lane 1 — why these classes matter)

- Tambon et al., EMSE 2025 (333 bugs): Misinterpretation 20.8%, Missing
  Corner Case 15.3%, Hallucinated Object ~10–12%, Wrong Attribute ~6–8%.
  The top two are NOT statically checkable — coverage + mutation ratchets
  (already shipped here) are the validated lever; treat that as the
  justification record for the mutation-gate investment.
- "Debt Behind the AI Boom" (484,606 issues in 304,362 AI-authored commits):
  89.1% code smells; broad exception handling is the single most frequent
  pattern (8.6%); 24.2% of AI-introduced issues are never remediated.
- GitClear longitudinal (623M changed lines, 2023–2026): block duplication
  +81%, within-commit copy/paste 9.4%→15.7%, error-masking constructs +47%,
  refactoring moves −70%, cross-file calls −35%.
- Reward-hacking corpora (SpecBench; TRACE's 54 hack categories; RHB:
  exploit rate 0.6%→13.9% after RL post-training): test gaming is universal
  at task-complexity scale; the mechanic fingerprints (hardcoded fixtures,
  harness edits, assertion deletion) are edit- or trajectory-observable.
- Trajectory studies (arXiv 2511.00197; SWE-EVO): failing agent runs are
  distinguishable by deterministic signals — action loops, same-region
  re-edits, skipped/ignored verification. Independently validates the
  0.5–1.0 verify-per-edit floor in CLAUDE.md's best-model profile.

## Next backlog (not built 2026-07-06; ranked within tier)

### Tier A — highest value, clear design

| Item | Surface | Effort | Notes / source |
|---|---|---|---|
| Per-(file,check) count water-line for ALL check ids (TSV, merge-conflict-free, auto-tighten-on-contact, lock-at-zero) | post + pre-gate + ratchet + CLI | L | THE legacy-adoption lever. ESLint bulk-suppressions, Notion/eslint-seatbelt, TikTok 70k-suppression precedent. Extends `interlinked adopt`. |
| Blame-window "new code" definition (SonarQube Clean-as-You-Code) | post + verify + config | M | `new_code: {mode: reference_branch\|days\|since_baseline}`; per-line git-blame classification, cached. Lets advisory heuristics gate hard on new lines only. |
| Error-masking-construct ratchet (empty/log-only catch, silent fallback default) | post + ratchet | M | #1 AI-introduced issue in the wild (8.6%). Zero-FP shapes default-gate; log-only advisory; per-file count ratchet like non_null_assertion. |
| Dropped-defensive-logic delta gate (edit removes guards from an existing function) | pre-gate | M | Reuses the before/after AST parse the cyclomatic slew gate already pays (complexity-pulse stash). Genuinely new — per-edit file-trajectory analysis, invisible to linters. |
| Test-weakening-after-failure trajectory rule (red run → assertion-count/matcher-strength drop on the failing spec → green) | trajectory | M | The sequence form of test gaming; red-debt ledger (landed 2026-07) supplies the red signal. Commit-diff assertion-weakening check exists; this is the in-session version. |
| Per-edit extreme-mutation strategy (Descartes method-level mutants on touched functions + sampled statement mutants, Stryker incremental format) | mutation gate | L | The concrete path to per-edit mutation under budget_ms: ~9× fewer mutants, 5–20% samples retain ~93% score accuracy, affected-test subset via project graph. |
| Hallucinated-API existence check via installed-library introspection (Python / plain-JS) | post | L | 100% precision / 87.6% recall published for the class; TS already covered by tsc. Cache per-package symbol tables like the trigram index. Marquee `hallucinated_api` from the agent-era memo. |
| Per-edit duplication-introduction gate (trigram-index-backed, jscpd-class) | post + Stop metric | L | GitClear +81% duplication. The dirty layer already makes same-session writes searchable. Advisory "duplicates X:L10–40 — extract or import". |

### Tier B — high value, moderate design

| Item | Surface | Effort | Notes |
|---|---|---|---|
| Check-health v2: per-check fix-rate (flagged content changed before session end) joined with dismiss-rate | trajectory capture + CLI | M | v1 (log-derived repeat-rate + probation table) ships 2026-07-06. v2 needs (check_id, file, line-hash) fix tracking at post-tool time. Tricorder/Meta governance precedent: <10% effective-FP bar, probation, demotion. |
| Promotion-ladder CLI with clean-first precondition (`checks promote <id>` refuses pre_block until recurrence scan is clean or grandfathered) | CLI + ratchet | M | Tricorder's compiler-check admission rule, machine-enforced. |
| Stale-entry pruning for every baseline/grandfather file (+ Betterer-style `goal` field, auto-graduation at goal) | verify + SessionStart + Stop | S | Dead entries are latent slack an agent can grow back into. Direction-legal auto-tighten. |
| Flaky-primitive gate: nondeterminism source in test without its antidote (fake timers/seed/msw) | post | M | Partially covered by test_nondeterminism after 2026-07-06 antidote-awareness fix; full pairing check (network/order-dependence) remains. |
| Static polluter detection (test writes shared state — env/global/module-top-level — without afterEach restore) | post | M | iDFlakies: order-dependence is the #1 flaky root cause; shared module state dominates in JS. |
| Rotten-green-test check (assertions only inside conditionals/loops with no expect.assertions escape hatch) | post | M | ICSE 2019: worse than assertion-free; reachability upgrade to the existing pre_blocks. |
| Test-smell counters with published thresholds (Assertion Roulette 3/5/10, Eager Test 4/7/39, magic-number-in-expect) | post + ratchet | M | Agent-written tests skew 93–99% Assertion Roulette, 85–100% Magic Number (arXiv 2410.10628). |
| Test-fixture special-casing detector (prod conditional hardcodes a literal that appears in session's test files, after a failing run) | trajectory + post | M | The prod-side reward-hack; complements test-side guards. |
| Nesting-depth + total-param-count ratchets in the complexity guard | pre-gate | M | Same AST walk, same slew/cap semantics. |
| tsgolint (oxlint type-aware alpha) as budget-capped [proven] tool check: no-floating-promises, no-misused-promises, no-deprecated, no-unnecessary-condition, no-misused-spread | tool-quality | M | 59/61 type-aware rules at seconds-scale; alpha caveats (memory, version-match tsgo). Upgrades several [heuristic] regex checks to [proven]. |
| no-deprecated as a standalone per-edit check via TS JSDoc tags (agents reach for stale APIs) | post | M | Implementable with the existing `typescript` optional dep without full tsgolint. |
| Per-package/per-directory water-line scoping for monorepos | ratchet + pre-gate | M | Nearest-package-root keying (maxLinesFor-style walk). Prevents legacy-subtree allocations from masking the clean subtree. |
| tsc strictness baseline (run stricter flags, report only new errors vs snapshot) | tool-quality + ratchet | L | ts-bulk-suppress semantics replicated in the diff-aware layer; native baselining exists in neither tsc nor biome. |

### Tier C — worthwhile refinements

| Item | Surface | Effort | Notes |
|---|---|---|---|
| Session-scoped dead-scaffolding Stop nudge (symbols added this session, zero inbound refs in project graph) | stop | S | Near-zero-FP scoping of the existing dead_exports advisory. |
| Cross-file reuse ratio Stop metric (pre-existing-symbol references added vs lines added) | stop (shadow) | S | GitClear −35% cross-file calls; repo-relational trajectory stat. |
| Same-region churn nudge (N≥3 edits to one line-bucket without an intervening verifier run) | trajectory | S | Region-granular version of the shipped verify-ratio nudges. |
| Unresolved-merge-conflict / in-progress-rebase Stop probe | stop | S | Lift ONLY the unfinished-state slice of FailproofAI's require-* family; require-push/CI-green gates are documented anti-patterns here. |
| Per-rule operator `hint` field appended to warnings (FailproofAI instruct-verb lite) | config + post | S | Structured, operator-editable "do this instead" text. |
| Per-check-id `failClosed` override (Cursor hooks mechanic) | pre-gate config | S | Compliance-critical checks may flip crash→deny individually. |
| Machine-applicable fix payloads on highest-confidence findings (safe/unsafe two-tier, Biome 2.5 plugin mechanic) | post payload | M | Cuts the block→retry round-trip; only fully-deterministic rewrites get "safe". |
| Biome ≥2.5 harvest: noUnusedInstantiation, useArraySortCompare, noShadow, noUnnecessaryConditions; defer circular_imports to project-rule noImportCycle when biome present | tool config | S | Cheapest lift in the sweep; inline ports only for non-biome repos. |
| Linter "domains": auto-enable check families from detected dependencies (react/test/node-fs…) | rules-loader | M | Dependency-sniff at SessionStart; cuts irrelevant-family FP noise. |
| ast-grep YAML rule-pack directory (`.interlinked/ast-rules/*.yml`) as /enforce target + community-corpus import | post + CLI | L | Declarative per-repo AST rules; CodeRabbit precedent. |
| Ship harness detectors as an oxlint JS plugin (ESLint-v9-API) | distribution | L | One detector, three surfaces (hook path, editor, CI). Syntactic rules only. |
| Codex hooks GA parity audit (SubagentStart/Stop, PreCompact capture) | installers | M | Codex hooks went GA ~2026-05; our installer predates it (feature-flag only). |
| Test-duration water-line per test file (2× band, Stop nudge only) | stop + ratchet | S | The "fast" desideratum; vitest JSON reporter durations are already produced by the coverage gate. |
| Checked-coverage-lite: oracle-checked exports ratio as a committed per-file water-line | post + ratchet | L | Static dual of mutation (introverted_test's dataflow machinery reused). |
| Ruff preview allowlist for the Python lane (B/RUF/PGH correctness families only) | tool config | S | Mirrors the default-vs-advisory split; copy the preview→stable graduation mechanic for harness families. |

## Explicit non-adoptions (decided 2026-07-06, with reasons)

- **General comment-code drift detection** — evidence points the other way
  (LLM comments are MORE consistent than human ones; real drift needs test
  execution or LLM hybrids → violates determinism). Only the narrow
  stale-reference slice shipped (jsdoc_param_drift).
- **require-push / require-PR / require-CI-green Stop gates** — competitor
  behavior deliberately not copied (`feedback_reluctance_to_push`).
- **Trajectory Family 2 (scope-creep)** — measured NOT to predict failure
  (trajectory-rules-validation.md); deprioritized despite intuitive appeal.
- **LLM-as-judge anywhere in the check path** — standing policy; the cloud
  tiers (2/3) are the escalation layer, not the check pipeline.

## Sources (primary)

- arxiv.org/abs/2403.08937 (Tambon et al., LLM bug taxonomy) · arxiv.org/html/2603.28592v1 (Debt Behind the AI Boom) · gitclear.com/the_ai_code_quality_maintainability_gap · arxiv.org/html/2605.21384v1 (SpecBench) · arxiv.org/pdf/2601.20103 (TRACE) · arxiv.org/pdf/2605.02964 (RHB) · arxiv.org/pdf/2511.00197 (code-agent behaviour) · arxiv.org/html/2601.19106v1 (hallucinated-API detection)
- oxc.rs/blog/2025-12-08-type-aware-alpha · biomejs.dev/blog/biome-v2-5 · typescript-eslint.io/rules · knip.dev · ast-grep.github.io/catalog/typescript · eslint.org/blog/2025/04/introducing-bulk-suppressions
- abseil.io/resources/swe-book/html/ch20.html (Tricorder) · cacm.acm.org …scaling-static-analyses-at-facebook · notion.com/blog/…ratcheting-system · github.com/justjake/eslint-seatbelt · github.com/tiktok/ts-bulk-suppress · docs.sonarsource.com …about-new-code · phenomnomnominal.github.io/betterer · newsletter.pragmaticengineer.com/p/stripe-part-2
- stryker-mutator.io/docs/stryker-js/incremental · docs.arcmutate.com/docs/git-integration · arxiv.org/pdf/1811.03045 (Descartes) · dl.acm.org/doi/abs/10.1109/ICSE.2019.00062 (rotten green tests) · arxiv.org/html/2410.10628 (LLM-generated test smells) · testdesiderata.com
- paulmduvall.com/claude-code-hooks-code-quality-guardrails · docs.befailproof.ai/built-in-policies · github.github.com/gh-aw/blog/2026-06-15-weekly-update (linter-miner) · github.com/nizos/tdd-guard · cursor.com/docs/hooks · developers.openai.com/codex/hooks

## Harness-compat evals (v1) — shipped 2026-07-06

The inverse regression suite: vitest pins what the gates *block*; `evals/`
pins what they still *permit*. Real headless agents (claude haiku; codex
feature-detected) run 8 everyday tasks (new module + test, fix failing test,
cross-file rename, 3-file scaffold, scratchpad script, run-tests-and-report,
docs edit, read-heavy question) across 4 fixture shapes (colocated-tdd /
separate-tests / no-tests / python), each task harness-on vs harness-off in a
throwaway fixture copy with its own daemon. Metrics come from the fixture's
`activity.jsonl` via `src/harness/eval-metrics.ts` (pure, vitest-covered):
blocks per rule, block loops (same rule ≥3× consecutively — the stuck-agent
signal), block→retry success, noise ratio (warnings per tool call), verifier
runs. Verdicts: FAIL when a task succeeds harness-off but fails harness-on
twice in a row; WARN on block loops or noise ratio >0.5. Manual and
cost-bearing (roughly $1–4 + 15–45 min per full claude sweep) — never part of
`npm test`; preview with `node evals/run-evals.mjs --dry-run`. Docs:
`evals/README.md`. Exit 1 on FAIL keeps a future scheduled lane CI-gateable.
