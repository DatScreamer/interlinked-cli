# Three-Product Architecture: Free CLI + Guardrails + Agent CI

**Status:** Plan / not yet implementation. Supersedes parts of `mcp-server-discovery-endpoint.md` (no remote config surface needed) and `oauth-hardening.md` (Managed OAuth removes the entire stack). References and integrates: `harness-risk-tiers-and-severity.md`, `harness-jsonl-output-contract.md`, `harness-break-glass-primitive.md`, `llm-policy-classifier.md`, `classifier-prompt-caching-and-sanitization.md`, `classifier-remote-config-and-failback.md`, `mcp-proxy-worker-attribution.md`, `project-think-integration.md`, `private-vs-shared-agent-state.md`, `harness-incremental-rereview.md`.

**Scope:** Defines the product line as three architecturally distinct offerings, the latency budget framework that governs each, and the phased rollout to ship them.

**Audience:** Engineering, product, and anyone considering pricing or sales motion.

---

## TL;DR

We ship three products, not one:

1. **Free CLI** (`interlinked`) — local-only deterministic checks, runs in ~hundreds of ms, no network. The funnel.
2. **Guardrails** (paid, fast cloud) — sub-second blocking policy gate that rides every PreToolUse. Per-request pricing. The expansion.
3. **Agent CI** (paid, slow cloud) — async deep scans triggered by commit/PR/schedule/escalation, runs for seconds to hours in Sandboxes against forked Artifacts. Per-compute-minute pricing. The monetization.

They share auth (Cloudflare Access Managed OAuth) and observability (AI Gateway → Logpush) but are otherwise distinct codebases. Each is independently sellable. The escalation flow connects fast → slow.

Latency budgets are **per-tool-class**, not a single number. Free CLI: 300ms read-class, 800ms modify-class, 2s side-effect-class. Guardrails: same envelope, with cloud round-trip absorbed. Agent CI: no blocking budget — async by definition.

---

## 1. Latency Budget Framework

### Why one number is wrong

A blanket "<500ms p99" budget treats every tool call as if the user were watching a spinner. They aren't. The user's perception of "the agent is slow" depends on:

1. **What tool just ran** — `Read` is expected to be instant; `Bash` is expected to take time.
2. **Whether the agent was thinking before the tool** — model reasoning often takes 2–15s, which absorbs hook latency entirely.
3. **How many tool calls per turn** — chains amplify latency; lone calls don't.
4. **Whether the user is actively watching** — pre-commit gates have a different audience than PreToolUse hooks.

The correct framing is **tool-class-specific budgets** with worst-case stack-up math.

### Tool classes

| Class | Examples | User mental model | Hook budget (total, including all checks) |
|---|---|---|---|
| **Read** | `Read`, `Grep`, `Glob`, `LS`, `Bash` with `ls`/`cat`/`pwd` | Instant | **300ms p99** |
| **Modify** | `Edit`, `Write`, `Bash` with `mv`/`cp`/code execution | Sub-second | **800ms p99** |
| **Side-effect** | `Bash` with `git push`, `gh pr merge`, `rm -rf`, deploy commands, network mutations | Multi-second OK | **2000ms p99** |
| **Long-running** | Test suites, builds, migrations | Many seconds OK; progress updates expected | **5000ms p99** + streaming progress |

This is the bound on the *total* hook latency — local checks plus any cloud round-trip combined. The split between local and cloud within that budget is an implementation choice.

### Worst-case stack-up math

With these budgets and realistic tool-call mix (5 tool calls per agent turn, of which ~30% trigger the gate at modify-class):

- 5 tools × 30% gated × 800ms = **1.2s added per turn**
- 60 turns/hour × 1.2s = **72s added per hour** ≈ 2% perceived slowdown
- Side-effect calls (~5% of turns): one extra 2s gate occasionally, in the noise of the operation itself

For comparison, my prior 500ms blanket would have been 50% too tight on side-effect calls and unnecessarily restrictive everywhere else. The new framework gives ~60% more compute headroom on modify-class and ~300% more on side-effect-class without measurably degrading UX.

### Free CLI budgets

The CLI is local and compute-bound, not network-bound. With a warm daemon (`interlinked-hookd`) holding project graph state, the hot-path per-check runtimes are:

| Check | Cold | Warm (daemon) |
|---|---|---|
| Secret regex on diff | 5ms | 5ms |
| Structure / ID-confusion regex | 20–100ms | 20–100ms |
| Suppression / schema-order checks | 10–50ms | 10–50ms |
| **tsgo single-file check** (`--noEmit` scope) | 200–800ms | **5–50ms** |
| Biome on changed file | 50–200ms | 50–100ms |
| tsgo over file + immediate dependents | 500ms–2s | 100–400ms |
| Full-project tsgo | 2–30s | 500ms–5s |
| Mini-mutation gate (single-file) | 200–800ms | 100–500ms |

The warm-daemon column is what governs the PreToolUse split. `tsgo` was designed explicitly for editor-tight-loop usage — single-file check via a long-held project graph is in the same league as biome.

**Hook placement:**

| Hook | What runs | Budget |
|---|---|---|
| `PreToolUse` (blocking) | Secret regex, structure regex, ID-confusion, suppression check, schema migration-order, **tsgo single-file check (via daemon)**, biome (target file), **simulated-edit type check** on `Edit` ops | <300ms (Read), <800ms (Modify), <2000ms (Side-effect) |
| `PostToolUse` (advisory, non-blocking) | tsgo on touched file + immediate dependents, test-quality patterns, mini-mutation gate, heavier custom rules | Best-effort; streams results; blocking on *next* PreToolUse if new errors introduced |
| `pre-commit` (`interlinked verify`, gated by user wait) | All of the above on staged files + cross-file structural checks | <5s typical, <30s worst case |
| `pre-push` (full verify) | Full-project tsgo + everything | <60s |
| CI (`interlinked verify --ci`) | Everything | Unbounded; runs to completion |

**The daemon (`interlinked-hookd`):**

- Starts on `SessionStart` hook; killed on `SessionEnd`
- Spawns `tsgo --watch --noEmit` with the project's tsconfig loaded; holds the full type graph in memory
- Exposes a Unix-socket RPC: `check-file <path>`, `simulate-edit <path, old_string, new_string>`, `invalidate <path>`, `diagnostics-for <path>`
- Maintains mtime-keyed result cache for non-tsgo checks (biome, regex) to skip re-runs on unchanged files
- Hook binary becomes a thin client: posts event JSON over the socket, reads decision, exits
- Cold-start fallback: if the socket isn't reachable, spawn a one-shot tsgo for just the touched file (still fast thanks to tsgo's architecture, just not instant)

**Simulated-edit type check (the interesting PreToolUse trick):**

For `Edit` tool calls, the hook has both the current file content and the proposed `old_string → new_string` patch. The daemon can apply the edit to its in-memory copy, re-check the file in ~10–50ms, compare diagnostics against the baseline, and surface *only new* errors as `additionalContext`. This catches type regressions *before* they hit disk — turning PostToolUse noise into PreToolUse guidance.

### Fast cloud (Guardrails) budgets

Network adds 30–80ms baseline (US dev → CF edge). Our compute budget within the user-facing envelope:

| Tool class | Total user budget | Network | Compute budget for cloud-side |
|---|---|---|---|
| Read | 300ms | ~50ms | ~200ms compute |
| Modify | 800ms | ~50ms | ~700ms compute |
| Side-effect | 2000ms | ~50ms | ~1900ms compute |

What 700ms of compute buys (modify-class):

- Cedar policy eval (~80ms) + DO read (~80ms) + signature DB lookup (~150ms) + small classifier (~400ms) **in parallel** = max ~400ms ✓
- Same in series = ~710ms — borderline; only do this for high-stakes
- The "lite" coordinator+specialist tier (one coordinator + 3 specialists at gpt-oss-20b) — typically 600–900ms — fits for modify-class on the high end

What 1900ms of compute buys (side-effect-class):

- Full coordinator + 7 specialists tier — typically 1500–2500ms — fits if we keep it lean
- Multi-stage Cedar evaluation with 2–3 cross-policy compositions
- Larger model (gpt-oss-120b) for nuanced policy decisions
- LLM reasoning over the diff with retrieval from past verdicts (AI Search)

Hard ceiling: if a planned check would take >2s p99, **it does not belong in Guardrails**. It belongs in Agent CI.

### Slow cloud (Agent CI) budgets

No blocking budget. SLOs measured differently:

- Initial response (`scan.request_deep_scan` returns `job_id`): <500ms
- First progress update visible to user: <30s (typically the first specialist returns)
- Full deep-policy scan complete: 2–15 minutes typical
- Mutation testing run: 5–30 minutes
- Integration test run against customer staging: 10 minutes – 2 hours
- Compliance scan: 1–6 hours

Streamed progress is the UX contract. Agents and users see specialist findings appear as they're produced; the Coordinator's final verdict comes last.

---

## 2. Free CLI — `interlinked`

The free CLI is the centerpiece of the initial engineering effort. Because the detail needed to implement it would bloat this overview doc past a readable length, it lives in three focused companion docs. **If you are implementing the CLI, start with these, not with this section.**

| Doc | Purpose |
|---|---|
| [`free-cli-architecture.md`](./free-cli-architecture.md) | Core CLI architecture — scope, distribution, check inventory, installer, daemon, directory layout, config schemas, check declaration format, telemetry wire format, cloud future-proofing, output formatting |
| [`cli-hook-normalization.md`](./cli-hook-normalization.md) | Cross-runner hook adapter design — unified event envelope, per-runner adapters (Claude Code, Copilot CLI, Cursor, Gemini CLI, Codex), tool-class classifier, decision response translation, what we borrow from Sondera vs where we diverge |
| [`cli-implementation-plan.md`](./cli-implementation-plan.md) | Phased build order (Phases A–J) for a coding agent or engineer building from the current codebase — file-by-file steps, each phase independently shippable |

### Summary of the shape

- `interlinked` runs **entirely locally**; no auth, no network for core function. Source-available, Bun-compiled single binary + npm + homebrew tap.
- Extends existing harness infrastructure at `cli/src/harness/` (67 guard rules + 22 structural + 18 quality + ~50 generic checks + coverage ratchet + mutation gate + reservations + trigram). Does not rewrite.
- New work is concentrated in: runner-adapter layer (`cli/src/harness/adapters/`), unified event envelope (`unified-event.ts`), tool-class classifier, typed daemon RPC, warm `tsgo` child process, telemetry spool.
- Normalizes hooks across five runners behind a common `RunnerAdapter` interface. Claude Code and Copilot CLI are in-place today and get restructured; Cursor, Gemini CLI, and Codex are greenfield adapters.
- `interlinked install-hooks` writes merge-safe fragments to each runner's native settings file and records exactly what it did in `installer-manifest.json` for precise uninstall.
- `interlinked-hookd` daemon, started per session, holds a warm `tsgo` graph for 5–50 ms single-file type checks and a simulated-edit type check that catches type regressions before they hit disk.
- Designed so cloud opt-in (`--cloud=guardrails`) adds synchronous conservative escalation from the daemon with **zero architectural changes** — only config and per-check metadata.
- Commercial purpose: developer mindshare and onboarding funnel into Guardrails.

### Latency targets (recap from §1)

| Tool class | Total hook budget p99 |
|---|---|
| Read | 300 ms |
| Modify | 800 ms |
| Side-effect | 2000 ms |
| Long-running | 5000 ms + streamed progress |

Warm-daemon `tsgo` single-file check fits comfortably in the Read budget (5–50 ms); full-project `tsgo` does not and runs only via `verify` / `pre-push` / CI or the slow cloud tier.

---

## 3. Fast Cloud — Guardrails

### Architecture

```
Hook binary
   │  sync POST /mcp via Portal (Access JWT)
   ▼
MCP Portal (Cloudflare Access Managed OAuth)
   │
   ▼
GuardrailsAgent extends McpAgent<Env, State, {}>
   │
   ├── Cedar policy eval (compiled WASM, in-Worker)         ~80ms
   ├── Workspace DO read (Facet for session state)          ~50ms
   ├── Signature DB lookup (Bloom + Vectorize)              ~150ms  
   ├── (optional) classifier via AI Gateway Dynamic Route   ~400ms
   │       └── Workers AI: @cf/openai/gpt-oss-20b
   │
   └── Decision merge → @callable response
```

All non-classifier calls run in parallel; classifier is sequential after the deterministic signal aggregation (some specialists need the deterministic findings as input).

### MCP tool surface

Single tool per the `mcp-agent-migration-spike.md`:

```typescript
@callable()
async evaluatePolicy(args: {
  tool_name: string;
  tool_class: "read" | "modify" | "side-effect" | "long-running";
  tool_args_redacted: Record<string, unknown>;  // DLP-stripped before send
  session_id: string;
  workspace_id: string;
  agent_handle: string;
  diff_summary?: string;     // small, capped at 4KB
  context_hash?: string;     // pointer to fuller context in DO if needed
}): Promise<{
  decision: "allow" | "ask" | "deny" | "escalate";
  reason: string;
  receipt_id: string;        // for audit; appears in Logpush
  classifier_used: string | null;
  evaluated_in_ms: number;
  gate_class: "fast-deterministic" | "fast-classifier" | "fast-coordinator";
}>;
```

### Detection / decision split (Sondera pattern)

Two distinct phases per call:

1. **Detection** — deterministic signal generators (Cedar predicates, regex, DO lookups, classifier output) produce a structured signals object. Every detector runs concurrently; all signals available before any decision.
2. **Decision** — one Cedar policy evaluates the signals object → final verdict. Easy to audit, easy to test, easy to tune without touching detectors.

This is the core architectural commitment. Adding a new detector never changes the decision logic; tightening a policy never requires re-running detectors.

### Check inventory

| Check | Detector → Decision input | Compute |
|---|---|---|
| Cedar policy DSL | Direct policy eval over signals | 80ms |
| Secret entropy + signature DB | `secrets_found: [{signature, score}]` | 150ms |
| Single-package CVE freshness | `cve_hits: [{package, severity}]` | 200ms |
| File-reservation conflict | `reservation_conflicts: [{path, holder}]` | 80ms |
| Intent-scope enforcement | `out_of_scope: bool, intent_id?: string` | 80ms |
| Taint trail lookup | `tainted_files_touched: [{path, source_url}]` | 100ms |
| Small-model classifier | `classifier: {risk, categories[], confidence}` | 400ms |
| Moderation pre-scan | `moderation: {flagged, categories[]}` | 250ms |

### Risk tiering inside the gate

Per `harness-risk-tiers-and-severity.md`, the gate itself routes:

- Tool class = Read → only deterministic detectors run (~250ms p99)
- Tool class = Modify → deterministic + small classifier (~700ms p99)
- Tool class = Side-effect → full coordinator (1 coordinator + 3 specialists, 1500–1900ms p99)
- Long-running → fan out to slow mode immediately (`escalate`)

### AI Gateway Dynamic Route

`policy-router` configured in dashboard, not code:

```
if metadata.gate_class == "fast-coordinator" → coordinator(gpt-oss-120b) + 3 specialists(gpt-oss-20b)
elif metadata.gate_class == "fast-classifier" → single specialist(gpt-oss-20b)
else                                          → no LLM call

per-key rate limit: 100/min/customer
per-key budget limit: configurable per plan tier
ZDR: true for OpenAI/Anthropic (BYOK customers)
fallback: same-family in-degree on 429/503
```

### Standalone usage

Agents speaking MCP can connect directly to `portal.interlinked.dev/mcp` without the CLI. The `evaluatePolicy` tool fires at every MCP tool dispatch on the server side. Coverage gap vs CLI+cloud: the agent's local shell/file-edit tools (no hook present), but everything in the MCP surface is gated.

### Pricing model

- Per-request, tiered volume pricing
- Free tier: 1,000 evaluations/month (developer trial)
- Hobby: 10,000 evals/month, $X
- Team: 100,000 evals/month + shared signature DB updates, $Y
- Enterprise: unlimited + ZDR + BYOK + dedicated routing, $Z

Logpush of every receipt to customer SIEM as part of Team/Enterprise. Detailed cost-attribution per agent-handle via `mcp-proxy-worker-attribution.md` pattern.

### Standalone vs CLI+cloud

| | Standalone (no CLI) | CLI + Guardrails |
|---|---|---|
| Coverage | MCP tool dispatch only | All hook events |
| Local-tool coverage (shell, edit) | No | Yes |
| Latency | ~150–600ms (server-side, no extra hop) | +30–80ms network |
| Privacy | Server sees all tool args | CLI redacts before send |
| Best for | Headless agents, CI bots | Interactive dev sessions |

---

## 4. Slow Cloud — Agent CI / Deep Scans

### Trigger surfaces

Customer enables any subset:

1. **Explicit MCP tool call** — `scan.request_deep_scan({ session_id, scope: "policy" | "mutation" | "integration" | "compliance" })` returns `{ job_id }` immediately.
2. **Git webhook** — installable GitHub App receives PR open/update; spawns Workflow with the changed-files list.
3. **Schedule** — cron triggers configured per workspace: nightly compliance, weekly fleet anomaly, etc.
4. **Escalation from fast mode** — `evaluatePolicy` returns `decision: "escalate"` → a Workflow is spawned automatically with the same `session_id` and `receipt_id`.

### Per-run architecture

```
Trigger
  │
  ▼
ScanCoordinatorWorkflow extends WorkflowEntrypoint
  │
  step.do("fork-artifact"):
      env.ARTIFACTS.get(workspace_baseline).fork(`scan-${jobId}`, {
          defaultBranchOnly: true, readOnly: false
      })
  │
  step.do("spawn-sandbox"):
      sandbox = getSandbox(env.Sandbox, `scan-${jobId}`)
      sandbox uses InterlinkedSandbox class:
        enableInternet = false
        outboundByHost = {
          "api.github.com": inject GITHUB_TOKEN,
          "registry.npmjs.org": pass-through,
          customer-staging-host: cf1:network via Mesh,
        }
  │
  step.do("clone-into-sandbox"):
      sandbox.exec(`git clone <artifact-remote> /workspace`)
  │
  step.do("phase-1-install"):
      sandbox.setOutboundHandler("allowHosts", { allowedHostnames: ["github.com", "registry.npmjs.org"] })
      sandbox.exec(`cd /workspace && npm install`)
  │
  step.do("phase-2-lockdown"):
      sandbox.setOutboundHandler("noHttp")
      // No more outbound; tests run sealed
  │
  Promise.all([
      step.do("full-tsc-biome", () => sandbox.exec(`npm run lint && npm run type-check`)),
      step.do("test-suite",      () => sandbox.exec(`npm test -- --json`)),
      step.do("mutation-run",    () => sandbox.exec(`npx stryker run --files-to-mutate=${touchedFiles}`)),
      step.do("llm-deep-policy", () => coordinatorAgentReview(diff, repoContext)),
      step.do("sbom-license",    () => sandbox.exec(`npx @cyclonedx/cdxgen -o sbom.json`)),
      // optional integration if customer has Mesh + staging credentials configured
      step.do("integration",     () => sandbox.exec(`npm run test:integration`)),
  ])
  │
  step.do("collate"):
      verdicts → SessionFacet.findings table; summary blob → R2
  │
  if (any high-risk verdict):
      step.waitForEvent("approve", { timeout: "24h" })
      // Posts to Slack + dashboard; resumes when human responds
  │
  step.do("report"):
      gh.createPRComment(...)
      gh.createStatusCheck(...)
      slack.notify(...)
      ws.broadcast(sessionId, { type: "scan_complete", ... })
  │
  step.do("cleanup"):
      sandbox.destroy()
      // Artifact retained per customer policy: archive 90d default
```

### Coordinator + Specialists pattern (Pattern 4)

For the `llm-deep-policy` step:

| Tier | Specialists | Coordinator | Use when |
|---|---|---|---|
| Trivial | 1 generalist | gpt-oss-20b (downgraded) | Single-file edit, <10 lines |
| Lite | 3 (code-quality, security, test-quality) | gpt-oss-20b | <100 lines, no sensitive paths |
| Full | 7 (above + performance, docs, release, compliance) | gpt-oss-120b | Sensitive paths or >100 lines |

Per `classifier-prompt-caching-and-sanitization.md`:
- Shared prompt prefix cached at AI Gateway (target >80% cache hit rate)
- User-controlled fields sanitized via boundary-tag stripping (Pattern 9)
- Specialists read shared MR context from R2-staged file rather than embedding (Pattern 8)

### Re-runs that remember (Pattern 13)

Per `harness-incremental-rereview.md`:
- Workflow stores per-finding state in the SessionFacet (`fixed | unfixed | user_resolved | won't_fix | disagreed`)
- On re-run, Coordinator receives previous findings + states; re-emits unfixed, omits fixed, respects resolved unless materially worse

### Check inventory

Every check that legitimately can't fit Guardrails' budget:

| Check | Typical runtime | Implementation |
|---|---|---|
| Full LLM reasoning over diff | 30s–3min | Coordinator + Specialists in Workers AI / AI Gateway |
| Mutation testing | 5–30min | Stryker in Sandbox |
| Integration tests against staging | 10min–2hr | Customer test command in Sandbox + Mesh binding |
| Deep prompt-injection scan | 1–10min | Per-message scan over session history; LLM-assisted |
| SBOM + license + CVE graph | 1–10min | `cdxgen` + Snyk / OSV in Sandbox |
| Rendered design audit (contrast / layout-overflow / touch-target) | 1–10min | Impeccable browser engine via Cloudflare Browser Rendering (`@cloudflare/puppeteer`) over a deployed preview — the rendered-DOM checks the local `design_slop` regex port and the `interlinked design` static path can't do; intake `docs/external-pulse/impeccable.md` |
| Compliance reporting | 1–6hr | Long-running `step.do` with checkpointing |
| Fleet anomaly detection | 10–30min | Cross-session pattern mining over Logpush data in R2 |
| Audit log generation | 1–10min | Aggregation over Logpush + DO state → signed PDF |

### Reporting surfaces

- **GitHub PR comment + status check** — installable GitHub App per `harness-incremental-rereview.md`. Comment is a single sticky comment that gets edited on re-runs (no spam).
- **Slack notification** — incoming-webhook URL per workspace; threaded for re-runs.
- **Email** — Cloudflare Email Service for compliance reports.
- **Dashboard at `dashboard.interlinked.dev`** — Worker serving HTML, WebSocket from `GuardrailsAgent` state for live updates. Per-workspace, per-scan view.
- **R2 artifacts** — full SBOMs, compliance PDFs, mutation reports stored as signed-URL R2 objects.
- **Logpush** — every scan event to customer-configured destination (S3, GCS, SIEM).

### Pricing model

- Per-compute-minute (Sandbox runtime) + per-run (Workflow instance) + per-LLM-token (AI Gateway)
- Plan tiers:
  - **Pay-as-you-go**: $X/run + $Y/compute-min + LLM at cost-plus
  - **Team**: 50 runs/month included, includes basic mutation + integration, $Z/mo
  - **Enterprise**: unlimited + reserved Sandbox capacity + Mesh + Logpush-to-SIEM + custom DSL, custom pricing

Higher margin than Guardrails. Sales motion: *"We replace your CI security review and your manual mutation runs with one product that speaks MCP natively."*

---

## 5. The Escalation Flow

The single most important UX detail — what makes "fast + slow" feel like one product instead of two.

```
1. Agent fires PreToolUse on `git push origin main`.
2. CLI hook calls Guardrails `evaluatePolicy({ tool_class: "side-effect", ... })`.
3. Cedar + classifier returns: { decision: "escalate", receipt_id: "rcpt_abc" }.
4. CLI returns "ask" to Claude Code, surfacing:
     "Deep scan running before push (receipt rcpt_abc). Results in ~3min. /approve to proceed, /skip to bypass."
5. In parallel, the Guardrails Worker enqueues:
     scan.request_deep_scan({ session_id, scope: "policy", receipt_id: "rcpt_abc" })
6. ScanCoordinatorWorkflow runs (fork artifact, sandbox, coordinator+specialists).
7. On completion, Workflow:
     - Writes verdict to SessionFacet (keyed on receipt_id)
     - Broadcasts via WebSocket to any connected dashboard
     - Posts to Slack if configured
     - If decision is "approve": automatically completes the original ask
     - If decision is "deny": surfaces blocker reasoning to user
     - If decision is "needs human": opens GitHub PR check + Slack thread for explicit approval
8. Agent resumes with verdict.
```

The `receipt_id` is the durable thread between fast and slow. Every Logpush event in either tier carries it; tracing a decision end-to-end is one query.

### Break-glass escape (Pattern 11)

Per `harness-break-glass-primitive.md`:

- Commit message containing literal `break glass` token bypasses both Guardrails and Agent CI
- Telemetry event `break_glass_override` always logged with user, session, tool, reason
- Track rate; alert if >1% — signal that gates are too aggressive
- Cannot be silently disabled; always logged via Gateway → Logpush → SIEM

---

## 6. Cross-Cutting Concerns

### Authentication — Cloudflare Access Managed OAuth

Replaces the entire current OAuth stack. What goes away:

- `src/auth/google-handler.ts`, `github-handler.ts` (~600 LOC)
- `@cloudflare/workers-oauth-provider` dependency
- Routes: `/authorize`, `/register`, `/token`, `/auth/*/callback`
- DCR client storage in Registry DO
- `mcp_state` preservation logic (~150 LOC, source of multiple past bugs)
- The "Token audience does not match resource server" bug class
- The "DCR wiped on DO reset" bug class

What replaces it (~30 LOC):

```typescript
import { jwtVerify, createRemoteJWKSet } from "jose";

const JWKS = createRemoteJWKSet(new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`));

async function authenticateRequest(request: Request, env: Env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion") 
    ?? request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) throw new UnauthenticatedError();
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
  });
  return { email: payload.email as string, sub: payload.sub as string };
}
```

Per `oauth-hardening.md`: this design supersedes the entirety of that doc. Delete it after this ships.

The conceptual win: every JWT is user-delegated. `jwt.email` is authoritative. Every agent action attributable to a human, automatically. The audit primitive that was on the roadmap becomes a side effect of removing code.

### Per-session state — Facets + Artifact + Memory

Every CLI session gets three cloud objects, scoped `session-<id>`:

1. **Sub-Agent DO Facet** of the per-workspace `SessionSupervisor`. Static-class facet (Project Think pattern), not dynamic code. Isolated SQLite. Stores: every hook event, every Guardrails decision, every Agent CI scan result, attribution metadata. Zero-latency RPC from parent. Per `think-facet-per-chat-thread.md`.

2. **Artifact repo** forked from workspace baseline at SessionStart. Every file edit becomes one git commit (PostToolUse hook on Edit/Write commits via isomorphic-git in the Worker). Tier-4 mutation runs fork the Artifact again; ArtifactFS hydrates on demand for large repos.

3. **Agent Memory profile** scoped `workspace-<ws>`. At compaction: `profile.ingest(messages)` classifies into facts/events/instructions/tasks. `profile.recall(...)` replaces both `get_my_context` (compaction recovery) and our planned taint-trail tables. Five-channel hybrid retrieval (full-text + exact-key + raw-message + vector + HyDE) is better than anything we'd build.

Per `private-vs-shared-agent-state.md`: the boundary is private (Facet, agent-scoped Memory) vs shared (Workspace DO state, workspace-scoped Memory). All telemetry goes to private; aggregations and cross-agent state go to shared.

### Observability

| Layer | Mechanism |
|---|---|
| Per-tool-call decision | Logpush of `mcp_portal_logs` to R2 + customer SIEM |
| Inference cost / latency | AI Gateway logs (custom metadata: anon UUID, session_id, gate_class, receipt_id) |
| Workflow lifecycle | Cloudflare GraphQL Analytics on Workflow events |
| Sandbox runtime | DO-level metrics + Sandbox SDK lifecycle events |
| Artifact ops | Artifacts GraphQL Analytics (`artifactsEventsAdaptiveGroups`) |
| Live dashboard | WebSocket from `GuardrailsAgent` state via Agents SDK |

Per `mcp-proxy-worker-attribution.md`: anonymous UUID in `cf-aig-metadata` (D1 source of truth, KV hot cache); emails never appear in Gateway logs or provider logs.

### Privacy / data movement

| Tier | What leaves the machine | DLP applied |
|---|---|---|
| Free CLI (no cloud) | Nothing | N/A |
| CLI + Guardrails | Redacted diff summary + tool args; signature DB lookups (hashed) | Local pre-redaction + Gateway DLP |
| CLI + Agent CI | Forked Artifact (full repo state) + diff metadata | Customer-owned Artifact + Gateway DLP scan |
| Standalone Guardrails | Full tool args reach the server | Gateway DLP only |

ZDR (zero-data-retention) option for inference: route OpenAI/Anthropic traffic through their ZDR endpoints via `cf-aig-zdr: true`. Customer-friendly compliance pitch.

### Multi-tenant isolation

- DO Facets per session (isolated SQLite)
- Artifacts per scan (isolated git repo, isolated DO)
- Workers AI inference scoped via `cf-aig-metadata.userId` (anon UUID)
- Logpush per-customer destination (Enterprise tier)
- Mesh per-customer network (each customer's `cf1:network` is isolated)

---

## 7. Commercial Frame

### SKUs

| SKU | Audience | Pricing | Key value |
|---|---|---|---|
| Free CLI (`interlinked`) | Individual devs, OSS projects | Free | Taste enforcement, zero friction |
| **Guardrails** Hobby | Solo dev with cloud needs | $X/mo, 10K evals | Real-time gating |
| **Guardrails** Team | Small teams | $Y/mo, 100K evals + shared sig DB | + Cross-agent state, audit |
| **Guardrails** Enterprise | Regulated orgs | Custom | + ZDR + BYOK + custom routing |
| **Agent CI** Pay-as-you-go | Project teams | $/run + $/compute-min | CI-grade async checks |
| **Agent CI** Team | Eng teams running agents at scale | $Z/mo, 50 runs included | + Mutation, integration, SBOM |
| **Agent CI** Enterprise | Large orgs | Custom | + Reserved Sandbox + Mesh + Logpush-to-SIEM + custom DSL |

### Sales motion

- **Free → paid**: free CLI is the funnel. Adoption metric: installs, DAU. Conversion event: user enables `interlinked install-hooks --cloud=guardrails` (gates the cloud tier behind one explicit step).
- **Guardrails → Agent CI**: customers running Guardrails see escalation events accumulate; "you have 23 escalated calls this week — enable Agent CI to deep-scan automatically."
- **Agent CI → Enterprise**: customers hitting Workers/Sandbox limits, needing private backends (Mesh), or wanting custom policy DSLs.

### Standalone modes (matter for sales)

- **Guardrails standalone** (no CLI): ideal for customers running headless agents in their own infra. Sales pitch: "your agent connects to one URL; you get tool-dispatch-level policy enforcement with no install."
- **Agent CI standalone** (no CLI): ideal for customers who already have agents but want CI-grade checks. Sales pitch: "install our GitHub App; every agent PR gets deep-reviewed."
- **Both standalone**: small-team sales motion; can sell either alone.

The architectural separation is the commercial flexibility.

---

## 8. MVP — Phased Rollout

Each phase is independently shippable, measurable, and revenue-generating (where applicable).

### Phase 1: Free CLI complete (4–6 weeks)

- All deterministic local checks running
- `install-hooks` for Claude Code, Copilot CLI, Cursor
- `verify` with the JSONL output contract
- Daemon mode for warm-runtime hooks
- Source-available release on GitHub
- npm + Homebrew + binary distribution

**Measure:** install count, DAU, retention curve, telemetry-opt-in rate, GitHub stars.
**Ship to:** dev community, our own internal use.
**Decision gate:** if installs <5K in 8 weeks, revisit packaging/positioning before Phase 2.

### Phase 2: Guardrails beta — deterministic only (3–4 weeks)

- Stand up MCP Portal at `portal.interlinked.dev`
- Enable Cloudflare Access Managed OAuth (delete legacy auth code)
- Convert `AgentChatSQLite` DO to extend `McpAgent`
- Implement `evaluatePolicy` with Cedar + signature DB + DO reads (no classifier yet)
- CLI hook integration: `interlinked install-hooks --cloud=guardrails --token=...`
- Logpush + Gateway routing

**Measure:** p99 latency per tool class, decision distribution, false-positive rate, signature-DB freshness.
**Ship to:** 5–10 design-partner customers.
**Decision gate:** p99 latency must hit <800ms for Modify class to proceed.

### Phase 3: Guardrails + classifier (3–4 weeks)

- Add AI Gateway Dynamic Route `policy-router`
- Add `@cf/openai/gpt-oss-20b` specialist
- Coordinator+Specialists for side-effect-class only
- Per `classifier-prompt-caching-and-sanitization.md`: shared prompt prefix cache, boundary-tag stripping
- Per `classifier-remote-config-and-failback.md`: KV-based provider enable flags, in-family fallback chain

**Measure:** escalation rate, classifier latency, FP-rate-with-classifier, cache hit rate (target >80%).
**Ship to:** existing Guardrails customers + 5 more.
**Decision gate:** if classifier-driven FP rate is worse than deterministic-only, hold; iterate prompts.

### Phase 4: Agent CI beta — LLM review only (4–6 weeks)

- Build GitHub App + webhook receiver
- Implement `ScanCoordinatorWorkflow` with the `llm-deep-policy` step only
- Coordinator+Specialists pattern with `gpt-oss-120b` coordinator
- PR comment + status check reporting
- WebSocket dashboard for live updates

**Measure:** per-run cost, time-to-verdict, PR comment clickthrough, customer feedback on signal quality.
**Ship to:** 3–5 design-partner customers.
**Decision gate:** per-run cost must be <$0.50 average; customer-reported signal quality >7/10.

### Phase 5: Agent CI + Sandboxes (4–6 weeks)

- Add Sandbox spawning with `InterlinkedSandbox` class + Outbound Worker
- Phased lockdown for install/test boundary
- Add `mutation-run` step (Stryker)
- Add `test-suite` step (customer's own `npm test`)
- Add `sbom-license` step (cdxgen + OSV)

**Measure:** compute-minute consumption per run, sandbox failure modes, mutation report quality.
**Decision gate:** total per-run cost (compute + LLM) < $5 average; <2% sandbox failure rate.

### Phase 6: Escalation wiring (2 weeks)

- Fast-mode `escalate` decision auto-spawns slow-mode scan
- `receipt_id` flows through both tiers and Logpush
- Dashboard surfaces "scan in progress" inline with chat
- Auto-resume agent when verdict reached

**Measure:** end-to-end UX latency for escalated calls, user-reported confusion on the wait.

### Phase 7: Enterprise tier (8–12 weeks)

- Mesh integration for customer private backends
- Logpush-to-SIEM (S3, GCS, Splunk)
- Custom policy DSL authoring (per `config-as-code-tool-and-check-authoring.md`)
- SSO via Access (multi-IdP)
- Reserved Sandbox capacity SLA
- Dedicated support tier

**Measure:** enterprise pipeline, ACV per logo, expansion rate from Team tier.

---

## 9. Open Questions / Risks

| Question / Risk | Mitigation |
|---|---|
| Workers AI safeguard model availability — `gpt-oss-safeguard` specifically isn't confirmed in catalog (only `gpt-oss-20b`/`-120b`) | BYOK to Groq via AI Gateway as fallback; or use base `gpt-oss-20b` with safety-prompted system message |
| Workflows v2 50K concurrency cap — fleet scale | Distribute across multiple Workflow classes; request limit increase early |
| Cloudflare Mesh in beta — customer adoption | Ship Tier-4-without-Mesh first (customer-public-IP integrations); Mesh as Enterprise upsell |
| Artifacts in private beta — limited availability | Apply for early access; have R2-based fallback for diff storage during beta |
| GitHub App approval process — slow | Start Marketplace listing application early in Phase 4 |
| Pricing calibration — unclear right per-call/per-run cost | Run Phases 2 + 4 with explicit cost-tracking; iterate to break-even before public pricing |
| Daemon-mode hook complexity — bugs in IPC | Ship cold-start mode first; daemon as optional optimization |
| ZDR + BYOK combinatorics — every customer wants different config | Limit BYOK to Anthropic + OpenAI initially; add others on demand |
| Standalone-Guardrails coverage gap (no local-tool view) | Document explicitly; sell CLI+Guardrails as the recommended config |
| Free CLI cannibalizing paid product perception | Sharpen positioning: free CLI does *correctness*, paid does *security + scale*; never overlap value props |

---

## 10. Appendix: Full Check Matrix

Reference table of every check across all three products.

| Check | Free CLI | Guardrails | Agent CI | Why placed here |
|---|---|---|---|---|
| `tsgo` single-file check (target of Edit/Write) | **PreToolUse** (via daemon, 5–50ms) | — | — | Daemon-warm single-file check fits even Read-class budget |
| `tsgo` simulated-edit check | **PreToolUse** on `Edit` ops | — | — | Catches type regressions before they hit disk |
| `tsgo` on touched file + immediate dependents | PostToolUse (advisory; blocks next PreToolUse if new errors) | — | — | Dependent traversal too variable for blocking |
| `tsgo` full-project | `pre-push` / `verify` / CI | — | per scan | Multi-second; user-waited or async only |
| Biome / Prettier / ESLint (target file) | **PreToolUse** + verify | — | — | Fast, deterministic, fits even Read budget |
| Structure rules | PreToolUse + verify | — | — | AST/regex, local |
| `placeholder_test` etc. | PreToolUse + verify | — | — | Deterministic regex |
| Schema migration-order | PreToolUse + verify | — | — | Static analysis |
| Coverage ratchet | verify | — | full coverage report | Local diff; cloud full |
| Mini mutation gate | PreToolUse / verify | — | — | Single-file, fast |
| Bundle size budgets | verify | — | — | Local build output |
| Secret regex (cheap reject) | PreToolUse | — | — | Must reject before commit |
| Secret entropy + signature DB | — | sync | — | Authoritative; fresh DB |
| Cedar policy DSL | — | sync | — | Centrally tunable |
| Signature DB Vectorize lookup | — | sync | — | Stateless lookup |
| Single-package CVE freshness | — | sync | — | Pre-indexed |
| Taint trail / intent / reservation | — | sync DO read | — | Shared state |
| Small-model classifier | — | sync (modify+) | — | Fast LLM inference |
| Moderation pre-scan | — | sync (side-effect) | — | LLM inference |
| Coordinator + 7 specialists | — | — | per scan | Multi-call LLM, slow |
| Mutation testing (full) | — | — | per scan | Minutes |
| Integration tests | — | — | per scan | Minutes–hours |
| Deep prompt-injection scan | — | — | per scan | LLM over long context |
| SBOM + license + CVE graph | — | — | per scan | Repo-wide graph traversal |
| Compliance reporting | — | — | per scan / scheduled | Hours |
| Fleet anomaly detection | — | — | scheduled | Cross-session pattern mining |
| Audit log generation | — | — | per scan / scheduled | Aggregation |
| OTel trace assertions | — | — | per scan | Server-side traces only |
| License policy enforcement | — | sync (org policy) | per scan (full SBOM) | Both — sync for blocker, async for full audit |
| `npm audit` / dep CVEs | verify (cached DB) | sync (single-pkg fresh) | per scan (full graph) | Three-tier defense in depth |

---

## Architectural Principles (the things to never compromise)

1. **Free CLI works fully alone.** The Project Think "Tier 0 alone" principle. If the cloud doesn't exist, the CLI still catches the common cases.
2. **Each cloud product works without the CLI.** Standalone customers can't be second-class.
3. **Detection / decision split.** Sondera pattern in Guardrails. Decisions are auditable; detectors are swappable.
4. **Tool-class-specific latency budgets.** Never a single number; always per-class with worst-case stack-up math.
5. **Escalation is first-class.** `receipt_id` threads fast → slow.  
6. **Build on Cloudflare primitives.** Custom code limited to: hook binary, harness checks, policy prompts, domain glue. Everything else is platform.
7. **User-delegated auth, every action attributable.** Managed OAuth, no service accounts.
8. **Deterministic harness, LLM only at narrow escalation points.** Per `feedback_harness_deterministic_only.md`.
9. **Streamed JSONL, never blocking telemetry.** Pattern 7 + Pattern 14.
10. **Suppressions are escape valves, not solutions.** Every suppression has a `reason` + (`fix_pr` or `expires_at`).
