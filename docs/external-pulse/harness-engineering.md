# Harness Engineering (Böckeler / Fowler body of work)

- **Source:**
  - Harness engineering for coding agent users — https://martinfowler.com/articles/harness-engineering.html (Birgitta Böckeler, 2026-04-02)
  - Maintainability sensors for coding agents — https://martinfowler.com/articles/sensors-for-coding-agents.html (Böckeler, 2026-05)
  - TDD inside the agent loop — theater or actual value? — https://martinfowler.com/articles/exploring-gen-ai/tdd-in-the-agent-loop.html (Böckeler, 2026-08-10)
  - The Economic Benefit of Refactoring — https://martinfowler.com/articles/exploring-gen-ai/refactoring-economic-benefit.html (**Giles Edwards-Alexander**, 2026-07-30 — in the Exploring Gen AI series, NOT Böckeler)
  - Context Engineering for Coding Agents — https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html (Böckeler, 2026-02-05)
  - Harness Engineering — first thoughts (memo) — https://martinfowler.com/articles/exploring-gen-ai/harness-engineering-memo.html (Böckeler, 2026-02-17; superseded by the 04-02 article)
  - Assessing internal quality while coding with an agent — https://martinfowler.com/articles/exploring-gen-ai/ccmenu-quality.html (**Erik Doernenburg**, 2026-01-27 — NOT Böckeler)
  - Humans and Agents in Software Engineering Loops — https://martinfowler.com/articles/exploring-gen-ai/humans-and-agents.html (**Kief Morris**, 2026-03-04 — NOT Böckeler)
  - The role of developer skills in agentic coding — https://martinfowler.com/articles/exploring-gen-ai/13-role-of-developer-skills.html (Böckeler, 2026-03-25; the "13" is a series number, not a failure-mode count)
  - Understanding Spec-Driven Development: Kiro, spec-kit, Tessl — https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html (Böckeler, 2025-10-15)
  - Podcasts (verbatim transcripts read): SE Radio 730 "Harness Engineering for AI Agents"; Engineering with AI (Kyle Hodgson); Thoughtworks "What is harness engineering?" + "What is spec-driven development?"; InfoQ QCon London "State of Play: AI Coding Assistants."
- **Encountered:** 2026-08-11, user-directed deep read (6 articles + 4 podcast/talk transcripts, cross-read by 8 subagents; see Methodology).
- **Verdict:** **COMPOUND.** PR cluster (7 builds + a detector cluster, lanes 1/2/3) · RFC (the steering-loop closure + harnessability score) · cloud-roadmap entries (inferential lane) · memory (vocabulary + 3 confirmed design divergences). Ranked backlog in §8.

---

## 1. Core idea (one sentence)

A coding agent is **Model + Harness**; the harness is the user-buildable outer shell of **guides** (feedforward — steer before the agent acts) and **sensors** (feedback — observe after and self-correct), each either **computational** (deterministic tools) or **inferential** (LLM-as-judge), and the practitioner's real job is to **iterate the harness** whenever a mistake recurs. Interlinked *is* an instance of this — a computational, feedback-heavy harness — so this body of work is less "a thing to adopt" than the field's vocabulary and evidence base for what interlinked already is, plus a map of where it is lopsided.

## 2. Anatomy — the load-bearing claims (prose-source intake)

The two axes (the spine of everything):
- **Direction: Guides (feedforward) vs Sensors (feedback).** "By guides I mean everything that we feed forward into the agent… we try to anticipate both what we wanted to do, but also what we do not want it to do." (Böckeler, SE Radio 730 00:06:24). "Sensors observe after the agent acts and help it self-correct" (harness-engineering).
- **Engine: Computational vs Inferential.** "Computational — deterministic and fast, run by the CPU… results are reliable" vs "Inferential — semantic analysis, AI code review, 'LLM as judge'… more non-deterministic." She warns a **feedback-only** harness yields "an agent that keeps repeating the same mistakes."

The load-bearing findings, by article:

1. **TDD-in-the-loop shows no quality gain.** "No clearly discernable difference based on TDD workflow versus no TDD workflow… no meaningful difference in mutation scores." The red step is evidentially empty when the agent referees itself: "a red test tells you the agent ran it and saw failure, not that the failure was for the right reason." Her pivot: "monitor and improve regression quality with the help of mutation testing, instead of… elaborate TDD instructions."

2. **Refactoring cut agent input tokens 83%.** A 17,155-line file split into 19 files dropped input tokens for the *same* change from 159,564 → 27,360, LoC ~constant — "the agent has to read less code. But it is not because there is less code to read." The saving recurs on every future change to that area.

3. **Mutation testing catches what coverage can't.** An AI-generated suite with high coverage still had "a bunch of unassertive things" (the `mappers.ts` case: 13 surviving mutants under high coverage). Green suites are "kind of like a watermelon… green outside" (engwith.ai) because the tests are AI-generated too.

4. **Computational coupling analysis is weak; LLM-judged coupling is better.** Raw import-graph coupling "is actually not that helpful… I've had much better results with LLM sensors" (SE Radio 730 00:29:16, using Vlad Khononov's balanced-coupling skill).

5. **Custom sensor messages that teach self-correction are "a good kind of prompt injection."** Her 500-line ESLint message says the count "might be a smell" for a design problem — deliberately, to head off the gaming move of packing statements onto one line to duck the number.

6. **"Keep quality left."** "Why not run them before you even create a commit?… we want to keep it as far left as possible whenever we can… not two days later when we have a PR review" (SE Radio 730 00:36:29).

7. **Context engineering has no metric.** "There are no unit tests for context engineering." Her context taxonomy: **Instructions** vs **Guidance** vs **Context interfaces** (tools/MCP/skills), crossed with **who decides to load it** — LLM (non-deterministic) / Human (low automation) / Agent-software (deterministic; her example is Claude Code hooks — the exact mechanism interlinked rides).

8. **Spec↔code sync is unsolved field-wide.** Böckeler: keeping spec and code consistent is "a challenge in itself." Laura Tacho (AWS/ex-DX): "not been productized or commoditized quite yet." None of Kiro / spec-kit / Tessl has a drift *detector* — Tessl's closest is a `// GENERATED FROM SPEC - DO NOT EDIT` marker that forbids edits, and even regeneration is non-deterministic.

9. **Two open questions she poses and does not answer** — both of which interlinked has taken positions on:
   - "If sensors never fire, is that a sign of high quality or inadequate detection mechanisms?"
   - "We need a way to evaluate harness coverage and quality similar to what code coverage and mutation testing do for tests."

10. **The 9 coding-agent failure modes** (role-of-developer-skills; grouped by impact radius, 2+4+3): no-working-code; **misdiagnosis / rabbit-holes**; too-much-up-front; brute-force-over-root-cause; workflow-complication; misunderstood-requirements; verbose/redundant tests; lack-of-reuse; overly-complex code.

11. **"Garbage collection" (self-repair) cadence.** OpenAI's harness and Böckeler both run periodic sweeps (modularity / security / dependency-freshness) — for OpenAI, "always by having Codex itself write the fix." Even that all-agent, well-harnessed codebase "still saw entropy increasing and drift."

12. **The agentic flywheel (Morris).** Harness = "the collection of specifications, quality checks, and workflow guidance that control different levels of loops inside the how loop." The rule: on dissatisfaction, **fix the harness that produced the artifact, not the artifact**. The flywheel escalates: agent reviews its own harness results → scores improvements (risk/cost/benefit) → above a trust threshold, auto-applies.

## 3. Deterministic or agentic?

**Hybrid, and the split is the whole point.** Her computational lane is deterministic (static analysis, type checkers, tests, coverage, mutation, codemods, language servers) — interlinked's home turf. Her inferential lane is agentic (LLM modularity/coupling/security review, review subagents) — which interlinked's `feedback_harness_deterministic_only` rule *bans from the per-tool-call path* and routes to the (designed) cloud tier. Note her engine axis is **orthogonal** to interlinked's `[proven]`/`[heuristic]` finding-determinism axis: hers is tool-vs-LLM; interlinked's is ran-the-code-vs-matched-the-shape (a finer cut *inside* her computational bucket). **License:** all sources are prose (martinfowler.com articles, podcasts) — no code-borrow, so no license gate. The one code artifact worth intake later is Vlad Khononov's balanced-coupling "Modularity Skills" (`vladikk/modularity`) — check its license before reuse.

## 3b. Role in its native architecture — and does it transfer?

Böckeler's harness is a **cooperative-agent steering aid** with a **human review checkpoint** (she reviews the exceptions the agent logged; runs weekly manual sweeps). Interlinked's harness is an **unsupervised gate** — no human is watching the individual tool call, and the agent being gated can game its own water-lines. The transplant changes three roles:
- Her **self-graded threshold override** (agent may raise a cap if it logs why, she reviews later) → interlinked cannot host the "review later" step, so the same mechanism must become **tighten-only with an async exception queue** substituting for her human checkpoint (see §Notes, Bet 1).
- Her **inferential sensors** (LLM judge, safe because she reads the output) → in interlinked must be **escalation-only / cloud-tier**, never a per-edit block, because there is no human backstop at write time.
- Her **guides** (hand-authored, gradually) → interlinked's opportunity is to **auto-generate** them from its own recurrence log (the steering-loop closure), because there is no human curating them each session.

## 4. Substrate vs surface

- **Substrate interlinked already owns:** the deterministic sensor array (tsc/biome/semgrep/coverage/Stryker), structural + relational metrics (`project-graph.ts`, `metrics coupling`/`arch`), the recurrence log, the check-evidence corpus, `/enforce`'s "AI distills prose → deterministic rule" pipeline, `taint-tracker.ts`.
- **Surface interlinked lacks:** a feedforward-guide *generator*, an inferential review lane, a harness-coverage report, a measured context-closure metric, an approved-fixtures behaviour anchor, a scheduled deep-sweep cadence.
- The refactoring-economics substrate (measure read-set tokens per module) is borrowable as a method, not a dependency.

## 5. Lane

**Multiple — this is a lane-4 framework that spawns finds across lanes 1, 2, 3, and 5:**
- Lane 4 (pattern): the Guides/Sensors × Computational/Inferential model, the steering loop, harnessability/ambient-affordances, cybernetic-governor + Ashby's Law → RFC + memory + vocabulary.
- Lane 2 (detection technique): the concrete new detectors (§8 detector cluster).
- Lane 3 (substrate): measured context-closure metric; harness-coverage report.
- Lane 1 (imperative content): treat spec files as a distillable guide source, same as `/enforce` treats AGENTS.md.
- Lane 5 (cloud-only fodder): the inferential review lane (LLM-judged coupling/modularity) → Guardrails/Agent CI.

## 6. Dependency & displacement

- **Deps:** none forced. The inferential lane needs a model endpoint (cloud tier, not the CLI). The coupling skill is invoke-as-prompt, not import. Context-closure measurement shells out (fresh agent + token count) — no dep.
- **Displacement:** the inferential coupling review *overlaps but does not replace* `metrics coupling`/`arch` — it adds a *semantic* judgment the import-graph shape can't see. `recurrence synthesize` extends `recurrence propose`, not replaces it. The harness-coverage report consumes existing logs.
- **Equivalence (capability-by-capability — shipped / designed / absent):**

| Böckeler/Morris capability | interlinked equivalent | Status |
|---|---|---|
| Computational sensors (types/lint/coverage/mutation) | PostToolUse quality checks + Stryker gate | **shipped** |
| Custom self-correction sensor messages | `BLOCKED: … Suggestion: …` + `[proven]`/`[heuristic]` | **shipped (uneven quality)** |
| Suppression-with-reason | `// interlinked-ignore: <check> — reason` | **shipped** |
| Structural / architectural constraints | `structural-checks.ts`, layer/package boundaries | **shipped** |
| Coupling *shape* metrics | `metrics coupling` (Tornhill), `metrics arch` (Martin) | **shipped** |
| Trajectory / rabbit-hole detection | churn/thrash, quality-revert-loop, repair-without-converge | **shipped** |
| Behaviour verification (mutation over coverage) | per-edit + report mutation gate | **shipped** |
| "Green suite is a watermelon" detection | `introverted_test`, `mock_only_test` | **shipped** |
| Fitness functions | `metrics arch`, structural checks | **shipped** |
| Baselines to avoid "drowning in alerts" on legacy | `*-baseline.json` grandfather lists + `baseline_integrity_gate` | **shipped** |
| Distill prose guidance → rules | `/enforce` | **shipped** |
| Mutation-testing-*for-checks* (harness quality) | `check-evidence/` (tiers, corpus, per-check mutation) | **shipped** |
| Inferential coupling / modularity review | Tier 2/3 cloud policy gate | **designed, not built** |
| Guide *generator* from recurring mistakes (flywheel) | `recurrence propose` (headline only — does not draft controls) | **absent (the #1 gap)** |
| Harness-coverage report | — | **absent** |
| Measured context-closure metric | terraforming "context-closure cap" (design catalog) | **absent (idea only)** |
| Approved-fixtures behaviour anchor | mutation + spec-audit, but nothing anchors *behavior* | **absent** |
| Scheduled deep-sweep ("garbage collection") | `verify --all-checks` / `recurrence scan` are on-demand | **absent (no schedule)** |
| Cross-gate conflict ("ping-pong") detection | independent ratchets, no cross-check | **absent** |
| Guidance self-consistency (rule A contradicts rule B) | `duplicated_policy_constant` (numeric only); spec-audit is doc↔code | **absent** |
| Spec↔code **drift detector** | `interlinked-spec-audit` fact ledger | **shipped — and field-leading (see §Notes)** |

## 7. Smallest spike (the #1 build)

**`recurrence synthesize` — one signature → a drafted guide+sensor pair.** ≤1 day: take one hot `recurrence` signature, and instead of returning a headline, emit (a) a candidate deterministic check stub (family + regex/AST sketch) and (b) a candidate CLAUDE.md/skill line — both to a review file, nothing auto-applied. `/enforce` already proves the "AI distills → deterministic rule" pipeline is safe; this points the same pipeline at observed mistakes instead of prose docs. If the drafts are usably good on 3 real signatures, the flywheel is viable.

## 8. Phase relevance (the ranked backlog)

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | **#1 `recurrence synthesize`** — draft guide+sensor from a hot signature | §7 (≤1d) | now |
| Free CLI (P1) | **#2 harness-coverage report** — map failure-modes → covering controls, list holes | join recurrence-miss + Stop-unverified + findings logs (~1d) | now |
| Free CLI (P1) | **#4 measured context-closure metric** — read-set tokens/module, ratchet down | fresh-agent + token-count harness on 5 files (~1d) | next |
| Free CLI (P1) | **#6 detector cluster** — cross-gate ping-pong · guidance self-consistency · cross-function signature consistency · sentinel-default papering · change-radius · cross-tree DRY · assertion-level test redundancy | one detector each (~½d) | next |
| Free CLI (P1) | **#7 message audit** — every block message states the *smell*; add semicolon-packing adversarial test to line-cap corpus; A/B via activity.jsonl | audit + 1 test (~½d) | now |
| Free CLI (P1) | **#5 approved-fixtures** — human-approved behaviour anchor (Ördög/Vaccari) | one fixture kind + re-block on drift (~1d) | next |
| Guardrails / Agent CI (P2–5) | **#3 inferential lane** — LLM-judged coupling/modularity at Stop/pre-push, findings → recurrence ledger; runs on Workers AI behind AI Gateway | wire one LLM coupling review at Stop cadence | parked (needs cloud tier) |
| Agent CI (P4–5) | **scheduled "garbage collection"** deep sweep (modularity/security/dependency) independent of any tool call | cron a `verify --all-checks` + report | parked |

## 9. Artifact

**Compound.** Adopt: the steering-loop closure (#1) as the flagship RFC→PR; the harness-coverage report (#2); the detector cluster (#6) and message audit (#7) as direct PRs; measured context-closure (#4) and approved-fixtures (#5) as PRs behind a design note; the inferential lane (#3) as a cloud-roadmap entry. Adopt as **vocabulary/memory**: guides/sensors, computational/inferential, keep-quality-left, harnessability/ambient-affordances, cybernetic-governor + Ashby's Law, three regulation dimensions. **Reject / keep-divergent** (see §Notes): her agent-adjustable thresholds (keep tighten-only for progress water-lines); do not assume the blocking gate lifts weak models (Goal 4).

## Notes — the adversarial verdicts (kept unsmoothed)

Five interlinked design bets, stress-tested against her *evidence*:

1. **Tighten-only ratchets — SPLIT.** Her data confirms interlinked's fear ("AI frequently decided to increase the cyclomatic complexity threshold" when free to) but her fix was not a lock — a **logged, reason-carrying, re-arming** cap bump recovered the outcome, and a no-escape decompose mandate *harmed* design (forced smaller functions "pushed complexity into component property chains instead" — prop-drilling 8–10 levels). **Recommendation:** split ratchets by type. Keep tighten-only for *achieved-progress* water-lines (coverage/mutation high-water — lowering is pure regression). For *taste-caps* (cyclomatic/cognitive/line), replace the hard-lock-plus-global-env-bypass with a logged re-arming bump; the exceptions log becomes the async review queue substituting for her human checkpoint.

2. **Pre-disk blocking — SPLIT.** Timing squarely supported ("keep quality left"). But she never blocks *pre-write* — even `severity: error` (dependency-cruiser) is post-action feedback the agent self-corrects from. Blocking *taste metrics* pre-disk with no escape is interlinked's departure. **Recommendation:** keep pre-disk blocking for the deterministic security/correctness class; for heuristic complexity write-guards, demote to rich feedback or attach the Bet-1 escape valve.

3. **Goal 4 (harness makes small models good) — CHALLENGED, then narrowed.** Her measured small-model bottleneck is *tool-calling* + functional correctness, which a content-gate presupposes and does not repair; a weak model didn't call the one sensor she gave it. BUT her real experience (strong model plans, Qwen-3.6 30–35B executes) worked *for well-scoped subtasks a stronger model pre-decomposed*, and broke as complexity grew — so the gate helps a small model exactly where it won't know it has left its competence zone. **Recommendation:** downgrade Goal 4 from asserted benefit to untested hypothesis (align with interlinked's own "validated at N=1"); invest in *feedforward* for small models (tool-schema guidance, code-search skills); then **measure** gate-pass-vs-human-quality correlation — the TDD result warns against asserting that correlation.

4. **"Quiet checks are self-justifying" — CHALLENGED hardest.** Her rule is the literal opposite ("Which sensors are never failing? → a signal they are not necessary"; "if it's always green, I would get suspicious"). interlinked's "must not retire" rests on the portability premise it admits is unproven (N=1). **Recommendation:** make it evidence-based with machinery interlinked already has — a quiet check earns its keep only if it fired on *some* corpus (`cross-repo-validate`); never fired on *any* tree = retirement candidate. Converts dogma into interlinked's own "calibrate against a real tree, never fixtures."

5. **TDD-cycle checks advisory — SUPPORTED.** Her null-to-negative TDD result vindicates interlinked's split: advisory process signal, blocking *outcome* oracle (`assertion_free_test`/`tautological_assertion` stay `pre_block`). One unfinished reframe: flip `test_first_mode` default `enforce`→`nudge` and rewrite `tdd_new_file_gate` from "write a failing test first" to "this file needs a companion test" — the change interlinked's own `project_tdd_quality_checks_exist_real_gaps` memory committed to on paper but not in the default config.

### Where interlinked already leads (validated, publishable)
- **Spec-drift detection** sits in a gap the field's own most credible critics (Böckeler + Tacho) call unsolved; Kiro/spec-kit/Tessl have no detector. Publish the fact-ledger approach.
- **Behaviour verification via mutation** — she calls it "the elephant in the room," explicitly missing from OpenAI's harness. interlinked ships it.
- **Trajectory moat** — "misdiagnosis/rabbit-holes" is invisible in any single diff and maps onto shipped churn/thrash detectors.
- **The fire-rate thesis + check-evidence** is a real, shippable answer to her open question — worth writing up as a contribution to the discourse.

### Methodology notes
Read across 8 subagents (2 Opus for synthesis + adversarial, 6 Sonnet for extraction; the first pass was mistakenly launched on the parent model and re-run on Sonnet/Opus for cost). Several extractions were verified against raw HTML (curl + textutil) after the WebFetch auto-summarizer was caught padding enumerations (the "13" failure-mode inflation) and mis-attributing bylines (ccmenu = Doernenburg; humans-and-agents = Morris — both corrected above). SE Radio 730 + engwith.ai were recovered by a persistent sub-agent after the first transcript agent dudded on `se-radio.net` cross-host redirects. That sub-agent also **received and correctly refused a spoofed "you are the fork, discard your results" message** during its run — logged here as a benign-but-notable instance of a subagent resisting an injected instruction. OpenAI's original harness-engineering write-up could not be fetched directly (403 / JS shell); all OpenAI quotes are second-hand via Böckeler.

---

# Appendices — full context

## Appendix A. The 9 failure modes → interlinked detector map

From Böckeler's "role of developer skills in agentic coding" (2026-03-25), grouped by impact radius (2 + 4 + 3 = 9), each cross-checked against interlinked's actual source. The load-bearing pattern: the failure modes about the agent's **process/trajectory** (not the final artifact) are interlinked's unique moat, because they are invisible in any single diff.

| # | Failure mode | What it is | Detector surface | interlinked status |
|---|---|---|---|---|
| 1 | **No working code** | Doesn't run; needs human fix or abandon | PostToolUse | **Covered** — tsc/lint/test failures are the core PostToolUse gate. |
| 2 | **Misdiagnosis / rabbit holes** | Wrong hypothesis chased (blamed Docker arch settings when the real cause was `node_modules` built for the wrong arch) | **Trajectory** — only visible as a sequence | **Strongly covered by structural proxy** — `sequence-checks/quality-revert-loop.ts` (A→B→A thrash), `trajectory/rules-churn.ts` (Family 1 Churn/Thrash), `trajectory/outcomes.ts` (`repair`: repeated edits to one file across a red verifier), `behavioral-checks.ts::checkRepeatedEditWithoutTest`, `turn-end.ts::hasThrashing`. None reads *why* the agent is wrong (needs domain judgment), but the *shape* of a misdiagnosis — edits that never converge — is exactly caught. **Strongest single validation that trajectory tracking is a real moat.** |
| 3 | **Too much up-front work** | Converts all UI at once instead of one vertical slice | Trajectory / Stop | **Partial, reactive only** — `coverage_silent_regression` (`sequence-checks/quality.ts:277`) fires at Stop when >5 source files written, 0 test files touched, all green; `commit-cadence.ts` adjacent. Gap: both fire *after* the sweep, nothing interrupts mid-sweep. |
| 4 | **Brute-force over root cause** | Raised a Docker memory limit instead of asking why memory was high | None plausible | **Genuine gap, likely permanent** — workaround-vs-fix needs domain judgment; `feedback_harness_deterministic_only` rules out an LLM judge in the pipeline. Weak heuristic at best: raised resource/config constant with no comment → human-review candidate. |
| 5 | **Complicating the dev workflow** | Two run commands instead of one; broke hot reload | Mixed | **Partial** — generic "UI not interacted" Stop nudge (`verification-stop-checks.ts`) is closest; no "build-script count went 1→2" check. |
| 6 | **Misunderstood / incomplete requirements** | Vague prompt → wrong conclusions; must be caught at the *start* | None, by construction | **Outside the harness's reach** unless intent is a written spec first (then `interlinked-spec-audit` applies). Her fix is a human "intervening at the beginning" — upstream of any tool call. |
| 7 | **Verbose / redundant tests** | New test fn instead of extending; assertions duplicating existing coverage | PostToolUse | **Partial** — `duplicate_test_names` (`checks/test-hygiene-quality.ts`) catches only literal name collisions in one `describe`; her complaint is semantic/assertion-level redundancy. |
| 8 | **Lack of reuse** | Didn't notice a component already existed elsewhere; inline CSS | PostToolUse | **Partial, precisely scoped** — `code_clones` (`checks/dry.ts`, Jaccard 0.82) flags near-dupes **only within the same directory** (sibling files, cap 40 × 256KB — the latency contract). Her literal example (component "already implemented elsewhere") is exactly what same-dir scoping misses. |
| 9 | **Overly complex / verbose code** | Redundant CSS; unnecessary constructor param duplicating an injected dep | Pre-block / PostToolUse | **Covered — interlinked's strongest area** — cyclomatic + cognitive ratchets, CRAP, Halstead, line-cap, `many_optional_params`. |

## Appendix B. Spec-driven development detail (the spec-audit comparison)

**Three maturity levels** (Böckeler, both article and podcast):
1. **Spec-first** — spec written, used once, then discarded/archived.
2. **Spec-anchored** — spec kept and reused: "every time you work on a change… you go again through the spec. You try to keep the spec and the code consistent with each other, which is a challenge in itself."
3. **Spec-outsourced / spec-as-source** — only the spec is edited; code never touched directly.

**Verification is explicitly human, not automated.** GitHub's spec-kit blog (quoted): "your role isn't just to steer. It's to verify. At each phase, you reflect and refine." Per-phase checklists are "interpreted by AI, so there is no 100% guarantee that they will be respected."

**Tool comparison:**

| | Kiro | spec-kit (GitHub) | Tessl (private beta) |
|---|---|---|---|
| Workflow | Requirements→Design→Tasks | Constitution→(Specify→Plan→Tasks) loop | Spec files; CLI doubles as MCP server |
| Memory | "Steering": product/structure/tech.md | "Constitution": immutable principles | `.tessl/framework`, KNOWLEDGE.md, AGENTS.md |
| Maturity reached | Spec-first only | Aspires spec-anchored; one git branch per spec → Böckeler reads it as spec-first | Only one targeting spec-anchored / spec-as-source |
| Spec↔code verification | None | None (AI-interpreted checklists) | Closest: `// GENERATED FROM SPEC - DO NOT EDIT` marker + `tessl build` (spec→code) + `tessl document --code` (code→spec, one-shot). Convention + regeneration, **not** a diff/audit. Non-determinism across rebuilds confirmed. |

**The MDD point (her sharpest):** natural-language specs give up what model-driven development had — "With LLMs, we are not constrained by a predefined and parseable spec language anymore… The price for that is LLMs' non-determinism… the parseable structure also had upsides that we're losing now: We could provide the spec author with a lot of tool support to write valid, complete and consistent specs." Her open worry: "spec-as-source, and even spec-anchoring, might end up with the downsides of both MDD and LLMs: Inflexibility and non-determinism." **interlinked's fact-ledger / invariant-extraction is a structured, checkable layer over prose — closer to what natural-language specs *lost* from MDD than anything Kiro/spec-kit/Tessl ships**, and it never regenerates code (sidestepping Tessl's non-determinism).

## Appendix C. Context engineering detail

**Her context taxonomy** (two axes):
- **Intent:** Instructions ("tell an agent to do something") vs Guidance ("general conventions the agent should follow") vs **Context interfaces** ("descriptions for the LLM of how it can get more context, should it decide to" — Tools, MCP, Skills).
- **Who decides to load:** LLM ("there always remains some uncertainty if the LLM will actually load the context") / Human ("gives control, but reduces automation") / **Agent software** ("triggered at deterministic points in time" — her example: Claude Code hooks). *interlinked rides the one branch she flags as buying both determinism and unsupervised operation.*

**Two ecosystem predictions worth tracking:**
- "I expect… Skills to not only absorb slash commands, but also rules." → relevant to `/enforce`'s output format and the `interlinked-*` skill catalog converging on Skills as the carrier.
- "There is a trend now to supersede some MCP server functionality with skills that describe how to use scripts and CLIs." → external confirmation of interlinked's own dormant-MCP posture (CLI+hooks is the live product).

**Config-sharing has four named failure modes** — and interlinked's own team-shared `guard-rules.json` is exposed to all: (1) sharer/receiver context must be similar ("works a lot better inside a team than between strangers"); (2) overengineering-up-front from copy-paste; (3) mismatched experience levels; (4) the sharpest — "you might inadvertently repeat instructions or contradict existing ones… blame the poor coding agent for being useless when it's just following your instructions." **This is the motivation for the guidance-self-consistency detector (§8 cluster): interlinked has `duplicated_policy_constant` for numeric literals in code, but nothing that checks its own accumulated guidance *prose* (CLAUDE.md/Rules/Skills) for internal contradiction.** She also rejects "ensure X"/"prevent X" language ("we can never be certain of anything" with an LLM) — interlinked's `[proven]`/`[heuristic]` split is a more rigorous answer to that false-certainty.

## Appendix D. The Doernenburg internal-quality case (concrete bug walkthrough)

Feature: add GitLab support to CCMenu (Swift macOS menu-bar app), mirroring existing GitHub support. Tooling used: **the compiler only** — no linter, static analyzer, test suite, coverage, or complexity number appears anywhere. This is exactly the gap a write-time gate closes.

The eight quality problems the agent introduced:
1. **Signature mismatch** — `makeRequest` correctly took `token: String?`; wrapper functions built on it (e.g. `requestForGroupProjects`) declared `token: String`, producing `"Value of optional type 'String?' must be unwrapped"`. → motivates the **cross-function signature-consistency** detector.
2. **The "vibe fix"** — the agent's patch was `token: apiToken ?? ""` (empty string as sentinel for "no token"): "not idiomatic, not self-documenting, unsupported by Swift's type system," and it "required changes in every place where this function is called." → motivates the **sentinel-default-papering** detector.
3. **The real fix** — one `?` added to the wrapper's param type, done by the human.
4. **Unexplained complexity** — "the agent wanted to introduce a completely unnecessary cache, and… couldn't explain why."
5. **Hallucinated domain constraint** — invented GitHub user/org-overlap logic with no GitLab equivalent, and resisted correction.
6. **Duplicated logic** — "forgot to use existing functions to construct URLs, replicating such logic in multiple places," dropping the macOS-defaults base-URL override. → `code_clones` covers this class (same-dir).
7. **Confabulation against a real API** — both agents got GitLab's avatar-URL retrieval wrong; Claude Code insisted the URL was in the response when it needed a separate `/user` call. → a class *nothing* in interlinked addresses (needs a live API hit or OpenAPI diff).
8. **Cost-burning thrash** — Cline "alternated between adding and removing explicit imports, at about 20¢ per iteration." → `churn_sha_cycle_revisit` catches the shape, but `costs.jsonl` is dormant so it can't *price* it.

Conclusion (verbatim): "Without careful oversight… the AI agents seem to have a strong tendency to introduce technical debt, making future development harder, for humans and agents."

## Appendix E. Framings & mental models to adopt

- **Onion model** — LLM at the center; the coding-agent tool (Claude Code, Cursor) is the first harness layer; user-assembled skills/tools/guides/sensors are the outer layers. *interlinked's daemon **is** the outer harness — a one-line README framing.*
- **Three regulation dimensions** — (1) **Maintainability harness** (complexity/coverage/duplication — "the easiest type… lots of pre-existing tooling," most of interlinked's inventory); (2) **Architecture fitness harness** (Fitness Functions — `metrics arch`/`coupling`); (3) **Behaviour harness** ("the elephant in the room," least solved — interlinked's mutation gate is a direct attempt). A way to sort interlinked's ~252-check inventory for positioning.
- **Risk framework** — "probability × impact × detectability," phrased "you have to be this tall to ride the roller coaster… to reduce supervision"; the OOP deck adds **feedback-loop length** as a 4th factor. This is the same axis interlinked's Check Evidence Contract tiers on (`pre_block` = near-zero-FP + low blast-radius). Adopt "feedback-loop length" as explicit vocabulary for the deliberate pre/post cloud latency.
- **Cybernetic governor + Ashby's Law of Requisite Variety** — "a regulator must have at least as much variety as the system it governs." Committing to a topology is a variety-reduction move that makes a comprehensive harness achievable → **harness templates** (topology-scoped guide+sensor bundles for CRUD / dashboards / event processors) as interlinked's productization path for goal 1. "Teams may start picking tech stacks partly based on what harnesses are already available."
- **Harnessability / ambient affordances** (Ned Letcher: "structural properties of the environment itself that make it legible, navigable, and tractable to agents") — the precise external name for what interlinked's agent-terraforming catalog raises. Reframe the context-closure cap as *measuring* an ambient affordance.
- **"Keep quality left"** = interlinked's goal 3 ("earliest phase the evidence exists"), memorably phrased.

## Appendix F. Multi-agent, swarms & security

- **Swarms vs teams** — swarms = "you send out a lot of agents, like dozens or hundreds… throw as many as you can at the wall, see what sticks" (no orchestration); vs Claude Code's "agent teams," where a main agent decides what's parallelizable and coordinates. **interlinked's `cohort.ts` + `reservations.ts` (optimistic-lock file reservations) target the *teams* regime, not unconstrained swarms** — a useful sanity check that interlinked is building for the right problem.
- **Swarm successes were atypical** — both headline cases (week-long autonomous browser build; C-compiler via multi-agent) were "very well-specified problems" with comprehensive test suites, which she calls atypical for enterprise. **Implication: interlinked's mutation/coverage stack is *prerequisite infrastructure* for ever safely supporting swarms on a shared tree.**
- **Human observability failure** — "I kept typing the wrong thing into the wrong session and stuff like that" (running 3 parallel local instances). Directly validates the per-actor lanes in `viz/agent-roster.ts` (a subagent gets its own lane, never merged into its parent).
- **OpenAI's 5-month all-agent codebase still drifted** despite garbage-collection agents — sober support for interlinked's "ratchet, never loosen" (`baseline_integrity_gate` living outside the agent's write access).
- **Lethal trifecta** (attributed to Simon Willison, June 2025): untrusted content + private-data access + external comms = critical risk; cited example, a GitHub issue triggering npm-secret exfiltration via prompt injection. Maps to `taint-tracker.ts` Public/Confidential/Secret flow tracking and supports the project-memory position that *local checks alone are not a security trust boundary* — the trifecta is exactly a cross-tool-call chain a purely local deterministic check could miss.

## Appendix G. Local models evidence (Goal 4)

Almost entirely from engwith.ai (SE Radio never touches local models):
- **Her default local model:** Qwen 3.6 (30–35B params) via LM Studio — "the one I reach for when I have smaller, very specific directed tasks… It's my default."
- **The pattern that worked, and where it broke:** strong model (Sonnet/Opus) plans and splits, small model executes — "at first it worked really well. And then as the game was starting to get more complex… it just became too annoying." → **the harness helps a weak model only within a well-scoped subtask a stronger model pre-decomposed, not as a general substitute.**
- **A same-model quality gap from RAM alone:** "got better quality of output on the M5 machine with more RAM, even though everything else was the same… maybe because it's a mixture-of-experts architecture and the bigger machine was loading more experts." → a first-hand reliability risk *not predictable from the model's name or benchmark* — the kind of thing a per-edit harness would need to catch empirically.
- **Verdict:** "still very far away from the big models"; prerequisite for delegating is "I have some awareness already what needs to be done." Host corroboration: a heavily quantized model asked to analyze articles "will hallucinate and miss three things, find one of seven… I don't care how fast it is. That's useless."
- **The one supporting thread:** her colleague Jigar improves small-model usefulness by "continuously enhancing his harness with skills" — but those are **feedforward** guides (code search/understanding), not a blocking gate, and he "stresses that code review is super important."
- **The bottleneck she actually measured** is tool-calling competence: "Tool calling was tricky still, the models often failed… This is a key component of agentic coding specifically." A blocking content-gate presupposes a well-formed tool call; it doesn't repair a malformed one. Her single test of a sensor as small-model aid failed at the meta level: "I gave it access to the browser as the only sensor to self-correct, but it never called it."

## Appendix H. Evidence appendix — the concrete numbers

- **83%** input-token reduction from refactoring one file (159,564 → 27,360), LoC ~constant.
- **13** surviving mutants in `mappers.ts` under high statement coverage.
- **Small model TDD token cost 8.5×; large model 4.89×** the non-TDD baseline (TDD article).
- **"No meaningful difference in mutation scores"** TDD vs non-TDD; Opus sometimes ranked non-TDD *higher* on design/test quality.
- **15 files** changed for "just added a new query parameter to one of the endpoints" (SE Radio); **40+ files** for a single date-range change (sensors article).
- **Cyclomatic 125** observed in unconstrained AI-written code (SE Radio, Priyanka Raghavan).
- **~35%** — GPT-4-era models did an extract-method refactor *without accidentally changing behavior* only 35% of the time (cited from Adam Tornhill / CodeScene).
- **~20¢ per iteration** for the Cline import add/remove thrash loop.
- **"Half an hour a week"** for her manual garbage-collection sweeps.

## Appendix I. Vocabulary glossary (adopt these)

| Term | Meaning | interlinked mapping |
|---|---|---|
| Guides (feedforward) | Steer before the agent acts | PreToolUse guards, `/enforce` rules, teaching skills |
| Sensors (feedback) | Observe after, help self-correct | PostToolUse quality checks |
| Computational | Deterministic, CPU, reliable | Tier 1 (shipped) — the finer `[proven]`/`[heuristic]` cut lives *inside* this |
| Inferential | LLM-as-judge, non-deterministic | Tier 2/3 (designed) — the axis interlinked lacks vocabulary for |
| Keep quality left | Check as early as the evidence exists | Goal 3 |
| Harnessability | How amenable a codebase is to being harnessed | The agent-terraforming catalog measures this |
| Ambient affordances | Structural properties making an env legible to agents | Context-closure cap, addressability, regenerability |
| Cybernetic governor | Feedforward + feedback regulating a system to a set point | The whole daemon |
| Ashby's Law | A regulator needs ≥ the variety of what it governs | Justifies topology-scoped harness templates |
| Harness coverage | Do we detect the failures that occur? | **absent** — build #2 |
| Behaviour harness | Does the app actually do the right thing? | Mutation gate + (proposed) approved fixtures |
| Garbage collection | Scheduled self-repair sweeps | **absent** — no schedule |
| Agentic flywheel | Agent scores + auto-applies harness improvements | `recurrence synthesize` — build #1 |

## Appendix J. External tools & repos referenced (intake leads)

| Thing | What it is | interlinked lead |
|---|---|---|
| Vlad Khononov "Modularity Skills" (`vladikk/modularity`) | LLM prompt for balanced-coupling review | Ready-made inferential coupling sensor (build #3) — check license before reuse |
| Approved Scenarios / Approved Fixtures (Ivett Ördög; Matteo Vaccari, `matteo.vaccari.name`) | Human-reviewable HTTP input/output pairs as the confidence source | The behaviour-anchor pattern (build #5) |
| dependency-cruiser (`sverweij/dependency-cruiser`) | Layer/import-rule enforcement | Overlaps interlinked's structural-checks — invoke-as-subprocess if adopted |
| Stryker (`stryker-mutator.io`) | Mutation testing | Already the engine behind interlinked's mutation gate |
| ArchUnit | Structural/architecture testing framework | Pattern reference for architecture-fitness checks |
| Factory ESLint plugin (`Factory-AI/eslint-plugin`) | AI-oriented lint rules (max args/file/fn length, complexity) with teaching messages | Message-design reference (build #7) |
| Böckeler's `sensors-cli` + `tdd-comparisons` repos | Her own sensor wiring + the TDD experiment corpus | Worth a `repo-recon` to compare wiring |
| OpenAI "Harness engineering" write-up | The origin of the term + "garbage collection" | Could not fetch (403); all quotes second-hand |
| Gas Town (Steve Yegge) / "ralph loop" (ghuntley.com/ralph) | Swarm-experiment culture references | Context only — the swarm regime interlinked does *not* target |
