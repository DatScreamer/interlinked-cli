# Sondera AI Integration -- Evaluation and Recommendations

## What Sondera Is

Sondera is a **deterministic policy enforcement platform for AI agents** -- a "control plane for the agentic era." It enforces rules about what agents can and cannot do at runtime, using formal policy languages and multiple guardrail subsystems.

**Critically, Sondera is NOT a SAST/SCA/secrets tool.** It operates at the **runtime agent behavior layer**, not the code artifact analysis layer. It governs what an agent does (which tools it calls, what data it accesses, what operations it performs), not what code the agent writes.

## Two Products

### 1. Python SDK (`sondera` package)

- **CedarPolicyHarness**: Core policy engine using AWS Cedar
- 6-stage adjudication pipeline: PRE_RUN, PRE_MODEL, POST_MODEL, PRE_TOOL, POST_TOOL, POST_RUN
- Three verdicts: ALLOW, DENY, ESCALATE (human-in-the-loop)
- Steering: denial reasons are fed back to the LLM so it can try alternative approaches
- Audit logging for compliance (ISO 42001, SOC 2)

### 2. Rust Coding Agent Hooks (`sondera-coding-agent-hooks`)

- Pre-built Rust binaries for Claude Code, Cursor, Copilot CLI, Gemini CLI (4 agents)
- Three guardrail subsystems running in the hook:
  - **YARA-X signatures**: Pattern matching on tool inputs/outputs
  - **LLM policy model**: `gpt-oss-safeguard-20b` via Ollama for nuanced policy decisions
  - **Information Flow Control (IFC)**: Bell-LaPadula model tracking data sensitivity
- Pre-built Cedar policies: `base.cedar`, `destructive.cedar`, `file.cedar`, `ifc.cedar`, `supply_chain_risk.cedar`
- MIT licensed, 159 stars on GitHub (most mature Sondera component)

## Cedar Policy Language

Cedar is AWS's open-source authorization policy language with key properties:

- **Deterministic**: Same input always produces the same verdict (no probabilistic decisions)
- **Forbid-wins-over-permit**: If any policy says "forbid," the action is denied regardless of permit policies
- **Formal verification**: Policies can be mathematically proven to have no gaps or conflicts
- **Human-readable**: Policy authors don't need to write code

Example Cedar policy:
```cedar
forbid (
  principal,
  action == Action::"tool_execute",
  resource
)
when {
  resource.tool_name == "Bash" &&
  resource.command.contains("rm -rf")
};
```

## Sondera's 6-Stage Pipeline

| Stage | When | What It Does |
|-------|------|-------------|
| PRE_RUN | Session start | Validate agent identity, set session-level constraints |
| PRE_MODEL | Before LLM call | Filter/modify system prompts, enforce context limits |
| POST_MODEL | After LLM response | Scan response for policy violations before tool selection |
| PRE_TOOL | Before tool execution | Evaluate tool call against Cedar policies (block/allow/escalate) |
| POST_TOOL | After tool execution | Scan tool output, update IFC taint state |
| POST_RUN | Session end | Audit log, cleanup, final compliance checks |

## Three Verdicts

| Verdict | Effect | Use Case |
|---------|--------|----------|
| **ALLOW** | Tool call proceeds | Normal operations |
| **DENY** | Tool call blocked, reason sent to agent | Destructive operations, policy violations |
| **ESCALATE** | Paused, notification sent to human | PHI access, production deployments, ambiguous cases |

The ESCALATE verdict is unique to Sondera -- our harness only supports block and allow.

## Supply Chain Risk Policies

Sondera's `supply_chain_risk.cedar` covers threats beyond what npm audit detects:

| Threat | What It Catches | npm audit Coverage |
|--------|----------------|-------------------|
| **Typosquatting** | `lodas` instead of `lodash`, `colar` instead of `color` | Not covered |
| **Dependency confusion** | Private package names published to public registry | Not covered |
| **Build script injection** | `preinstall`/`postinstall` scripts that execute arbitrary code | Not covered |
| **Lock file tampering** | Manual edits to lock files that change integrity hashes | Partially covered (our harness also blocks this) |
| **Known CVEs** | Vulnerabilities in dependency tree | Fully covered by npm audit |

## Comparison: Our Harness vs Sondera

| Dimension | Interlinked Harness | Sondera |
|-----------|-------------------|---------|
| **Code artifacts (what agents write)** | Full coverage: SAST (Semgrep), SCA (npm audit), Secrets (gitleaks), TypeScript (tsc), Linting (biome/eslint), Strong typing, Structural checks | Not covered -- Sondera does not analyze code |
| **Agent behavior (what agents do)** | Partial: 66 guard rules, sleep detection, file reservations, taint tracking | Core focus: Cedar policies, IFC, YARA-X signatures |
| **Policy language** | Ad-hoc JSON guard rules (`guard-rules.json`) | Cedar (deterministic, formal verification, forbid-wins-over-permit) |
| **Escalation** | Block or warn only | Block, warn, or **escalate to human** |
| **Supply chain** | npm audit (known CVEs) + lock file tamper blocking | Typosquatting, dependency confusion, build script injection, lock file tampering |
| **IFC model** | Taint tracking with sensitivity levels (low/medium/high/critical), ratchet-up, network blocking | Bell-LaPadula with LLM classifier for sensitivity assessment |
| **Agent CLI coverage** | Claude Code (production), Gemini CLI (production), Codex (fire-and-forget) | Claude Code, Cursor, Copilot CLI, Gemini CLI (4 agents, pre-built Rust binaries) |
| **LLM-in-the-loop** | Not implemented | `gpt-oss-safeguard-20b` via Ollama for nuanced policy decisions |
| **Audit logging** | Guard event reporting to MCP server, telemetry files | Structured audit logs for ISO 42001, SOC 2 |

## No Healthcare-Specific Features

Sondera does not ship healthcare-specific policies (no HIPAA rules, no PHI detection, no HL7/FHIR awareness). However, it provides **compliance primitives** that can be composed for healthcare:

| Primitive | Healthcare Application |
|-----------|----------------------|
| Audit logs (ISO 42001, SOC 2) | HIPAA audit trail requirements |
| PII protection policies | PHI access controls |
| Data residency enforcement | Data localization requirements |
| RBAC (role-based access control) | Minimum necessary principle |
| HITL escalation | Human review for PHI-adjacent operations |
| IFC taint tracking | Prevent PHI from flowing to external services |

## Three Integration Options

### Option A: Install Alongside (Lowest Effort)

Install `sondera-coding-agent-hooks` alongside the Interlinked harness. Both hook into the agent's settings file (e.g., `.claude/settings.json`). They are complementary layers:

- **Interlinked harness**: Code artifact analysis (SAST, SCA, secrets, tsc, biome, structural checks)
- **Sondera hooks**: Agent behavior enforcement (Cedar policies, IFC, supply chain risk)

**Implementation**: Zero code changes. Install Sondera's Rust binary, configure both hooks in settings.json. Both evaluate independently -- if either blocks, the tool call is denied.

**Immediate benefit**: Adds Cursor and Copilot coverage via Sondera's pre-built binaries.

### Option B: Replace guard-rules.json with Cedar (Medium Effort)

Migrate our 66 guard rules from JSON format to Cedar policies. This gives us:

- **Deterministic guarantee**: Same input always produces the same verdict (formal verification)
- **Forbid-wins-over-permit**: No accidental allow-through from rule ordering
- **Standard language**: Cedar is an AWS standard; team members can write policies without understanding our JSON format
- **Composability**: Cedar policies can be composed, extended, and reasoned about

**Implementation**: Write Cedar translations of each guard rule. Replace `matchesRule()` in evaluator with Cedar evaluation. Keep all quality checks (SAST, SCA, etc.) as-is -- Cedar only replaces the behavioral rules.

**Example migration**:
```
// Current JSON rule:
{
  "id": "builtin-rm-rf-root",
  "action": "block",
  "patterns": [{ "field": "command", "regex": "\\brm\\s+-rf\\s+\\/" }],
  "reason": "Recursive deletion of root-level paths is dangerous"
}

// Cedar equivalent:
forbid (
  principal,
  action == Action::"tool_execute",
  resource
)
when {
  resource.tool_name == "Bash" &&
  resource.command like "*rm -rf /*"
}
unless {
  resource.command like "*rm -rf /tmp*" ||
  resource.command like "*rm -rf /var/tmp*"
};
```

### Option C: HITL Escalation for PHI (Highest Value for Healthcare)

Use Sondera's `@escalate` verdict for PHI-adjacent operations:

- Human-in-the-loop for patient data access patterns
- HIPAA minimum necessary principle enforced at the agent level
- Escalation notifications to designated compliance officers
- Audit trail of all escalation decisions and resolutions

**Implementation**: Write Cedar policies that escalate (not block) on PHI-adjacent patterns:
```cedar
// Escalate when agent reads patient-related files
@escalate("PHI access requires human approval")
forbid (
  principal,
  action == Action::"file_read",
  resource
)
when {
  resource.file_path like "*patient*" ||
  resource.file_path like "*phi*" ||
  resource.file_path like "*hipaa*"
};
```

## Recommendation

**Start with Option A**, then evaluate Cedar migration based on scaling needs.

Option A is zero-effort and immediately adds:
1. Cursor and Copilot coverage (via Sondera's pre-built binaries)
2. Supply chain risk detection (typosquatting, dependency confusion)
3. LLM-in-the-loop for ambiguous cases
4. Structured audit logging

If the guard rules grow beyond 100+ rules and become hard to reason about, migrate to Cedar (Option B). If healthcare compliance requires human-in-the-loop, add Option C.

## Sondera's Agent Coverage vs Ours

Sondera's Rust hooks cover **4 agents** with dedicated binaries:
- `sondera-claude` — Claude Code
- `sondera-cursor` — Cursor
- `sondera-copilot` — GitHub Copilot CLI
- `sondera-gemini` — Gemini CLI

Each binary normalizes the agent's JSON events into four standardized categories (action, observation, control, state), then Cedar rules work identically across all four.

**Agents Sondera does NOT cover**: Codex CLI, Amp. Neither has Sondera binaries.

**The complementary coverage model**:
- Sondera covers Cursor and Copilot (which we don't yet)
- We cover Codex (fire-and-forget, which Sondera doesn't)
- Both cover Claude Code and Gemini CLI
- Neither covers Amp (we have stubs, Sondera has nothing)

Installing Sondera Option A alongside our harness immediately gives us 4-agent behavioral coverage (Sondera) + 2-agent code quality coverage (our harness), with overlap on Claude Code and Gemini CLI providing defense-in-depth.

## Maturity Note

Sondera is early-stage:
- Main Python SDK repo has ~12 commits
- Waitlist-based access for the hosted platform
- Small community (not yet widely adopted)

However, the **Rust coding agent hooks repo is the most mature component**: 159 stars, MIT licensed, actively maintained, and the binary works standalone without the hosted platform.

## References

- [Sondera Documentation](https://docs.sondera.ai/)
- [Sondera GitHub](https://github.com/sondera-ai)
- [sondera-coding-agent-hooks](https://github.com/sondera-ai/sondera-coding-agent-hooks) — 159 stars, MIT, Rust
- [cedar-python](https://github.com/sondera-ai/cedar-python) — Python bindings for Cedar, includes MCP server for policy authoring
- [AWS Cedar](https://www.cedarpolicy.com/) — Policy language specification
- Interlinked memory: `project_llm_policy_enforcement.md` — existing plan for LLM-in-the-loop policy enforcement, which Sondera's `gpt-oss-safeguard-20b` approach directly addresses
