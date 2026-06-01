# Maximal Local Enforcement — Roadmap

**Status:** living plan. Companion to `docs/design/test-quality-harness-local-first.md` (the detailed four-lane design); this doc is the higher-level status + sequencing for the "make the product fully opinionated" campaign.

## Thesis

The CLI harness/daemon enforces the **maximal set of deterministic checks at runtime** — PreToolUse / PostToolUse / Stop, on every tool call — **locally**, and **dogfoods them on its own codebase first**. Anything that fits the ~25s PreToolUse window stays local; only LLM-judgment review, multi-agent/multi-human aggregation, and embarrassingly-parallel heavy compute (hub-file / whole-repo mutation) go to the cloud. **The harness's own code must always pass the maximally-enforced rule set** — promoting a check is gated on the harness itself being clean for it.

## Shipped this campaign

| Item | Result | Commit |
|---|---|---|
| Coverage keystone | `@vitest/coverage-v8` wired, scoped to `src/`, feeds CRAP + the ratchet | `27c9416` |
| File-size cap 1500→1000 | 15 over-cap modules decomposed; 3 grandfathered pending | `ce71204`, `c36a17f` |
| Advisory-promotion audit | All 112 demoted checks measured; the set is well-calibrated (the rest are genuinely high-FP or language-specific) | — |
| 4 checks promoted to default gate | `type_smuggling`, `fetch_without_timeout`, `silent_demo_fallback`, `circular_imports` — 26 findings fixed (incl. a latent `explain.ts` bug), harness passes them | `4b29157` |

## Prerequisite for #2/#3 — "cut the full coverage baseline"

**What it means:** run the *whole* test suite under coverage (`npm run test:coverage` = `vitest run --coverage`) on a stable, committed tree, producing `coverage/coverage-final.json` (per-function, all files) and `coverage/coverage-summary.json` (per-file %). Then **freeze that as the committed baseline** with `interlinked coverage --update-baseline` → `.interlinked/coverage-baseline.json`.

- **"Full"** distinguishes it from the scoped 3-file proof already run (which only covered the trigram files). The baseline must reflect the *entire* codebase.
- **"Cut"** = generate + commit the snapshot, like cutting a release baseline — reproducible because the tree is committed.
- It unblocks **#2** (CRAP gets real per-function coverage → real scores instead of fail-open) and **#3** (the ratchet has a per-file floor to enforce).
- Must run on a **stable, committed tree** (which we now have, post-C1/C2) so the numbers are reproducible.

## Shared keystone — the test-coverage *map* (distinct from the baseline, and unplanned)

Separate from the coverage *baseline* above, and more structurally important — it's the recurring keystone-omission pattern across the whole doc set, named once where it belongs instead of as a per-feature footnote. The **test-coverage map** — *which tests cover this line/function* — is **not** the baseline: the baseline says *how much* is covered (per-file %, per-function), the map says *by what*. It is marked **❌ does-not-exist** in `harness-system-diagrams.md` §3, needs **per-test instrumentation** (not a per-run report), and is **not yet planned anywhere**.

It is **not an #9 prerequisite** — it is a **three-feature keystone** three separate features each silently assume:
- **#9 mutation-scoping** — which covering set to run per mutant (else whole-suite-per-mutant, blowing the fan-out floor).
- **§13 smart-selection** — which covering tests to run for an edit (the entire selection substrate depends on it).
- **diff-coverage left-shift** — running the covering set speculatively at PreToolUse (`harness-system-diagrams.md` box 6).

**Schedule it as its own infrastructure work**, not as a footnote on whichever feature trips over it first. Naming it per-feature is how three docs each conclude they independently need it; naming it once is how it gets built.

## Remaining tasks

### #2 — CRAP → default gate
Promote `crap` out of `DEFAULT_ADVISORY_SKIPS`. **CRAP = `comp² × (1 − cov)³ + comp`** per function — the canonical Crap4J metric (Savoia/Evans, 2007), and *exactly* what `src/harness/checks/crap.ts::crapScore` computes (verified). The coverage term **gates** the squared term: at full coverage `(1 − cov)³ = 0`, so a fully-covered function scores `CRAP = comp` (bare complexity) — complexity-10 fully covered scores **10**, not 100. Only *complex AND under-covered* functions score high (complexity-5 at 0% coverage = **30**, the boundary), which is the metric's whole point. The **≈30 threshold is Crap4J's own**, native to *this* formula, so the borrow is valid here.
> **Cross-doc consistency fix (this doc + the code are correct):** the §2.3 CRAP primers in `docs/test-quality-harness-plan.md` and `docs/design/test-quality-harness-local-first.md` carried a non-canonical `complexity × (1−coverage)²` — **both corrected to canonical in this pass.** (An earlier draft of this note blamed `three-tier-architecture-v2.md`, which on audit doesn't mention CRAP at all — verify-before-correct caught the misattribution; the real two were found by grep.) The user's external "Level-1 explainer" carries the same simplified form and should be corrected there too. A 30-threshold against the simplified form would be the miscalibrated gate; against the canonical form it is correct.

**Depends on the full coverage baseline.** After the baseline: audit findings (the scoped run's counts were inflated by *partial* coverage — full coverage deflates them), confirm the threshold against real data, fix/justify the genuine hotspots, then promote. The harness's own functions must clear it.

### #3 — Coverage ratchet → default gate
After cutting the baseline: wire the per-file ratchet (no file may drop below its baseline coverage %) into the default gate, plus diff-aware "are my new lines hit?" piggybacked on the agent's own test run at PreToolUse. **Depends on the full coverage baseline.**

### #4 — Every-file-tested (both signals)
Companion-existence *nudge* (extend the new-file gate to flag existing source lacking a companion, exemption-aware: barrels / `types/` / entry / config / consolidated-covered) **+** coverage-backed gate (a file satisfies policy if a companion exists **or** it's covered). Current companion coverage is 79% (a floor — it undercounts consolidated tests). **The coverage half depends on the baseline.**

### #5 — Red-then-green (Stop nudge, new-symbol-only)
Require a net-new public symbol's companion test to be observed **red→green** before impl is "done." Refactor/backfill **exempt** via `behavioral-diff-checks.ts` (API-stable diff) — without that exemption it punishes refactoring/characterization (the decompositions this campaign ran would have tripped it). Ship as a Stop nudge first; promote to block after FP-rate is known. **No coverage dependency — buildable now.**

### #6 — Property tests on the pure primitives
fast-check on the units the decomposition exposed: `trigram` pack/unpack round-trip, detector "never throws on arbitrary input," CRAP monotonicity. Fixed-seed + bounded-N, kept **out of** mutation's covering set (nondeterminism vs. the deterministic-harness rule). Encouraged, not gated; an advisory "exported pure fn without a property test" check is optional. **Buildable now.**

### #7 — Complexity / cyclomatic: refine → promote
`complexity:103`, `function_arg_count:84`, `loop_nesting_depth:43` are high-FP today (generated/barrel/data files). Refine detection to exempt those before promoting; otherwise the line cap remains the enforced coarse proxy. Lower priority.

### #8 — Cap 1000 → 800 → 500
Once the 3 grandfathered files land and the tree settles, ratchet the cap further (hub-first, graph-guided, importers re-pointed to narrower shards). Below ~500, stop using the line cap and let complexity/CRAP nominate the genuinely-bad sub-500 files.

### #9 — Mutation (diff-scoped, local + cloud-fan-out)
Install Stryker, wire `mutation-gate.ts`. The strongest anti-gaming signal; keep property tests out of the covering set.

> **Prerequisite — the test-coverage *map* (see "Shared keystone" above), not the baseline.** Diff-scoped mutation needs the covering set per mutant; until the map exists, mutation runs the *whole suite per mutant*, blowing the covering-suite-runtime floor the fan-out premise rests on. This isn't #9's private problem — it's shared infrastructure that §13 smart-selection and diff-coverage left-shift need too.

- **Local:** leaf/mid diff-scoped at PreToolUse (5–20 mutants fit one machine in the window).
- **Cloud, also targeting ~25s:** mutation is *embarrassingly parallel*, so fan **all** mutants out concurrently across sandboxes and the wall-clock is **constant in mutant count**: `t ≈ sandbox_warmup + one_mutant_covering_suite_runtime`. The claim *"whole-repo (80–150 mutants) fits ~25s with one sandbox per mutant"* is a **model — measurement-pending (Phase 3.5)**: constant-in-count is sound, but `sandbox_warmup` is the unvalidated term that could blow it.
  - **The irreducible floor is the covering-suite runtime** — exactly what the smaller-files (#8) + test-runtime-ratchet work shrinks; the decomposition campaign feeds *directly* into making cloud mutation fit. One latency budget, two substrates.
  - **Levers:** pre-warmed sandbox pool; ship the diff not the repo (content-addressed, one-file overlay per sandbox); sufficient concurrency.
  - **Caveats:** cost scales with concurrent sandboxes (gate on diff size / sample); a genuinely-slow covering suite (>25s) can't be fan-out-rescued; the PreToolUse network round-trip eats budget. Distinct from the multi-agent *sync-barrier* latency.

### Loose ends
- **Decompose the 3 grandfathered files** — `pre-tool.ts` (1469, safety-critical evaluator), `hooks-template.ts` (1246) + `hook-template-chunks/session-state.ts` (1396, byte-identical codegen templates). Removing them empties the grandfather list → clean cap=1000.
- **`circular_imports` cost cache** — now a default gate; the per-edit DFS can be slow on graph hubs. Add a cross-edit walk cache (its own rationale's noted follow-up) to bound the cost.
- **dep-audit: 2 critical** — chase the criticals introduced by the `@vitest/coverage-v8` transitive tree (`npm audit`).
- **Floating-promise** in the file-checks group modules — pre-existing, flagged during the circular-imports refactor; clean up.

## Adjacent work — out of this campaign's scope, cross-referenced

This roadmap is deliberately scoped to *local deterministic checks*; keeping that scope tight is a virtue. But three threads we've affirmed as priorities live (or should live) elsewhere — cross-referenced here so the doc isn't mistaken for the whole near-term plan:

- **Durable trajectory + finding substrate (the persistent receipt / finding ledger).** Principle #7 in `harness-system-diagrams.md` requires every PostToolUse steer to *also write a durable finding*, so steering serves future agents and humans — not just one session. That substrate (receipt ledger Phase 0.3 + finding history Phase 0.4 in `test-quality-harness-local-first.md`; `docs/design/trajectories-as-primitive.md` + `trajectory-sequence-detectors.md` + `trajectory-integrity.md`) is **⬜ everywhere** and is the write-target several checks above assume. Out of scope for a *checks* campaign, but its precursor is load-bearing for all of them.
- **Graph-prediction protocol** (`docs/design/graph-prediction-protocol.md`) — a PreToolUse awareness gate, local and deterministic-adjacent, **already shipping in shadow mode**. A near sibling of #5/#6 (buildable-now local gates); tracked separately only because it's prediction-based, not purely deterministic. Promote it on the same dogfood discipline as everything here.
- **The validation join — the prerequisite for promoting *any* predictive gate.** Before graph-prediction (or any predictive signal) may *block*, the §18-RFC logic requires proving **prediction accuracy actually predicts defects** — the join between predicted outcome and observed defect. Now homed in **`docs/design/predictive-gate-validation-join.md`** (a precondition spec with an acceptance bar + a named substrate dependency, not a backlog paragraph). It gates #9's predictive scoping and graph-prediction's promotion alike, and is itself blocked on the durable-substrate decision.

## Sequencing

1. **Now:** cut the full coverage baseline → unblocks #2 and #3.
2. **#2 (CRAP→gate) + #3 (ratchet)** — parallel, both off the baseline.
3. **#4** every-file-tested (coverage-backed half).
4. **#5 red-then-green + #6 property tests** — buildable now, parallel with the above.
5. **Decompose the 3 grandfathered files** → cap fully clean at 1000.
6. **#8** cap 1000→800→500 (ongoing ratchet).
7. **#7 complexity refine, #9 mutation, circular_imports cache, dep-audit** — as capacity allows; #9 is the largest and reaches into the cloud tier.
