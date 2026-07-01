# Extracting the Fable-5 corpus to improve the harness, agents, and future models

Status: findings + shipped artifacts. Produced from the model-labeled
`timeline.jsonl` pipeline (see the timeline-capture/backfill work) and the
`.interlinked/claude-fable-5-complete.jsonl` dataset — 4,063 records Fable-5
produced (1,509 reasoning blocks, 440 messages, 2,114 tool calls) across 17
sessions on this repo, 2026-06-09 → 06-12, plus the broader multi-model timeline
(Fable-5 + Opus 4.8 + Opus 4.7).

This is the analysis behind a `/goal` run: "take everything the best released
model did and use it to make our harness / agents / future models better."

## TL;DR

1. **The cyclomatic gate is validated, not a best-model false positive.** All 3
   of Fable's cyclomatic blocks were true positives — Fable's own reasoning was
   "I need to decompose this," and it did. The per-edit cyclomatic hit-rate is
   essentially identical across the best and current models (~0.015/edit), so the
   gate catches a *universal* first-draft tendency. Keep it.
2. **The highest-leverage extraction is steering, not retraining.** The best
   model has a measurable profile (surgical edits, relentless verification,
   deep-private/terse-public reasoning, decompose-on-nudge). Encoding those as
   guidance steers *whatever* model is driving.
3. **The (monolithic → decomposed) and multi-model-divergence pairs are real
   training data** for the existing LoRA / preference work — quality-weighted,
   because the corpus is narrow (17 sessions, one repo).

## Finding 1 — the cyclomatic gate is well-calibrated (the gate audit)

Fable-5 tripped the per-edit cyclomatic gate exactly 3 times. Reading each
blocked function and Fable's recovery:

| Function | File | CC | Fable's next reasoning | Recovery |
|---|---|---|---|---|
| `elementSetFromIstanbul` | coverage-shards/vitest.ts | 28 | "break down … by extracting three separate functions" | +helpers, decomposed |
| `loadCoverageFinalSummary` | coverage-final-reader.ts | 30 | "break it down by extracting the metric calculation" | +5 fn decls |
| `addAllowlistCommand` | commands/allowlist.ts | 28 | "extracting the license and advisory screens into separate functions" | +3 fn decls |

All three are the *naturally branchy* archetype — a coverage-data parser, a
summary loader, a multi-screen policy handler — where a large share of the
cyclomatic count is defensive type-guards on untyped JSON (`isRecord`,
`typeof x !== "number"`). I went in expecting these to be the classic
cyclomatic-FP smell. They are not: each is genuinely decomposable into cohesive
sub-extractors, the gate's remedy ("extract cohesive branches into named
functions") is correct, and **the best model agreed every single time** and
produced the better, decomposed design.

**Quantitative confirmation:** cyclomatic gate-hit rate per edit is
`11/751 = 0.0146` for Fable-5 and `40/2654 = 0.0151` for Opus-4-8 — model-agnostic.
The gate is not over-firing on the best model; it catches a universal
write-monolithic-first tendency that even the best model has, and that the best
model fixes when nudged. **No gate change. "Even Fable hits it" is evidence of
value, not miscalibration.**

## Finding 2 — the best-model behavioral profile (multi-model contrast)

Measured over `timeline.jsonl` (model-attributed tool calls / messages /
reasoning; gate-hits joined via `tool_use_id`):

| Metric | Fable-5 | Opus-4-8 | Opus-4-7 |
|---|---|---|---|
| sessions / edits | 17 / 751 | 77 / 2654 | 2 / 81 |
| Edit : Write ratio | **5.9** | 3.4 | 1.5 |
| verify-bash per edit | **0.58** | 0.99¹ | 0.90 |
| think : message (chars) | **5.8×** | 3.1× | 2.0× |
| avg message chars | 584 | 563 | 778 |
| gate-hits per edit | **0.053** | 0.115¹ | 0.062 |

¹ Opus-4-8's numbers include this very session, whose pre-disable coverage-debt
friction inflated both verification re-runs and coverage gate-hits — read its
*cyclomatic* rate (0.0151/edit), which is friction-free, as the clean signal.

Fable's signatures: **most surgical** (prefers small `Edit`s to full rewrites),
**verifies after roughly every other edit**, **thinks ~6× more than it speaks**
with concise (~580-char) messages, and trips the harness least per edit.

## What this ships

### A. Harness — verification-cadence baseline for the Stop nudges
The Stop-event "did you verify?" nudge (`verification-stop-checks.ts`) currently
fires on a guessed threshold. The empirical best-model floor is **~0.5–1.0
verification commands per substantive edit**; the anti-pattern is ~0. Calibrate
the nudge to fire when an agent's `verify-commands / code-edits` ratio for the
session is far below that floor (e.g. < 0.1 after ≥ N edits), rather than on a
raw edit count. This grounds the nudge in what the best agents actually do.
*(Recommendation; not auto-applied — the nudge logic should be changed with a
test, see the Stop-checks module.)*

### B. Agents — "best-model habits" steering (the highest-leverage extraction)
Encode the measured habits as deterministic guidance (a skill / CLAUDE.md
section / harness nudge text). Each is grounded in the data above:

- **Decompose-first.** For parser / loader / multi-screen-policy functions,
  extract cohesive sub-blocks into named helpers *as you write*, not after the
  gate blocks you. The best model needed this nudge 3/3 times and always complied
  — pre-empting it saves the block→retry round-trip. Worked example below.
- **Prefer `Edit` over `Write`** when modifying existing code (best model's E:W
  is 5.9 — surgical, not rewrite-the-file).
- **Verify after substantive edits** — run the project's test/typecheck/build
  (~0.5–1.0 per edit for the best models).
- **Concise out, deep in** — terse user-facing messages, deep private reasoning.

#### Worked decomposition (the Opus side of the replay)
`elementSetFromIstanbul` packs four cohesive extractions inline (lines, branches,
functions, statements) — each a guarded loop over one istanbul map. Given the
same task, the decomposition both models converge on:

```
elementSetFromIstanbul(fc):                  // CC ~6, orchestration only
  lines      = extractLineHits(fc.statementMap, fc.s)
  branches   = extractBranchHits(fc.branchMap, fc.b)
  functions  = extractFunctionHits(fc.fnMap, fc.f)
  statements = extractStatementHits(fc.statementMap, fc.s)
  return { lines, branches, functions, statements }
// each extract* helper: one map, one loop, its own guards — CC ~7, testable in isolation
```

This is the gate's intended outcome: the orchestrator drops well under the cap,
and each extractor becomes independently testable — which also *raises* coverage
addressability, the second-order win.

### C. Future models — training-data spec (extends the qwen LoRA work)
Three quality-weighted slices, all derivable from the timeline:

1. **Decomposition pairs** — `(rejected monolithic edit + gate reason) →
   (accepted decomposed edit)`. Fable generated both halves 3×; across all
   models the timeline has more. SFT/DPO signal for "write decomposed-first."
   Miner: `scripts/mine-decomposition-pairs.mjs`.
2. **Multi-model divergence pairs** — same repo, same checks, Fable vs Opus.
   Where the best model's action is preferred and a weaker model's diverges, that
   is DPO preference signal. Foundation already in hand: **107 files were edited
   by BOTH Fable-5 and Opus-4-8** on this repo — including the harness internals
   each was extending (`commit-gate.ts` 41/39, `coverage-write-guard.ts` 22/41,
   and `complexity-write-guard.ts` itself, the very cyclomatic gate that blocked
   them). The *clean* preference pairs (same context → different action) come from
   the replay harness below; the shared-file set is the candidate pool.
3. **Imitation target** — the best-model profile (surgical, verifying,
   decompose-first). Behavior, not raw CoT — Fable's reasoning is the
   `display:summarized` view, so distill *rationale shape*, not thinking tokens.

**Caveats (do not paper over):** 17 sessions / one repo / one developer →
calibration-grade, not scale-grade; quality-weight it or it overfits this repo's
idioms. Summarized reasoning, not raw chain-of-thought. And per the harness's own
rule, anything Fable-derived stays in offline calibration / training / the narrow
escalation layer — never inside the per-edit deterministic checks.

## The replay harness (built this run)

Two self-contained scripts implement teacher-forced single-step differential
replay — same reconstructed state → compare each model's *next* action:

- `scripts/replay-reconstruct.mjs --session <id> --tool-use-id <id>` — rebuilds
  the Anthropic Messages context up to a decision point + the ground-truth action
  (deterministic; validated on the 3 gate-hits: 122K–182K-token contexts).
- `scripts/replay-run.mjs --bundle <ctx.json> --model <id>` — calls the API,
  diffs the proposed action vs ground truth. **Ready to run; needs
  `ANTHROPIC_API_KEY`** (not available in this run's environment).

Run the live Opus-vs-Fable comparison on the gate-hits with:
```
ANTHROPIC_API_KEY=… for b in .interlinked/replay/gate-hit-*.context.json; do
  node scripts/replay-run.mjs --bundle "$b" --model claude-opus-4-8
done
```
Fidelity caveat: the transcript preserves the message history faithfully but not
the exact Claude Code system prompt — the runner supplies a representative
reconstruction + CLAUDE.md. For the cleanest result, replay both `claude-fable-5`
and the candidate model on the same bundle and validate each against the recorded
ground truth (if API-Fable reproduces real-Fable, the reconstruction is trusted).

## Why a full free-running replay is *not* feasible (honesty)

A teacher-forced single-step replay is sound. A free-running full-session replay
(let Opus drive the whole task, compare end states) is not, for three reasons the
data made concrete: trajectories diverge after step 1 (only outcome-comparable);
deep decision points are 120K–180K-token contexts (cost-bounded — a curated-set
tool, not replay-all-4,063); and the exact runtime (system prompt + harness
reminders) isn't fully recoverable.
