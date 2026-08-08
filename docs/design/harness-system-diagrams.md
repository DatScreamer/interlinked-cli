# Harness — System at a Glance (Diagrams + Modality Reference)

**Why this harness exists.** AI coding agents operate under one hard constraint: a limited context window. On a small greenfield project that barely bites. On a **large existing codebase — or a codebase the agent is itself rapidly making large** — it becomes the dominant failure mode: the agent cannot hold the whole system in view, so it edits against a partial picture and introduces problems a full-context engineer wouldn't. This harness is **highly opinionated about agentic coding best practices** precisely to compensate — it enforces, at the moment of each edit, the disciplines the agent would follow if it could see everything, so the agent doesn't have to hold them in its head. The payoff is concrete and twofold: **agents improve at runtime and require fewer code reviews later**, and the workspace becomes **extensible for multiple future agents and human users**, because the disciplines live in the harness rather than in any one agent's memory.

Everything below is downstream of that paragraph. The left-shift gradient, the gauntlet budget, the durable substrate — each is in service of *limited context window on large codebases → enforce the discipline the agent can't hold → fewer reviews, more extensible.* If a reader understands only this, they understand the doc.

**Purpose of this doc:** a visual reference for how the harness fires at each stage of the agentic loop, what substrates each stage reads, and where each discipline lives. Read top-to-bottom.

> ⚠️ **Read this as a roadmap, not an as-built diagram.** The diagrams draw the **target** architecture; a large share is designed-not-built. Each section carries a **ground-truth status table** marking every box against the actual code. The load-bearing gaps remain **smart-selection (§13 of the kernel doc)** and the **cloud fan-out tier** — without them, "use the 25s window" is a slogan for the heavy items, not yet a system.
>
> **Status legend (every table below):** ✅ shipped (running today, with tests) · 🟡 partial (a related mechanism exists, not in the shape/stage drawn) · ⬜ designed-not-built (plan/doc only) · ❌ wrong (contradicts the code or another design doc) · ☁️ cloud-future (additive fan-out tier).
>
> **Shipped in the 2026-06-01 "maximal enforcement" campaign** (`docs/design/maximal-local-enforcement-roadmap.md`): the **coverage keystone** (`@vitest/coverage-v8`, feeds CRAP + the ratchet), the **file-size cap ratcheted 1500→1000** (15 over-cap modules decomposed, 3 grandfathered), and **4 advisory checks promoted to the default gate** after an FP-audit of all 112 demoted checks (`type_smuggling`, `fetch_without_timeout`, `silent_demo_fallback`, `circular_imports`). **Still designed-not-built:** the observed-red gate, coverage-backed every-file-tested, smart-selection, the persistent receipt ledger, in-loop test/coverage/mutation execution, and the cloud fan-out tier.

## Design principles (the spine of every diagram below)

1. **Maximal local enforcement, dogfooded — but portability is the product.** The harness enforces the maximal set of *deterministic* checks at runtime — and **its own code must always pass them**. Promoting a check to the default gate is gated on the harness itself being clean for it (real fixes over suppressions). **Dogfood-clean is necessary, not sufficient** (amended 2026-08-07): it proves the check does not block US, not that it has a low false-positive rate in the codebases the harness actually targets — which are multi-language, human-written, and not agent-hardened. Promotion to a *blocking* gate wants cross-repo evidence too. And the inverse never holds: **a check that is quiet here is not thereby unneeded.** Fire rate measures the agent and the tree, not the check. See `maximal-local-enforcement-roadmap.md` §Thesis and CLAUDE.md "What this is for".
2. **Put as much in PreToolUse as possible — and migrate checks left over time (Stop → PostToolUse → PreToolUse).** The *why* is the payoff above: moving a check earlier *helps our agents improve at runtime, requires fewer code reviews later, and makes the workspace more extensible for multiple future agents and human users.* The migration is motivated by the context-window/extensibility payoff, **not by latency aesthetics**. PreToolUse is the strongest lever because it refuses the bad edit *before it lands*. The *constraint* on how far left a check can move is **substrate warmth** — a gate can fire here only if the data/compute it needs is already warm (graph cached, types resolvable, clone pre-staged). Content-local checks run on the proposed content directly; heavier ones ride the speculative-clone path (§0). PostToolUse / Stop remain the fallback only for the shrinking minority that genuinely need the *post-write reality*.
3. **Red/green TDD on the inner loop.** A source edit is gated on a test-first discipline: a new source file needs a companion test (shipped); a new *public symbol's* test should be observed **red→green** before the impl is accepted (designed) — refactors/backfills exempt, because they produce green-from-birth tests.
4. **Every source file is tested, and every file runs the full check battery.** Companion-existence **or** coverage-backed; the ~100+ deterministic per-file checks run on each source edit.
5. **One ~25s budget, two substrates.** Local single-machine for what fits ~25s on one box; **cloud *horizontal fan-out*** for heavy embarrassingly-parallel work (mutation) — which **also targets ~25s**, not a slower async tier. The cloud buys *scale*, not *time*: `wall-clock ≈ warmup + one_unit_runtime`, constant in unit count.
6. **The covering-suite runtime is the unifying floor.** Smaller files → smaller covering sets → faster per-test / per-mutant runtime → fits both the local window AND cloud-25s fan-out. The LoC ratchet, the test-runtime ratchet, and cloud mutation are **one lever**, not three.
7. **PostToolUse steers the trajectory — and every steer leaves a durable record.** PostToolUse exists to **inform the agent so it alters and improves its trajectory** — a fact injected via `additionalContext` while the reasoning is still warm. Because that injection is ephemeral and single-agent, and because the goal is *fewer reviews later* and *extensible for future agents and humans*, every steering injection must **also write a durable finding**. The act that steers this agent builds the record that serves the next agent and the human reviewer. Steering that evaporates at session end serves neither goal.

**The throughline** — the sentence to leave with: *a system highly opinionated about agentic coding best practices, built for agents working under a limited context window on large and growing codebases, that improves agents at runtime so they need fewer reviews later and so multiple agents and humans can work the same codebase on shared, enforced discipline.* Every box below should be checkable against it.

### Scope & cross-references (these bound every diagram below)

- **WHAT vs HOW.** This doc is the opinionated *WHAT* — the disciplines and the default-strict **BLOCK** behavior. It is **not** absolutist: the configurability framework (`docs/test-quality-harness-plan.md` §22) governs *how* a deployment dials strictness (**strict / enforce / advise / monitor / off**) and *where* artifacts live. The opinions are firm; the integration is configurable.
- **New gates earn their teeth by dogfood (Principle #1).** Every gate drawn ⬜ below — the trajectory gate (§0 box 8), speculative coverage, any new blocker — enters **designed-not-built** and graduates to *blocking* only after **the harness's own code passes it (real fixes over suppressions)**. None is switched on by fiat.
- **Detection/decision + fail-open-except-safety.** Any new gate's *decision* runs through Cedar over a **typed signal** (detection stays separate from decision); if that signal's substrate is unavailable the gate **fails open (allow + log)** unless the signal is safety-critical. A trajectory gate that can't read `session-state.ts` allows and logs — it does not block.
- **The LLM tier can block (cited correctly).** Where this doc references the cloud/LLM tier (`docs/design/three-tier-architecture-v2.md`): the **Tier-2 safeguard classifier *can block* via Cedar** when policy dictates (bounded taxonomy, validated, fast enough — otherwise it wouldn't be useful); only the **open-ended Tier-3 judgment reviewer stays advisory**. This is mostly a deterministic-local doc, but it must not imply the LLM layer is advisory-only.
- **Numbers discipline.** Every "X takes Y seconds" in the band diagrams + the speculative-clone / warm-pool / tsgo claims is **measurement-pending (Phase 3.5)** modeling to validate, *not* a measured fact. The only cited latency facts are the per-runner ceilings in §7. A warm pool / speculative clone is a **design commitment**; its latency is a **measurement claim** — kept distinct.

**Companions:**
- `docs/design/maximal-local-enforcement-roadmap.md` — the campaign status + sequencing (#2–#9) these diagrams target.
- `docs/design/test-quality-harness-local-first.md` — the local-first kernel (Phases 0–3.7), four lanes, smart-selection §13.
- `docs/hooks-ecosystem-comparison.md` — per-runner hook timeouts and decision contracts.

**Cross-runner working-budget note:** the diagrams use **~25s** as the cross-runner least-common-denominator PreToolUse/Stop working budget. But the per-runner ceilings are far more generous — Claude Code and Codex default to **600s** for command hooks (see §7). So "put as much in PreToolUse as possible" has *lots* of headroom on single-runner deploys; the ~25s LCD is what the cross-runner substrate plans against, and what the cloud fan-out tier is engineered to hit even for whole-repo mutation.

---

**Terminology — "trajectory."** Here, *trajectory* means the **single-agent, in-session span of tool calls** (substrate: `session-state.ts`) — that is the only referent in this doc. It is an **input to PreToolUse gates**, not merely a Stop artifact: a gate "really shouldn't be only a Stop hook if the detected trajectory involves a low-quality or low-security file about to be written to disk." Other span-shaped signals one *could* call trajectories — a single file's or module's edit history, cross-session patterns — are **not in scope here**; they're an open future consideration, and if ever added they carry a strict authority rule (**in-session may gate; any non-session prior may only inform, never block**).

## §0. The inner-loop discipline — red/green TDD + the per-file check battery · TARGET STATE

This is the heart of "maximal local enforcement": every source-file edit is gated, at **PreToolUse**, on the proposed content — so a violation is blocked *before it ever lands on disk*.

```
   AGENT proposes  Write/Edit  foo.ts   (content is in tool_input)
                       │
                       ▼  PreToolUse — the inner-loop gate (everything that can live here, does)
   ╔══════════════════════════════════════════════════════════════════╗
   ║ 1. CLASSIFY the target: source / test / config / generated        ║
   ║      (generated/test/.d.ts exempt from the source-discipline below)║
   ║                                                                    ║
   ║ 2. TEST-FIRST GATE  (new source file)                             ║
   ║      companion foo.test.ts must exist on disk OR have been written ║
   ║      earlier this session  ──────────────────────────────►  BLOCK ║
   ║      [shipped: tdd_new_file_gate, test_first_mode=enforce]         ║
   ║                                                                    ║
   ║ 3. RED→GREEN GATE  (edit introduces a new public symbol)          ║
   ║      its companion test must have been observed RED, then GREEN,   ║
   ║      this session — proving the test can fail.  ──────►  NUDGE→BLOCK║
   ║      EXEMPT: refactor / backfill / characterization (API-stable    ║
   ║      diff) — those legitimately produce green-from-birth tests.    ║
   ║      [designed — roadmap #5; cycle tracker records red_at/green_at]║
   ║                                                                    ║
   ║ 4. EVERY-FILE-TESTED                                              ║
   ║      file passes if a companion exists OR its public symbols are   ║
   ║      covered by some test (coverage-backed).  ────────────►  NUDGE ║
   ║      [companion half partial; coverage-backed half designed — #4]  ║
   ║                                                                    ║
   ║ 5. FULL LOCAL CHECK BATTERY on the proposed content (all gating):  ║
   ║      • tsc --noEmit (incremental) · biome / oxlint                ║
   ║      • secrets (inline, fail-closed) · package-allowlist          ║
   ║      • the promoted family: type_smuggling, fetch_without_timeout, ║
   ║        silent_demo_fallback, circular_imports, + the standing      ║
   ║        ~100 default-gate detectors (SQLi, taint, async-safety, …)  ║
   ║      • module-size cap (1000) · import-cycle · complexity          ║
   ║      [today these run mostly at PostToolUse; the target is to run   ║
   ║       every content-only check here, on the proposed content]      ║
   ║                                                                    ║
   ║ 6. COVERAGE / CRAP on the touched function                        ║
   ║      diff-coverage ("are the new lines hit?") + CRAP risk score    ║
   ║      [needs the coverage baseline — roadmap #2/#3]                 ║
   ║                                                                    ║
   ║ 7. HEAVY, via fan-out (still inside ~25s)                         ║
   ║      diff-scoped MUTATION — local for leaf/mid files; cloud        ║
   ║      horizontal fan-out for hubs/whole-repo (all mutants concurrent║
   ║      → wall-clock constant in mutant count).  [designed — #9, ☁️]  ║
   ╚══════════════════════════════════════════════════════════════════╝
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
        BLOCKED               ALLOWED → the write lands → PostToolUse
     (bad content never        finalizes (the few checks that need the
      reached disk)            on-disk file / whole-project state)
```

**8 · Trajectory-informed gate (the in-session span is an *input* to this PreToolUse, not just a Stop signal).** If the in-session trajectory (`session-state.ts`) shows a concerning span **and** this write is a low-quality / low-security file about to land, block at **this write's** PreToolUse — the edit is the trigger, the in-session span is the context. Decision via **Cedar over the typed session-state signal**; **fails open (allow + log)** if session-state is unavailable, unless the signal is safety-critical. Enters **⬜**, graduating to blocking only once the harness's own code passes it.

**Speculative coverage (rides box 6 on the clone).** Diff-coverage / CRAP need the covering tests *run*, not just parsed — so they ride the speculative-clone path below: the covering set executes against the proposed content on the clone and returns "are the new lines hit?" to inform the decision. Enters **⬜**.

**Why PreToolUse and not PostToolUse — and why "needs the file on disk" is a smaller constraint than it looks:** PostToolUse fires *after* the bad content is already on disk — the agent must be told to undo it; PreToolUse fires with the proposed content in hand and can refuse it, so the working tree never holds the violation. Crucially, **the file does not need to be written to disk to be evaluated** — that's where the git clone + edit comes in: PreToolUse has the proposed contents of a file that has not yet been written, so it can **apply them to a clone of the repo (git clone + edit, or a Cloudflare-Artifacts worktree), execute and evaluate there, and return the result to inform the PreToolUse decision.** That makes even whole-project and execution-based checks left-shiftable — not just content-local ones. Whole-project type resolution is the canonical example: **`tsgo` is now fast enough to do whole-project `tsc` for most codebases locally, and if necessary we can optimize that in the cloud too.** So the set that *genuinely must* wait for PostToolUse shrinks to what needs the **post-write reality itself** — chiefly diff-coverage piggybacked on the agent's *own* test invocation, and confirming what actually landed. *(Speculative-round-trip and warm-clone latencies are measurement-pending — Phase 3.5; the warm clone is a design commitment, its cost a claim to validate.)*

**7 · Mutation (box 7) is a *per-plan obligation*, hard-gated at commit — not a per-edit block.** Mutation tests the *(source, test) pair*, so a survivor is feedback whose fix is cross-file and iterative (and a Pre-block fires no Post, so it couldn't carry the survivor list anyway). Per-edit, box 7 *kicks off* the cluster's mutation run (async, bridged, `--incremental`) and *reports + tracks* survivors as an open obligation (PostToolUse, present-not-prescribe, four-way: test / source / both / annotate-equivalent); the synchronous ~25s in-band cloud block lives at the **commit** boundary (`git commit`'s PreToolUse), which blocks if any obligation is open. The cheap local checks (tsc/lint/secrets) still block per-edit. Full flow + the four-way resolution in **§4a**; obligation mechanics in `open-obligation-ledger.md`. *(This refines the earlier "synchronous per-edit block" framing — the block is preserved but relocated to commit; it is not the async-tail anti-pattern, since survivors are reported synchronously and tracked to a hard deadline.)*

### §0 ground truth — the inner-loop discipline today (verified 2026-06-01)

| Discipline box | Status | Reality |
|---|---|---|
| Test-first gate (new source needs companion test) | ✅ | `evaluator/tdd-new-file-gate.ts`, `test_first_mode: "enforce"` is the default (`rules/default-config.ts:627`); returns a `block` decision |
| Red→green gate (observed-red before impl, new-symbol-only) | ⬜ | `server-tdd-cycle.ts` records `red_at`/`green_at`/`regression`, but **nothing gates on observed-red**; this is roadmap #5 (ship as Stop nudge first) |
| Red→green refactor/backfill exemption | 🟡 | `behavioral-diff-checks.ts` exists (API-stable diff signal); not yet wired to a red/green gate |
| Regression nudge (green→red this session) | ✅ | `formatTddRegressionWarning` at Stop |
| Every-file-tested — companion half | 🟡 | covered for *new* files by the test-first gate; existing files not swept |
| Every-file-tested — coverage-backed half | ⬜ | needs the coverage baseline (#3) |
| Full check battery **at PreToolUse on proposed content** | 🟡 | the guard pass (rules, secrets, package-allowlist, write-content guards) runs at PreToolUse; the ~100 inline quality detectors run at **PostToolUse** today — moving them left (onto proposed content) is the open "max-PreToolUse" work |
| 4 promoted default-gate checks | ✅ | `type_smuggling`, `fetch_without_timeout`, `silent_demo_fallback`, `circular_imports` — promoted 2026-06-01, harness's own code passes them |
| Coverage / CRAP per-edit | 🟡 | CRAP wired into `verify` (fail-open until the baseline is cut); diff-coverage piggyback ⬜ |
| Diff-scoped mutation in-loop | ⬜ / ☁️ | `mutation-gate.ts` is a dormant report-reader; Stryker not installed; cloud fan-out tier unbuilt |
| Trajectory-informed gate (§0 box 8) | ⬜ | `session-state.ts` records the in-session span; no Cedar gate reads it at PreToolUse yet. Enters via dogfood; fails open if the substrate is unavailable |
| Speculative-clone evaluation (whole-project / execution checks at PreToolUse) | ⬜ / ☁️ | no clone-per-edit path yet; `tsgo` makes local whole-project tsc plausible (measurement-pending), cloud clone is the fallback |

---

## §1. Inner loop — filling the ~25s PreToolUse window · TARGET STATE

§0 is *what* the inner loop enforces; this is *how* the window is filled — cheap checks unconditionally, heavier ones admitted by smart-selection (§13) up to the budget, heaviest fanned out to the cloud **within the same budget**.

```
   ╔═══════════════════════════════════════════════════════════════════╗
   ║ PreToolUse hook  [per-runner ceiling: 600s Claude/Codex · 30s LCD] ║
   ║                  [cross-runner working budget ~25s]               ║
   ╠═══════════════════════════════════════════════════════════════════╣
   ║ Smart selection (§13): reads substrates → ranks → admits to budget ║
   ║                                                                    ║
   ║  ┌─ ALWAYS  <50ms (unconditional, never ranked) ─────────────────┐ ║
   ║  │ guard rules · inline secrets · package-allowlist · import-cycle│ ║
   ║  │ module-size cap · file-kind classify · blast-radius query ·   │ ║
   ║  │ CRAP lookup · test-first gate (§0.2)                          │ ║
   ║  └───────────────────────────────────────────────────────────────┘ ║
   ║  ┌─ FAST  50ms–5s (content-local; run on proposed content) ──────┐ ║
   ║  │ tsc --noEmit incr · biome/oxlint · the ~100 inline detectors ·│ ║
   ║  │ cyclomatic complexity · curated Semgrep · KG companion/layer  │ ║
   ║  └───────────────────────────────────────────────────────────────┘ ║
   ║  ┌─ SELECTED  up to ~25s — picked by §13 for THIS edit ──────────┐ ║
   ║  │ selected covering unit tests (bug-catch-ranked) · diff-scoped  │ ║
   ║  │ mutation (leaf/mid, local) · property tests (bounded N) ·      │ ║
   ║  │ red→green confirmation · acceptance smoke (short)             │ ║
   ║  └───────────────────────────────────────────────────────────────┘ ║
   ║  ┌─ FAN-OUT  ☁️ also ≤~25s — embarrassingly parallel, off-box ───┐ ║
   ║  │ whole-repo / hub mutation: all mutants → N sandboxes at once  │ ║
   ║  │ wall-clock ≈ warmup + one covering-suite run (constant in N)  │ ║
   ║  └───────────────────────────────────────────────────────────────┘ ║
   ║ → writes receipt (per-tool-use eval), emits BLOCK / ALLOW          ║
   ╚═══════════════════════════════════════════════════════════════════╝
```

> **Reconciliation (supersedes the old "heavy work can never be synchronous" stance):** that was true for *single-machine* work in a tight cross-runner window. It is no longer the whole story. Heavy verification now fits the PreToolUse window two ways: **(a)** single-runner deploys have a 600s ceiling (Claude/Codex), so the ~25s LCD is conservative; **(b)** the cloud tier targets the *same* ~25s by horizontal fan-out — mutation is embarrassingly parallel, so `wall-clock ≈ warmup + one_covering_suite_run`, independent of mutant count. The covering-suite runtime is the irreducible floor, which is exactly what the smaller-files + test-runtime-ratchet work shrinks. The fan-out mechanism — a clone-per-mutant worktree via ArtifactFS, Supervisor-DO-orchestrated, run on the speculative clone (§0) — is detailed in §4. **Still gated on §13 (selection) + the cloud substrate, both unbuilt.**

### §1 ground truth — what fires at PreToolUse / PostToolUse today (verified 2026-05-29 · campaign rows updated 2026-06-01)

| Diagram box | Status | Reality |
|---|---|---|
| ~25s budget + INSTANT/FAST/SELECTED/FAN-OUT bands | ❌ | `pre-tool-pipeline.ts` is a synchronous guard pass; no budget/band scheduler |
| Smart selection (§13) — rank → admit ≤25s | ⬜ | **Zero code.** The load-bearing component for the SELECTED/FAN-OUT bands |
| ALWAYS · guard rules / secrets / allowlist / import-cycle / module-size / blast-radius / test-first gate | ✅ | all shipped at PreToolUse |
| FAST · the ~100 inline detectors "on proposed content" | 🟡 | they run, but at **PostToolUse** on the written file — not yet left-shifted onto `tool_input` content |
| FAST · tsc / biome "on changed files" | 🟡 | in `interlinked verify`, or at PreToolUse only on `git commit`/`push` — not an every-edit FAST band |
| SELECTED · mutation / selected tests / property / red→green | ⬜ | no selection, no in-loop runner; property-test infra absent; Stryker not installed |
| FAN-OUT · cloud whole-repo mutation ≤25s | ☁️ | substrate unbuilt; this is the §9 cloud target |
| PostToolUse · secrets re-scan / KG companion re-check | ✅ / 🟡 | re-scan shipped (`post-tool.ts:84`); `public_symbol_test_case_missing` shipped (narrower than "was the promised test written?") |
| PostToolUse · diff-coverage piggyback / test-runtime ratchet | ⬜ | not implemented (`TestRuntimeRatchet` is a type with no writer) |
| PostToolUse · receipt finalized + signed | 🟡 | trajectory persisted at **Stop**, not Post; not signed; no per-tool-call receipt |

---

## §2. Outer loop — per session / per push / nightly · TARGET STATE

The outer loop is the *fallback cadence* for work that genuinely can't be left-shifted into the inner loop (whole-suite, full-history, cross-service), plus the reflection nudges.

```
   (many inner loops accumulate; agent stops)
                             │
                             ▼
   ╔═══════════════════════════════════════════════════════════════╗
   ║ Stop                     [seconds tolerable · reflection]     ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ • Whole-suite coverage ratchet (the #3 floor)                 ║
   ║ • Mutation against changed lines (broader than per-edit)      ║
   ║ • Whole-project tsc · dead-code · KG adoption / glossary drift║
   ║ • Reflection: did the agent verify? left stubs? (Stop nudges) ║
   ║ • Red→green regression nudge · commit-cadence nudge           ║
   ║   "Stop is reflection, not heavy work; spawn detached if heavy"║
   ╚═══════════════════════════════════════════════════════════════╝
                             │  user runs git push (manual)
                             ▼
   ╔═══════════════════════════════════════════════════════════════╗
   ║ Pre-push                 [minutes tolerable]                  ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ • Full whole-file Stryker mutation · Gitleaks full-history    ║
   ║ • Architecture-rule verification · acceptance full suite      ║
   ╚═══════════════════════════════════════════════════════════════╝
                             │  pushed → CI fires
                             ▼
   ╔═══════════════════════════════════════════════════════════════╗
   ║ CI / pre-merge           [minutes–tens of minutes]            ║
   ║ • Org-policy Semgrep · whole-suite coverage+ratchet · e2e ·   ║
   ║   perf regression · migration smoke · OpenSSF Scorecard       ║
   ╚═══════════════════════════════════════════════════════════════╝

  ═════════════════ IN PARALLEL, CONTINUOUSLY ═════════════════
   Tier 4 Scheduled  [nightly]: flakiness N=5 · mutator rotation ·
     acceptance mutation (cost-contained here) · brownfield audit
   Tier 5 Continuous [always-on]: coverage-guided fuzzing corpus ·
     SCA vuln-DB polling · Semgrep policy refresh
```

### §2 ground truth — Stop / pre-push / CI / scheduled today (verified 2026-05-29 · campaign rows updated 2026-06-01)

| Diagram box | Status | Reality |
|---|---|---|
| Stop · reflection nudges + commit-cadence + red→green regression + pattern-rescan | ✅ | `lifecycle-events.ts` + `verification-stop-checks.ts` + `commit-cadence.ts` |
| Stop · whole-suite coverage ratchet | ⬜ | coverage is now *generatable* (keystone shipped) but the ratchet isn't wired at Stop — roadmap #3 |
| Stop · mutation vs changed lines | ⬜ / ☁️ | not wired; #9 |
| Stop · whole-project tsc | ❌ | tsc gate runs at PreToolUse on `git commit`/`push`, not Stop |
| Pre-push (every box) | ⬜ | the markdown-only fast-path + typecheck/test gate exist (`scripts/git-hooks/pre-push`), but none of the heavy boxes drawn |
| CI / pre-merge | 🟡 | CI runs typecheck + docs:check + test + build + publish-lints — **not** `interlinked verify`, coverage, or mutation |
| Tier 4 / Tier 5 (every box) | ⬜ | no scheduler/cron; no always-on process |

---

## §3. Substrates — what every stage reads from / writes to

```
   PreToolUse ──read──► [substrates] ◄──write── PostToolUse / Stop

   ╔════════════════ LOCAL-CANONICAL (.interlinked/, append-only JSONL) ═══════════════╗
   ║  ┌─ Codebase graph (Supermodel) ─┐  ┌─ Knowledge graph (structure/) ─┐            ║
   ║  │ file imports · symbol calls · │  │ declared layers · public-symbol │            ║
   ║  │ blast radius · (coverage map) │  │ companions · pkg boundaries ·   │            ║
   ║  └───────────────────────────────┘  │ glossary residue                │            ║
   ║  ┌─ Trajectory / session-state ─┐   └─────────────────────────────────┘            ║
   ║  │ TDD cycles (red_at/green_at) ·│  ┌─ Baselines ─────────────────────┐            ║
   ║  │ test_runs · verification_     │  │ large-files (1000) · coverage-% /│            ║
   ║  │ observed · stubs introduced   │  │ file · CRAP / fn · non-null/as-any│            ║
   ║  │ → powers the §0 red/green +   │  │ · mutation-score / file (planned)│            ║
   ║  │   the Stop nudges             │  └─────────────────────────────────┘            ║
   ║  └───────────────────────────────┘  ┌─ Receipt ledger + finding history (planned)─┐║
   ║                                     │ per-tool-call eval · fingerprint first/last │║
   ║                                     └─────────────────────────────────────────────┘║
   ╚════════════════════════════════════════════════════════════════════════════════════╝
```

### §3 ground truth — substrates today (verified 2026-05-29 · campaign rows updated 2026-06-01)

| Substrate | Status | Reality |
|---|---|---|
| Storage engine | — | append-only JSONL throughout (no SQLite); `.interlinked/*.jsonl` (20+ files) |
| Codebase graph (Supermodel) — imports, calls, blast radius | ✅ → ⚠️ **deprecating** | `supermodel-graph.ts` over `.graph` shards — **Supermodel is being retired** (2026-06). ~28 files read it (`evaluator/pre-tool.ts`, `impact-analysis.ts`, `structural-checks.ts`, `dependency-view.ts`, `dead-on-arrival.ts`, all `graph-prediction-*`). Re-anchor on an `OracleGraph` interface fed by a **TS-toolchain-derived producer** (or our own `.graph` writer); `project-graph.ts` is already Supermodel-free. The graph-prediction reconciler only `import type`s the shape, so the protocol survives the swap. See `project_supermodel_deprecation_graph_oracle_reanchor` + §4b. |
| └ test-coverage map ("what tests cover X?") | ❌ | does not exist; only path-pattern discovery — blocks §13 selection, diff-coverage, mutation-scoping |
| Knowledge graph (`structure/`) | ✅ | layers, companions, boundaries, glossary residue |
| **Trajectory / session-state** | ✅ | `session-state.ts` — TDD cycles, test_runs, verification_observed, stubs; **the substrate the §0 red/green discipline runs on** |
| Baselines | mixed | large-files ✅ (now **1000**) · coverage-%/file ✅ (`coverage-baseline.json` — *generatable since the keystone, not yet cut*) · CRAP 🟡 in-mem · non-null/as-any 🟡 · mutation-score ⬜ |
| Receipt ledger / finding history | ⬜ / 🟡 | decision computed in-memory, ephemeral; `error-history.jsonl` append-by-timestamp (no per-fingerprint lifecycle) |

---

## §4. One ~25s budget, two substrates (local + cloud fan-out)

```
   ╔══════════════ LOCAL SINGLE-MACHINE ══════════════╗   ╔════════ CLOUD HORIZONTAL FAN-OUT (☁️) ════════╗
   ║ What fits ~25s on one box:                       ║   ║ What fits ~25s ONLY by fanning out:           ║
   ║  • the guard pass, the ~100 detectors, tsc/biome ║   ║  • whole-repo / hub MUTATION — N mutants →    ║
   ║  • diff-scoped mutation on leaf/mid files        ║   ║    N sandboxes concurrently                   ║
   ║  • selected covering tests, bounded property     ║──►║  • long acceptance e2e, coverage-guided fuzz  ║
   ║  All substrates local-canonical (.interlinked/). ║   ║  wall-clock ≈ warmup + one covering-suite run ║
   ║                                                  ║   ║    — CONSTANT in unit count                   ║
   ╚══════════════════════════════════════════════════╝   ║  NOT a slow async tier — SAME ~25s budget.    ║
                                                           ║  Levers: pre-warmed pool · ship the diff not  ║
   The cloud is additive: local stays authoritative;      ║   the repo (content-addressed) · concurrency. ║
   sync/receipt format is already signable + hash-keyed.  ║  Cost scales with concurrent sandboxes.       ║
                                                           ╚═══════════════════════════════════════════════╝
```

**Key reframe:** "local vs cloud" is not "fast vs slow" — it's *"what fits the budget on one machine"* vs *"what fits the budget only with fan-out."* The cloud buys **scale, not latency.** A genuinely-slow covering suite (>25s) can't be fan-out-rescued — which is why shrinking the covering-suite runtime (smaller files, the test-runtime ratchet) is the load-bearing prerequisite for both substrates. (Distinct from the multi-agent *sync-barrier* latency, which is coordination wait, not compute — see `feedback_deliberate_prepost_latency`.)

**Mutation, fanned out — the flagship cloud workload:** it runs only *after* a file has **first passed all the red/green TDD checks / unit tests** (no point mutating code that isn't yet green). Then the system makes **one copy (worktree) of the codebase per possible mutation of the file, executes each separately, and returns which mutants survived.** Two facts make clone-per-mutant viable: **(a)** Cloudflare **Artifacts (ArtifactFS) blobless clone** — each copy shares the content-addressed base and is a one-file overlay, so N clones is cheap, not N full checkouts; **(b)** a **Supervisor DO orchestrates and aggregates** (it dispatches mutants and tallies survivors — it does not itself execute). Execution is **Sandbox-class** for real test suites; **Facets** are reserved for the pure-unit subset where colocated SQLite + zero-latency RPC suffice. Result: `wall-clock ≈ warmup + one covering-suite run`, constant in mutant count (§1). *(⬜ / ☁️ — graduates to a gate only via dogfood; all latencies measurement-pending.)* **Scope note:** that clone-per-mutant picture is the **hub / whole-repo** case (**Mode C** in §4a); a *per-edit* small diff needs only **one** box — local (Mode A) or a single Sandbox with Stryker parallelizing internally (Mode B). §4a gives the decision rule and the per-edit async-tail hook flow.

**Status:** the local column is the shipped/near-shipped kernel; the entire cloud column is ☁️ designed-not-built (additive fan-out tier).

---

## §4a. Mutation execution — three modes + the obligation model (per-edit feedback, commit-gate block) · TARGET STATE

**Resolving "does mutation actually need the cloud?"** — Not as a blanket rule. The "one standard-4 Sandbox handles ~20 mutants in ~25s, one sandbox, done" figure is right **for the per-edit small-diff case** — but it is **one *cloud* Sandbox, not no cloud**, and it does **not** generalize to hub files. Mutation has **three execution modes**; which one an edit needs is a function of **mutant count `M` vs. parallelism width `W` vs. the budget** — not a binary local/cloud switch.

**The one formula.** Every mode obeys:

```
wall_clock ≈ warmup + dry_run + ⌈M / W⌉ × t_cover
                                └── the only term that differs by mode ──┘
```

`t_cover` = covering-test runtime per mutant. `dry_run` = Stryker's one instrumented pass that learns each mutant's covering set (`coverageAnalysis:"perTest"`), amortized **once** across all `M`. `W` = how many mutants run at once: a single box's **vCPU count** (Modes A/B) or the **number of concurrent sandboxes** (Mode C).

| Mode | Triggered when | Substrate | `W` (width) | Wall-clock shape | Per-run cost† | Fidelity | Status |
|---|---|---|---|---|---|---|---|
| **A · local box** | leaf/mid file, `M`≈5–20, fits the dev's machine in the Post window | the dev's own CPU | local cores | `⌈M/cores⌉·t_cover` (warmup≈0, deps present) | $0 | full (real local env) | ⬜ Stryker not installed |
| **B · one cloud Sandbox** | same small `M`, but offloaded so it doesn't burn the laptop, or headless/CI | **1 Sandbox**, Stryker-internal parallel | box vCPU (≤~16) | `warmup + dry_run + ⌈M/vCPU⌉·t_cover` (~25s @ `M`≈20, std-4) | ~$0.0017 | full (pinned image ⇒ cloud==local) | ☁️ designed |
| **C · many Sandboxes (fan-out)** | hub file / multi-file diff / whole-repo, `M`≈150–5000, where one box's `⌈M/vCPU⌉` busts the budget | **N Sandboxes**, ≥1 mutant each | account cap (~1500 vCPU) | `warmup + ⌈M/C⌉·t_cover` → ~constant in `M` | ~$0.0001/mutant (total ∝ `M`) | full | ☁️ designed |

†*Cost/latency figures are **modeled** (per the Cloudflare cost analysis) — measurement-pending per the Numbers-discipline note at the top of this doc, not measured facts.*

**Decouple the block *decision* from the *information returned* — they have different requirements.** The *decision* needs only ∃-survivor (one survivor justifies the block). The *information* should be the **complete survivor set**: returning just the first forces the agent through **N fix-rounds** (fix one → re-run → find the next), whereas the full list collapses that to ~one round, lets it make edits that resolve several mutants together, and surfaces cross-effects (one fix breaking another mutant's covering test). Under **full fan-out** (`W ≥ M`, all mutants concurrent) the complete set lands in the *same* wall-clock as the first survivor — so the **default is: run them all, return everything.** **Delivery channel depends on the decision — and a blocked call has no PostToolUse.** PostToolUse fires only *after a tool runs*, so a Pre-blocked call gets **no Post event at all** (verified against all three runners — note below). Therefore:
- **Block path:** put the **full survivor list in the block reason itself** (`permissionDecisionReason` / `additionalContext`) — you computed the whole set in the pre window anyway, so the refusal carries the complete to-do list. **One phase.**
- **Allow / advisory path:** the edit lands, Post *does* fire, and late survivors arrive as Post `additionalContext`. This — and *only* this — is the genuine two-phase split. Use it in advisory mode, or when mutation couldn't finish in the pre window and you allowed rather than blocked on partial info.

Early-exit (cancel the unfinished mutants once one survives) is only a **cost/width-constrained fallback** for when you can't fan wide enough to finish inside the pre-window. You short-circuit the *decision*, never the *information*.

> **Verified — PostToolUse does NOT fire when PreToolUse blocks.** Claude Code: PostToolUse runs *"After a tool call succeeds."* Codex: *"after a tool returns."* Copilot CLI: *"After each tool completes successfully"* (failures route to `postToolUseFailure`; a hook-denied tool never completes, so neither fires). A blocked tool never executes → no Post event. **The block reason is the only in-band channel on a refusal** — the "post window" exists only on the allow path. (Sources: Claude Code hooks reference; GitHub Copilot `hooks-configuration` reference; Codex `codex-rs/hooks` lifecycle via `docs/hooks-ecosystem-comparison.md`.)

**The tradeoff is real, and it is this:** Mode B's wall-clock is **linear in `⌈M / vCPU⌉`**. It fits the budget *only while `M` stays small*, because a single box's width is capped at its vCPU count (~4–16). The moment `M` outgrows `budget × vCPU / t_cover` — a big hub file, or several files in one diff — you must either widen the box (more vCPU, capped) or switch to **Mode C**, whose width is the account vCPU cap (hundreds of boxes). **Fan-out changes nothing about cost** (you pay per mutant-second either way); it converts **linear wall-clock into constant wall-clock**. That conversion is the *only* thing the cloud fan-out buys — exactly Principle #5 ("the cloud buys scale, not time").

Against the per-edit goal:
- **Per-edit, leaf/mid file (the common case) → Mode A or B. No fan-out needed.** "One sandbox, done" is correct here; per-edit you may not even need the cloud (Mode A) — Mode B is about not burning the laptop + a clean pinned env, not capability.
- **Per-edit hub file / multi-file diff, or any whole-repo sweep → Mode C.** Fan-out is mandatory to hold ~25s instead of minutes.

**Why the standalone coverage map (§3, ❌ today) still matters even though perTest scopes covering sets for free:** perTest's dry-run is amortized across all `M` *on one box* (Modes A/B) — no external map needed. **Mode C breaks that amortization**: one-mutant-per-sandbox must either redo the dry-run per sandbox (wasteful) or precompute + distribute the covering map. So the coverage-map keystone is what makes *cheap* fan-out possible — Modes A/B don't need it, Mode C does. (Same keystone §13 smart-selection and diff-coverage need — name it once, build it once.)

### Mutation as an obligation — per-edit feedback, commit-gate block — the hook flow

**Mutation tests the *(source, test) pair*, not the edited file — so it's an obligation, not a per-edit gate.** A surviving mutant says "this pair has a blind spot," and the fix is four-way: edit the **test** (assert it), the **source** (remove dead/redundant code), **both** (refactor for observability, then assert), or **neither** — an **equivalent mutant**, discharged by annotation. The fix loop is cross-file and iterative, and survivors are *normal* mid-development (you haven't written the assertion yet — it's red-green TDD). Gating each edit fights that loop — and since a Pre-block fires **no PostToolUse** (verified above), a per-edit block couldn't even deliver the full survivor list on the blocked edit. So mutation is a **per-plan obligation** (`open-obligation-ledger.md`, example #8): reported the moment it's found (never hidden), tracked across the fix loop, **deadline = commit**. Per-edit is the *allow path* (report + track); the synchronous ~25s cloud block from the modes above **doesn't disappear — it relocates to the commit boundary**, the *block path*, where "done" is unambiguous and the full list rides the block reason.

```
AGENT edits foo.ts (source) OR foo.test.ts (test) — same cluster
  │
  ▼ PreToolUse — only the CHEAP LOCAL gates block here (tsc/lint/secrets/CRAP-lookup,
  │   §0 STAGE 1). Mutation does NOT block the edit. If the cluster has settled,
  │   kick off its mutation run async (bridged Pre→Post, debounced, --incremental). ALLOW.
  ▼ (edit lands)
  ▼ PostToolUse — report + record  (bookkeeping is sync; the run itself is async)
  │   survivors ready? → additionalContext, PRESENT-NOT-PRESCRIBE:
  │     "foo.ts:42 `>=`→`>` survived — assert it (test) · remove dead code (source) ·
  │      make it observable (both) · mark equivalent (annotate)."
  │   → record/refresh an OPEN OBLIGATION on the (source + covering tests) cluster
  │   clean? → discharge it; quiet "✓ foo cluster: all mutants killed"
  │
  │   … agent loops across files; the obligation persists + re-evaluates each run …
  │
  ▼ Stop — nag; Claude/Codex/Gemini can BLOCK-TO-CONTINUE if obligations are open:
  │   "foo cluster: 3 survivors unresolved — your tests don't catch them. Keep going."
  │
  ▼ git commit — PreToolUse on the commit call = THE HARD GATE (synchronous, ~25s)
      run all touched clusters' mutation in-band (incremental + fanned out; ∃-survivor
      early-exit OK — it's a gate). Any open obligation → BLOCK the commit; full
      survivor list in the BLOCK REASON (commit-block fires no Post — the reason carries it).
```

**Why this shape (the principle).** Mutation indicts the *(source, test) pair* and survivors are expected mid-development, so a per-edit block fights the cross-file fix loop — and a Pre-block kills the Post event that would carry the survivor list anyway (verified above). The obligation model fixes both: per-edit it **reports synchronously** (PostToolUse `additionalContext`, present-not-prescribe) and **tracks**, never silently dropping a survivor (`open-obligation-ledger.md`: *"deadline, not suppression"*); the hard block lands at **commit**, where "done" is unambiguous. This is **not** the async-tail anti-pattern — the finding is reported the instant it's known and is hard-gated; the synchronous ~25s cloud block is *preserved*, just **relocated** from per-edit to the commit boundary. The one deviation from the ledger's "stays synchronous" rule: mutation's *evaluation* is async because it genuinely costs ~30–60s — **async-because-expensive, not async-to-dodge-budget**. The ledger *bookkeeping* stays deterministic and synchronous (Principle #7: the steer that informs *this* agent also writes the durable row for the next).

### §4a ground truth — mutation execution today

| Element | Status | Reality |
|---|---|---|
| **Mutation as a per-plan obligation** (report + track, not per-edit block) | ⬜ | `open-obligation-ledger.md` designed-not-built; no obligation ledger (decision is ephemeral, §3) |
| Per-edit async report (bridged Pre→Post, present-not-prescribe, four-way) | ⬜ | no clone/overlay-per-edit path; PostToolUse `additionalContext` channel exists |
| **Commit-gate synchronous ~25s block** (the hard wall) | ⬜ | `git commit` is already intercepted at PreToolUse (tsc/test gate, §2); needs the ~25s budget + in-band cloud run + a `compareMutation` wrapper |
| Stop nag / block-to-continue on open obligations | 🟡 / ⬜ | Stop nudges exist (`verification-stop-checks.ts`); no mutation-obligation consumer |
| Early-exit ∃-survivor at the gate | ⬜ | the gate predicate; unbuilt |
| Mode A/B/C execution (where the mutants run) | ⬜ / ☁️ | **Stryker not installed**; `mutation-gate.ts` is a dormant report-reader (#9); Sandbox binding commented out (`cloud/wrangler.jsonc`) |
| `coverageAnalysis:"perTest"` scoper + `--incremental` | ☁️ | Stryker config; absent (no Stryker) |

*(Optional tier-0 fast lane, pure JS/TS only: batched Dynamic Worker isolates — AOT-bundled deps + mutants packed as static modules in one loaded worker — are ~free under the included allotment but carry a workerd≠Node fidelity asterisk, so they're a leaf-file accelerator, not the default. The default for the cloud==local contract is the Sandbox path above.)*

---

## §4b. The three trust axes — routing by concern × deferrability · TARGET STATE

The per-edit / Stop / commit machinery across §0–§4a resolves into **three orthogonal questions**, each gated on its own substrate. Route by **concern × deferrability** (the latter is the [`open-obligation-ledger`](open-obligation-ledger.md) deferrable-vs-never axis):

| Check class | Deferrable? | Fires | Substrate | Blocks? | Why there |
|---|---|---|---|---|---|
| **Cheap deterministic** (tsc, lint, secrets-regex, `rm -rf`, fail-closed allowlist) | no (safety) | per-edit | local | yes | fast; but **convenience-grade vs an adversary** (`proof-of-enforcement` §4) |
| **Semantic security** (safeguard / gpt-oss-safeguard, trajectory + prompt-injection + exfil) | **NEVER** — immediate blast radius | per-edit | **cloud** (sync ≤25s) | **yes, live** | must stop the specific action *before* it executes; local can't be trusted; the 25s sync PreToolUse cloud block lives here |
| **Quality-bundle** (mutation; multi-file source + test + graph/structure coherence) | yes — artifact property | **Stop**/commit | cloud | commit-block | no security urgency; only meaningful as a settled bundle; debounced to kill redundancy |
| **Context-sufficiency** (graph-prediction: predict the structural neighborhood before the edit; reveal the miss) | no for the per-edit challenge; the accuracy *trend* is a deferred per-session analysis | per-edit (challenge/reveal) + per-session (curve) | **local** (oracle = TS-derived post-Supermodel) | not until the **validation join** passes — shadow/inform-only, then soft-gate/ack | measures whether the agent loaded enough context to *safely touch this file* — the limited-context-window failure mode; complementary to security (intent) + correctness (behavior) |

**The tripod.** Those four rows are three *dimensions of "should this proceed"* — each per-edit-fast and boundary-strong, each gated on one substrate:

| Axis | Question | Per-edit | Boundary | Substrate unlock |
|---|---|---|---|---|
| **Comprehension** (graph-prediction) | does the agent *understand* this code? | predict/reveal (advisory) | per-session curve → trust/escalation | the graph oracle (post-Supermodel producer) + **validation join** |
| **Security** (safeguard / trajectory) | does the action *mean harm*? | cloud block, live | — (immediate) | cloud referee + **proof-of-enforcement** |
| **Correctness** (tests / coverage / CRAP / mutation) | is the code *right*? | diff-scoped local feedback | Stop whole-file + commit gate | **coverage map** + Stryker |

**Per-edit pipeline ordering** — comprehension precedes safety precedes correctness:

```
PreToolUse:  Stage 0  Comprehension      (graph-prediction, advisory)
          →  Stage 1  cheap deterministic (tsc / lint / secrets — local block)
          →  Stage 2  semantic security   (cloud, blocks live)
edit lands →  PostToolUse: diff-scoped correctness feedback + record obligations
          →  Stop:        whole-file correctness + cloud mutation → refresh obligations
          →  commit:      enforce obligations + proof-of-enforcement attestation
```

**Two substrate unlocks are shared across axes** — build these and all three earn teeth at once:
- **The validation join** (`predictive-gate-validation-join.md`) — turns *any* predictive signal (comprehension today, a competence classifier later) into a gating one by proving it predicts defects.
- **The state-substrate decision** (`state-substrate-decision.md`) — the durable, joinable log both the validation join *and* proof-of-enforcement require.

**Status:** the routing is a design synthesis (⬜ as a unified scheme); per-cell build status lives in §0–§4a (cheap-deterministic ✅ local · semantic-security ☁️ · quality-bundle ⬜/☁️ · context-sufficiency 🟡 shadow). Both shared unlocks are ⬜.

---

## §5. The modalities — reference table

Reading guide: "where it fires" = the *target* stage(s); the status column says what's actually built.

| # | Modality | Where it fires (target) | Built today? |
|---|---|---|---|
| 1 | **Red/green TDD discipline** | PreToolUse §0 (test-first ✅ · observed-red ⬜) + Stop (regression ✅) | 🟡 test-first shipped & blocking; observed-red gate designed (#5) |
| 2 | **Every-file-tested** | PreToolUse §0 (companion ∨ covered) | 🟡 companion half (new files); coverage-backed ⬜ (#4) |
| 3 | Test coverage | PostToolUse (diff piggyback) + Stop + CI (ratchet) | 🟡 keystone shipped (generatable); ratchet/piggyback not wired (#3) |
| 4 | CRAP analysis | PreToolUse lookup (rides coverage) | 🟡 wired into `verify`, fail-open until baseline cut (#2) |
| 5 | Cyclomatic complexity | PreToolUse FAST | ✅ (advisory) — refine→promote is #7 |
| 6 | Module sizes | PreToolUse ALWAYS (cap **1000**) + Stop ratchet | ✅ |
| 7 | Mutation testing | **Per-plan obligation** (per-edit report+track) + **commit-gate synchronous block** — present-not-prescribe (test/source/both/equiv); cloud fan-out, early-exit at the gate (§4a + `open-obligation-ledger.md`) | ⬜ / ☁️ dormant reader; Stryker not installed (#9) |
| 8 | Property testing | PreToolUse bounded-N + Stop + nightly deep-shrink | ⬜ zero infra (#6) — fast-check used in 3 test domains today |
| 9 | Unit testing (selected) | PreToolUse ranked subset + Stop broader | 🟡 *observed* via TDD-state; not *selected/orchestrated* (needs §13) |
| 10 | Dependency structure (graph) | read by every stage | ✅ Supermodel; ❌ the "test-coverage map" sub-claim |
| 11 | Knowledge graph (`structure/`) | PreToolUse companion/layer/invariant + Stop drift | ✅ |
| 12 | Acceptance tests | PreToolUse smoke + Stop + pre-push + ☁️ Sandbox | ⬜ no runner; several e2e probes exist under `.interlinked/` |
| 13 | Dependency checking | PreToolUse lockfile-delta + Stop closure + Tier 5 | ✅ allowlist (fail-closed) shipped |
| 14 | The ~100 inline detectors | **PreToolUse** on proposed content (target) | 🟡 run at PostToolUse today; left-shift is the open max-PreToolUse work |
| 15 | Per-tool-use eval (receipt) | PostToolUse write → §13 read | ⬜ ephemeral, not persisted |
| 16 | Brownfield / greenfield posture | affects every threshold | 🟡 baselines exist; triage wizard unbuilt |

---

## §6. Brownfield vs greenfield — same loop, different priors

```
   BROWNFIELD                               GREENFIELD
   ──────────                               ──────────
   Baselines pinned at install.             Baselines start at 0.
   "No regress past current state."         "Every finding is new."
   Provenance matters (introduced /         Provenance trivial
    pre-existing-in-file / -codebase);      (everything = introduced).
    policy matrix applies.                  Trust accrues as receipts do.
   Smart-selection priors seeded by         Adaptive priors empty for the
    blast radius + accumulated bug-catch.    first N edits → uniform.
```

This harness's *own* repo is the brownfield case it dogfoods on: the cap ratchet, the FP-audited promotions, and the grandfather list are all "no regress past current state" mechanisms applied to itself.

---

## How to read this together

The loop in §0–§2 is the same in brownfield/greenfield and local/cloud. What changes is **which substrate fans out** (local-only vs. local+cloud) and **where baselines start** (pinned vs. zero). Two components are load-bearing and unbuilt: **smart-selection (§13)** — how the inner loop actually spends the window — and the **cloud fan-out tier** — how the heaviest checks still hit ~25s. The whole campaign's near-term sequence (cut the coverage baseline → CRAP/ratchet gates → every-file-tested → red→green nudge → property tests → decompose the 3 grandfathered files → cap 1000→800→500 → mutation) is in `docs/design/maximal-local-enforcement-roadmap.md`.

**Leave with this:** *a system highly opinionated about agentic coding best practices, built for agents working under a limited context window on large and growing codebases, that improves agents at runtime so they need fewer reviews later and so multiple agents and humans can work the same codebase on shared, enforced discipline.* Every box above is either in service of that sentence, or a guardrail protecting it.

---

## §7. Per-runner Stop / SessionEnd table (verified 2026-05-26)

> ✅ **Verified accurate** against `docs/hooks-ecosystem-comparison.md` — the one part of this doc with no shipped-vs-designed gap.

> **Local kernel policy: SessionEnd is narrow + Claude-Code-only.** Two items run there: (1) a reason-aware audit-chain row using Claude Code's `reason` field; (2) one-time `reconcileCommits` finalization (`hooks-template.ts:1023-1025`). Everything else stays on Stop because SessionEnd is fire-and-forget on Gemini, missing on Codex, skipped on hard-kill, and unable to block.

| Runner | Stop / equivalent default | SessionEnd default | Blocks at Stop? | Source |
|---|---|---|---|---|
| **Claude Code** | **600s** (`Stop`, per turn) | **600s** (`SessionEnd`, per session) | Yes (`Stop` blocks via `decision: "block"`; max 8 consecutive). SessionEnd: stderr-to-user only. | Anthropic Claude Code hooks docs |
| **Codex CLI** | **600s** (`Stop`, per turn) | **No SessionEnd event** | Yes (`Stop` blocks via `decision: "block"`). `discovery.rs:457` `unwrap_or(600).max(1)`; enforced in `command_runner.rs:71-72`. | Codex source (verified) |
| **Gemini CLI** | **60000ms = 60s** (`AfterAgent`) | **60s** (`SessionEnd`, fire-and-forget) | `AfterAgent` can `decision: "deny"` to force a retry; SessionEnd cannot block. | upstream `docs/hooks/reference.md` |
| **GitHub Copilot CLI** | **30s** (`agentStop`) | **30s** (`sessionEnd`) | **No** at Stop-class — only `preToolUse` blocks (deny-only) | GitHub Copilot hooks docs |
| **Cursor IDE** | platform default (example 30s) | same as Stop | `stop` uses `followup_message` to auto-resubmit (bounded by `loop_limit`, default 5) | `cursor.com/docs/hooks` |

**Practical implications:**
- **Cross-runner hard ceiling = 30s (Copilot).** Single-runner Claude/Codex deploys get **600s** — so "push everything into PreToolUse" has enormous headroom there; the ~25s LCD is the conservative cross-runner plan, and the cloud fan-out tier is what keeps heavy checks inside it for *everyone*.
- **Stop blockability varies** — only Claude Code and Codex truly block at Stop; the kernel keeps Stop-class work advisory regardless.
- **Gemini SessionEnd is unreliable** (fire-and-forget); **Codex has no SessionEnd**. Units diverge (Gemini = ms). Cross-runner installers must translate.
