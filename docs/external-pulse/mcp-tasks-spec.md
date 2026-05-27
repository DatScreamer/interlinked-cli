# MCP Tasks (protocol 2025-11-25, experimental)

- **Source:** https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks · https://modelcontextprotocol.io/extensions/tasks/overview · https://github.com/modelcontextprotocol/experimental-ext-tasks
- **Encountered:** 2026-05-27, user raised it while asking how a "latest unreleased MCP spec" change interacts with our harness
- **Verdict:** RFC — two architectural gaps in our hook flow + lane-2 detector drops for the new attacker-controllable strings the spec introduces

## 1. Core idea (one sentence)

MCP servers can return a **task handle** instead of a tool result, deferring the actual side-effect to a background execution the client polls via `tasks/get` / `tasks/result` — turning every task-capable tool call into an async two-phase operation that our PreToolUse/PostToolUse synchronous-pair model doesn't represent.

## 2. Anatomy (load-bearing claims)

- **Task-augmented request shape.** Client adds `task: { ttl }` to `tools/call` params. Receiver returns `CreateTaskResult` with `{ taskId, status: "working", ttl, pollInterval, statusMessage }`. The actual tool result arrives later via `tasks/result`.
- **Lifecycle:** `working`, `input_required`, `completed`, `failed`, `cancelled`. Terminal = the last three. Transition `working ↔ input_required` is the elicitation channel — server pulls more input from client mid-task.
- **Tool-level negotiation.** `tools/list` carries `execution.taskSupport: "required" | "optional" | "forbidden"`. A `required` tool MUST be invoked as a task; the client cannot opt out.
- **`model-immediate-response` field.** Optional `_meta["io.modelcontextprotocol/model-immediate-response"]` in `CreateTaskResult` — server-supplied text the host passes back to the LLM as the "tool result" so the LLM moves on while the task runs in the background. **Server controls what the LLM sees as the immediate result** — first-class prompt-injection vector.
- **Cancellation is cooperative.** `tasks/cancel` is best-effort; the server MAY ignore it and still complete the side effect.
- **Durability across sessions.** Task IDs survive client crash/restart; pending tasks bridge session boundaries.
- **Server-as-requestor.** Either client or server can be the "requestor." Task-augmented `sampling/createMessage` lets the server drive long-running LLM work on the client side.
- **Security spec (spec § Security Considerations).** Receivers MUST bind tasks to auth context when available; without auth they MUST use cryptographically-secure task IDs and SHOULD NOT declare `tasks/list`. Receivers SHOULD enforce concurrent-task limits and rate-limit task ops to prevent enumeration.

## 3. Deterministic or agentic?

Deterministic spec (state machine + JSON-RPC shapes). Our consumption is also deterministic — no LLM in the harness's task-tracking path. Cleanly compatible with `feedback_harness_deterministic_only.md`.

## 4. Substrate vs. surface

N/A (spec, not a tool to adopt).

## 5. Lane (1–6)

**Lane 2 (new detectors) + lane 4 (architectural gap).**

Lane-2 detectors:
- Content-scan `_meta["io.modelcontextprotocol/model-immediate-response"]` for prompt-injection (attacker-controllable text injected directly into LLM context).
- Content-scan `statusMessage` on `tasks/get` / `notifications/tasks/status`.
- Content-scan elicitation prompts emitted during `input_required` (server-authored, user/agent-facing).
- Alarm on unscoped `tasks/list` traffic, especially across agent cohorts.

Lane-4 architectural gaps:
- **Async-tool hook model.** Our PreToolUse/PostToolUse pair assumes synchronous execution. Need a `OnTaskCreated` / `OnTaskStateChange` / `OnTaskResult` triplet (or equivalent) so quality checks fire on the actual side effect, not on `CreateTaskResult`.
- **Cross-session task tracking.** `session-state.ts` is per-session; need a durable task index keyed on `taskId` so a task created in session A can be reconciled with a result polled in session B.

## 6. Dependency & displacement

- **Deps:** None new. Hook-event handling lives in `src/harness/server/lifecycle-events.ts`; per-runner adapters in `src/harness/adapters/`.
- **Displacement:** Doesn't displace existing infrastructure but **invalidates one assumption**: `evaluator/post-tool.ts` quality checks today re-scan the file after a Write. For task-augmented Write-equivalent MCP tools, the file change happens out-of-band; our PostToolUse fires against the `CreateTaskResult`, not the post-side-effect state. Need to detect this case and either defer the quality check until `OnTaskResult` or mark the trajectory as "task-pending."

## 7. Smallest spike (≤1 day)

Detect a `CreateTaskResult` shape in any PostToolUse payload across the adapters (`claude-code` / `cursor` / `codex` / `copilot-cli`) and emit a single structured stderr warning: *"this tool call returned a task; PostToolUse checks reflect only the acceptance, not the side effect — file changes will be visible only after `tasks/result` returns."* Pure passive: shape detection, log, no behavior change. Validates that the adapter layer can recognize CreateTaskResult on the runners we currently support.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | CreateTaskResult shape detection; content-scan of `model-immediate-response`, `statusMessage`, elicitation prompts; durable task index keyed on `taskId`; `OnTaskStateChange` hook for `working → input_required` (injection vector) | §7 | now |
| Guardrails (P2–3) | Task-aware policy: a tool advertising `taskSupport: "required"` for an external-action verb gets stricter pre-eval since PostToolUse can't gate its side effect; capability-fingerprint drift detection on `tools/list` (a server quietly adding `tasks` support is a behavior change worth flagging) | rule engine reads tools/list capability snapshot | next |
| Agent CI (P4–5) | Cross-session task forensics: which tasks completed unsupervised after a session ended; which servers consistently return tasks for innocuous-looking calls; sampling-as-task auditing | none yet | parked |

## 9. Artifact

- RFC: `docs/design/mcp-task-aware-hooks.md` — `OnTaskCreated` / `OnTaskStateChange` / `OnTaskResult` hook surface, durable task index, content-scan additions on the three new attacker-controllable strings.
- PR for §7 spike (passive CreateTaskResult detection across all four adapters).
- Memory: `project_mcp_tasks_async_gap.md` linking this intake + the RFC.

## Notes

- **Task-augmented sampling (server-as-requestor) has zero precedent in our threat model.** The server asks the client's LLM to do work, asynchronously. The harness has no hook on `sampling/createMessage` today, and Claude Code does not expose sampling as a regular hook event. Parked.
- `tools/list` carries `execution.taskSupport`; we have no machinery to read or cache `tools/list` responses today. Adding a per-server `mcp_capability_index` snapshot at first-connect is the prerequisite for capability-aware policy AND enables drift detection.
- Per spec, `tasks/cancel` is cooperative — a harness-initiated cancel cannot promise the side effect didn't happen. Frame any cancel-based safety story accordingly; the real safety boundary remains PreToolUse acceptance.
- Cross-link: the plan-submission gate from `pb-and-j-least-autonomy.md` shares the "pre-evaluate the whole sequence" shape with task-augmented requests' deferred-execution model. They're orthogonal axes (plan-gate = local-author intent, task = remote-server execution shape) but use the same primitives — durable id, lifecycle state machine, terminal-result correlation.
- The spec's own security section emphasizes auth-context binding and concurrent-task limits — both are server-side requirements, but our harness can audit whether the local + remote MCP servers we connect to actually implement them (capability assertion test in `interlinked doctor`).
