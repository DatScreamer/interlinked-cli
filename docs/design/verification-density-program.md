# Verification-density program

Status: **Phases 0–4 + Track A lanes 1–2 landed** (2026-07-26); lane 3 partial.
Supersedes CLAUDE.md step 7 ("≥3 negative / ≥3 positive cases").

## What landed

| Piece | State |
|---|---|
| Phase 0 — Check Evidence Contract | `src/harness/check-evidence/` (types, tiers, case parser, resolver, sweep, baseline) |
| Phase 1 — the pin | `contract.test.ts`; 113 of 251 checks grandfathered, shrink-only, gate-protected |
| Phase 2 — corpus dogfood | `corpus.ts` + `corpus-scan.ts`, adjudication model, `.interlinked/check-corpus.json` |
| Phase 3 — recall | `recall.ts`: derived case floors from detector branch structure + detector mutation scores |
| Phase 4 — independent adversary | `adversarial.ts`, source-hash-bound so a rewritten detector re-opens the review |
| Lane 1 — quality metrics | `halstead_difficulty` (advisory, **verify-only**), Halstead + MI in `checks/maintainability.ts` |
| Lane 2 — property tests | `property_test_candidate` (advisory, **verify-only**), complements the existing `property_test_gap` |
| Lane 3 — fuller mutation | Operator coverage declared + pinned (`stryker-mutators.test.ts`). **Defaulting `per_edit_mutation` on is NOT done** — that needs per-edit latency measurement against `budget_ms` on real edits, which has not been run. |

Enforcement is staged through the baseline's `enforced` field, which is
GROW-ONLY under the baseline-integrity gate. At landing: `["cases"]`. The
corpus, derived-case, mutation and adversarial dimensions are measured and
reported but do not yet fail the pin — switching one on is a deliberate
ratchet step once its backlog is backfilled.

### Both new checks are verify-only, on evidence

Neither lane-1 nor lane-2 runs on the per-edit hook path, and both were moved
there after measurement rather than by preference:

- `property_test_candidate` reads the module's companion test files, so it is
  not the pure `(content, filePath)` function the PostToolUse registry contract
  requires. Registered inline, it made `determinism-conformance` flap — green
  alone, red in the full suite where other tests create and remove files
  concurrently.
- `halstead_difficulty` IS pure, but costs a full TS parse plus a per-token
  tally per file. On the inline path it pushed the same conformance suite (18
  inputs x 3 runs) past its 30s budget.

Both are advisory taste checks that fire ~17 and ~62 times across the whole
repo. That is deep-audit cadence, not per-keystroke cadence. The general rule
this establishes: **a check earns per-edit latency by catching defects, not by
expressing taste.**

### The corpus obligation earned its keep immediately

`halstead_difficulty` was first calibrated on unit-test fixtures, where a
difficulty ceiling of 25 separated dense from ordinary code cleanly. The corpus
run over 9023 real functions showed 25 is the **75th percentile** — it produced
2226 findings. Recalibrated to 80 (just under p99.9), it produces 17. The
fixtures were not wrong, they were unrepresentative, which is the entire thesis
of Phase 2 and the reason defect #2 was worth fixing.

## Thesis

Agent write-speed should be spent on verification density, not output volume.
This repo already enforces that on the *product* code: coverage, cyclomatic,
cognitive, CRAP, mutation, line-cap, all per-edit. It does **not** enforce it on
the *checks themselves*. The checks are the thing everything else trusts, and
they are the least-verified code in the tree.

Two halves:

- **Phase 0–3** — make the checks trustworthy. Replace the unenforced
  case-count convention with a measured, phase-scaled evidence contract.
- **Track A (lanes 1–3)** — add per-edit verification density: more quality
  metrics, property tests, fuller mutation.

Out of scope (deliberately): performance and jitter/concurrency testing. Both
are nondeterministic and slow, which violates the hook-path contract
(`feedback_harness_deterministic_only`; sub-10ms guard eval). They belong in
the cloud lane — see `docs/plans/06-cloud-metrics-program.md`.

## Why the "≥3 positive / ≥3 negative" rule is being replaced

Measured 2026-07-26: **13 of 100** check test files use the labeled
MUST-NOT-FIRE convention. Nothing enforces it — no meta-test, no lint. It is
the only policy in this repo with no pin, which is precisely why compliance is
13%. `DEFAULT_ADVISORY_SKIPS` is pinned, `DEFAULT_MAX_LINES` is pinned, check
counts are pinned by `check-inventory.test.ts`; the case-count rule is prose.

Five defects, and what replaces each:

| # | Defect | Replacement |
|---|---|---|
| 1 | Unenforced prose → decays to 13% compliance | Meta-test pin over `CHECK_REGISTRY` (Phase 0) |
| 2 | Hand-authored fixtures only cover FPs the author already imagined | Corpus dogfood obligation: run the detector over the tree; every legitimate hit becomes a required negative (Phase 2) |
| 3 | False negatives are invisible — recall is never measured | Mutation-test the detector function itself (Phase 3) |
| 4 | A flat "3" ignores risk tier: a `pre_block` hard-block and an advisory taste check get the same floor | Obligations derived from the detector's own branch structure, scaled by phase (Phase 3) |
| 5 | The check author writes their own adversary — same blind spot | Recorded independent FP-hunting pass (Phase 4) |

### The number was always a proxy

"3" stands in for the real question: *does every distinguishable behavior of
the detector have a case, in both directions?* If a detector has exactly one
legitimate shape it must stay silent on, one negative is **complete** and three
is padding. If it has twelve, three is negligent. So the obligation is derived,
not declared:

> Every branch of the detector function must be exercised by at least one
> labeled case, and each direction the detector can decide (fires / stays
> silent) must have at least one case. The count falls out of the detector's
> own structure.

This is mechanically checkable — branch coverage of the detector plus a
mutation score on it — which is what makes it enforceable where the flat count
was not. It also answers the "what if there's only one?" case directly: one
case in a direction is sufficient **iff** it covers the branch. The floor is
per-branch, not per-check.

## Phase 0 — the Check Evidence Contract (CEC)

One record per registered check id, derived from live sources, never
hand-maintained:

```
CheckEvidence {
  check_id            // from CHECK_REGISTRY
  phase               // pre_block | pre_warn | post — sets the obligation tier
  detector_fn         // the `fn` symbol + its source file
  test_file           // resolved companion test
  positive_cases      // labeled MUST-FIRE cases found
  negative_cases      // labeled MUST-NOT-FIRE cases found
  branch_coverage     // of detector_fn only
  mutation_score      // of detector_fn only (Phase 3)
  corpus_run          // tree-walk record: hits, adjudications (Phase 2)
  adversarial_pass    // independent FP hunt record (Phase 4)
}
```

Obligation tiers — a `pre_block` check hard-blocks a write, so a false positive
bricks an edit; an advisory `post` check firing spuriously in `--all-checks`
costs nothing. They must not share a bar:

| Phase | Branch coverage | Both directions | Corpus | Mutation | Adversarial |
|---|---|---|---|---|---|
| `pre_block` | 100% | required per branch | required, zero unadjudicated hits | required | required |
| `pre_warn` | 100% | required per branch | required | required | recommended |
| `post` (default gate) | ≥90% | required per branch | required | recommended | optional |
| `post` (advisory) | ≥80% | ≥1 each direction | recommended | optional | optional |

Storage: `.interlinked/check-evidence.json`, committed, **tighten-only** under
the existing baseline-integrity gate (`baseline-integrity-gate.ts`) — the same
reasoning as every other water-line: the agent being gated can write the file,
so loosening it is the canonical gaming move. Register it in the gate's file
table with direction `tighten-only` for thresholds and `shrink-only` for any
exemption list.

Surfaced by `interlinked harness checks --evidence` and as a `verify` section.

## Phase 1 — the pin (fixes defect 1)

Meta-test walking `CHECK_REGISTRY`, asserting each check meets its tier's
obligation. Ships with a grandfather list seeded from the current 87% gap so
the suite stays green on landing; the list may only shrink (same contract as
`large-files-baseline.json`). New checks get no grandfathering — the contract
is a hard gate from day one for anything added after this lands.

This is the highest-value single step: it converts the policy from prose to a
number and immediately reports the true size of the gap.

## Phase 2 — corpus dogfood (fixes defect 2)

`recurrence scan` already walks the working tree running inline detectors. Wire
it to check authoring: a candidate detector must run over the tree, and every
hit must be adjudicated as either a true positive (real bug — fix it) or a
false positive (legitimate shape — becomes a required negative case). The
adjudication record lands in the evidence file.

Precedent: `nan_coercion_guard` shipped by finding and fixing 2 real instances
in `sponsor/types.ts`. That happened by good judgment, not by obligation. This
makes it the obligation.

Note the failure mode this also exposes: `introverted_test` reported 0/791
dogfood hits and that reads as a clean result — but it is indistinguishable
from a detector that does not work. A zero-hit corpus run is not evidence of
correctness; it is a demand for Phase 3.

## Phase 3 — recall, and derived obligations (fixes defects 3 + 4)

Mutation-test the detector functions themselves, reusing `src/harness/mutation/`
(the machinery exists — stable mutant identity, receipts, cloud runner). A
surviving mutant in a detector means the test cases cannot tell the difference
between the detector and a subtly broken version of it, which is exactly the
false-negative signal that is invisible today.

Branch coverage of the detector supplies the derived case count from Phase 0's
rule. Both feed the tier table.

## Phase 4 — independent adversary (fixes defect 5)

A recorded pass whose only job is "find code this detector wrongly flags,"
performed independently of the detector author. The repo already has the
culture (refute-by-default verifiers, the Codex review loop); this points it at
check authoring, where the blind spot is most structural. Required for
`pre_block`, recommended for `pre_warn`.

## Track A — per-edit verification density

### Lane 1 — expand quality metrics (start here)

Purely additive; reuses `metric-caps.json`, the slew-ratchet pattern from
`docs/design/monotonic-metric-ratchet.md`, and the baseline-integrity gate.
Nearly no new architecture.

- Halstead volume / difficulty / effort
- Maintainability index (composite; derives from Halstead + cyclomatic + LOC)
- Fan-in / fan-out caps per module (the project-graph already computes Ca/Ce
  for `metrics arch` — promote to a capped, ratcheted metric)

Each lands as a metric with a cap, a per-edit delta guard, and a tighten-only
water-line — the pattern is established, so this is mostly wiring.

### Lane 2 — property tests

New check family. Static detection: an edit adds or modifies a pure exported
function with ≥2 parameters and no fast-check property covers it → advisory
warning naming the function and a suggested property shape. Plus a
`metrics property` view of property coverage across the tree.

`fast-check` is already a dev dependency and already used in
`reservations.test.ts` — the precedent exists, nothing requires it.

Deliberately advisory at v0, precision-first, following the `introverted_test`
model: untraceable purity → silent. Ratchet advisory → default → block only
after corpus adjudication under Phase 2.

### Lane 3 — fuller per-edit mutation

`per_edit_mutation` exists and defaults off. Work is operator-coverage
expansion and making the `budget_ms` story honest enough to default on. Last of
the three because it carries real latency risk on the hook path.

## Build order

1. Phase 0 + 1 (contract + pin) — tells us the true gap size
2. Lane 1 (quality metrics) — additive, established pattern
3. Phase 2 (corpus dogfood)
4. Lane 2 (property tests) — first new family under the full contract
5. Phase 3 (detector mutation / recall)
6. Phase 4 (adversarial pass)
7. Lane 3 (fuller mutation)

Phases 0–1 gate everything after them: no new check family should land before
the contract exists to hold it, or lane 2 just adds to the 87% gap.
