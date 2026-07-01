# Heavy Coder

- **Source:** https://github.com/codegraphtheory/heavy-coder (CodeGraphTheory; docs at graphtheory.xyz/heavy-coder)
- **Encountered:** 2026-06-27, GitHub link from QC ("anything we can adapt/learn?")
- **Verdict:** memory note (convergent-architecture validation) **+ one lane-2 spike** (intent-vs-action mismatch). Compound. Nothing to borrow wholesale.

## 1. Core idea (one sentence, your words)
A **Hermes Agent** (Nous Research CLI) profile that forces "Grok Heavy"-style **multi-candidate coding swarms**: hooks block solo repo edits until the coordinator fans out N parallel leaf agents (`delegate_task`, default 8), each emits a structured evidence JSON, a deterministic rubric ranks them, the (LLM) coordinator synthesizes a winner, and a future fail-closed gate would carry it issue→PR→merge.

## 2. Anatomy (concrete walkthrough)
Python 3.11 package `heavy-coder-foundation` ("Deterministic foundations…"), **zero runtime deps** (`pyproject.toml` `dependencies = []`; dev-only pytest/jsonschema/mypy/ruff/PyYAML), MIT. The repo is **scaffolding + hooks + skills**; the LLM swarm runs in the external Hermes/Composer runtime, never in this code (grep confirms: no `openai`/`anthropic`/`httpx`/`requests`/`api_key`; the only `subprocess` is `git`/`gh`).

Annotated map:
- `agent-hooks/` — Hermes stdin-JSON hooks (the harness). `hook_lib.py` (347L) is the shared lib: `read_payload()` parses `hook_event_name`/`session_id`/`tool_input`/`extra.user_message`; per-session phase state persisted to `~/.hermes/.../hook-sessions/{id}.json`.
- `src/heavy_coder/` — deterministic core: `triage.py` (adaptive width), `team_plan.py` (plan builder), `policy.py` (merge gate), `state.py` (run-state machine), `candidate_result.py` (schema validation), `log_privacy.py` (path redaction), `council_injection.py` (compact injection).
- `skills/` — 17 `SKILL.md` operating contracts + `heavy-issue-to-merge/scripts/` (claim/publish/merge/policy_gate, all fail-closed).
- `schemas/` — `candidate-result.schema.json` (the evidence envelope).
- `config.yaml` — Hermes hook wiring + `heavy_coder.*` config.

Load-bearing files (my words):
1. **`agent-hooks/pre_tool_heavy_team.py`** — PreToolUse block. While phase==`AWAITING_DELEGATE`, blocks every mutation tool (`patch`/`write_file`, write-like `terminal`/`execute_code`/`skill_manage`) until the agent fans out a `delegate_task` of ≥`min_delegate` tasks; also blocks an undersized batch. *Workflow-shape enforcement via a phase machine.*
2. **`agent-hooks/hook_lib.py`** — besides the protocol + state, two regex batteries: `_TERMINAL_WRITE_HINTS` (`>`/`>>` redirect *excluding `/dev/null|stdout|stderr`*, `tee`, `sed -i`, `patch`/`git apply`, mutating git verbs, `rm|mv|cp|touch|truncate`, pkg installs) and `_EXECUTE_CODE_WRITE_HINTS` (`.write_text`, `open(…,'w')`, `shutil`, `os.remove`). Plus `should_trigger_team_plan()` — a **read-only-vs-implementation classifier on the user message** (inspect/audit/review ⇒ read-only; implement/fix/add ⇒ mutating).
3. **`src/heavy_coder/triage.py`** — fully deterministic prompt router: `HIGH_RISK_PATTERNS` (refactor/security/migrate/cross-cutting/breaking) → width 5; `HEAVY_COUNCIL_PATTERNS` → 16; long prompt → bump; `ROLE_ROTATION` assigns diverse roles (minimal-fix / robust-fix / test-first / compatibility-first / refactor-safe) round-robin across the width.
4. **`scripts/critique_candidates.py`** — deterministic rubric scorer (NOT an LLM critic): `score = tests_passed×25 + min(changed,10)×2 + confidence×10 − (50 if schema-invalid) − risks×2`, sort, pick winner. **Weights verifiable evidence (tests-passed, schema-valid) far above self-reported confidence.**
5. **`src/heavy_coder/policy.py`** — fail-closed `evaluate_merge_policy()`: accumulates *every* blocking reason, allows iff empty. Gates: repo allowlist, required trigger label, actor permission, branch protection, required checks, no admin bypass, **`expected_head_sha != actual_head_sha` (anti-TOCTOU)**, no force-push-to-default, repair-attempt cap, isolated-execution required, protected-path globs, `policy_ambiguities → block`.

End-to-end: user message → `pre_llm_call` hook runs `triage`→`team_plan`, sets phase `AWAITING_DELEGATE`, injects a **≤4500-char** compact plan → agent must call `delegate_task` (≥N) or every edit is blocked → `post_tool_call` flips phase to `AWAITING_SYNTHESIS` → each leaf's `subagent_stop` writes `.heavy-coder/evidence/{id}.json` → `critique_candidates.py` ranks → coordinator (LLM) synthesizes → verify → (future, `merge_pr.py` is a hard fail-closed stub returning `{implemented:false}`).

## 3. Deterministic or agentic?
**Hybrid, honestly labeled — the inverse of the CodeWiki failure mode.** The repo's *structure* is genuinely deterministic (zero LLM/network in the Python; phase tracking, JSON schemas, protected-path globs, width/role triage, the critique rubric, the merge-policy evaluator). The load-bearing *decisions* are LLM-in-the-loop and the repo says so: synthesis ("choose spine"), role assignment, adaptive-width escalation triggers ("when candidates disagree" — undefined), and ambiguity judgment all run in Composer, not here. Crucially, `docs/enforcement-model.md`: **"Hermes does not kernel-block single-agent mode"** — the hooks are advisory discipline relying on coordinator compliance, *not a trust boundary*. License **MIT** (code-borrow allowed).

## 3b. Role in its native architecture — and does it transfer?
Native role: a **discipline/convenience layer** (nudges the agent into a wide workflow) plus a **deterministic floor** under LLM decisions (rank candidates, gate a merge). It is explicitly *not* the security boundary at home (GitHub permissions / branch protection / sandbox are). That maps cleanly to interlinked's own topology: any piece we lift stays advisory/heuristic locally and only becomes a hard gate when cloud-anchored — same as `feedback_local_checks_not_a_trust_boundary`. Nothing here pretends to be a boundary, so nothing has to be *down*graded on transplant.

## 4. Substrate vs. surface
Surface = "Grok Heavy for your repo" (the swarm UX). Substrate = the deterministic floor: prompt-triage → fan-out width + diverse roles; structured evidence envelope; verifiable-over-self-reported ranking; accumulate-all-reasons fail-closed gate; lifecycle state machine externalized to GitHub labels. The substrate is borrowable as *patterns*; the surface is a multi-agent product interlinked-the-CLI doesn't ship.

## 5. Lane (1–6)
Primarily **4 (pattern → memory/RFC)**, with a thin slice of **2 (detection → one harness check)** and **5 (cloud fodder → the swarm itself)**. The deterministic substrate mostly *validates* code interlinked already ships (lane-3 displacement), so it does not land as new substrate.

## 6. Dependency & displacement
- **Deps:** none — it's a Python port-or-pattern, not an import. No dependency pressure either way.
- **Displacement:** overlaps interlinked's harness (stdin-JSON hooks + per-session phase state = `session-state.ts` + the 23 shipped trajectory detectors), `reservations.ts` (state machine), `suggestion-scorer.ts` (weighted scoring), the bash-write guards, the commit/baseline gates, and the Workflow tool (fan-out, `schema` validation, one-level nesting). It is a **sibling in the "hook-enforced agent discipline" category** — convergent evolution, not a new capability.
- **Equivalence (capability-by-capability):**

| heavy-coder capability | interlinked equivalent | status |
|---|---|---|
| Stdin-JSON hook harness + per-session phase machine | harness + `session-state.ts` / trajectory detectors | **shipped** |
| Stealth-write shell detect (`sed -i`/`tee`/`>`-redirect) | `pre-checks-bash-write-detect.ts` + `file-dump-guard-parse.ts` + `pre-tool-rules.ts` (a **superset** — ties write to "bypasses content-quality gates") | **shipped** |
| Fail-closed accumulate-all-reasons gate (+SHA-match anti-TOCTOU) | commit-gate + baseline-integrity gate (same default-deny shape) | **shipped** |
| Edge-defined-once state machine | `reservations.ts` `applyTransition` | **shipped** |
| Deterministic weighted scoring of findings | `suggestion-scorer.ts` | **shipped** |
| Verify-command inference from repo markers | quality-checks project-type detection | **shipped** |
| CI-gateable policy exit code (0/2) | `allowlist verify` / `verify` exit codes | **shipped** |
| Context-budget cap on injected content (4500 chars) | `heavy-context-budget` skill; warnings are already small | **shipped (philosophy)** |
| Structured subagent-output validation | Workflow `schema` option (validates at tool-call layer) | **shipped** |
| One-level subagent nesting (`max_spawn_depth:1`) | Workflow "nesting is one level only" | **shipped** |
| Sensitive-path edit class (`.github/workflows`, `infra`, `deploy`, `release*`, lockfiles) | filesystem-guards (recently extended) | **shipped — diff the CI/deploy/release class** |
| Evidence envelope split: verifiable (test exit codes) vs self-report (confidence/risks) | witness-backed verification (predict/reveal/reconcile, W1–W6) | **designed** |
| Deterministic candidate pre-ranking before LLM synthesis | Workflow judge-panel/adversarial-verify (LLM, no deterministic pre-rank) | **designed (Agent-CI surface)** |
| Task-semantics adaptive fan-out width + role diversity | Workflow `FLEET = budget/100k` (budget-based, not task-semantics) | **partial** |
| **Read-only-intent-vs-mutating-action mismatch** | nothing (only a "scope-creep" refactor comment in `stop-rescan.ts`) | **absent** |
| Absolute-home-path / username redaction in always-on prompt/thinking scrub | secrets/PII scrub (`redaction.ts`/`secrets.ts`); OPF scanner has a PATH category but is off/model-backed | **likely absent — verify `redaction.ts`** |

## 7. Smallest spike
**Intent-vs-action mismatch detector (≤1 day).** Capture the user's stated scope from the prompt (interlinked already captures prompts full-fidelity) with a `should_trigger_team_plan`-style classifier — `READ_ONLY_RE` (audit/inspect/review/"don't change anything"/"just look") vs `IMPLEMENTATION_RE`. If the turn's stated intent is read-only and the agent then issues a Write/Edit/mutating-Bash, fire a trajectory advisory ("you said review-only; this edits `<path>`"). Lands in `checks/` + a trajectory detector; ≥3 positive / ≥3 negative cases. Fits the agent-era "watch the agent, not the file" moat (`project_agent_era_checks`). Secondary 30-min spike: confirm whether `redaction.ts` masks `/Users/<name>/…` → `~`; if not, add it (username = PII + env fingerprint that currently survives sync).

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | intent-vs-action mismatch trajectory check; (maybe) home-path redaction in the prompt scrub | §7 | next |
| Agent CI (P4–5) | validates the multi-agent vision: deterministic candidate **pre-ranking** (verifiable>self-report) as a prior under LLM synthesis; evidence-envelope split for witness-backed verify; task-semantics width triage as a fan-out sizer | port `critique_candidates.py` rubric into a Workflow pre-rank stage | parked |

## 9. Artifact
**Compound:** (1) this memory note — heavy-coder is the cleanest external **convergence proof** that interlinked's architecture is right (stdin-JSON hooks, phase state machine, fail-closed accumulate-reasons gates, one-level nesting, context budget, "hooks aren't a kernel lock"); don't rebuild any of it. (2) Build the **intent-vs-action mismatch** check (§7) — the one genuinely absent idea, and it strengthens the agent-era moat. (3) For the multi-agent/Workflow surface, keep `critique_candidates.py`'s **verifiable-over-self-reported ranking** and the **evidence-envelope split** as design references when the deterministic-pre-rank-before-LLM-synthesis work lands.

## Notes
- Honest-determinism contrast worth keeping: heavy-coder *advertises* "deterministic foundations" and it's **true** (the Python has no model in it) — the opposite of CodeWiki's `cluster_modules.py`. The LLM lives one layer out (Hermes), so "read the source" here confirms rather than debunks.
- `merge_pr.py` is a literal fail-closed stub (`{implemented:false}`, exit 2) — the most dangerous capability genuinely cannot fire. Good model for "ship the gate before the action."
- `policy.py`'s `expected_head_sha != actual_head_sha` is a clean anti-TOCTOU pattern (the PR moved since you evaluated it) — worth remembering if interlinked ever gates a stateful *external* action (it currently gates local edits, where TOCTOU is handled by reading live file state).
- heavy-coder's own `AGENTS.md`/`SOUL.md` are a tidy lane-1 `/enforce` *example* ("Never commit secrets; `.env` forbidden", "Dangerous operations must be dry-run only", "Do not invent provider model identifiers", "No docs may claim autonomous merge is available") — useful as a demo target, not as rules for interlinked itself. "Do not invent model identifiers" is a hallucination-guard sibling to `hallucinated_package`.
- Cloned to `reference-repos/heavy-coder/` (gitignored sibling repos dir). Related intakes: `failproofai.md` (the other hook-enforced-discipline competitor), `gh-aw.md` (Agent-CI shape).
