# Ponytail

- **Source:** [dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail), inspected at commit [`2ed6c52c9d7e5e56942508591085fd45dea277d3`](https://github.com/dietrichgebert/ponytail/tree/2ed6c52c9d7e5e56942508591085fd45dea277d3) (2026-08-08 +03:00)
- **Encountered:** 2026-08-30, user-directed repository clone and crosswalk against Interlinked CLI and the Interlinked MCP Server roadmap
- **Verdict:** **Compound:** Agent CI cloud-roadmap entry for a structured simplification audit/review lens; a layered `interlinked simplify scan|review|audit` capability spanning deterministic Free CLI evidence and deep Agent CI analysis; a Free CLI explicit-debt-marker spike; memory/RFC guidance for benchmark integrity; reject the static `gain` card, subjective blocking checks, and a second bare `audit` meaning.

## 1. Core idea (one sentence)

Ponytail is a portable set of agent instructions that makes a coding model search for the smallest adequate solution, then exposes the same simplification judgment as diff review, repository audit, deferred-shortcut inventory, and benchmark scoreboard prompts.

## 2. Anatomy (concrete walkthrough)

### What the repository actually contains

| Area | Native role | What matters to Interlinked |
|------|-------------|-----------------------------|
| [`AGENTS.md`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/AGENTS.md#L1-L30) and [`skills/ponytail/SKILL.md`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/skills/ponytail/SKILL.md#L32-L120) | The canonical “lazy senior” guidance: understand first, then try YAGNI, reuse, standard library, native platform, installed dependency, and finally the minimum implementation. | The ordered simplification ladder, root-cause/caller tracing, explicit safety carve-outs, and “one runnable check” discipline are reusable guidance. The literal “one line” rung should become “smallest clear implementation,” not code golf. |
| [`skills/ponytail-review/SKILL.md`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/skills/ponytail-review/SKILL.md#L13-L56) | A diff-scoped prompt asking the host model for terse over-engineering findings. | A useful specialist lens and output vocabulary, but no executable detector. |
| [`skills/ponytail-audit/SKILL.md`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/skills/ponytail-audit/SKILL.md#L12-L40) | The review prompt with repository-wide scope and largest estimated cut first. | The highest-value idea: one simplification engine parameterized by scope, with audit as the full-repository form. |
| [`skills/ponytail-debt/SKILL.md`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/skills/ponytail-debt/SKILL.md#L11-L44) | A prompt-directed grep for `ponytail:` comments, rendered as a ledger of ceilings and upgrade triggers. | “A deliberate shortcut must name its ceiling and trigger” is strong. Raw branded-comment grep is not a trustworthy ledger. |
| [`skills/ponytail-gain/SKILL.md`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/skills/ponytail-gain/SKILL.md#L11-L49) | A canned ASCII card containing benchmark claims, not a measurement of the current repository. | Its counterfactual honesty rule is worth adopting; its hard-coded metrics are a provenance-drift example to avoid. |
| [`commands/`](https://github.com/dietrichgebert/ponytail/tree/2ed6c52c9d7e5e56942508591085fd45dea277d3/commands), host manifests, and adapters | Thin aliases that ask the current host model to load a skill. | Confirms that `review`, `audit`, `debt`, and `gain` are prompts, not scanners, stores, or benchmark runners. |
| [`hooks/`](https://github.com/dietrichgebert/ponytail/tree/2ed6c52c9d7e5e56942508591085fd45dea277d3/hooks) | Injects the guidance, persists modes, and compensates for hosts that do not propagate context into subagents. | Useful adapter invariants and fail-open timeout discipline; the subjective `lite/full/ultra` mode system should not be mixed with Interlinked policy modes. |
| [`benchmarks/`](https://github.com/dietrichgebert/ponytail/tree/2ed6c52c9d7e5e56942508591085fd45dea277d3/benchmarks) | Paired agent experiments, deterministic task checks, an LLM over-engineering judge, completeness checks, and several candid follow-up audits. | The benchmark and falsification method is more valuable than the headline numbers. It provides the evaluation shape for an Interlinked simplification reviewer. |
| [`tests/`](https://github.com/dietrichgebert/ponytail/tree/2ed6c52c9d7e5e56942508591085fd45dea277d3/tests) | Mostly adapter presence, copy parity, hook behavior, and benchmark-check self-tests. | Good distribution tests, but no audit/review precision fixtures, ranking tests, schema validation, or verified line-savings tests. |

Ponytail is therefore closer to a portable prompt package than a code-analysis product. Its root package is MIT-licensed and declares no runtime dependencies ([`package.json`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/package.json#L1-L45)).

### End-to-end audit walkthrough

1. A user invokes `/ponytail-audit`, optionally with a target on hosts that preserve arguments.
2. The host adapter delegates to, copies, or asks the agent to load `skills/ponytail-audit/SKILL.md`.
3. The same general-purpose host model explores the repository using whatever tools and context that host provides.
4. The model emits free-text `delete`, `stdlib`, `native`, `yagni`, or `shrink` rows, ordered by guessed impact.
5. It guesses a net removable line/dependency total and applies nothing.
6. There is no canonical JSON, stable finding ID, coverage receipt, overlap handling, persisted run, patch, build/test validation, or rereview state.

The surprising part is step 2: `audit` is not an implementation hiding behind a slash command. The same is true of `review` and `debt`. `gain` does not even inspect the repository; it prints old benchmark prose.

### The five audit/review categories

| Ponytail tag | Useful interpretation | Evidence Interlinked should require |
|--------------|-----------------------|------------------------------------|
| `delete` | Behavior, code, dependency, flag, or flexibility that can disappear. | Reachability/import evidence, usage search, public-boundary and deliberate-seam checks; mutation or sandbox validation for higher confidence. |
| `stdlib` | Hand-written behavior replaceable by a standard-library API. | Exact target runtime/version, semantic-contract comparison, call-site evidence, and tests. API existence alone is insufficient. |
| `native` | Dependency/custom code replaceable by a platform capability. | Browser/OS/runtime support constraints, accessibility and behavior parity, dependency graph, and relevant tests. |
| `yagni` | Speculative variation point: one implementation, one product, unset configuration, or one-caller layer. | Project graph/caller counts plus evidence that it is not a public contract, generated boundary, test seam, framework requirement, or documented extension point. |
| `shrink` | Same contract expressed more directly. | A concrete candidate patch and semantic/build/test validation; line count alone is not evidence. |

The category is a **remedy axis**, not severity. It should augment Interlinked’s normal check ID, evidence, confidence, policy, and lifecycle fields rather than replace them.

## 3. Deterministic or agentic?

**Hybrid repository; agentic core.**

- Instruction selection, hook injection, mode persistence, adapter generation, text parity checks, and many benchmark task checks are deterministic.
- The actual review/audit judgment is the current host LLM reading code and following prose. Ponytail’s benchmark separately uses an LLM judge because over-engineering is not treated as a deterministic property ([`benchmarks/agentic/judge.py`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/benchmarks/agentic/judge.py#L1-L39)).
- Deterministic subsets exist: unused imports/exports, project-graph counts, dependency inventory, exact runtime support checks, and structured marker parsing. Those can land locally if they meet the CLI time budget.
- Broad claims such as “this abstraction is unnecessary” or “this implementation is semantically equivalent to that native API” remain inferential and route to Agent CI.

**License:** MIT. Borrowing patterns or adapting prompt concepts is allowed. No Ponytail runtime dependency is needed or recommended.

## 3b. Role in its native architecture — and does it transfer?

In Ponytail, the skills are a **cooperative-agent convenience and steering layer**. They are not a security boundary, deterministic oracle, or enforcement gate. The human sees a read-only recommendation from the same model already doing the coding.

That role transfers only as:

- an **advisory local evidence view** for deterministic candidates;
- a dedicated **Agent CI specialist/escalation** for semantic repository audit and diff review;
- a **separately authorized** patch-and-validate workflow in a Cloudflare Sandbox; and
- a durable finding lifecycle in the Interlinked MCP Server/Agent CI findings substrate.

It does **not** transfer as a `pre_block` check. “YAGNI,” delegating-wrapper taste, one-product factories, and estimated simplification all violate the zero-false-positive contract for blocking checks. Guardrails should not put a full-repository LLM scan on its sub-second request path.

## 4. Substrate vs. surface

**Borrowable substrate:**

- an ordered “do we need it / already have it / stdlib / native / installed dependency / minimum implementation” decision ladder;
- a simplification-only review lens, distinct from correctness/security/performance review;
- the five remedy categories and requirement to name a replacement;
- full-repository audit and diff review as the same operation with different scope;
- explicit ceiling-plus-trigger receipts for intentional shortcuts;
- read-only-by-default behavior;
- canonical skill behavior with thin host adapters and parity tests;
- paired real-agent benchmarking, instrument self-tests, safety/completeness checks, isolated arms, and publication of null or adverse results.

**Ponytail surface to avoid copying:**

- free-text findings as the only schema;
- unqualified “whole tree” or “lean already” claims without coverage/exclusion receipts;
- raw aggregate line/dependency estimates with overlapping findings;
- a branded-comment grep posing as a debt ledger;
- stale benchmark numbers embedded in a prompt;
- subjective always-on intensity modes; and
- adapter tests that prove files exist while arguments and semantics drift.

Interlinked should borrow the substrate and expose it through existing CLI evidence, the findings corpus, and Agent CI—not depend on or invoke Ponytail itself.

## 5. Lane (1–6)

**Primary: lane 5, cloud-only fodder.** The valuable whole-repository audit and semantic diff review depend on an LLM judgment, broad repository retrieval, synthesis, and eventually sandbox execution. Their natural home is Agent CI P4–5.

**Secondary: lane 2, detection techniques.** A bounded deterministic subset—delegate-only wrappers, one-product factories, never-read configuration, dependency/use evidence, source-aware debt-marker validation—can become advisory local checks after labeled-corpus validation. Existing dead-code and single-implementation-interface checks already cover part of this lane.

The simplification ladder and benchmark discipline also influence architecture, but they do not require a third implementation lane: they are design constraints on the lane-2 and lane-5 work.

## 6. Dependency & displacement

- **Deps:** no new Interlinked CLI runtime dependency. Reuse current scanners/graphs and native TypeScript/Node facilities. Agent CI uses its already-designed model, Artifact, Sandbox, AI Gateway, and persistent findings primitives; it should not import Ponytail.
- **Displacement:** compose `deadcode --categorize`, `verify --all-checks`, `metrics`/`metrics arch`, dependency inventory, mutation evidence, and the findings corpus. Do not create parallel dead-code, audit-state, debt-obligation, or external-review stores.
- **Equivalence:** Interlinked is already ahead on safe dead-code evidence and finding lifecycle; it is designed but unbuilt for asynchronous semantic review; it is absent on a dedicated simplification specialist, explicit shortcut-marker grammar, and evidence-generated impact reporting.

### Capability-by-capability crosswalk

| Ponytail capability | Interlinked equivalent | Status | Disposition |
|---------------------|------------------------|--------|-------------|
| Whole-repository simplification audit | Agent CI wide/full-repository review design in `docs/design/tier-3-async-deep-review.md` | **designed** | Add a dedicated `simplification` lens and repository scope; reuse the common reviewer/finding pipeline. |
| Diff-scoped simplification review | Introduced-only PostToolUse filtering; Tier-3 diff review design | **designed / partial shipped** | One engine, `scope=changed`. A real local `--changed`/`--staged` read-only scope remains useful. |
| Dead code / removal candidates | `interlinked deadcode --categorize` and safety buckets | **ahead** | Feed this evidence into audit; do not replace it with raw LLM deletion advice. |
| Single-implementation interface | `single_implementation_interface` advisory check | **shipped** | Keep advisory and provide its evidence to the specialist. |
| One-product factory | No focused check | **absent** | Candidate advisory detector after corpus validation. |
| Delegate-only wrapper | Some clone/dead-code overlap; no focused check | **absent** | Candidate advisory detector; require call-graph and boundary evidence. |
| Never-used flag/configuration | Partial dead-code/use scanning | **partial shipped** | Extend only where usage can be proven; dynamic configuration makes blanket claims unsafe. |
| Standard-library replacement | No general semantic replacement engine | **absent** | Agent CI, grounded in target runtime/version and semantic contract. |
| Native-platform replacement | No general version-aware platform catalog | **absent** | Agent CI; Ponytail’s `docs/platform-native.md` can seed examples, never unconditional policy. |
| “Same behavior, fewer lines” | Complexity/CRAP/clone metrics expose hotspots, not equivalence | **absent** | Agent CI proposal plus P5 Sandbox validation. |
| Rank largest cuts first | Metrics rank hotspots; no risk-adjusted simplification ranking | **absent** | Rank non-overlapping findings by confidence-adjusted, validated impact. |
| Net removable lines/dependencies | Git diff and dependency state exist, no counterfactual estimator | **absent by design** | Separate potential, sandbox-validated, accepted, and causal values. Never sum overlapping guesses. |
| Read-only one-shot report | Most verify/metrics/deadcode commands are read-only | **shipped** | Preserve default; recording and patching require explicit actions. |
| Structured finding schema | Tier-3 JSON design and external findings corpus | **ahead** | Add remedy, impact, validation, overlap, and coverage fields. |
| Finding persistence/rereview | Findings ingestion, anchored liveness, corpus reconciliation | **ahead** | Write Agent CI results directly to the common corpus; local report stays ephemeral unless `--record`. |
| Deliberate-shortcut receipt | Current `debt` is automatic coverage/red-suite/transient obligations | **absent and name-colliding** | Add a separate manual marker source/index under `debt markers` or `debt harvest`. |
| Ceiling + explicit upgrade trigger | No source-marker contract | **absent** | Adopt with a structured, source-aware grammar and `no-trigger` advisory. |
| Observed token/cost/LOC activity | Activity/session/status logs | **shipped** | Report as observed activity, not savings. |
| Causal “gain” measurement | No paired-control product measurement | **absent** | Cloud benchmark/evaluation program only; do not ship a marketing command first. |
| Tamper-evident audit chain | `interlinked audit verify` | **ahead but unrelated** | Preserve the existing meaning. Never make bare `audit` silently run code simplification. |
| Canonical skill + thin adapters | Focused `skills/interlinked-*` guidance and client installer registry | **shipped / ahead on hook semantics** | Keep one contract, generate adapter/help copies, and test argument plus semantic parity. |
| Rules in every subagent context | Client-specific hooks and shared generated hook orchestration | **partial shipped / host-dependent** | Audit supported-client behavior; copy only the invariant that subagents get required policy when the host drops parent context. |
| Benchmark judge canary | Check-evidence corpora and mutation/evidence discipline | **shipped in a different form** | Add labeled audit fixtures and judge self-tests; do not trust an uncalibrated LLM scorer. |
| Full safety/completeness validation | Type/test/security/mutation checks; P5 Sandbox design | **designed / partial shipped** | Run independently of the simplification specialist. “Correctness out of scope” defines report focus, not permission to break it. |

### Command and state collisions

- `interlinked audit verify` already verifies the tamper-evident activity hash chain (`src/registrars/observability-logs.ts:125-143`). Do not redefine bare `audit`. The cleanest new namespace is `interlinked simplify scan|review|audit`: `scan` composes deterministic local evidence, `review` uses changed/diff scope, and `audit` uses repository scope. If product design instead keeps one generic reviewer, use an explicit `lens=simplification` plus `scope=changed|repository`; never silently change bare `audit`.
- `interlinked debt list/show/resolve` owns automatically generated coverage, red-suite, and transient obligations (`src/commands/debt.ts` and `src/harness/obligations.ts`). Manual source markers need a distinct record kind and closure rules.
- `interlinked harness scanner review` is PII adjudication, not code review. A future top-level review command must not reuse that store or semantics.
- The existing opt-in Supermodel dead-code path should be subsumed by one Agent CI simplification pipeline, not become a third review ledger.

## 7. Smallest spike

**One-day audit schema + adversarial fixture spike; do not add command plumbing yet.**

1. Define the structured simplification finding extension: remedy category, repository/tree SHA, path/span, cut, replacement, evidence, confidence, estimated impact, validated impact, validation receipt, overlap group, and scope coverage.
2. Build a small labeled fixture corpus with one true positive for each category and traps for a public interface, deliberate test seam, generated file, dynamic configuration, framework adapter, trust-boundary validation, accessibility behavior, and a standard-library API with the wrong semantics.
3. Feed the specialist existing deterministic JSON from dead-code categorization, metrics, the single-implementation-interface advisory, manifests/runtime constraints, and a bounded source inventory.
4. Require valid JSON, exact locations, explicit evidence/replacement, no protected-behavior deletion, and useful top-five ranking.
5. Add a canary that must rank a known overbuilt fixture above its minimal counterpart, plus an independent completeness/safety validator.

Success means the specialist is precise enough to justify an Agent CI RFC/roadmap item. Failure means improve the evidence and evaluation; do not compensate with more untested prompt prose.

## 8. Phase relevance

There is intentionally **no Guardrails P2–3 row**. Repository-wide inference exceeds the synchronous budget, and simplification taste is not a safe blocking classifier. Guardrails may later enforce a deterministic, human-approved anti-regression rule distilled from repeated audit evidence, but that is the ordinary findings-to-check loop rather than a Ponytail-derived product slice.

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Compose shipped dead-code, advisory structure, metrics, dependency, and mutation evidence into a read-only simplification profile; add changed/staged scope rather than a second analyzer. | Prototype a JSON merger/report over current outputs and three fixtures; no new runtime dependency. | next |
| Free CLI (P1) | Structured manual shortcut receipts under `debt markers`/`debt harvest`, separate from automatic obligations. | Parse one explicit marker grammar, exclude non-source/generated/vendor files, flag missing triggers, emit stable JSON fingerprints. | now |
| Free CLI (P1) | Evidence-generated “impact” facts limited to observed/accepted deltas. | Render accepted finding closures, actual diff/dependency changes, and ratchet movements from one versioned fact artifact. | parked until audit/debt records exist |
| Agent CI (P4) | Full-repository and diff-scoped simplification specialist, deterministic-evidence grounding, synthesizer/adversary, structured findings, caching, and rereview. | §7. | next |
| Agent CI (P5) | Candidate patch on a forked Artifact, type/build/test/security/mutation checks in a Cloudflare Sandbox, exact non-overlapping delta, then human approval. | Validate one `delete` and one `native` candidate end to end. | next after P4 |
| Agent CI (P4–5) | Trigger-aware manual debt lifecycle and controlled impact experiments/team dashboards. | Evaluate one deterministic trigger; generate one benchmark card from a pinned result manifest. | parked |

## 9. Artifact

**Compound verdict:**

1. **Cloud-roadmap entry / RFC:** a dedicated Agent CI `simplification` specialist with `scope=diff|repository`, backed by existing deterministic evidence, the common structured findings corpus, an adversarial completeness/safety pass, and optional P5 Sandbox validation. The eventual CLI family should be `interlinked simplify scan|review|audit`, not aliases over the existing forensic `audit` command.
2. **Free CLI PR candidates:** an explicit manual-debt marker grammar and parser; then a deterministic simplification evidence profile and changed/staged review scope if the prototype demonstrates value.
3. **Memory/RFC constraint:** generated benchmark facts, paired-control methodology, and strict separation of potential, verified, observed, and causal impact.
4. **Skip:** a new bare `audit` behavior, a raw `ponytail:` grep, a hard-coded `gain` card, subjective pre-blocking, “file exports one thing” as a smell, and global `lite/full/ultra` modes.

## Notes

### Recommended audit architecture

The audit should be one pipeline with different depth and scope, not four independent commands:

```text
deadcode / graph / metrics / manifests / runtime facts
                         │
                         ▼
        simplification specialist (P4, JSON)
                         │
                         ▼
       synthesizer: dedupe + overlap + rank + coverage
                         │
                 ┌───────┴────────┐
                 ▼                ▼
     adversary/completeness   optional patch (P5)
          validator           + Sandbox checks
                 └───────┬────────┘
                         ▼
        common findings corpus + terse CLI/PR view
```

The normal reviewer should see the diff and bounded dependency/caller context. The full audit should partition the repository by module/import graph, give specialists a declared file inventory, then synthesize across partitions. Every run needs:

- repository/tree SHA and scope;
- included and excluded paths/languages;
- files not read because of tool/context limits;
- evidence-source versions;
- prompt/policy/model version;
- deterministic check receipts;
- whether a patch was attempted;
- validation commands and results; and
- a clean-result message limited to “no findings in covered scope.”

This corrects Ponytail’s strongest overclaim: a model that did not cover the tree cannot safely say the repository is lean.

### Proposed finding extension

Use Interlinked’s existing finding identity/lifecycle and add fields rather than invent a parallel store:

```json
{
  "lens": "simplification",
  "scope": "repository",
  "remedy": "delete|stdlib|native|yagni|shrink",
  "location": {
    "tree_sha": "…",
    "path": "src/example.ts",
    "start_line": 10,
    "end_line": 42
  },
  "summary": "Concrete cut",
  "replacement": "Concrete replacement or nothing",
  "evidence": [],
  "confidence": 0.0,
  "impact": {
    "estimated_loc": -33,
    "estimated_dependencies": [],
    "validated_loc": null,
    "validated_dependencies": null
  },
  "validation": {
    "status": "not_run|passed|failed|inconclusive",
    "commands": [],
    "artifact_sha": null
  },
  "overlap_group": null
}
```

Do not duplicate fields the common schema already owns. The important additions are remedy, replacement, impact provenance, validation, and overlap. Terminal and PR output can preserve Ponytail’s excellent terseness while `--json` and detail views expose the evidence.

Ranking should be based on a risk-adjusted value such as:

`validated impact × confidence × reversibility ÷ change risk`

Raw estimated line count is only a tie-breaker. Findings touching the same code or dependency belong to an overlap group and cannot all contribute to a total.

### Safety boundaries that must be stronger than Ponytail audit

Ponytail’s main skill exempts trust-boundary validation, data-loss prevention, security, accessibility, explicit requirements, hardware calibration, and the minimal runnable check. Its audit prompt does not restate all of those safeguards while declaring correctness/security/performance outside its reporting scope. Interlinked must preserve the specialist scope without treating it as removal permission.

A proposed cut must be vetoed or downgraded when it affects:

- trust-boundary validation or authorization;
- secret handling, auditability, or security controls;
- data-loss prevention, recovery, migration, or rollback paths;
- accessibility and user-agent/platform compatibility;
- public APIs, extension points, generated/framework boundaries, or documented compatibility;
- the only meaningful test/check for non-trivial behavior; or
- runtime semantics unsupported by the target versions.

Ponytail’s own robustness audit found a concrete parser-versus-validator mismatch when a model followed “standard library first”; attempts to fix it by adding more prompt language did not reliably help ([robustness audit](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/benchmarks/results/2026-06-16-robustness-audit.md#L90-L115)). The adaptation is not a longer prompt. It is evidence about the target contract, adversarial fixtures, and independent execution checks.

### Review: the same lens at diff scope

Adopt Ponytail’s separation of concerns:

- normal review continues to cover correctness, security, performance, policy, and maintainability;
- simplification review asks only what introduced complexity can safely disappear;
- the two reports sit beside each other; neither suppresses the other;
- a changed-line finding includes base/head SHA and diff side, not only `L12`;
- introduced-only deterministic signals run locally;
- semantic replacements run in Agent CI; and
- applying a change is a separate action.

A local `--changed`/`--staged` scope is a real gap because `interlinked verify` is whole-project while PostToolUse is introduced-only. That scope adapter is more valuable than copying Ponytail’s free-text slash command.

### Debt: explicit receipts, not comment harvesting

The transferable invariant is:

> A deliberate simplification that knowingly imposes a limit is not complete until it records both the limit and the measurable condition that justifies an upgrade.

Use an Interlinked-owned grammar, for example:

```ts
// interlinked-debt: in-memory scan; ceiling="10k records"; trigger="p95 > 100ms"; issue="ENG-123"
```

The exact grammar needs a design/test pass, but the requirements are clear:

- explicit opt-in prefix;
- required shortcut/decision, ceiling, and trigger;
- optional owner, issue, and review date;
- source-language-aware comment parsing;
- repository-relative path, line, commit, and content fingerprint;
- generated/vendor/build/docs/example exclusions by default;
- `--json` output;
- `no-trigger`/malformed advisory, never `pre_block` initially;
- removal or explicit resolution closes the manual record with provenance; and
- no ability for a manual marker to discharge an automatic coverage/red-suite obligation.

An audit finding explicitly deferred by a human can create or link one of these records. Audit should never create debt silently. The Interlinked MCP Server can later sync age/owner state, evaluate deterministic triggers from CI/telemetry, and open a notification or task when a trigger fires. Semantic trigger evaluation belongs to Agent CI.

Raw Ponytail-style grep should not be copied. Its marker pattern also matches examples, docs, implementation comments, and ordinary rationale that do not contain a ceiling or trigger. Those are search hits, not debt records.

### Gain: four evidence classes

| Class | What can be reported | Label |
|-------|----------------------|-------|
| Audit opportunity | Non-overlapping estimated reduction from current findings. | **potential**, never gain |
| Sandbox candidate | Exact patch/dependency delta after the candidate builds and passes selected checks. | **sandbox-validated**, still unaccepted |
| Accepted repository history | Actual merged lines/dependencies removed, finding/debt closures, ratchet improvements, verify trend. | **observed**, not necessarily caused by Interlinked |
| Product effect | Difference against a pinned paired control or credible cohort, with model/repo/client/date/sample size and safety/completeness outcomes. | **causal estimate** only when the design supports it |

Ponytail itself states the right counterfactual boundary: it cannot know what the same repository would have looked like without the guidance. Interlinked should preserve that honesty and avoid a `gain` command until it has trustworthy data.

The current Ponytail card demonstrates why. It still embeds older single-shot claims in [`ponytail-gain/SKILL.md`](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/skills/ponytail-gain/SKILL.md#L16-L37), while the current README explicitly reclassifies those results as a chatty-baseline artifact and reports a newer real-agent experiment ([README lines 27–29 and 59–88](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/README.md#L27-L29)). The command, README, and benchmark prose have drifted.

Interlinked should:

- store benchmark facts in a versioned JSON artifact with provenance;
- generate docs, terminal cards, and dashboard text from that artifact;
- test generated-surface parity;
- include safety/completeness beside LOC/tokens/cost/time;
- retain null, adverse, and provider-specific results;
- distinguish model/provider versions and caching;
- show observed local activity without calling it savings; and
- link an impact view back to the exact audit findings, accepted patches, or debt closures.

### Benchmark/evaluation method to adopt

Ponytail’s later benchmark is unusually useful because it records contamination and corrects earlier claims. It uses real headless coding sessions, the same agent without the skill as baseline, fresh contexts, a pinned public repository, Git diff LOC, separate overbuild and safety axes, and published limitations ([agentic benchmark](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/benchmarks/results/2026-06-18-agentic.md#L26-L76)).

For the Interlinked audit evaluation:

1. Pin repository SHA, task, model/provider, client/harness version, prompt/policy hash, runtime, and dependencies.
2. Isolate control and treatment settings so no global hook/plugin contaminates the baseline.
3. Self-test deterministic task scorers and the LLM judge before scoring candidates.
4. Pair known bloated/minimal implementations and include unsafe attractive reductions.
5. Measure precision at the top of the ranked list, protected-behavior false positives, valid non-overlapping removal, dependency delta, time, tokens, and cost.
6. Run type/build/tests/security/mutation independently of the simplification judge.
7. Preserve failed workspaces, raw structured findings, and validation receipts.
8. Publish nulls, reversals, provider differences, and limitations.

The source’s cost follow-up is another warning: recurring instruction and reasoning-token overhead can outweigh shorter output for some models ([cost verification](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/benchmarks/results/2026-06-17-cost-verification.md#L7-L22)). Agent CI should use the existing risk-tiered specialist/failback and shared-context caching design rather than assume that more prompt always means cheaper review.

### Main guidance and portability ideas

| Idea | Adaptation |
|------|------------|
| Understand and trace the real flow before minimizing | Adopt in a future simplification-review prompt/skill and audit evaluator. Small code in the wrong place is not a win. |
| Search every caller and repair the shared cause once | Useful coding-agent guidance and audit context-expansion rule; keep it bounded by project graph and public-boundary evidence. |
| Prefer reuse before new dependency/code | Aligns with Interlinked’s supply-chain stance and project-graph substrate. |
| Standard library/native/installed dependency ladder | Keep as an ordered question, not a rule. Require version and semantic evidence. |
| Shortest working diff / deletion over addition | Rewrite as “smallest clear, validated change satisfying the contract.” Raw LOC rewards code golf and stubs. |
| One runnable check for non-trivial logic | Preserve as a safety floor. Never flag the only meaningful smoke test as bloat. |
| Question complex requests | Do not automatically ship a smaller interpretation. Clarify only when scope is genuinely ambiguous or a safer/simpler equivalent satisfies the stated intent. |
| Hardware calibration caveat | Sound general advice, but no distinct Interlinked capability follows from it. Keep out of audit policy. |
| Canonical source plus thin adapters | Adopt/continue. Generate copies where possible and test target/flag forwarding plus semantic output, not just file presence. |
| Subagent context reinjection | Verify per supported client. If a host drops required policy, inject the canonical minimum with a bounded, fail-open hook. |
| `lite/full/ultra/off` | Skip. It is prompt personality/intensity, conflicts conceptually with Interlinked check policy, and adds recurring context cost. |

Ponytail documents broad host portability and has useful copy-parity machinery ([agent portability](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/docs/agent-portability.md#L1-L49), [copy checks](https://github.com/dietrichgebert/ponytail/blob/2ed6c52c9d7e5e56942508591085fd45dea277d3/scripts/check-rule-copies.js#L15-L76)). Its tests also reveal the limit of presence-only parity: some hosts preserve audit targets while another adapter discards them. Interlinked’s supported-client registry should pin argument and behavior parity as part of any new review/audit surface.

### Priority backlog

| Priority | Build or decision | Product | Why |
|----------|-------------------|---------|-----|
| Critical | Simplification finding schema, prompt, adversarial fixtures, and judge/completeness canaries | Agent CI design spike | Tests the central idea before committing command/storage surfaces. |
| Critical | Structured `interlinked-debt:` marker grammar and read-only parser | Free CLI | Small, deterministic, valuable independently, and does not need a model. |
| High | Full-repository simplification specialist grounded in current deterministic evidence | Agent CI P4 | The largest capability gap and Ponytail’s best idea. |
| High | P5 candidate patch plus independent validation and exact impact | Agent CI P5 | Converts advice into stronger evidence without auto-applying. |
| High | Changed/staged simplification review scope and deterministic evidence composer | Free CLI | Reuses shipped machinery and closes a real scope gap. |
| High | Findings-corpus integration, fingerprints, rereview, defer-to-debt action | Both | Prevents a one-shot prompt from becoming a parallel lifecycle. |
| Later | Version-aware stdlib/native capability catalog | Agent CI first; local deterministic entries later | Valuable but semantic and maintenance-heavy. |
| Later | Trigger evaluation and owner/age dashboard for manual debt | Interlinked MCP Server / Agent CI | Requires central state or telemetry for the useful lifecycle. |
| Later | Generated observed-impact view | Both | Only after audit/debt facts exist. |
| Skip | Static `gain` command or universal savings claim | — | No credible per-repository counterfactual; the source’s own card drift proves the risk. |

### Provenance and verification

- Cloned with shallow depth 1 to `/tmp/ponytail-interlinked-analysis-20260830` and inspected at `2ed6c52c9d7e5e56942508591085fd45dea277d3`. The clone exposes only that grafted commit, so command history/origin was not inferred.
- Read the canonical skills, compact guidance, host adapters, hooks, portability/copy checks, benchmark code, current benchmark reports, package/license, and relevant tests from the clone rather than relying on README summaries.
- Cross-checked Interlinked command registration and implementations for audit-chain verification, obligations debt, scanner review, dead-code categorization, advisory checks, metrics, findings reconciliation, activity/impact facts, Agent CI design, and product latency/phase boundaries.
- Used three parallel analyses: Ponytail audit internals; Ponytail review/debt/gain plus benchmark claims; and Interlinked shipped/designed/absent/ahead crosswalk. The synthesis above resolves their naming recommendations conservatively: no new bare command semantics and no parallel state stores.
- Ran `npm test` in the clone. Result: 83 of 84 root tests passed; the CSV correctness self-test failed because `pandas` is not installed and is not declared by the root package. The failure appears environmental/reproducibility-related rather than an audit behavior failure, but it is evidence that benchmark self-tests need an explicit toolchain manifest or deterministic skip/preflight.
- No external web summary was used for load-bearing claims. Stable links above pin the raw source commit.

## Methodology notes

This intake treats prompt output as a hypothesis source, not as deterministic evidence. That distinction is the central routing result: Ponytail’s vocabulary and evaluation habits are useful, while its slash-command names conceal how little machinery exists behind them.

The source is also most valuable where it falsifies itself. Its newer benchmark corrects the earlier conversational baseline, its cost follow-up shows provider/model reversals, and its robustness audit documents a semantic standard-library failure that additional prompt text did not fix. An Interlinked adaptation should institutionalize that self-correction through versioned facts, adversarial fixtures, independent validators, and the durable findings lifecycle.
