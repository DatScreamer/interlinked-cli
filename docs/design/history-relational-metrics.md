# History & relational metrics — beyond coverage / cyclomatic / LOC

**Status:** Phase 1 SHIPPED 2026-07-24 (cognitive_complexity live-verified in the
daemon via check-results.jsonl; coupling/arch/rework commands live-run on this
repo — propagation 2.4%, rework 40.1%/14d). Metrics #3 and #4 landed ahead of
schedule the same day (`metrics rework`, `metrics arch`). Remaining Phase 2:
AST-delta pulse line, Stop-event session-rework aggregate. **Owner:** harness.
**Origin:** 2026-07-24 session; ranked list refined against what the repo
already ships.

## 1. Why

Every enforced metric today measures one file, alone, at rest: line cap,
per-function cyclomatic, CRAP, per-file coverage (`src/harness/metric-caps.ts:30-41`
— the four `MetricKey`s). That family is saturated: the remaining defect classes
live in **relationships between files** and in **change over time**. Those need
either git history or the trajectory logs — data this repo uniquely has
(`.interlinked/` = 1.7 GB of it, mapped in `.interlinked/INDEX.md`), which is
also why competitors' static analyzers structurally cannot follow: a
tree-at-rest has no history axis.

## 2. What already exists (verified against source, 2026-07-24)

| Surface | What it covers | Where |
|---|---|---|
| Cyclomatic per-function (AST, `??`-aware, per-function isolation) | at-rest complexity | `src/harness/checks/cyclomatic-ast.ts` |
| Regex fallback when `typescript` absent | same, degraded | `src/harness/checks/cyclomatic.ts` |
| Caps + ratchet resolution (lines/cyclomatic/crap/coverage) | thresholds | `src/harness/metric-caps.ts` (`METRIC_DEFS:84`) |
| Per-edit pulse telemetry (before/after parses stashed at PreToolUse) | ΣCC + per-fn Δ per edit | `src/harness/evaluator/complexity-pulse.ts` |
| Whole-codebase scan (companion tests, coverage, cyclo, CRAP) | reporting | `src/commands/metrics.ts` |
| **Churn/thrash trajectory rules** (7): sha-cycle revisit, literal revert, undo-war toggle, edits-without-green, repeated failing bash, rerun-without-change, revert-after-fail combo | *event-triggered* in-session thrash nudges | `src/harness/trajectory/rules-churn.ts` (`CHURN_RULES:273`) |
| Import graph with per-file edges | declared dependencies | `src/harness/project-graph.ts` (`getDependencies:251`, `getImporters:256`) |

The churn family means "reverted-edit detection" is **already shipped** as
per-event nudges. What is missing there is only the *aggregate* (a per-session
rework rate at Stop). The genuinely absent axes are **git-history** metrics
(change coupling, rework age, flakiness) and **cognitive complexity**.

## 3. The metric set

Legend — Source: `git` (history), `ast` (parse), `graph` (project-graph),
`traj` (trajectory state / `.interlinked` logs), `net` (registry/network,
admission-time only). Surface: `check` (registry, per-edit), `cmd`
(on-demand CLI), `stop` (Stop-event reflection), `pulse` (per-edit telemetry
line), `screen` (allowlist admission).

| # | Metric | Definition / formula | Source | Surface | Phase |
|---|--------|----------------------|--------|---------|-------|
| 1 | Change coupling | pair support `s(a,b)` = commits touching both; strength = `s / ((rev_a+rev_b)/2)` (Tornhill's degree). Flag pairs with NO import edge either way = *hidden coupling* | git + graph | cmd `metrics coupling` | **Phase 1** |
| 2 | Cognitive complexity | SonarSource increments + nesting penalty (spec §5) | ast | check `cognitive_complexity` (advisory) + `metrics` scan column later | **Phase 1** |
| 3 | Rework age / churn ratio | % of changed lines in a commit whose prior blame-age < W days (default 14) | git | cmd `metrics rework` | Phase 2 |
| 4 | Martin metrics + propagation cost | per-dir Ca/Ce, I=Ce/(Ca+Ce); propagation = mean % of files transitively reachable | graph | cmd `metrics arch` | Phase 2 |
| 5 | Semantic edit size | per-edit AST node delta by kind vs raw line delta, from the pulse's already-paid parses | ast | pulse line extension | Phase 2 |
| 6 | Session rework rate | aggregate over existing churn state: reverted/re-edited edit share this session | traj | stop | **SHIPPED 2026-07-24** (`trajectory/session-rework.ts`, nudge at Stop over the shadow state) |
| 7 | Assertion density | assertions per test block, session-delta | ast | post | **already shipped pre-program** (Plan 09 Phase 1: `checkAssertionDensity` in `behavioral-checks-tdd-assertions.ts`, wired in `post-tool-file-checks-phases.ts`) — this program's row was stale; corrected 2026-07-24 |
| 8 | Flakiness | same (test, commit) with differing outcomes across runs | traj (`check-results.jsonl`) + CI | cmd | Phase 3 |
| 9 | libyear | years the approved version trails latest (npm `time` map) | net | **SHIPPED 2026-07-24** — screen 4 in `allowlist add` (warn-only, npm-only, pinned versions) | shipped |
| 10 | Max nesting depth | deepest control-structure nesting per function | ast | carried on every cognitive entry (`maxNesting`); **no separate gate — subsumed by cognitive**, whose nesting penalty is this metric weighted by depth (decision 2026-07-24, W2-6) | shipped (data) |
| 11 | Type coverage | % expressions not `any` (needs checker API, not just parse) | ast+checker | cmd | backlog |
| 12 | LCOM4 / clone ratio / comment staleness / Halstead | classic; each needs its own walker | ast/git | cmd | backlog |

FP policy: everything here lands **advisory or on-demand**. Nothing in this
set is `pre_block` — history metrics are judgment aids, not zero-FP rails
(`feedback_taste_enforcement`: pre_block keeps the low/zero-FP bar).

## 4. Phase 1 scope (this session)

1. `src/harness/checks/cognitive-ast.ts` — computation + entries (mirrors
   `cyclomatic-ast.ts`: optional `typescript` via the shared loader, null
   fallback, per-function entries). Registry check `cognitive_complexity`
   (post, warning, advisory) in the quality-frontier family; metadata; docs
   regenerated.
2. `src/commands/metrics-coupling.ts` — pure parse/compute core + thin command
   `interlinked metrics coupling`; registrar subcommand under `metrics`.

## 5. Cognitive complexity — precise v1 spec

SonarSource-aligned with two documented deviations for population parity with
the cyclomatic gate (same function enumeration ⇒ per-function tables join).

**Units.** Every implementation function-like node (same predicate as
`cyclomatic-ast.ts::isImplementationFunction`) is scored **separately**; nested
function-likes are excluded from the parent's walk.
*Deviation 1 (attribution):* Sonar rolls lambda contents into the enclosing
method. We attribute to the innermost function-like, but compensate via:

**Initial nesting = number of enclosing function-like ancestors.** An arrow
inside a method starts at nesting 1, so `if` inside it costs `1+1`; the sum
across units equals Sonar's roll-in score for the enclosing method, while
per-unit attribution survives. Extracting the callback to top level zeroes the
initial nesting — exactly the refactor the metric should reward.

**Increments (+1 + current nesting):** `if` (except an `else if` continuation),
`for`/`for-in`/`for-of`, `while`, `do`, `switch` (the statement, NOT its
cases), ternary, `catch`.

**Flat +1 (no nesting penalty):** `else` branch, `else if` continuation,
each **run transition** in logical-operator sequences over `&&`/`||`/`??`
(`a&&b&&c`=1, `a&&b||c`=2, `(a&&b)||(c&&d)`=3 — implemented as: a logical
binary node increments iff its paren-unwrapped LEFT child is not the same
operator), labeled `break`/`continue`, direct recursion (once per unit, by
callee-identifier == unit name; named units only).
*Deviation 2:* `??` counts as its own operator kind (post-dates the Sonar
paper; consistent with `cyclomatic-ast.ts` which counts `??`).

**Nesting descent (+1 for children):** bodies/branches of the increment
structures above — `then`, non-`if` `else` blocks, loop bodies, switch clauses,
catch blocks, ternary arms. An `else if` does NOT deepen (chains stay flat,
matching Sonar). `default:` clauses and case bodies sit at switch+1.

**Threshold:** `DEFAULT_MAX_COGNITIVE = 15` (Sonar's default), one constant in
`cognitive-ast.ts`. Not yet a `MetricKey` in `metric-caps.json` — promoting it
to a ratcheted cap (baseline-integrity direction: tighten-only) is Phase 2, so the
check message states the constant's source. Advisory: runs under
`verify --all-checks` and PostToolUse warning only.

**Why it earns its slot next to cyclomatic:** flat `switch` with 20 cases —
cyclomatic 21 (gate-relevant), cognitive 1 (readable, correctly not punished);
3-deep nested `if` — cyclomatic 4 (invisible), cognitive 6 (visible). The two
metrics disagree exactly where human review disagrees with branch counting.

## 6. Phase 2/Phase 3 sketches (for the next session's unit 7+)

- **rework** (`metrics rework --days 30 --window 14`): for each commit in
  range: `git diff -U0 parent..sha` hunks → for removed/replaced ranges,
  `git blame -L a,b parent -- file` → changed line is *rework* when
  `commit_time - blame_time < window`. Report overall %, top files, trend.
  Bounded: `--max-commits 200`, subprocess count = O(hunks), on-demand only.
- **arch** (`metrics arch`): fold `ProjectGraph` edges per top-level dir:
  Ca/Ce/I, plus propagation cost via BFS closure sampled ≤ 2k files.
- **Semantic edit size:** `complexity-pulse.ts` already stashes before/after
  parses; add node-kind histogram delta to the same `[interlinked:cyclomatic]`
  line (rename → ~0 structural delta vs 200-line textual delta).
- **Session rework rate (stop):** aggregate `fileShaHistory` /
  `fileEditLog` (already folded in `session-state`/trajectory state) into
  `reverted_edit_ratio = revisited-sha edits / total edits`; nudge only above
  a floor (say 0.25 with ≥8 edits). No new capture needed.
- **Flakiness:** `check-results.jsonl` + CI: same test id, same tree-hash,
  mixed pass/fail. Requires recording tree-hash per run first (small capture
  addition — do that before the metric).

## 7. Test plan (Phase 1)

- `cognitive-ast.test.ts`: oracle fixtures — flat-switch (1), nested-if ladder
  (6), else-if chain, boolean runs (1/2/3 incl. parens + `??`), lambda-depth
  attribution (sum equals Sonar roll-in on the reference example), recursion
  (+1 once), bodiless overloads produce no entries, `typescript`-absent → null
  (cache-reset helper), non-JS extensions → null. ≥3 positive / ≥3 negative
  per repo convention.
- `metrics-coupling.test.ts`: log-parse fixtures (blank-line separated,
  `%H\t%ct` header lines), pair math (support/strength), bulk-commit exclusion
  (`--max-commit-files`), companion-pair labeling (`foo.ts`/`foo.test.ts`),
  hidden vs linked annotation with a stub graph lookup, min-support filter.
- Registrar pin: `quality.test.ts` gains the `coupling` wiring case; existing
  `optsOf("metrics")` pin unchanged (parent action + subcommand coexist).

## 8. Non-goals

- No LLM anywhere in the pipeline (`feedback_harness_deterministic_only`).
- No new `pre_block` gates from this family.
- No metric-caps.json schema change in Phase 1 (baseline-integrity gate direction
  rules must be extended in the same diff when cognitive is promoted — Phase 2).
- Coupling stays out of the per-edit hook path: it shells to `git log`
  (hundreds of ms), which is `cmd`-tier cost, not hook-tier.
