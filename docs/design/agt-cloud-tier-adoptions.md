# AGT cloud-tier adoptions

Status: **design** (Tier 1 shipped 2026-05; Tier 2/3 designed)
Origin: intake at `docs/external-pulse/agent-governance-toolkit.md`
Related: `docs/design/three-product-architecture.md`,
`docs/design/tier-2-llm-policy-gate.md`,
`docs/design/tier-3-async-deep-review.md`,
`project_three_tier_policy_enforcement.md` (memory)

Microsoft's Agent Governance Toolkit (AGT) ships four patterns that map onto
our roadmap. Two landed in Tier 1 (hash-chained audit + OWASP ASI labelling).
Two remain to be adopted into Tier 2 (Guardrails, fast cloud gate) and a
related observability layer. This memo records the contract for each so the
follow-on work has a fixed target.

## Tier 1 — shipped 2026-05

### Hash-chained guard-decision audit (ASI11)

Source: `agent-governance-claude-code/lib/audit.mjs` (MIT).

Our adaptation:

- Writer: `src/lib/hook-template-chunks/session-state.ts::appendGuardDecision`
  computes `previousHash` (tail-read of `activity.jsonl` for the most recent
  hash-bearing `guard_*` entry; genesis `0×64` if none) and `hash`
  (`sha256(canonical_json(record - {hash}))`) on every guard decision before
  appending the line.
- Verifier: `src/lib/audit-chain.ts::verifyAuditChain` walks the file forward,
  re-computes the hash from the stored payload, and reports the first
  integrity failure with `timingSafeEqual`.
- CLI surface: `interlinked audit verify` (`src/commands/audit.ts`).

Chain coverage is **sparse by design**: only `guard_block` / `guard_warn` /
`guard_allow` are chained. The hot-path transcript writes (`appendLocal`)
stay unhashed so they don't pay the tail-read cost; transcript records are
recorded for reconstruction, decision records are recorded for proof. AGT
uses the same model — their `audit.mjs` chain covers `{action, decision}`
tuples, not raw event ingest.

### OWASP ASI labels on `check-metadata`

Source: `docs/compliance/owasp-agentic-top10-architecture.md` taxonomy (the
working group expanded from ASI01–ASI10 to ASI01–ASI11 in 2026; we adopt
all 11).

Our adaptation: `src/harness/check-metadata/types.ts` carries an optional
`asi?: OwaspAsi` field; representative checks in `quality.ts` and
`generic.ts` are tagged. Surface in `interlinked verify --json` so a
compliance reader can ask "which ASI risks does this codebase mitigate?"
deterministically.

Three risks the AGT toolkit lists as "Partial" coverage that we cover
**better** (worth claiming):

- **ASI04 Agentic Supply Chain.** AGT says "no SBOM." Interlinked has
  `interlinked allowlist` with Levenshtein typosquat detection across
  npm/pip/cargo/gem/go (CLAUDE.md §Supply-chain allowlist).
- **ASI05 Unexpected Code Execution.** We have inline `eval_usage`,
  `inner_html`, `dangerously_set_inner_html`, `secrets_in_source`,
  `gitleaks`, `semgrep` — all `fully_deterministic`.
- **ASI11 Agent Untraceability.** Now covered by the hash chain.

Three risks that are **AGT-shaped, not ours** — they belong to the
cloud/federation roadmap if anywhere:

- ASI03 Identity and Privilege Abuse (cryptographic agent identity).
- ASI07 Insecure Inter-Agent Communication (encrypted A2A channels).
- ASI08 Cascading Agent Failures (SLO + circuit-breaker semantics).

## Tier 2 — to adopt (Guardrails, fast cloud gate)

### PromptDefenseEvaluator → "guard-text coverage grade" for `/enforce`

Source: `@microsoft/agent-governance-sdk::PromptDefenseEvaluator`. Composes
a known attack-category coverage matrix against a guard-text block and
returns a letter grade (A–F) plus a `missing` list. AGT runs it at
`SessionStart` and writes the grade into `additionalContext` so the agent
sees its own defensive posture every turn. They block sessions if grade
falls under a configured `minimumPromptDefenseGrade` (default `B`).

Our adoption shape:

- **`/enforce` mode addition** (Tier 2 cloud LLM policy gate context):
  during `/enforce` distillation, run the evaluator over the **distilled
  rules + the input agent-instruction markdown**. Return a grade and a
  `missing` list (e.g., "no rule covering credential exfiltration", "no
  rule covering output weaponization"). Surface in
  `.interlinked/distilled-rules.json` as a top-level `coverage` field.
- **Cloud gate**: Tier 2 (`docs/design/tier-2-llm-policy-gate.md`) can read
  the grade as a fast-path signal — a low grade plus a tool call from a
  sensitive category routes the call through the LLM classifier instead of
  the deterministic allow-list.
- **Why this is cloud-tier work, not CLI**: the coverage matrix has to
  expand over time as new attack categories emerge. Maintaining it in the
  Tier-2 service (warm in memory, updated on push) keeps the CLI stable
  and lets the matrix evolve without re-shipping.

Determinism: the evaluator itself is deterministic — it's a regex
coverage check against a curated matrix. We can ship this in Tier 1 if it
turns out the matrix is stable. Defer to Tier 2 only if curation cost
warrants it.

### McpSecurityScanner → "MCP tool description threat scan" for cloud-side

Source: `@microsoft/agent-governance-sdk::McpSecurityScanner`. Scans
`{name, description}` of an MCP tool definition for threat patterns —
sensitivity-claiming text ("trust me", "always run"), command-injection
shapes, exfiltration hints, secret-extraction keywords. Returns
`{safe: bool, threats: [{type, severity}, ...]}`. AGT runs it inline in
the `agt-mcp-scan` backend of `PreToolUse` so any tool call routed through
an untrusted MCP server description gets scanned every call.

Our adoption shape:

- **Cloud Tier 2 (Guardrails) — per-call scan**: when the Interlinked MCP
  server proxies a tool call, scan the tool's *description* (cached) plus
  the *serialized argument set*. Threats `high`/`critical` → block;
  `medium` → route to LLM classifier; clean → fast-path allow.
- **Tier 3 (Agent CI) — post-connect scan**: when a new MCP server is
  attached to a workspace, run McpSecurityScanner across its full tool
  surface as part of the deep-review pipeline. Report violations as
  recurrence-style findings (`harness_missed`-shaped) so the operator can
  decide whether to keep the connection.
- **Why this is cloud-tier work, not CLI**: MCP server description text
  travels through the server, not the CLI. The CLI sees its **own** MCP
  client side only. Scanning happens at the proxy layer where every
  tenant's connected MCP set converges.

A meaningful subset *can* land in the CLI today: a small scanner that
walks `.mcp.json` (and equivalents) at edit time and flags `description`
fields with the obvious patterns. Cheap, deterministic, ASI06 (Memory and
Context Poisoning) coverage. If we ship that as a Tier-1 check, the Tier-2
service can reuse the regex catalogue from `src/harness/checks/`.

### Decision BOM → richer `activity.jsonl` envelope (Tier 2 cloud audit)

Source: AGT's `agent_os::DecisionBOM` (Python). Every evaluation produces
a "decision bill of materials" — what policy was active, which rule
matched, what backends voted, what fields of the action were inspected,
what the alternative outcome would have been. AGT's stated purpose is
post-incident replay: when a regulator asks "why did this action go
through?", the BOM is the answer.

Our current `appendGuardDecision` already records `guard_rule_id`,
`guard_check_results`, `guard_checks_ran`, `guard_grep_stats`. That's
~70% of a BOM. The missing 30%:

- **Active policy snapshot.** Hash of the loaded `.interlinked/guard-rules.json`
  + `.interlinked/distilled-rules.json` at the time of decision. Currently
  we record nothing — a rules-file rewrite invalidates the explanatory
  power of every past decision.
- **Backend vote disaggregation.** Which check fired, which checks
  abstained, which checks were skipped (and why). Map to AGT's
  `backendResults` shape.
- **Alternative outcome.** What the same call would have produced under
  the prior policy version. Requires keeping the previous compiled rules
  in memory.

This is a Tier 2 evolution: the local hook can write the augmented record,
but consuming it for replay needs a server-side index. RFC scope.

## Tier 3 / parked

### Cryptographic identity, mesh, SRE

See the explanation in the conversation thread that produced this memo.
**Short version**: AGT's agent-mesh (Ed25519 identity, X3DH/Double-Ratchet
A2A channels, trust scoring 0–1000) is built for the same problem we'd
hit at Phase 5 cross-organization federation in
`project_vision_multiagent.md` — proving "agent X did action Y" when X is
a service-account-shaped principal whose key may be shared. Not on the
CLI roadmap.

Agent SRE (SLOs, error budgets, circuit breakers, chaos testing) is
shaped for production multi-agent platforms — the inverse of our hot path.
The only borrowable shape is the **circuit-breaker pattern for the Tier-2
cloud gate**: if the classifier service falls under SLO, cleanly degrade
to the deterministic allow-list. That's a few-line policy in the cloud
proxy, not a new product.

## Open questions

- **Coverage matrix curation.** If we adopt PromptDefenseEvaluator, who
  owns the matrix? Microsoft updates theirs in `agent-governance-sdk` on
  every release. Forking is a maintenance commitment.
- **Decision BOM storage cost.** Adding the active-policy hash is cheap.
  Adding "alternative outcome" is ~2× the per-decision payload size. Run
  the numbers against the current `activity.jsonl` rotation budget before
  shipping.
- **ASI label drift.** AGT publishes their mapping in
  `docs/compliance/owasp-agentic-top10-architecture.md` and updates it as
  the working group revises. We should pin the version of the ASI
  taxonomy we map against (currently ASI 2026 = ASI01–ASI11) and
  re-baseline annually.

## Cross-references in memory

- `[[reference_failproofai_competitor]]` — different competitor, but their
  stop-event repeated-tool-call detector overlaps the same "what should
  the cloud gate notice that the local gate can't?" question.
- `[[project_three_tier_policy_enforcement]]` — the master tier doc.
- `[[feedback_harness_deterministic_only]]` — applies to the **CLI**;
  Tier 2 explicitly relaxes this for the policy gate path.
