# Tier 2 — Cloud LLM Policy Gate

**Status:** Designed (2026-05). Not built. Pre-requisites are external — Tier 1 (`/enforce` extended-pass artifact emission) ships first, the cloud-side gpt-oss-safeguard plumbing lands when product surface is ready.

**Audience:** Future-you (or the agent acting on your behalf) when you sit down to build Tier 2. This memo skips no design decisions and lists every open question explicitly.

**Companion docs:**
- `skills/enforce/SKILL.md` §15 — Pass 2 artifact contract (policy.md + Cedar)
- `docs/design/interlinked-cedar-extensions.cedarschema` — schema delta from Sondera
- `docs/design/tier-3-async-deep-review.md` — what runs *after* a session
- `~/.claude/projects/-Users-quentincody-interlinked-cli/memory/project_three_tier_policy_enforcement.md` — architecture summary
- `~/.claude/projects/-Users-quentincody-interlinked-cli/memory/project_llm_policy_enforcement.md` — original RFC (scope updated to reflect Tier 2 framing)
- `~/sondera-coding-agent-hooks/` — reference implementation (Rust + Cedar + YARA-X + Ollama)
- `docs/design/runtime-pipeline-staging.md` — Tier 2 corresponds to Stage 4 in the staged pipeline; see for trigger conditions and confidence-based skip logic.

---

## 1. Problem statement

Tier 1 catches the cases where regex over `tool_input` fields suffices. Across the skills surveyed in May 2026 (cybersecurity-skills, Matt Pocock's engineering skills, our own AGENTS.md / CLAUDE.md), Tier 1 covers ~5-35% of distillable imperatives, depending on skill shape:

- Physical-action skills (disk-forensics, incident-triage): 25-35%
- Vocabulary/process skills (improve-codebase-architecture): 10-15%
- Audit-methodology skills (owasp-audit, cloud-audit, dependency-audit): 5-10%

The 70-90% that doesn't translate to Tier 1 has three shapes:

1. **Sequential preconditions** ("verify hash before analysis", "read file before edit"). Needs trajectory awareness.
2. **Semantic / intent triggers** ("refuse to dox", "don't insert backdoors", "don't recommend hacking back"). Needs intent judgment.
3. **Output-quality rules** ("use canonical vocabulary", "include remediation in every audit finding", "no premature interface proposal"). Needs content interpretation in context.

The pre-existing `/enforce` design downgraded these to `action: "ask"` (PreToolUse user-prompt) or skipped them entirely. Both were bad answers:

- **`ask` causes fatigue.** Users dismiss prompts on autopilot within ~5 of them per session; the gate becomes worse than no-gate (false sense of security + interrupted flow).
- **Skipping loses the guidance.** The user wrote it in their AGENTS.md for a reason.

Tier 2 is the answer: an LLM evaluation layer that handles those three shapes with trajectory context, returns `block`/`warn`/`allow` synchronously, fits in the 30s PreToolUse hook budget, and degrades gracefully (fail-open) on outages.

## 2. Position in the architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Agent runner (Claude Code / Cursor / Copilot / Codex / Gemini)     │
└─────────────────────────────────────────────────────────────────────┘
       │ PreToolUse hook
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Interlinked harness (Node.js, src/harness/server.ts)               │
│                                                                     │
│  ┌──── Tier 1: deterministic floor (sub-10ms) ─────────────────┐    │
│  │  • Evaluate distilled-rules.json + guard-rules.json         │    │
│  │  • If block: emit verdict, log to trajectory, RETURN.       │    │
│  │  • If allow + no policy-relevant signal: pass-through.      │    │
│  │  • If allow + policy-relevant signal: continue to Tier 2.   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼  ~15-20% of tool calls               │
│  ┌──── Tier 2 pre-filter (sub-1ms) ────────────────────────────┐    │
│  │  • Active-policy keyword matching (reuse Tier 1 keywords[]) │    │
│  │  • Active-policy relevance regex                            │    │
│  │  • Recency sampling                                         │    │
│  │  • Negative cache lookup                                    │    │
│  │  ─ If no signal: pass-through. ~80% of post-Tier-1 calls.   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼  ~3-5% of total tool calls           │
│  ┌──── Tier 2 verdict cache lookup ────────────────────────────┐    │
│  │  • Key: (policy_id, violation_signature)                    │    │
│  │  ─ Hit: return cached verdict. ~50% hit rate.               │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼  ~1.5-2.5% of total tool calls       │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Inference path: Groq (default) / Cerebras (failover) / Self-host   │
│                                                                     │
│  • Prompt: cached prefix (active policies + early trajectory)       │
│    + recent trajectory delta + current tool call                    │
│  • Model: gpt-oss-safeguard-20b (default); -120b for hard cases     │
│  • Response: {decision, violated_policies[], violation_signature,   │
│              reasoning, confidence}                                 │
│  • Latency: ~3-6s p50, 10-15s p99, 30s hard timeout                 │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                  Verdict returned to harness
                  → caches it by (policy_id, signature)
                  → applies decision to PreToolUse response
                  → appends to trajectory
```

Tier 2 sits between Tier 1 (always-on, deterministic) and Tier 3 (post-session, full-repo). All three tiers share the trajectory model and the policy text — different consumers, same source of truth.

## 3. Provider selection

| Provider | Model | t/s | $/M output (est) | TTFB | Notes |
|---|---|---|---|---|---|
| **Groq** | gpt-oss-safeguard-20b | ~600 | ~$0.50 | ~200ms | Default. Fast, cheap, good for most cases. |
| **Cerebras** | gpt-oss-120b | ~3000 | ~$1.50 | ~150ms | Failover for tail latency. More capable. |
| **Cloudflare Workers AI** | gpt-oss-20b | ~300 | $0.30 | ~500ms | For Workers-co-located deployments. |
| **Self-host (Ollama)** | gpt-oss-safeguard-20b | varies | $0 | varies | Air-gapped, local-only mode. |

**Default chain:** Groq → Cerebras failover → local-Ollama fallback (if configured) → fail-open.

Per `project_classifier_inference.md`: long-term, the MCP server proxies inference for all users so they don't need to manage API keys. v1 calls Groq directly from the harness with `GROQ_API_KEY` from env. v2 routes through the server.

### Why gpt-oss-safeguard specifically

The OpenAI gpt-oss-safeguard models are purpose-built for "policy-at-inference-time" — you provide policy text in the prompt, the model reasons over whether a content/action violates it, returns a structured verdict. The 20b variant is the right starting point for cost/latency; the 120b is for cases where verdicts disagree across runs (judgment fragility).

Two reasons to prefer it over a general-purpose model (Claude Haiku, GPT-4o-mini, etc.):

1. **Structured reasoning output is native.** The model emits `reasoning_trace + final_verdict` shape; no prompt engineering required for output format. Generic models need careful prompting and still drift.
2. **Custom policy enforcement is the design center.** The training data includes policy-evaluation traces; the 20b model performs near 120b-general-model levels on policy classification tasks per OpenAI's reported benchmarks.

The tradeoff: it's an open-weights model, not API-native at Anthropic/OpenAI, so we rely on third-party inference providers. That's an acceptable cost — the providers (Groq, Cerebras) have strong uptime track records and the failover chain bridges outages.

## 4. Inference path

```
PreToolUse event arrives at harness via hook script
   │
   ▼
harness.evaluatePreToolUse(event)
   │
   ├── tier1 result = evaluateDeterministicRules(event)
   │   ├── if tier1.decision === "block": return tier1
   │   └── else: continue
   │
   ├── if tier2 disabled: return allow
   │
   ├── tier2PreFilter(event):
   │   ├── policy = activePoliciesFor(event.tool_name, event.skill_active)
   │   ├── if no policy has keywords matching event.tool_input: skip
   │   ├── if no policy has relevance regex matching event.tool_input: skip
   │   ├── if last K calls were all `allow` and no new signals: sample at 1/2
   │   └── if all pass: continue
   │
   ├── cacheKey = computeCacheKey(event, activePolicies, trajectory)
   │   ├── lookup verdict cache
   │   └── if hit: return cached verdict
   │
   ├── prompt = buildPrompt(
   │     activePolicies = loadAllActivePolicyDocs(),
   │     trajectory = lastNToolCalls(10),
   │     currentCall = event,
   │   )
   │
   ├── verdict = await callTier2WithTimeout(
   │     prompt, 
   │     provider = "groq",
   │     model = "gpt-oss-safeguard-20b",
   │     timeoutMs = 30_000,
   │     reasoningEffort = "medium",
   │     responseFormat = { type: "json_schema", schema: VERDICT_SCHEMA },
   │   )
   │
   ├── if verdict timed out OR errored:
   │   ├── log to .interlinked/policy-misses.jsonl
   │   └── return allow (fail-open per feedback_safety_continuity)
   │
   ├── cacheVerdict(cacheKey, verdict)
   ├── appendToTrajectory({...event, tier2_verdict: verdict})
   └── return verdict
```

## 5. Prompt structure (designed for prefix caching)

Anthropic and Groq both support prompt caching. The Groq implementation is automatic (no `cache_control` markers); Anthropic's requires explicit `cache_control` annotations on prefix blocks. Either way, the prompt must be structured so that the *prefix* stays identical across all tool calls in a session and the *suffix* contains only the new tool call.

```
┌──── PREFIX (cached across all tool calls in session) ──────────────┐
│                                                                    │
│ System: You are a policy evaluation gate for an AI coding agent.   │
│ Evaluate the current tool call against active policies, given the  │
│ trajectory of prior calls. Return a structured verdict.            │
│                                                                    │
│ Active policies (loaded from .interlinked/policies/ at session     │
│ start; identical for the lifetime of the session):                 │
│                                                                    │
│ ─── Policy: skill:disk-forensics ───                               │
│ <verbatim content of skill-disk-forensics.policy.md>               │
│                                                                    │
│ ─── Policy: local:AGENTS.md ───                                    │
│ <verbatim content of local-AGENTS.md.policy.md>                    │
│                                                                    │
│ ... (all active policies)                                          │
│                                                                    │
│ Trajectory so far (calls 1 through N-1; stable until next call):   │
│ [1] BashCommand: dig +short example.com → allow                    │
│ [2] BashCommand: nmap -sV example.com → allow                      │
│ [3] FileWrite scan.txt → BLOCKED (rule: out-of-scope)              │
│ [4] BashCommand: sha256sum case01.E01 → allow                      │
│ ... up to call N-1                                                 │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
┌──── SUFFIX (changes every call) ───────────────────────────────────┐
│                                                                    │
│ Current call (N):                                                  │
│ Tool: FileEdit                                                     │
│ Input: { file_path: "case01.E01", content: "..." }                 │
│                                                                    │
│ Evaluate the current call against active policies, given the       │
│ trajectory. Output JSON matching this schema:                      │
│                                                                    │
│ {                                                                  │
│   "reasoning": "string (your analysis, bounded to ~1K tokens)",    │
│   "decision": "block" | "warn" | "allow",                          │
│   "violated_policies": ["policy_id", ...],                         │
│   "violation_signature": "string (deterministic hash of            │
│      normalized signal shape — same across similar violations)",   │
│   "confidence": 0.0-1.0                                            │
│ }                                                                  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Cache behavior:** Anthropic's cache TTL is 5 minutes; Groq's is implementation-specific but similar. The prefix stays cached across tool calls within a 5-minute window. A typical agent session does 20-100+ tool calls in 5 minutes, so cache hit rate on the prefix is near 100% after the first call.

**Cost economics:** Cached input tokens are billed at ~5% of the fresh rate. With ~3-5K tokens in the prefix (active policies + early trajectory) and ~500 tokens in the suffix (current call + verdict schema), a cached call costs ~$0.00015 + $0.00025 = ~$0.0004. Plus ~1-2K reasoning + verdict output at ~$0.001. Total per call: ~$0.001-0.002.

## 6. Trajectory format

The trajectory section of the prompt is the load-bearing context for Tier 2's judgment. Design rules:

1. **Append-only.** Calls don't get undone, edited, or reordered. This is what makes prefix caching cheap.
2. **Include all calls, including blocked ones.** Per the design memo origin: a series of blocked exfiltration attempts still reveals intent. The Nth call may look benign in isolation but rightfully blocked because the trajectory shows escalating attempts.
3. **Bounded recency window.** Default last 10 tool calls. Tunable per skill (some skills benefit from longer context). Beyond the window, older calls are summarized into a single "earlier in session: X reads, Y writes, Z blocks" block.
4. **Redact secrets at trajectory-build time.** Never include API keys, passwords, or file contents matching secret patterns in the trajectory. The harness's existing secret-detection runs first and masks before the trajectory is built.
5. **Per-call fields:** tool name, tool_input (key fields only — command, file_path, content with size cap), Tier 1 verdict, timestamp delta from session start.

Example trajectory entry:
```
[step 7, t+45.3s] BashCommand
  command: "fls -r -o 63 case01.E01"
  → tier1: allow (no rule matched)
  → tier2: warn (policy: enforce-skill-disk-forensics-verify-hash-before-analysis)
```

Blocked example:
```
[step 4, t+12.7s] FileEdit
  file_path: ".env.production"
  content: "<redacted 1.2KB — matches secret-detection pattern 'env-file-write'>"
  → tier1: BLOCKED (rule: enforce-local-agents-no-prod-env-edit)
```

## 7. Verdict format

```typescript
interface Tier2Verdict {
  reasoning: string;        // ~500-2000 tokens, bounded by reasoning_effort
  decision: "block" | "warn" | "allow";
  violated_policies: string[];  // policy_ids from the active policy set
  violation_signature: string;  // see §8 — used as cache key
  confidence: number;       // 0.0-1.0
  source_quotes: Array<{    // for the agent to see in the warning/block message
    policy_id: string;
    quote: string;          // verbatim from the policy.md source
  }>;
}
```

JSON schema enforcement via the provider's `response_format: {type: "json_schema"}` — guarantees the output parses without fallback handling.

**Decision semantics:**
- `block`: PreToolUse response is `{decision: "block", reason: <reasoning + source_quotes>}`. The tool call doesn't run.
- `warn`: PreToolUse response is `{decision: "allow"}` BUT the harness records a PostToolUse advisory the agent sees on its next turn.
- `allow`: PreToolUse response is `{decision: "allow"}`. No advisory.

**No `ask` in v1.** User opt-in via `policy_engine.on_borderline: "ask"` config — only place `ask` survives. Borderline = confidence < 0.7.

## 8. Violation signature (the load-bearing cache primitive)

The verdict cache is keyed on `(policy_id, violation_signature)`. The signature must be:

1. **Deterministic** — same violation shape → same signature.
2. **Generalizable** — "agent attempted to write secret to .env.production" and "agent attempted to write secret to .env.staging" should share a signature so the cache hits across attempts.
3. **Specific enough** — "agent attempted to write secret" (without scope) is too coarse and would cache different policy violations together.

Approach: the model emits a structured violation_signature as part of its verdict. Examples:

- `policy=P1; signal=write-to-evidence-image-path` (file path is generalized to "evidence image")
- `policy=P3; signal=fls-without-prior-hash-verify` (specific tool, specific precondition)
- `policy=P5; signal=evidence-tampering-intent-suggests-modification` (semantic class)

The cache stores the verdict under this key. Future calls that produce the same signature reuse the verdict (~50ms cache lookup vs 3-6s LLM call).

**Cache invalidation:** Policy files change on `/enforce` re-run → invalidate all entries for affected `policy_id`s. Model version changes → invalidate everything. Session ends → optionally drop the cache (or keep it for cross-session reuse, depending on §13 scope decision).

## 9. Pre-filter design (load-bearing for cost)

Without aggressive pre-filtering, every tool call pays an inference cost. With ~500 tool calls/session and ~$0.001-0.002/call, that's $0.50-$1.00/session — fine for individual devs, problematic at team scale.

The pre-filter aims for 80%+ pass-through (no Tier 2 call) on tool calls that have no chance of violating an active policy.

```
function tier2PreFilter(event, activePolicies, recentTrajectory) {
  // 1. Tool-match: does any active policy target this tool?
  if (!activePolicies.some(p => p.tool_match.includes(event.tool_name))) {
    return "skip-no-tool-match";
  }
  
  // 2. Keyword quick-reject: any policy keyword in the tool_input?
  const inputBlob = serializeToolInput(event.tool_input);
  if (!activePolicies.some(p => p.keywords.some(k => inputBlob.includes(k)))) {
    return "skip-no-keyword";
  }
  
  // 3. Active-policy relevance regex (cheap regex over event.tool_input)
  if (!activePolicies.some(p => p.relevance_regex.test(inputBlob))) {
    return "skip-no-relevance";
  }
  
  // 4. Recency sampling: if last K calls all allowed and no new signals, sample at 1/N
  const recentAllows = recentTrajectory.slice(-RECENT_WINDOW).every(c => c.verdict === "allow");
  if (recentAllows && !hasNewPolicySignals(event, recentTrajectory)) {
    if (Math.random() > SAMPLE_RATE) return "skip-sampled";
  }
  
  // 5. Negative cache: have we already determined this exact shape is safe?
  const negCacheKey = computeNegativeCacheKey(event);
  if (negativeCache.has(negCacheKey)) return "skip-neg-cache";
  
  // No skip — proceed to Tier 2 LLM call
  return null;
}
```

**Tunable defaults:**
- `RECENT_WINDOW = 5` (recent-trajectory check)
- `SAMPLE_RATE = 0.5` (sample half when calls are quiet)
- `negativeCache` TTL: 10 minutes (long enough to be useful, short enough to recover from policy changes)

**Calibration target:** measure pre-filter hit rate in shadow mode (v1) and adjust thresholds before enforce-mode (v2).

## 10. Fail modes (binding: fail-open everywhere)

Per `feedback_safety_continuity`: no circuit breakers on safety layers. Failure modes degrade gracefully:

| Failure | Detection | Handler |
|---|---|---|
| Hard 30s timeout | `AbortController.signal` fires | Fail-open. Log `{event, reason: "timeout"}` to `.interlinked/policy-misses.jsonl`. |
| Network unreachable | fetch error | Fail-open. Log. Don't retry within this call. |
| Provider 5xx | response status | Fail over to next provider in chain. If all fail: fail-open + log. |
| Provider 4xx (auth) | response status | Log loudly, disable Tier 2 for this session, fail-open. |
| Malformed JSON response | parse error | Fail-open. Log with raw response for debugging. |
| Cache corruption | deserialization error | Drop cache, log, re-run inference. |
| Policy file invalid | load error at session start | Skip that policy, log, continue with other policies. Don't fail-open the whole layer. |

**The deterministic Tier 1 floor still applies on every fail-open path.** Tier 1 doesn't depend on the network and catches the catastrophic cases.

**Log location:** `.interlinked/policy-misses.jsonl` (append-only JSONL). One entry per fail-open event. Used for: (a) calibrating reliability, (b) replaying offline to see what Tier 2 would have decided, (c) producing dashboards for the user.

## 11. Cost model

Realistic per-session cost estimates (Groq pricing, gpt-oss-safeguard-20b):

| Tool calls / session | LLM-evaluated calls (~1.5-2.5%) | Cost / session |
|---|---|---|
| 50 | 1-2 | ~$0.002 |
| 500 (typical dev session) | 8-13 | ~$0.013 |
| 5000 (heavy AI agent session) | 75-125 | ~$0.13 |

Plus prefix caching savings: the cached prefix is billed at ~5% of fresh rate, so the per-call cost stays low even with a 3-5K token policy context.

**Annualized for a typical user:**
- 200 sessions/year × ~$0.013 = ~$2.60/year (Groq + prefix cache)
- 200 sessions/year × ~$0.06 = ~$12/year (worst case, no caching)

Tractable for individual dev. For team plans, multiply by team size; for high-frequency agent workflows, consider per-org cache and rate limiting (see §13).

## 12. Rollout cadence (shadow → enforce)

**v1: Shadow mode (no enforcement).**

- All Tier 2 calls happen, verdicts are logged to `.interlinked/policy-shadow.jsonl`.
- The verdict is NOT applied to the PreToolUse response — the call proceeds regardless.
- The user can `interlinked policy review` to see what Tier 2 would have done.
- Goal: measure FP rate per policy, calibrate the LLM gate before enforcement.

**v1.1: Selective enforce.**

- For policies where shadow-mode FP rate is < 5% on real sessions, flip to enforce.
- For policies where FP rate is high, stay shadow + flag for source-markdown tightening.
- Per-policy `enforced: true/false` flag in `policy.md`.

**v2: Default enforce.**

- All policies default to enforced. Per-policy opt-out via `interlinked policy disable <id>` (which goes into `distilled-rules.overrides.json`).
- Shadow mode still available for new policies.

This matches the existing `project_llm_policy_enforcement` rollout pattern. The scope has expanded (Tier 2 evaluates most tool calls, not just escalations), but the shadow→enforce cadence is unchanged.

## 13. Cross-runner contract

Tier 2 doesn't need per-runner adapters. The runner-side concern is hook delivery (already handled by the existing Tier 1 fan-out via `src/harness/adapters/`). The policy.md content lives on the harness side and is loaded into the cloud agent's prompt context — runner-agnostic.

What IS runner-specific:

- **PreToolUse blocking semantics.** Claude Code understands `{decision: "block", reason: "..."}` directly. Cursor uses similar JSON. Copilot has a slightly different envelope. Codex has its own. These are all handled by the existing Tier 1 adapters; Tier 2 just produces the same decision format.
- **PostToolUse warning delivery.** Some runners (Cursor, Claude Code) render PostToolUse output as agent-visible system-reminders; others (Copilot pre-2026) drop them. Tier 2 emits the same warning regardless; visibility is the runner's choice.

The user has memory on this: see `project_posttooluse_visibility` and `project_copilot_cursor_status`.

## 14. Local-only fallback (Sondera self-host)

For users who can't or won't use cloud inference:

**Config:** `policy_engine: "local-ollama"` in `.interlinked/config.local.json`.

**Behavior:**
1. The harness exec's `ollama run gpt-oss-safeguard-20b` (or the user's chosen model) with the same prompt format as the cloud path.
2. Latency is higher (~10-30s p50 on consumer hardware vs ~3-6s on Groq).
3. Accuracy is similar (same base model).
4. No cost.

**Sondera compatibility:** Users running Sondera locally can wire their harness to consume our `.cedar` files from `.interlinked/policies/`. The Cedar files use Sondera's entity model by default; the `.interlinked.cedar` files use our extensions documented at `docs/design/interlinked-cedar-extensions.cedarschema`.

This is the "self-hosted air-gapped" mode. Documented in `cli/docs/harness.md` (to be added in v1).

## 15. Human-in-the-loop (opt-in only)

**Default:** no user prompts. `ask` is removed from the default action set.

**Opt-in:** `policy_engine.on_borderline: "warn" | "block" | "ask"` in `.interlinked/config.local.json`. Default is `warn`. Setting to `ask` enables PreToolUse user prompts for verdicts with `confidence < 0.7`.

This is the only place `ask` survives, and it's user-controlled. The product default of `warn` matches the existing feedback on `ask` causing fatigue (see `feedback_pinned_no_ask_prompts` if landed, or the inline reasoning in §15.1 of `skills/enforce/SKILL.md`).

## 16. Open decisions

These are blocked on either product direction or experimental data and won't be resolved until Tier 2 prototyping starts:

1. **Verdict cache scope: per-user, per-org, or cross-user-global?**
   - Per-user (lowest hit rate, best privacy)
   - Per-org (medium hit rate, requires org tenant model)
   - Cross-user-global (best hit rate, raises trust/privacy questions on policy text + signatures)
   - **Leaning:** per-user in v1, per-org opt-in in v1.1, global never.

2. **Default Tier 2 state for v1: shadow or enforce?**
   - **Decided:** shadow (matches `project_llm_policy_enforcement` framing).

3. **Where do prose.md files live for Tier 3?**
   - Same dir as policy.md (`.interlinked/policies/<group>.prose.md`)
   - Separate dir (`.interlinked/prose/<group>.md`)
   - **Leaning:** same dir — they're per-group artifacts of the same /enforce run.

4. **How are policies loaded for sub-agents / sub-sessions?**
   - When the agent calls a sub-agent (Task tool), does Tier 2 evaluate the sub-agent's tool calls with the parent's active policies?
   - **Leaning:** yes, inherit. Sub-agents share the trajectory.

5. **Model selection: when to use gpt-oss-safeguard-120b instead of -20b?**
   - 120b is ~3x more expensive but more capable for nuanced judgments.
   - **Leaning:** -20b default. Per-policy `model_override: "120b"` available for hard policies. Or dynamic: if -20b confidence < 0.7, retry with -120b.

6. **Confidence calibration: where does the threshold for "borderline" come from?**
   - Currently 0.7. Empirical — adjust based on shadow-mode data.

7. **Cross-session trajectory: does Tier 2 see trajectory from prior sessions?**
   - Within a session, yes (it's the cached prefix).
   - Across sessions, currently no.
   - Option: persist last-N session trajectories to `.interlinked/trajectories/`, surface them as compressed summaries in the prompt context.
   - **Leaning:** v1 in-session only. v1.1 explore cross-session summaries for trajectory-pattern detection ("over the last 5 sessions, this agent has attempted to exfiltrate 12 times").

8. **Rate limiting at the per-user level.**
   - Groq has its own rate limits, but our wrapper should cap LLM-eval calls per session/minute to prevent runaway costs.
   - **Leaning:** soft cap at 200 calls/session, hard cap at 1000. Beyond the soft cap, increase sample rate aggressively.

9. **Streaming vs batch inference.**
   - Groq supports streaming. Streaming the reasoning could let the verdict arrive faster.
   - But the verdict is the final JSON, and we need to wait for the full structured output anyway.
   - **Leaning:** non-streaming. Simpler error handling.

10. **What goes in the trajectory after a fail-open?**
    - The current call was processed without a Tier 2 verdict.
    - Record `tier2_verdict: "fail-open"` for visibility in the trajectory?
    - **Leaning:** yes — Tier 3 should see fail-open events so it can flag sessions with unreliable gating.

---

## Implementation order

When you sit down to build Tier 2:

1. **Verdict schema + fail-open contract.** Get the typing right first; everything depends on it.
2. **Pre-filter (no LLM yet).** Implement filtering against a hardcoded policy set. Measure pass-through rate against a real session log. Validate 80%+ before paying for any LLM calls.
3. **Prompt template + prefix-cache validation.** Build the prompt, verify Groq/Anthropic cache hits work as expected, measure latency.
4. **Shadow mode end-to-end.** Hook up Groq, log verdicts, don't enforce. Run for a week against your own sessions.
5. **Calibrate.** Tune pre-filter, tune sampling, look at fail-open rate, evaluate FP rate per policy.
6. **Verdict cache.** Add the (policy_id, signature) cache after shadow data shows it'd be useful.
7. **Selective enforce (v1.1).** Flip per-policy `enforced` flag based on shadow data.
8. **Cerebras failover + local-Ollama mode.** Add the failover chain once the happy path is stable.
9. **Default enforce (v2).** All policies enforce unless opted out.

**Pre-requisites that aren't built yet:**
- The cloud-side product surface (server-proxied inference for users without API keys, per `project_classifier_inference`)
- Per-user rate limiting infrastructure
- The dashboards / `interlinked policy review` UX

These don't block prototyping with a personal `GROQ_API_KEY` — they block GA.
