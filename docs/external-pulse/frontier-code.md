# FrontierCode — Code-Quality / Mergeability Benchmark (Cognition)

- **Source:** https://cognition.ai/blog/frontier-code ("Introducing FrontierCode", Eric Lu et al., 2026-06-08)
- **Encountered:** 2026-06-09, blog post pasted by user
- **Verdict:** memory note + cross-link into `test-category-adoption-from-the-wild.md` + one optional ≤1-day lane-2 spike. Lane 4 (pattern/definition) primary — the value is almost entirely in §6 displacement. Compound: **adopt the mergeability framing + the blocker/non-blocker lens; reject building anything net-new (we already ship the deterministic axes; the LLM axes are correctly cloud-routed).**

## 1. Core idea (one sentence, your words)

FrontierCode is a benchmark that grades whether an agent's PR would actually be *merged* — not just whether it's correct, but whether it's clean, in-scope, well-tested, and idiomatic — by running an ensemble of deterministic verifiers (unit tests, shell commands, run-the-test-against-the-bug, diff-scope constraints) plus LLM rubric grading, with the pass/fail line drawn at maintainer-defined "blocker" criteria.

It is the **offline-benchmark dual of what interlinked is as a live harness**: Cognition built a *measurement* of mergeability; interlinked enforces the same axes per-edit. The six grading methods are nearly 1:1 with our check families.

## 2. Anatomy (concrete walkthrough)

Prose source — load-bearing claims (my words):

1. **The thesis: correctness is table stakes; quality is the frontier.** "Models can write correct code… The question we should be asking is: can models write *good* code?" The metric is **mergeability** — "would the maintainer actually merge this PR?" — across correctness, test quality, scope discipline, style, and codebase-convention adherence. This is `feedback_taste_enforcement.md` ("harness checks are taste levers") stated as a benchmark, and `feedback_coverage_100_is_the_north_star`'s pairing of executed-with-verified.
2. **Built by maintainers, graded like a tech lead.** 20+/36 OSS maintainers, ~40h/task, defining "mergeable" for *their* repo. Quotes are the thesis verbatim: *"Where others grade like a CI, FrontierCode grades like a tech lead"* (Celery); *"a milestone for AI models respecting subjective quality"* (uppy).
3. **Six grading axes, mixed-method (the load-bearing table).** behavioral correctness (classical: inject tests, run), mechanical cleanliness + regression safety (command: exit 0), **test correctness (reverse-classical: run the agent's test against the *base* commit — it must FAIL)**, behavioral correctness for open-ended tasks (adaptive classical grading via `mutagent`, an LLM that surgically patches the test env to tolerate superficial diffs), **scope (files / size / semantic)**, and code quality (prompt: LLM reviews the diff vs an NL spec). Each criterion is a **blocker** (hard merge-stop → if any fails, score is 0) or **non-blocker** (quality signal).
4. **Misclassification is the enemy.** They report **81% lower FP+FN** vs SWE-Bench Pro. FP = verifier rewards a wrong solution (incomplete tests); FN = verifier punishes a correct one (over-rigid tests checking exact strings/fn-names). The three novel methods (reverse-classical, scope, adaptive grading) exist to cut both.
5. **Concise prompts, infer-the-intent.** Prompts are ~⅓ SWE-Bench Pro's length; the agent gets task + AGENTS.md-style guidelines and must infer maintainer intent. Difficulty scales via *rubric depth*, not patch size (FrontierCode patches are *smaller* than DeepSWE's yet harder).
6. **Results: quality is genuinely unsaturated.** Diamond (50 hardest): Opus 4.8 leads at **13.4%**, GPT-5.5 6.3%, best OSS (Kimi K2.6) 3.8%. Main/Extended: Opus 4.8 34.3% / 51.8%. GPT-5.5 uses up to 4× fewer tokens — better cost-intelligence. Tasks **won't be released** (contamination) → nothing to borrow as data.
7. **The worked failure (the sharpest line for us).** On a C++ task requiring a `LOG_WARNING() -> std::ostream&` helper used at every warning site, Opus 4.8 writes a *behaviorally correct* solution that bakes in `std::cerr == LOG_WARNING()` at the call site (`LOG_WARNING() << a; std::cerr << b;` instead of chaining `<< a << b`). Correct output today, abstraction-leak tomorrow. **This is exactly the behaviorally-correct-but-unmergeable class interlinked's taste layer targets — and it is *not* a regex/AST shape, so it correctly belongs to the LLM code-quality axis, not the local gate.**

## 3. Deterministic or agentic?

**Hybrid, and the split is clean.** Of the six methods: **three are fully deterministic** — classical (run injected tests), command (exit 0), reverse-classical (run the test against base, assert fail) — plus the **files/size** sub-parts of scope. **Three need a model** — adaptive classical grading (`mutagent`), the **semantic** sub-part of scope, and the code-quality prompt grader. The determinism filter routes the deterministic three to the Free CLI and the LLM three to Guardrails/Agent CI — precisely the axis split in `test-category-adoption-from-the-wild.md` §6. No marketing-vs-reality trap: Cognition is explicit that rubric grading is subjective and LLM-backed; the "novel verifiers" *are* the deterministic nuggets, named honestly. License: proprietary benchmark, tasks unreleased — moot, since a benchmark isn't importable anyway.

## 3b. Role in its native architecture — and does it transfer?

In FrontierCode the LLM grading methods are **oracle-backed and calibrated**: every task has a known-good reference solution, an adversarial hack-report pass, a 4-point 0→100% calibration, and human review (81% lower FP). That scaffolding is what makes subjective LLM grading *trustworthy as a benchmark*. **In our live topology there is no per-task reference solution and no human calibrator at inference time** — so the LLM-grading role can only transplant to the **cloud Agent CI** tier (model-as-reviewer over diff + AGENTS.md = FrontierCode's "prompt" method *minus* calibration), never to the local deterministic gate. The deterministic methods (command, reverse-classical) need no oracle → they transplant cleanly to the local PreToolUse/Stop gate. This is the same boundary `feedback_harness_deterministic_only.md` already draws.

## 4. Substrate vs. surface

- **Surface:** the benchmark + leaderboard (a measurement product; tasks not released).
- **Substrate — transferable only as *patterns*, since a benchmark grades and doesn't enforce:**
  - *Reverse-classical* — a test that passes against the unfixed tree proves nothing. (→ §6.3, §7)
  - *Blocker vs non-blocker* — a two-tier severity where blocker-fail zeros the score. (→ §6, = our default-gate vs advisory)
  - *Scope as a first-class graded axis* — files/size/semantic constraints on the diff. (→ §6.5)
  - *Mergeability as the target* — "grade like a tech lead, not a CI."

interlinked can't run an offline benchmark and trains nothing, so none of this is adopted as code. It is adopted as **evidence**: FrontierCode is an independent witness — built by 36 maintainers — that the bets interlinked has already placed (taste-as-quality, executed-and-verified tests, two-tier severity) are the right ones, and that the gap they target is real and *unsolved* (best model 13.4% on Diamond).

## 5. Lane (1–6)

**Lane 4 (pattern/definition) — primary.** The mergeability framing and the blocker/non-blocker taxonomy → memory + the existing design thread. Not a new RFC.

**Lane 2 (detection technique) — one optional spike.** The *forced* reverse-classical is a deterministic upgrade to our *observational* red→green (§7).

**Lane 5 (cloud-only) — the LLM axes.** Adaptive grading / semantic scope / code-quality prompt land on Agent CI; we already ship the manual version (`/code-review`) and the automatic one is designed (Tier 3). Routing, not a build proposal.

Not lane 3 — there is nothing to borrow as code (tasks unreleased, benchmark not a library).

## 6. Dependency & displacement

- **Deps:** none. Nothing imported; the only code an optional spike touches is interlinked's own red→green checks.
- **Displacement:** total overlap with bets already in flight — FrontierCode's six axes are the offline-grading dual of interlinked's live enforcement. No replacement.
- **Equivalence (capability-by-capability, verified against the tree 2026-06-09):**

| FrontierCode method | Grades | interlinked equivalent | Status |
|---|---|---|---|
| **classical** (inject tests → run → pass) | behavioral correctness | per-edit/Stop impacted-test execution + coverage ratchet (`coverage-ratchet.ts`, `commands/coverage.ts`); the apply-before-disk runner in `test-category-adoption-from-the-wild.md` §5 | **shipping now** — metrics shipped; per-edit execution is *landing in this WIP* (`commit-gate.ts`, `coverage-write-guard.ts`, `coverage-edit-targets.ts`, `staged-snapshot.ts`, `tdd-new-file-gate.ts` — all modified/new in the current tree; recent commit "per-edit coverage/red-green/CRAP actually enforce") |
| **command** (shell → exit 0) | mechanical cleanliness + regression safety | `quality-checks.ts` — 31 checks (tsc/biome/oxlint/cargo/mypy/gitleaks/semgrep/dep-audit…) PostToolUse + `interlinked verify` | **shipped** |
| **reverse-classical** (run agent's test vs base → must fail) | test correctness | TDD red→green state machine (`server-tdd-cycle.ts`; `checkTddGreenConfirmation` *requires* `previous_state==="red"`, `checkTppLeapfrog` requires `red_at`) + assertion-quality **pre_block** taste checks (`taste-checks-test-assertions.ts`: assertion-free / tautological / mock-the-SUT / private-member) | **shipped (observational variant)** — we *watch* the suite go red→green; FrontierCode *forces* the reverse-run. The forced run is the §7 spike. |
| **adaptive classical grading** (`mutagent` LLM patches tests/app) | open-ended correctness | none, **by design** — LLM-as-judge barred from the deterministic pipeline (`feedback_harness_deterministic_only`) | **N/A to CLI** — a benchmark-grading robustness trick, not a live-enforcement primitive |
| **scope: files** (allow/deny/must-delete) | scope discipline | `git-session-scope-gate.ts` (asks before a commit pulls in files this session didn't author) + `reservations.ts` (cross-agent file ownership) | **adjacent-shipped** — different axis (session-authored, not maintainer-declared) but same family |
| **scope: size** (Δlines / net growth / file count) | scope discipline | `checkProdTestLocRatio` + `gitNumstatDelta` (prod/test churn ratio) + `large-file-policy.ts` (800-line per-file cap) | **partial** — ratio + per-file caps ship; a PR-level *net-line/file-count* hard cap is **absent** (and arguably shouldn't be a hard gate live — no per-task oracle; §9) |
| **scope: semantic** (LLM locality) | scope discipline | — | **cloud** (lane 5) |
| **prompt** (LLM reviews diff vs spec) | code quality | `/code-review` (+ `code-review ultra` multi-agent cloud); Tier 3 async deep review on staged commits (`docs/design/tier-3-async-deep-review.md`) | **shipped manual / designed automatic** (lane 5) |

The single most useful row is `adaptive classical grading → N/A by design`: it's the one method we should explicitly *not* rebuild — it exists to make a benchmark's *scoring* robust, which is a different problem than gating an edit.

## 7. Smallest spike

The headline value needs **no build** (validation + cross-link + the taxonomy lens). The one shippable lane-2 nugget, ≤1 day:

**Forced reverse-classical as an advisory upgrade to red→green.** Today our red→green is *observational* — `checkTddGreenConfirmation` only awards credit when it *saw* the test go red→green, but it doesn't *block or nudge* a test authored already-passing. So an agent can add a real-looking test that happens to pass against the unfixed tree (exercises the wrong path, or locks in already-correct behavior) and our assertion checks won't catch it (it's neither tautological nor assertion-free). That is the exact gap FrontierCode's reverse-classical closes. Spike: when an `Edit`/`Write` adds/changes a test, optionally apply *only that test* to the pre-edit tree (the `git stash`/overlay substrate already specified in `test-category-adoption-from-the-wild.md` §5.3) and run it; if it **passes against base**, emit an advisory: *"this test passes without your change — does it actually exercise the fix?"* FP carve-out: a regression-lock for already-correct behavior legitimately passes on base → **advisory, never block**, and skip when no prod file changed this session. Ships with ≥3 pos / ≥3 neg cases per the agent-quality convention; lands in `behavioral-checks-tdd.ts` + `check-registry/entries-warnings`.

This is marginal precisely *because* the observational version already ships — offer it, don't force it.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Deterministic axes — command (shipped), classical (shipping in current WIP), reverse-classical (observational shipped; §7 forced-run optional). The blocker/non-blocker lens maps onto `DEFAULT_ADVISORY_SKIPS` (`src/commands/verify/advisory.ts`) — already our split; FrontierCode validates keeping it. | §7 | now / next |
| Guardrails (P2–3) | — | — | — |
| Agent CI (P4–5) | The LLM axes — code-quality prompt review, semantic-scope locality, adaptive-grading-style tolerance. interlinked ships the manual analog (`/code-review`, `code-review ultra`); the automatic Tier-3 pre-push reviewer is designed. FrontierCode is the design touchstone for *what an LLM code-quality reviewer should grade* (the six axes, blocker-gated). | Define the rubric a Tier-3 reviewer grades against, seeded by the six axes | parked |

## 9. Artifact

**Memory note + cross-link, plus one optional spike.** Memory: a `reference`-type entry recording the FrontierCode-delta — *mergeability/blocker-vs-non-blocker is the benchmark statement of our taste-lever + default-vs-advisory bets*, and *reverse-classical is a second witness to red→green*. Cross-link into `test-category-adoption-from-the-wild.md` as the grading-side dual of that doc's survey-side taxonomy (same "from the wild" methodology, opposite direction). Optional PR: the §7 forced-reverse-run advisory — the only directly-shippable nugget, and marginal because the observational version ships. **No cloud-roadmap build entry** — the benchmark is Cognition's category; the LLM axes it grades are already covered by `/code-review` (shipped) + Tier 3 (designed).

Compound carve-out: **adopt** the framing (quality-as-frontier) and the lens (blocker/non-blocker ≡ default/advisory); **explicitly do not rebuild** adaptive classical grading (LLM scoring-robustness, not enforcement) or a hard PR-level net-line scope cap (no per-task oracle live; keep scope advisory).

## Notes

- **The sharpest line for interlinked:** even the best model scores **13.4% on Diamond**. Mergeable-quality code is an *unsolved* problem — which is the macro case for interlinked's taste/quality layer existing at all. Correct-but-unmergeable (the Opus 4.8 `std::cerr` abstraction-leak, §2.7) is the precise gap the harness's taste checks target, and the fact that it's *not* an AST shape is the cleanest illustration of where the local→cloud boundary falls.
- **Quote worth keeping:** *"Where others grade like a CI, FrontierCode grades like a tech lead."* (Tomer Nosrati, Celery.) That is `feedback_taste_enforcement.md` said by a maintainer.
- **The benchmark's results are directional, not load-bearing** for us — we don't tune to a leaderboard. The load-bearing fact is the *shape* (six axes, blocker-gated, FP-disciplined), not the numbers.
- Cross-refs: `test-category-adoption-from-the-wild.md` (survey-side dual; §5 execution substrate + §9.1b test-integrity guards are where §7 lands), `test-quality-harness-local-first.md` (canonical four-lane), `devin-cloud-verification.md` + `echo-rl.md` (the prior two "validation find" intakes), `docs/design/tier-3-async-deep-review.md` (the LLM-axes home), `src/commands/verify/advisory.ts` (the blocker/non-blocker split). Memories: `feedback_taste_enforcement`, `feedback_coverage_100_is_the_north_star`, `feedback_harness_deterministic_only`, `project_tdd_quality_checks_exist_real_gaps`, `project_per_edit_coverage_enforcement`.

## Methodology notes (optional)

- This is the **third** intake whose verdict is "we already bet on this" (ECHO → Devin → FrontierCode), and the first that's a *benchmark* rather than a tool/product. The pattern the Devin intake flagged holds and sharpens: a benchmark is *definitionally* a measurement, so it can only ever witness a **definition** (mergeability = our taste thesis) or corroborate a **mechanism** (reverse-classical = our red→green) — it cannot propose an adoptable artifact. The value lived entirely in §6; the failure mode would have been writing it up as if FrontierCode proposed something to build. The rubric's §6 "equivalence, capability-by-capability" row did the real work — half of evaluating it was confirming what *not* to rebuild (`adaptive classical grading`).
- A mature benchmark's **grading-method table is a free gap-audit of your own check families.** Mapping its six methods to our modules surfaced both a confirmed strength (reverse-classical ships, observationally) and a precise, FP-aware gap (the forced-reverse-run) in one pass — the same way Devin's disclosed *failure modes* pointed at our JS-injection gap. When a measurement project enumerates its axes, grep your enforcement layer against each axis before reading the prose.
