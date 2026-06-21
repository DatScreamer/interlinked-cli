# Baseline-Integrity Gate — Implementation Plan

**Status:** PreToolUse gate + commit-gate backstop SHIPPED + dogfood-verified live, 2026-06-21. Full suite green (18,619). Uncommitted.

## As-built (deltas from the plan below)

Two findings during the build changed the design:

1. **Disk-as-before, not git HEAD.** Dogfooding revealed that only `large-files-baseline.json`
   and `untested-files-baseline.json` are git-tracked — `coverage-baseline.json`,
   `coverage-edit-baseline.json`, `mutation-baseline.json`, and `metric-caps.json` are
   **gitignored** (`.interlinked/*`). A HEAD comparison fails open on the four most important
   baselines. The gate instead compares the proposed content against the **current on-disk**
   water-line: the PreToolUse hook fires *before* the write lands, so disk still holds the
   pre-edit baseline, and this works regardless of git-tracking. This is also simpler (no git
   subprocess on the hook path) and strictly more correct for the threat model (an agent gaming
   its own session's local gate).
2. **No `git-head-read.ts` extraction.** Rather than a new shared-util file (which would drag in
   its own TDD/coverage dance), the three needed helpers (`readDiskContent`, `reconstructEditContent`,
   `safeJsonParse`) are simply `export`ed from `config-loosening-gate.ts`. `readHeadVersion` is
   not used by this gate.
3. **Commit-gate backstop — BUILT.** `src/harness/evaluator/commit-baseline-gate.ts`
   (`checkCommitBaselineGate` + `runCommitBaselineGate`) is an always-on PreToolUse pipeline phase
   (wired in `pre-tool-pipeline.ts` *before* the config-gated `runCommitGate`) that blocks a real
   `git commit` whose STAGED change loosens a git-tracked baseline (diffs `git show HEAD:<f>` vs
   `git show :<f>` through `detectBaselineGaming`). Scope: the **3 carved-out/stageable** baselines
   (`large-files`, `untested-files`, `metric-caps`); the gitignored 3 never stage. It closes the
   `apply_patch`/sub-agent/manual-editor hole for committable baselines. Note: it lives in its own
   ungated phase, NOT inside `checkCommitGate` (which is config-gated OFF by default). The
   verify-only backstop was dropped as redundant (commit-gate covers the same committed files at the
   point-of-no-return).

**Files (as-built):** `src/harness/evaluator/baseline-integrity-gate.ts` (+`.test.ts`, 34 cases),
exports added to `config-loosening-gate.ts`, wrapper `evaluateBaselineIntegrityGate` in
`pre-tool-guards.ts` (+test), thunk wired in `pre-tool.ts`. Decision = **block**, `rule_id`
`baseline_integrity_gate`, env bypass `INTERLINKED_DISABLE_BASELINE_GUARD=1`. Live probe confirmed:
a Write/Edit lowering `coverage-baseline.json` blocks; a raising edit allows.

---

**Status (original plan):** plan, awaiting build. 2026-06-21.
**Companion:** `docs/design/test-category-adoption-from-the-wild.md` §9.1b (test-integrity guards),
`docs/design/test-quality-harness-local-first.md` §13 (the ratchet substrate this protects).
**Reuses:** `src/harness/evaluator/config-loosening-gate.ts` (HEAD-read + Edit-reconstruction +
JSONC-tolerant diff + ask/block plumbing, 57 tests, wired at `pre-tool.ts:162`).

---

## 1. Problem & thesis fit

The "poor man's Jeff Emanuel" local-enforcement substrate is a stack of **ratchets** — coverage,
mutation, per-edit coverage, cyclomatic slew, CRAP, per-file line cap, untested-file floor. Every one
of them decides by reading a committed water-line JSON under `.interlinked/`. Jeff gets ratchet
integrity *for free*: a human reviewer + CI own the thresholds, so nobody can quietly lower them. We
don't have that — **the agent being gated has write access to the very files that define the gate.**

An agent that can't get an edit past the coverage gate can `Edit .interlinked/coverage-baseline.json`
to lower the bar, or add its just-oversized file to the `large-files-baseline.json` grandfather list,
and walk through every ratchet at once. This is the canonical gate-gaming vector, and it is **wide
open today** — verified: `config-loosening-gate.ts` matches only `tsconfig/biome/package.json/.eslintrc`,
and the files that reference the baselines (`coverage-ratchet.ts`, `mutation-gate.ts`, …) are the
ratchet *consumers*, not a guard against an agent editing them.

The fix is a pure before/after numeric diff over JSON the harness itself authored: **a water-line may
only move in the safe direction.** 100% deterministic, no suite execution, no LLM, near-zero FP.

---

## 2. Scope — the files and their (non-uniform) safe direction

This is the heart of the gate. Direction is **per-file** and must be encoded explicitly — getting it
wrong inverts the gate into noise.

| File | Shape | BLOCK (loosening) | ALLOW (tightening / neutral) |
|---|---|---|---|
| `coverage-baseline.json` | `{version, files: {path: {lines_pct, branches_pct}}}` | a pct **lowered** for an existing file; entry **removed** while source file still exists | pct raised; new file added; entry removed for a deleted source file |
| `coverage-edit-baseline.json` | flat `{path: number 0..1}` | a value **lowered**; entry removed while source exists | value raised; new entry; entry removed for deleted source |
| `mutation-baseline.json` | `{version, files: {path: {score, killed}}}` | `score` or `killed` **lowered**; entry removed while source exists | raised; new entry; entry removed for deleted source |
| `large-files-baseline.json` | `{max_lines, files: {path: count}}` | `max_lines` **raised**; a grandfather `count` **raised**; a **new** grandfather entry whose count > post-edit `max_lines` | `max_lines` lowered; count lowered; entry removed (file resolved) |
| `untested-files-baseline.json` | `{min_coverage_pct, files: [path]}` ← **inverted: `files` is an exemption list** | `min_coverage_pct` **lowered**; a path **added** to the exemption array | `min_coverage_pct` raised; path removed (file now subject to coverage) |
| `metric-caps.json` | `{max_lines?, max_cyclomatic?, crap_threshold?, min_coverage?}` | `max_lines`/`max_cyclomatic`/`crap_threshold` **raised**; `min_coverage` **lowered** | caps tightened (opposite) |

Notes:
- `mutation-baseline.json` and `metric-caps.json` are **not committed in this repo** — the gate
  handles-if-present (no-op when absent), so it's correct for repos that do commit them.
- Path match: `(?:^|/)\.interlinked/(coverage-baseline|coverage-edit-baseline|mutation-baseline|large-files-baseline|untested-files-baseline|metric-caps)\.json$`.
- Structural/metadata fields (`version`, `updated_at`, `_comment`) are ignored — only the typed
  water-line keys above are compared.

---

## 3. Mechanism — retarget `config-loosening-gate.ts`

The whole pipeline already exists and is dogfood-proven. Lift the shared parts into a small util both
import (don't duplicate):

- **`src/harness/evaluator/git-head-read.ts`** (new) — extract `readHeadVersion(file)`,
  `readDiskContent(file, cwd)`, `reconstructEditContent(current, old, new)`, `safeJsonParse(text)`
  from `config-loosening-gate.ts`; re-export from there so its 57 tests stay green.

- **`src/harness/evaluator/baseline-integrity-gate.ts`** (new) — modeled on config-loosening:
  - `detectBaselineGaming(filePath, beforeText, afterText): BaselineGamingFinding[]` — pure-function
    per-file detectors implementing §2's direction table. New file (`!beforeText`) → `[]`. Unparseable
    proposed JSON → `[]` (fail-open; the file is the harness's own, a corrupt write breaks the ratchet
    loudly elsewhere).
  - `evaluateBaselineIntegrityForEvent(event): HarnessDecision | null` — mirrors
    `evaluateConfigLooseningForEvent`: handle `Write` (`tool_input.content`) and `Edit`/`Update`
    (`old_string`→`new_string` via `reconstructEditContent`); read HEAD via the shared util; return a
    decision when findings exist.

---

## 4. Decision mode & FP guards

- **Decision: `block`** (severity `high`, `rule_id: "baseline_integrity_gate"`), **not `ask`**.
  Rationale: unlike a legitimate tsconfig relaxation (which `ask` fits), there is **no honest reason
  for an *agent* to hand-lower a committed water-line.** Open decision §9-(a) if you'd rather start at
  `ask`.
- **Internal-write immunity (the main FP trap, structurally avoided).** The harness's own legitimate
  high-water raises go through internal `fs.writeFileSync` (`writeFileCoverageBaseline` at
  `coverage-write-guard.ts`, `coverage-ratchet.ts`, `mutation-gate.ts`) — **never** the agent's
  Write/Edit tool — so they never reach a PreToolUse tool-call gate. Confirmed.
- **Key-removal nuance.** Removing a `coverage`/`mutation` entry is legit *iff the source file was
  deleted*. The detector does an `existsSync` on the keyed source path: still-present → block the
  removal (gaming); gone → allow. Cheap, eliminates the "deleted a module, cleaned its baseline" FP.
- **Bypass:** `INTERLINKED_DISABLE_BASELINE_GUARD=1` (logged), for the rare intentional human reset /
  ratchet-down campaign — mirroring `INTERLINKED_DISABLE_PACKAGE_GUARD`.
- **Fail-open** on git/parse/IO error, per `feedback_safety_continuity`.

---

## 5. Tool coverage & defense-in-depth

- **v1 PreToolUse covers `Write` + `Edit`/`Update`** (exactly what config-loosening covers).
  `MultiEdit` / `apply_patch` reconstruction is harder → fail-open at PreToolUse, **caught by the two
  backstops below.** (Open decision §9-(c): extend reconstruction to MultiEdit now or follow-up.)
- **Backstop 1 — verify-only `baseline_integrity` check** (default gate, not advisory): diff
  `git show HEAD:<f>` vs working-tree disk for each baseline; reuses `detectBaselineGaming`. Catches
  any tool, CI-gateable. Register in `VERIFY_ONLY_CHECKS` (like `gitignored_written_config`).
- **Backstop 2 — commit-gate**: run the same HEAD-vs-staged diff in `commit-gate.ts` so a tampered
  baseline can't be committed regardless of how it got to disk.

---

## 6. Wiring checklist

1. `evaluator/git-head-read.ts` — extract shared util; `config-loosening-gate.ts` imports from it.
2. `evaluator/baseline-integrity-gate.ts` — detectors + event entry point.
3. `evaluator/pre-tool-guards.ts` — add `evaluateBaselineIntegrityGate(event, toolName, warnings)`
   wrapper mirroring `evaluateConfigLooseningGate` (`:228`).
4. `evaluator/pre-tool.ts` — add `() => evaluateBaselineIntegrityGate(event, toolName, warnings)` to
   the guard thunk chain adjacent to `:162`.
5. Verify-only surface — `src/commands/verify/` + `VERIFY_ONLY_CHECKS`; formatter wiring.
6. `commit-gate.ts` — add the staged-baseline check.
7. `check-metadata.ts` — metadata entry (determinism `fully_deterministic` → `[proven]`).
8. Docs: regenerate (`npm run docs`); add a CLAUDE.md bullet under the ratchet sections.

---

## 7. Tests (`baseline-integrity-gate.test.ts`)

Per the agent-quality convention, ≥3 positive / ≥3 negative — and explicitly exercise **each
direction**, especially the inverted ones:

**Positive (block):** lower a `coverage` `lines_pct`; lower a `coverage-edit` value; lower a mutation
`score`; raise `metric-caps.max_cyclomatic`; raise `large-files.max_lines`; raise a grandfather
`count`; add a new grandfather entry over cap; **lower `untested-files.min_coverage_pct`**; **add a
path to the `untested-files` exemption array**; remove a coverage entry whose source still exists.

**Negative (allow):** raise a coverage pct; add a new covered file; remove a coverage entry for a
**deleted** source file; lower `max_lines`; lower a grandfather count; remove a resolved grandfather
entry; raise `min_coverage_pct`; remove a path from the exemption array; tighten a `metric-cap`; a
brand-new baseline file (no HEAD); the harness's internal-write shape (sanity).

---

## 8. Dogfood plan

This repo commits `coverage-baseline.json`, `coverage-edit-baseline.json`, `large-files-baseline.json`,
`untested-files-baseline.json` — the perfect target.
1. Run the verify-only `baseline_integrity` over the current tree → expect **zero** findings
   (committed == HEAD water-lines).
2. The agent's normal flow never hand-edits these files, so the PreToolUse gate is silent in practice —
   it fires only on the exact gaming move. Ship it default-on.
3. Smoke: make a coverage-*improving* edit and confirm the harness's own baseline raise (internal fs
   write) does **not** trip the gate (proves the internal-write immunity).

---

## 9. Open decisions (resolve before build)

- **(a) Decision mode:** `block` (recommended — no honest agent reason to loosen) vs `ask` (softer
  start, matches config-loosening's precedent).
- **(b) `coverage-edit-baseline.json`:** guard it too (recommended — it backs the per-edit coverage
  gate) or scope v1 to the five "classic" baselines?
- **(c) `MultiEdit`/`apply_patch`:** reconstruct at PreToolUse in v1, or rely on the verify +
  commit-gate backstops and add reconstruction as a follow-up (recommended for a tight v1)?
```
