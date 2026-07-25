---
name: interlinked-quality-gates
description: "Respond to Interlinked's metric ratchets — the edit-time gates that block on line-count, cyclomatic complexity, coverage, and CRAP, plus the baseline-integrity gate. Load this when an edit was BLOCKED for growing a file past the line cap (500), for a cyclomatic-complexity jump or over-cap function, for adding an uncovered line or dropping coverage, for a high CRAP score, or for \"loosening a baseline\"; when adopting Interlinked on a legacy repo (`interlinked adopt`); or when managing caps/coverage/mutation baselines (`interlinked caps`, `coverage`, `mutation`, `debt`, `metrics`). The rule: water-lines only tighten — meet the bar (decompose / add a test / cover the line), never lower the baseline."
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
past. This is the repo's "decompose-first" habit: extract helpers *as you write* branchy
functions, rather than waiting for the gate to block.

## Load this when
- An edit was blocked for: file too long / line cap; a complexity jump or over-cap function;
  an uncovered added line or a coverage drop; a high CRAP score; or "loosening a baseline".
- You're adopting Interlinked on a legacy/large repo.
- You're managing caps or coverage/mutation baselines, or reducing debt.

## The gates you bump into at edit time
All are **PreToolUse blocks** with **delta semantics** (holding or reducing is always allowed).

| Gate | Blocks when | Threshold | Correct response |
|---|---|---|---|
| **Line cap** | a Write/Edit grows a *cappable* file past its ceiling | **500** lines (`DEFAULT_MAX_LINES`) | Decompose into a re-exporting entry + sibling modules |
| **Cyclomatic — over cap** | edit adds/raises a function over the hard cap | **25** | Extract cohesive branches into named helpers |
| **Cyclomatic — slew** | a uniquely-named ≤cap function jumps **>2** branches in one edit | tolerance **2**/edit | Split the change across edits |
| **Per-edit coverage** | edit adds an uncovered executable line/function, or drops a file's coverage vs its high-water | drop ε 0.005; floor default 0 (off) | Add a test exercising the added line, then retry |
| **CRAP** | a touched function is both complex AND under-covered | **30** | Decompose OR add coverage (both lower CRAP) |
| **Baseline-integrity** | a Write/Edit *loosens* any `.interlinked/` water-line | per-file direction | Meet the bar; don't edit the baseline |

**Line cap** — three surfaces, one policy: PreToolUse block (pure before/after delta — shrinking
or holding an over-cap file is always allowed, the refactor-down path), a `large_files` verify
check, and a `[interlinked:file-size]` PostToolUse nudge. **Cappable = hand-written code only**;
exempt: `.d.ts`, anything under `.interlinked/`, root `scratch/`, non-code extensions
(md/json/yaml/toml/html/…), generated files (`.gen.`/`generated/` path or `@generated`
content), test/spec paths, and `@codegen-data`-marked modules.

**Cyclomatic** — strict, **no override**. Over-cap uses an identity-free multiset compare (a new
over-cap function, or raising one past 25, blocks); sub-cap limits a named function to +2
branches/edit. JS/TS via the TS AST, Python via `radon`, other languages skipped. **Fails open
(allows) + warns loudly** when the analyzer is unavailable — never a silent skip.

**Per-edit coverage** — default **ON**. Runs the *affected tests only* under a scoped overlay,
then decides: red-bar (opt-in) → uncovered-added-line → per-file coverage drop vs
`coverage-edit-baseline.json` → `min_coverage` floor → CRAP (opt-in). The block names the exact
file+line+function — **write the test first, then re-apply the code.**

**CRAP** = `cyclomatic² · (1 − coverage)³ + cyclomatic`. Because it's monotonic in cyclomatic and
equals `cyclomatic` at full coverage, keeping cyclomatic < 25 keeps CRAP safe — there's no
separate sub-cap CRAP ratchet.

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
| `interlinked debt list \| show <file> \| resolve <file>` | The pair-scoped TDD obligation ledger (coverage / red-suite debts). |
| `interlinked adopt [--dry-run] [--suite-baseline]` | Seed every water-line from the repo's current state (see below). |

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
Seeds every water-line from the repo's **current** state so day-1 gates become ratchets
("everything can only improve from here"). Human-invoked `fs` writes, so it bypasses the
integrity gate (the sanctioned carve-out). Idempotent and **never loosens** — a re-run refuses
to grandfather a *new* offender (decompose/cover it instead). Steps: (1) trigram index,
(2) large-files grandfather list, (3) untested-files exemption list, (4) coverage baseline from
any existing report (never runs the suite), (5) metric-caps defaults (only if absent),
(6, opt-in `--suite-baseline`) run the suite once to record red/green. `interlinked doctor` flags
missing adoption artifacts.

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
```

## Related skills
- **interlinked-verify** — the content gate (pre_block/biome/tsc) and how to land edits.
- **interlinked-harness** — the general guard, suppression grammar, cold fallback.
- **interlinked-observability** — `interlinked metrics` and recurrence for finding hotspots.
