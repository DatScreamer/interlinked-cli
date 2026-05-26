# Agent Governance Toolkit (AGT)

- **Source:** https://github.com/microsoft/agent-governance-toolkit
- **Encountered:** 2026-05-26 — user asked: "competitor or enhancer?"
- **Verdict:** PR (hash-chained audit + OWASP ASI labels) + RFC (Decision-BOM evolution of `activity.jsonl`; framing alignment)

## 1. Core idea (one sentence)

Microsoft-published MIT-licensed multi-language toolkit (Python core; TS/.NET/Rust/Go SDKs; Claude Code / Copilot / Antigravity plugins) that intercepts every agent action — tool call, message send, sub-agent spawn — in deterministic application code *before* execution, framed as 10/10 (now 11/11) coverage of the OWASP Agentic Top 10.

## 2. Anatomy (concrete walkthrough)

**Top-level (~public 2026-03-02; v1.0 2026-03-04; v3.7.0 on 2026-05-18; ~2.4K stars in 12 weeks; ~17 releases):**

```
agent-governance-toolkit/
├── agent-governance-python/        # the heart — agent-os, agent-mesh, agent-runtime,
│                                   #   agent-sre, agent-hypervisor, agent-lightning,
│                                   #   agent-marketplace, agent-mcp-governance, ...
├── agent-governance-typescript/    # @microsoft/agent-governance-sdk (zero runtime deps)
├── agent-governance-{dotnet,golang,rust}/   # language-specific SDKs
├── agent-governance-claude-code/   # ← direct overlap with interlinked-cli
├── agent-governance-copilot-cli/   # in-process extension (has output suppression)
├── agent-governance-antigravity-cli/        # newest (Unreleased)
├── action/                         # GitHub Action: governance-verify / policy-evaluate
├── docs/compliance/                # OWASP ASI01–ASI11 mapping (canonical)
└── examples/, tests/, scripts/
```

**Claude Code package (the overlap surface; ~1500 LOC + 170-line default policy):**

| File | What it does |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (uses Claude Code's plugin loader, not `settings.json` mutation) |
| `hooks/hooks.json` | Registers `SessionStart`, `UserPromptSubmit`, `PreToolUse` — `timeout: 30` each |
| `hooks/*.mjs` | 16-line stubs that read stdin → `loadPolicy()` → call into `lib/policy.mjs` → write stdout |
| `lib/policy.mjs` | 1158-line policy core: `loadPolicy`, `compilePolicy`, `evaluatePromptSubmission`, `evaluatePreToolUse`, 4 backends |
| `lib/audit.mjs` | **Hash-chained tamper-evident audit log** (sha256, `timingSafeEqual` verification, 10k entry cap) |
| `server/agt-mcp.mjs` | Bundled MCP server with `agt_policy_status` / `agt_policy_check_text` |
| `config/default-policy.json` | Regex blocks: `rm -rf`, `curl|sh`, `.env` reads, metadata endpoints (`169.254.169.254`), credential paths (`.ssh`, `.aws`, `.docker`, `.kube`), `.git/hooks` writes |

**Four policy backends compose per call**, all deterministic:

1. `agt-command-patterns` — regex on `tool_input.command` for Bash patterns
2. `agt-direct-resources` — path-rule and URL-rule walk over `tool_input` tree
3. `agt-prompt-poisoning` — `ContextPoisoningDetector` with regex pattern set
4. `agt-mcp-scan` — `McpSecurityScanner.scan({name, description})` over tool name + serialized args

**End-to-end session:** `claude --plugin-dir .` → SessionStart hook injects 10-paragraph PRODUCTION_GUARD_CONTEXT + advisory grade → user prompt → UserPromptSubmit regex/poisoning-scan → tool call → PreToolUse cold-spawns Node, loads SDK, builds 4 backends, evaluates, returns `{permissionDecision: "allow|deny|ask", reason}`. **Every hook pays the full cold-start tax.** Interlinked's daemon answers in ~1ms over a Unix socket; AGT's pre-tool hook spends hundreds of ms re-bootstrapping per call.

**The explicit Claude-side gap** (their README §"Important parity gaps"): "`PostToolUse` in Claude cannot reliably redact tool output after the tool has already executed, so this package does not claim Copilot-style output suppression parity." → all 31 of our quality / structural / agent-quality PostToolUse checks have no analogue here. The Copilot package has a global-policy mjs that does post-call work; the Claude package deliberately doesn't.

**Wider Python toolkit** (orthogonal to the CLI, but it's what the marketing scopes): `agent-os` (PolicyEngine + capability model + Decision BOM), `agent-mesh` (Ed25519 identity, SPIFFE, trust 0-1000, X3DH+Double-Ratchet E2E channels, registry/relay), `agent-hypervisor` (Merkle-chain execution audit), `agent-runtime` (4-tier execution rings), `agent-sre` (SLOs, error budgets, chaos), `agent-lightning` (RL training governance). All Python, ~zero vendor deps, run offline.

**The OWASP ASI framing** (`docs/compliance/owasp-agentic-top10-architecture.md`): 11 risks (the working group expanded from 10), 8/11 marked Full, 3/11 marked Partial (ASI04 supply-chain — they say "no SBOM"; ASI06 memory/context — "no memory sandbox"; ASI09 human-trust — "no UI guardrails"). Their `LIMITATIONS.md` openly documents an action-layer-undefendable cross-session attack chain (Dai et al., May 2026, 80–95% ASR).

## 3. Deterministic or agentic?

**Deterministic** across all enforcement paths. No LLM in any policy or scanning code path I read — `ContextPoisoningDetector` is regex/pattern catalog, `McpSecurityScanner` is description-string heuristics, `PolicyEngine` is rule-tree evaluation. The "10/10 OWASP" marketing claim survives a source read (rare for this category — c.f. the `codewiki.md` worked example).

**License:** MIT. Code-borrow allowed for lanes 1, 3, and 5 with attribution.

## 4. Substrate vs. surface

- **Substrate:** regex+path policy engine, `ContextPoisoningDetector`, `McpSecurityScanner`, hash-chained audit, Ed25519 identity primitives, `PromptDefenseEvaluator` (grades a guard-text block A–F against a known attack-category coverage matrix), Decision BOM, OWASP ASI taxonomy.
- **Surface:** Claude Code plugin, Copilot CLI plugin, Antigravity plugin, GitHub Action, framework adapters (LangChain/AutoGen/CrewAI/OpenAI/ADK/Pydantic-AI).
- The substrate is borrowable without the surface (MIT + clean SDK layering — `@microsoft/agent-governance-sdk` is zero-deps, Node-runnable, and the Claude package is a thin shell over it).

## 5. Lane (1–6)

**Primary: 4 (pattern)** — OWASP ASI01–ASI11 taxonomy as positioning; hash-chained audit pattern; Decision BOM as a richer audit envelope; `PromptDefenseEvaluator` as a /enforce review mode.

**Secondary: 3 (substrate)** — hash-chained audit log is a half-day spike that fits the CLI today; MCP threat scanner is a deterministic regex catalogue we can run at edit time.

**Secondary: 1 (imperative content)** — the `default-policy.json` regex catalogue is a high-quality, MIT-licensed corpus of `block` rules. Borrow specific patterns into `.interlinked/distilled-rules.json` examples and `/enforce` docs.

**Out of scope: 5 (cloud-only fodder)** for the local CLI — the AgentMesh E2E encryption / wire protocol / registry / SRE / execution-rings stack is centralized, multi-process, and enterprise-shaped; if any of it routes anywhere it's the Guardrails / Agent CI roadmap, not the harness.

## 6. Dependency & displacement

- **Deps:** zero new runtime deps required for the borrowable patterns. Hash-chain audit uses `node:crypto` (stdlib). OWASP labels are docs. The full `@microsoft/agent-governance-sdk` is one npm package but importing it would violate the one-dep stance — borrow the *pattern*, not the dependency.
- **Displacement (internal overlap):** their policy engine overlaps `src/harness/evaluator.ts`; their audit log overlaps `src/lib/local-activity.ts`; `agt_policy_status` MCP tool overlaps `interlinked status` + `harness status`. None of these *replace* what we have — they augment. Their per-edit depth is shallower (no project graph, no PostToolUse, no trigram-accelerated grep, no per-file line cap, no reservations, no recurrence aggregation, no supply-chain allowlist with typosquat detection).

## 7. Smallest spike (≤1 day)

**Hash-chained `activity.jsonl`** (~½ day):

- Add `previousHash` + `hash` fields to each appended event in `src/lib/local-activity.ts`. Genesis = `"0".repeat(64)`. SHA-256 over `{timestamp, agentId, action, decision, previousHash}` (mirror their schema — `lib/audit.mjs` lines 28–34).
- New subcommand `interlinked audit verify` walks the chain with `timingSafeEqual` and reports first-bad-index. Map to ASI11 (Agent Untraceability) in `docs/`.
- Trivially layers under the existing append-only model — no schema break.

**Bundled half-day** for the OWASP framing: label existing checks in `check-metadata.ts` with `asi: "ASI01" | … | "ASI11"` (where applicable). Surface in `interlinked verify --json`. Pure positioning — no code-path change, immediate marketing parity.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | hash-chained `activity.jsonl` + OWASP ASI labels on `check-metadata.ts` + ingest their regex catalogue as `/enforce` corpus | §7 (½ day each) | **now** |
| Guardrails (P2–3) | Decision-BOM-shaped envelope for cloud-side per-action audit; `PromptDefenseEvaluator` grade as a fast cloud gate; `McpSecurityScanner` against connected MCP server tool descriptions | 2-day spike: port `McpSecurityScanner` pattern set to a cloud check | next |
| Agent CI (P4–5) | AgentMesh wire protocol / Ed25519 identity as reference for cross-org federation in `project_vision_multiagent.md` Phase-5 axis | RFC, not code | parked |

## 9. Artifact

**PR** for §7 (hash-chained audit + OWASP labels) — both single-file additions, fit the one-dep stance, mappable to existing CLAUDE.md surfaces.

**RFC** in `docs/design/` for the broader framing: (a) Decision-BOM evolution of `activity.jsonl` (richer per-event metadata, multi-backend reasoning trail), (b) when/whether `/enforce` should grow a `PromptDefenseEvaluator`-style coverage grade for distilled rules, (c) where AGT's published OWASP positioning maps onto our three-tier policy enforcement model (`project_three_tier_policy_enforcement.md`).

## Notes

**Risk read:** the closest *direct* competitor at Microsoft scale we've intaked. 2.4K stars in 12 weeks, MIT, multi-language, Microsoft-signed, with a working Claude Code plugin. **But** the Claude plugin is deliberately the lightest deliverable in the toolkit — it's a proof-point for the OWASP marketing, not a serious local developer-protection product. The strategic moat is depth on PostToolUse (31 quality + 25 structural + 13 agent-quality checks), the daemon model (~1ms per call vs their cold spawn), trigram-accelerated grep, project graph, reservations, recurrence aggregation, per-file line cap with ratchet, supply-chain allowlist with typosquat detection, `/enforce` skill — all of which they could build but haven't. If they ship Copilot-style PostToolUse parity for Claude, that gap closes; until then, our developer story is materially stronger and theirs is materially better at the platform/security-team-deploying-autonomous-agents story.

**Enhancement read:** four borrowable patterns + one framing adoption + one regex corpus. None of the four touch our dep stance.

**Three Partial-coverage gaps they admit that we cover better:**

- ASI04 (Agentic Supply Chain) — they say "no SBOM." We have `interlinked allowlist` with typosquat detection across npm / pip / cargo / gem / go (per CLAUDE.md). Label this prominently.
- ASI11 (Agent Untraceability) — they have hash-chain audit; we have JSONL but no hash chain. **Adopt their pattern, §7.**
- ASI06 (Memory & Context Poisoning) — they admit "no memory sandbox"; we don't have one either. No play here.

**Three risks that are AGT-shaped and not ours:** ASI03 (cryptographic agent identity), ASI07 (encrypted A2A), ASI08 (SLO circuit breakers). These belong in the cloud roadmap framing if anywhere — they are *not* in scope for the harness.

**`LIMITATIONS.md` is exemplary.** Their cross-session attack-chain disclosure (Dai et al., May 2026, 80–95% ASR under SFT delivery) is the kind of self-honesty that builds enterprise trust. Worth adopting the same disclosure pattern in our `docs/` — link it from the README.

**Release cadence:** 10+ commits/day, ~17 releases since 2026-03-04. Tuning we can't out-pace on commit volume — we win on depth.

**Cross-references already in `docs/external-pulse/`:** [[failproofai]] (the policy-rule-count competitor), [[sanctum-oss]] (the YARA-based competitor), [[sondera-coding-agent-hooks]] (LLM-classifier-fed Cedar). AGT is the most architecturally similar to our shipped Tier-1 + intended Tier-2 split (they explicitly call out deterministic-only at the action layer + LLM-grade defenses at the prompt layer).

## Methodology notes

- **AGT's `LIMITATIONS.md` and `INDEPENDENCE.md` survive a source read.** Their published "no vendor deps" claim checks out (`@microsoft/agent-governance-sdk` is zero-dep; `agent-os-kernel` is pydantic-only). Fold a "what limit does the project's own docs admit?" prompt into INTAKE §3 — projects that disclose their gaps are usually less marketing-padded than those that don't.
- **Multi-language toolkits with a heavy core + thin per-surface plugins** are an emerging pattern (AGT here; Sondera's two-repo split). When intaking one, the right question is not "what does the whole toolkit do?" but "what does the package that overlaps our surface do, and how much of *that* is borrowed from the core?" — the marketing scopes the core, the overlap surface is usually 1–5% of the LOC, and the substrate-vs-surface split (§4) is where the truth lives.
