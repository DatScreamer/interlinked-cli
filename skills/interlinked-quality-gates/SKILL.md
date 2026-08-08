---
name: interlinked-quality-gates
description: "Configure and respond to Interlinked's metric ratchets: line-count, cyclomatic complexity, coverage, CRAP, baseline integrity, the report-based mutation-score ratchet, and the live per-edit mutation survivor gate. Load this for a quality-gate block; `caps`, `coverage`, `mutation`, `debt`, `metrics`, or `adopt`; a lowered-baseline refusal; choosing mutation cadence/scope/strictness; configuring `mutation_gate` or `per_edit_mutation`; connecting/sharding a mutation runner; or interpreting `[interlinked:mutation]` and `[mutation:not-measured]`. Water-lines only tighten: meet the bar rather than lowering the baseline."
---

# interlinked-quality-gates — the metric ratchets

Every quality metric is a **water-line** stored in a JSON file under `.interlinked/`. The gates
enforce **"may only move in the tightening direction"**: coverage/mutation scores may only rise;
caps may only fall. The harness raises water-lines itself (internal writes); **an agent
hand-lowering a water-line is the canonical gate-gaming move and is blocked.** North star:
~100% coverage paired with mutation testing.

**When a gate blocks you, the correct move is always to meet the bar — decompose, add a test,
cover the line — never to loosen the baseline.** The strict gates (cyclomatic, per-edit
coverage) have **no suppression and no env bypass**; decomposition or a test is the only way
past. The habit that pays here is **decompose-first**: extract helpers *as you write* branchy
functions, rather than waiting for the gate to block. (Measured on the harness's own repo
across 17+ sessions of the strongest available models, at an identical per-edit rate — so it
is a property of how models write branchy code, not of one codebase.)

## The gates you bump into at edit time
These run before an edit lands. The local metric ratchets use **delta semantics**: holding or
reducing existing debt is allowed. Per-edit mutation is separately configurable as off, warn,
or block.

| Gate | Blocks when | Threshold | Correct response |
|---|---|---|---|
| **Line cap** | a Write/Edit grows a *cappable* file past its ceiling | **500** lines (`DEFAULT_MAX_LINES`) | Decompose into a re-exporting entry + sibling modules |
| **Cyclomatic — over cap** | edit adds/raises a function over the hard cap | **22** | Extract cohesive branches into named helpers |
| **Cyclomatic — slew** | a uniquely-named ≤cap function jumps **>2** branches in one edit | tolerance **2**/edit | Extract cohesive branches into named helpers; do not stage one logical complexity increase across edits |
| **Cognitive — over cap** | edit leaves a function over the cognitive cap | **30** | Flatten: guard clauses, extract the deepest-nested block |
| **Cognitive — slew** | a uniquely-named ≤cap function jumps **>4** cognitive points in one edit | tolerance **4**/edit | Flatten rather than extract-in-place; a branch pulled out unchanged keeps its nesting cost |
| **Per-edit coverage** | edit adds an uncovered executable line/function, or drops a file's coverage vs its high-water | gate default on; drop ε 0.005; floor default 0 (off) | Stay within the source/test pair and add coverage; default debt mode allows the first uncovered/red edit but blocks unrelated wandering |
| **CRAP** | a touched function is both complex AND under-covered | **25**, default on | Decompose OR add coverage (both lower CRAP) |
| **Per-edit mutation** | a measured edit adds a changed-region survivor/uncovered site, makes affected tests red, or exceeds the site limit | default **off**; site limit **50**; `mode: block\|warn\|off` | Strengthen the test, fix/remove the source behavior, or split an oversized behavioral change |
| **Baseline-integrity** | a Write/Edit *loosens* any `.interlinked/` water-line | per-file direction | Meet the bar; don't edit the baseline |

**Line cap** — three surfaces, one policy: PreToolUse block (pure before/after delta — shrinking
or holding an over-cap file is always allowed, the refactor-down path), a `large_files` verify
check, and a `[interlinked:file-size]` PostToolUse nudge. **Cappable = hand-written code only**;
exempt: `.d.ts`, anything under `.interlinked/`, root `scratch/`, non-code extensions
(md/json/yaml/toml/html/…), generated files (`.gen.`/`generated/` path or `@generated`
content), test/spec paths, and `@codegen-data`-marked modules.

**Cyclomatic** — strict, **no override**. Over-cap uses an identity-free multiset compare (a new
over-cap function, or raising one past the cap, blocks); sub-cap limits a named function to +2
branches/edit. JS/TS via the TS AST, Python via `radon`, other languages skipped. **Fails open
(allows) + warns loudly** when the analyzer is unavailable — never a silent skip.

**Cognitive** — same three rules, promoted from warn-only to blocking 2026-08-01 (measured p99 26
vs cap 30). Two ways it is *stricter* than cyclomatic: uniquely-named functions are compared by
identity rather than rank, so relocating complexity into a newly-created over-cap helper still
blocks; and the remedy is flattening, not extraction — pulling a deeply-nested branch into its
own function unchanged carries the nesting cost with it. Run `interlinked caps` for live values;
the numbers in this table are the committed defaults, not a promise about your repo.

**Per-edit coverage** — default **ON**. Runs the *affected tests only* under a scoped overlay,
then decides: red-bar (default on) → uncovered-added-line → per-file coverage drop vs
`coverage-edit-baseline.json` → `min_coverage` floor → CRAP (default on). With default
`debt_mode:true`, the first uncovered or red result opens a pair-scoped debt and the edit lands;
keep working in that source/test pair until it is covered and green. The commit gate remains the
ground-truth backstop.

**CRAP** = `cyclomatic² · (1 − coverage/100)³ + cyclomatic`, where coverage is a percentage.
Full coverage reduces the score to cyclomatic, but low coverage can exceed the default threshold
even at modest complexity (complexity 5 at 0% coverage scores 30). Treat complexity and coverage
as independent levers; neither cap alone guarantees a safe CRAP score.

**A function with no coverage reading gets no CRAP score at all.** When the report contains no
measurement for a function — the source moved since the last coverage run, or the instrumenter
never emitted an entry for it — that is *unknown* coverage, not 0%. Such functions are omitted
from CRAP findings entirely: absent from `interlinked metrics` hotspots, from the CRAP
distribution, and from the over-cap gate count (they still carry cyclomatic complexity, so they
stay in the function inventory). Scoring them as 0% used to drive CRAP to its ceiling, which put
fully-covered functions at the top of the hotspot list and false-blocked edits to well-tested
code. If a function you expect to see is missing from the hotspots, regenerate coverage
(`npm run test:coverage` or the project equivalent) rather than reading its absence as a pass.

## Mutation testing: choose cadence, scope, and enforcement

Interlinked has **two independent mutation systems**. Do not treat their baselines or config as
interchangeable.

| Surface | Cadence and scope | Verdict state | Who runs the engine? |
|---|---|---|---|
| **Report score ratchet** — `interlinked mutation check` | Manual/CI/pre-push/weekly; every file present in the supplied report | `.interlinked/mutation-baseline.json`; score drop = error, below `min_score` = warning | The user or CI runs Stryker (or emits the supported generic `files` JSON shape) first |
| **Live per-edit survivor gate** — `per_edit_mutation` | Each supported source edit; runner measures the selected JS/TS file and the gate judges changed symbols | `.interlinked/mutation-manifest.json`; new survivor/uncovered site = warn or block | A configured mutation-runner endpoint runs Stryker against the proposed overlay |

### Report score ratchet

Use this when mutation is too slow for every edit or when CI owns the exhaustive campaign:

```bash
npx stryker run                         # scope/operators/tests come from Stryker config
interlinked mutation check --report reports/mutation/mutation.json
interlinked mutation check --report reports/mutation/mutation.json --update-baseline
interlinked mutation baseline
```

Set the score floor in `.interlinked/check-policy.json` (team) or
`.interlinked/check-policy.local.json` (personal override):

```json
{
  "version": 1,
  "mutation_gate": {
    "enabled": true,
    "min_score": 0.75,
    "schedule": "weekly"
  }
}
```

**Current contract:** `min_score` affects the comparison. `enabled` and `schedule` record policy
intent but do not invoke or schedule Stryker; wire the command into the chosen CI/hook/cron
surface yourself. The public command currently exposes `--report`, `--baseline`,
`--update-baseline`, and `--json`; `--baseline` is accepted but the handler still reads the
standard `.interlinked/mutation-baseline.json`. Internal `minScore`/`changedFiles` support is not
registered as public CLI flags.

The score is `killed / (killed + survived)`. Timeout, no-coverage, compile-error, and
runtime-error mutants are excluded from that denominator; inspect the engine report instead of
reading a high score as proof that every mutant was conclusively measured.

Interlinked decides only the **ratchet verdict**. Configure how much mutation work happens in the
engine: Stryker's `mutate` paths/ranges, test runner and selected tests, mutator exclusions,
concurrency, timeouts, coverage analysis, and incremental mode. There is no Interlinked
`light|standard|full` preset.

### Live per-edit survivor gate

The shipped default is off. Opt in under `.interlinked/guard-rules.json` for team policy or
`.interlinked/guard-rules.local.json` for machine-local runner topology/credentials:

```json
{
  "per_edit_mutation": {
    "enabled": true,
    "mode": "warn",
    "unavailable_behavior": "allow_unmeasured",
    "site_count_threshold": 25,
    "budget_ms": 10000,
    "harvest_budget_ms": 15000,
    "runner_url": "https://mutation-runner.example"
  }
}
```

| Knob | Effect |
|---|---|
| `enabled` | Master opt-in. `false` does no live mutation work. |
| `mode` | `block` rejects measured findings; `warn` runs the same measurement but allows with warnings; `off` is a no-op. |
| `unavailable_behavior` | `allow_unmeasured` preserves continuity with `[mutation:not-measured]`; `block` fails closed when no verdict is available. |
| `site_count_threshold` | Maximum distinct changed-symbol mutation sites in one established file before "split this patch"; default 50. |
| `budget_ms` | Initial runner round-trip ceiling; default 25,000 ms. Expiry is not a pass and can be harvested later. |
| `harvest_budget_ms` | PostToolUse wait for an over-budget pending run; default 25,000 ms. |
| `runner_url` | One mutation-runner endpoint. No endpoint means unavailable, not clean. |
| `runner_urls` | Extra endpoints. Several runners shard the selected file into line ranges and measure concurrently. |
| `token` | Optional bearer credential. Keep it in the gitignored local rules file, never committed policy. |

Scope is deliberately narrow: JS/TS product source (`.ts/.tsx/.js/.jsx/.mjs/.cjs`) only; test
and root `scratch/` paths are excluded. A change set selects its first eligible source as the
primary. It ships the full proposed change set, companion test, and local dependencies as
overlays; the runner measures that primary file, while the ratchet judges mutants in changed
symbols. Multiple runner URLs improve wall-clock coverage by sharding line ranges; they do not
change the survivor invariant.

The first measured sighting of a file establishes its accepted floor so brownfield survivors do
not make adoption impossible; a red affected suite still blocks in `block` mode. Later runs flag
only new changed-region survivors/uncovered sites. A clean measured run refreshes the manifest
and appends a receipt. Warn-mode findings and unavailable runs never launder the manifest clean.

When the live gate reports:

- **New survivor:** strengthen the assertion, fix the source behavior, or remove dead/over-specific code.
- **Uncovered site:** add a test that executes the changed behavior.
- **Affected suite red:** restore green before interpreting mutation results.
- **Over site limit:** split the patch into smaller behavioral changes with their tests.
- **Not measured:** check runner configuration/reachability, test selection, budget, and the target repo's Stryker setup. Do not describe it as a pass.

**Baseline-integrity** — a PreToolUse block on any edit that loosens a water-line file (below).
Pure disk-vs-proposed numeric diff, near-zero FP. Reset an intentional baseline change with
`INTERLINKED_DISABLE_BASELINE_GUARD=1` (logged). A commit-gate backstop closes the
`apply_patch`/subagent hole for the git-tracked baselines.

## Command surface
| Command | Purpose |
|---|---|
| `interlinked caps` | Show effective caps (lines/cyclomatic/crap/coverage) + provenance. |
| `interlinked caps set <lines\|cyclomatic\|crap\|coverage> <n>` | Retune a cap → `.interlinked/metric-caps.json`. |
| `interlinked caps explain [metric]` | Definition, default, fix hint per metric. |
| `interlinked coverage check [--update-baseline] [--json]` | Full-suite per-file coverage ratchet vs `coverage-baseline.json`. |
| `interlinked mutation check [--report <p>] [--update-baseline]` | Per-file mutation-score ratchet vs `mutation-baseline.json` (needs a Stryker report). |
| `interlinked metrics [--top <n>] [--json]` | Read-only whole-repo scan: companion-test, coverage, cyclomatic, CRAP hotspots + gate verdicts. |
| `interlinked debt list \| show <file> \| resolve <file>` | The obligation ledger — coverage / red-suite debts AND `transient` debts (the deferred tsc/registry findings a coordinated edit opens). All three verbs see every kind; `resolve` is the human override for a debt no future edit will clear. |
| `interlinked adopt [--dry-run] [--suite-baseline]` | Seed the supported adoption artifacts from the repo's current state (see below; mutation state is excluded). |

`interlinked coverage`/`mutation` need a report on disk first (a coverage run / `stryker run`) —
those runs are slow; don't trigger them incidentally. `interlinked metrics` reports complexity +
companion presence even without a coverage report (coverage columns marked unavailable).

## Baselines & direction rules (`.interlinked/`)
The integrity gate matches these eight files; direction is **per-file**:

| File | Direction (what's blocked) |
|---|---|
| `coverage-baseline.json` | pcts may only **rise** (`interlinked coverage` CLI). |
| `coverage-edit-baseline.json` | fraction may only **rise** (per-edit gate high-water). |
| `mutation-baseline.json` | score/killed may only **rise**. |
| `large-files-baseline.json` | `max_lines` may only **fall**; a grandfather count may only **shrink**; a new over-cap entry is blocked. |
| `untested-files-baseline.json` | `min_coverage_pct` may only **rise**; `files` is an **exemption list** → may only **shrink**. |
| `metric-caps.json` | `max_*`/`crap_threshold` may only **tighten**; `min_coverage` may only **rise**. |
| `skipped-tests-baseline.json` | `max_skipped` may only **tighten**; a grandfather count may only **shrink**. |
| `mutation-manifest.json` | the accepted-survivor set may only **shrink**. |

> **Two different "min coverage" numbers:** `metric-caps.json → min_coverage` = the per-file
> **floor for the edit-time gate** (default 0 = off). `untested-files-baseline.json →
> min_coverage_pct` = the threshold deciding whether a companion-less file counts as "tested"
> for the `untested_files` verify check (default 60). And **two coverage baselines**:
> `coverage-baseline.json` (full-suite CLI) vs `coverage-edit-baseline.json` (per-edit gate).
> Editing the wrong one has no effect on the gate you're trying to satisfy.

## Adopting on a legacy repo — `interlinked adopt`
Seeds the supported non-mutation water-lines from the repo's **current** state so day-1 gates become ratchets
("everything can only improve from here"). Human-invoked `fs` writes, so it bypasses the
integrity gate (the sanctioned carve-out). Idempotent and **never loosens** — a re-run refuses
to grandfather a *new* offender (decompose/cover it instead). Steps: (1) trigram index,
(2) large-files grandfather list, (3) untested-files exemption list, (4) coverage baseline from
any existing report (never runs the suite), (5) metric-caps defaults (only if absent),
(6, opt-in `--suite-baseline`) run the suite once to record red/green. `interlinked doctor` flags
missing adoption artifacts. **It does not seed `mutation-baseline.json` or
`mutation-manifest.json`.** The report ratchet is seeded explicitly with
`interlinked mutation check --update-baseline`; the live gate establishes a file floor on its
first measured sighting. The lower-level brownfield manifest adoption helper is not wired to a
public `interlinked mutation adopt` command.

## Gotchas
- **The line cap is ONE number.** `DEFAULT_MAX_LINES` (code) and `max_lines`
  (large-files-baseline) are pinned equal by a test; `metric-caps.json → max_lines` overrides
  both. Ratchet down by editing them together (or `caps set lines`).
- **Lowering a baseline is exactly what the integrity gate stops.** If you're blocked editing a
  baseline, you're doing the gate-gaming move. Intentional reset:
  `INTERLINKED_DISABLE_BASELINE_GUARD=1`.
- **Cyclomatic & per-edit-coverage gates have no bypass and no suppression** — decompose/test is
  mandatory. (`per_edit_coverage.enabled:false` in `guard-rules.local.json` is a repo-wide
  policy opt-out, not a per-edit escape.)
- **Mutation has two configs and two states.** `check-policy*.json → mutation_gate` controls the
  report score floor; `guard-rules*.json → per_edit_mutation` controls the live survivor gate.
  `mutation-baseline.json` and `mutation-manifest.json` are not substitutes.
- **Interlinked does not choose the mutator strength.** Pin the Stryker operator set and test
  scope in the target repo; changing either can make scores incomparable without changing the
  Interlinked baseline schema.
- **`mutation accept` REFUSES every prose accept — do not plan around it.** (Corrected
  2026-08-07; the previous text here described behavior that no longer exists.) Since typed
  dispositions, `equivalent` status requires a verifier-issued certificate bound to the
  mutant's current symbol hash, and the CLI cannot mint one — so
  `interlinked mutation accept --file <p> --id <mutantId> --reason <why>` reports the refusal
  and exits non-zero, whatever the reason says. A reason is not a mechanism.
  **Consequence to know before promising anyone a number:** a survivor's only recordable
  end-states are *killed* or *unjustified*, so an "unjustified survivors" count can never fall
  below the survivor count. Kill the mutant with a test, or delete the code if the mutant is
  unkillable because the code should not exist. (`src/commands/mutation-disposition.ts` exists
  to expose the certificate-free judgments — `dead_code`, `unresolved` — but is not yet wired
  into the CLI registrar.) Hand-editing the manifest remains blocked by the integrity gate.
  Use it only for mutants with no observable behavior change; agent-facing message prose is
  behavior in this repo, so assert it instead of accepting. Campaign guidance:
  `docs/plans/15-survivor-elimination-campaign.md`.
- **Do not split one branchy change into multiple edits to evade the +2 slew.** The edit-sized
  tolerance is a regression detector, not permission to accumulate the same design debt slowly.
  Extract a helper or simplify the control flow.
- **`tsgo` ≠ `typescript` for the AST gate.** The cyclomatic/CRAP gate parses with the optional
  `typescript` compiler API; `tsgo` is typecheck-only with no importable JS API. Installing with
  `--omit=optional` makes the cyclomatic gate fail open (silent enforcement gap) — keep
  `typescript` installed. Python needs `radon` on PATH.

## Quick reference
```bash
interlinked caps                       # current caps + provenance
interlinked metrics --top 15           # worst CRAP/complexity hotspots
interlinked adopt --dry-run            # preview seeding a legacy repo
interlinked coverage check             # full-suite coverage ratchet
interlinked mutation check --report reports/mutation/mutation.json
interlinked mutation baseline          # inspect report-ratchet high-water scores
```

## Related skills
- **interlinked-verify** — the content gate (pre_block/biome/tsc) and how to land edits.
- **interlinked-harness** — the general guard, suppression grammar, cold fallback.
- **interlinked-observability** — `interlinked metrics` and recurrence for finding hotspots.
