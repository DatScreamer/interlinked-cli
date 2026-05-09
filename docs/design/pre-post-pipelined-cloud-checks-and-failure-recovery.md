# Pre+Post Pipelined Cloud Checks + PostToolUseFailure Recovery Channel

**Status:** Plan / not yet implementation. Designed local-first so Phase 1 ships without the cloud.

**Supersedes parts of:** `three-product-architecture.md` §3 (Guardrails latency budget assumptions). Tightens the timing contract from "Pre alone, sub-2s" to "Pre + Post = 60s, tool runtime incidental."

**References / integrates:**
- `three-product-architecture.md` — parent product vision (free CLI / Guardrails / Agent CI)
- `harness-firefox-bug-class-checks-plan.md` — Tier 3 dynamic checks land here when cloud arrives
- `harness-jsonl-output-contract.md` — output channel spec
- Existing local infrastructure: `src/harness/recurrence.ts`, `src/harness/session-state.ts`, `.interlinked/hooks/interlinked-activity.mjs`, `src/harness/checks/`

**Audience:** Engineering. Anyone implementing should also have read `three-product-architecture.md` §1 (latency framework) and `harness-firefox-bug-class-checks-plan.md` (the Firefox-bug-class checks that benefit most from the cloud upgrade).

---

## TL;DR

Two coupled designs, **shipped in this order**:

1. **Phase 1 — Local Failure-Recovery Channel** *(no cloud, no receipts)*. Six channels handling tool-call failures: recurrence-pattern lookup, triage, recovery suggestion, cross-session similar-failure lookup, auto-rollback feasibility, failure-cause explanation. Five of six are pure-local; the sixth (cross-session) requires cloud aggregation and lands later. Hooks into the **regular Post* event** for Claude/Codex/Gemini/Copilot and into Cursor's **dedicated `postToolUseFailure`** event (registered today at `src/lib/hook-installers.ts:144`); both delivery shapes converge in the harness handler. Failure detection uses the canonical `tool_outcome === "error"` from our wire-format vocabulary — *not* a provider-specific field. **No Claude PostToolUseFailure subscription** (Claude's installer deliberately omits it to avoid a duplicate-display UX bug); **Cursor's dedicated failure event remains supported**.

2. **Phase 2 — Receipt-Threaded Pre+Post Cloud Pipelining** *(requires cloud + receipts)*. PreToolUse spawns an async cloud check; PostToolUse picks up results **best-effort** within its window. If the check overruns, the receipt stays pending and is surfaced in a later turn or via `interlinked checks show <id>`. The cloud pipeline is **never load-bearing for tool latency** — Pre returns within its synchronous budget regardless.

**Phase 1 has two local stores**: `.interlinked/recurrences.jsonl` (Channel 1 aggregation, append-only) and `.interlinked/failures/<failure_id>.json` (per-failure record carrying Channels 2/3/5/6 outputs). **Phase 2 adds** `.interlinked/checks/<receipt_id>.json` (cloud-receipt records, which reference `failure_id` rather than duplicating its contents). Output emits through a per-provider channel matrix (model-visible `additionalContext` where supported, stderr fallback elsewhere, disk file always).

The headline change from the prior version of this doc: **failure recovery is independent of receipts and the cloud**, so Phase 1 ships without either. The 60s contract is now framed honestly as "best-effort by Post; pending receipt otherwise."

---

## 1. The Timing Contract: best-effort by Post, pending receipt for overruns

### What's actually true today (verified against running code)

- `HARNESS_PRE_TIMEOUT_MS = 5000` (`src/lib/hooks-template.ts:118`). Pre is **not** a 30s window; the synchronous client-side budget is **5s**.
- PostToolUse uses **mode-based budgets**: 30 / 50 / 60s (`src/harness/rules/modes.ts:55`).
- Provider hook timeout ceilings range from 30s (Copilot floor) to 600s (Claude Code default for command-type handlers).

The previous version of this section claimed "30s Pre + 30s Post = 60s contract." That's wrong on the Pre side and brittle on the Post side. Honest framing:

```
t=0      ──────► PreToolUse fires; cloud check spawns async (receipt_id minted)
t=0..PRE_BUDGET (5s today)
                 Pre runs synchronous deterministic gate; cloud check runs in parallel
t=PRE_BUDGET   Pre returns "allow"|"deny"|"ask" + receipt_id  (cloud may still be running)

                 [Tool executes — duration variable, not part of our budget]

t=Tool         PostToolUse fires; reads receipt_id from session state
t=Tool..Tool+POST_BUDGET (30/50/60s mode-based)
                 ┌─ if cloud check finished : merge findings, emit additionalContext, return
                 ├─ if still running        : emit "[interlinked] receipt rcpt_xyz pending —
                 │                            see interlinked checks show rcpt_xyz" + return
                 └─ if cloud check failed   : emit warning, return with local-only verdict

Cloud check effective budget: PRE_BUDGET + tool_runtime + POST_BUDGET
  - Floor (instant tools, e.g. Edit/Write):  ~5s + ~ms + ~30s = ~35s
  - Typical (small Bash):                    ~5s + ~1s + ~30s = ~36s
  - Bonus (long Bash / tests):               ~5s + many s + ~30s = unbounded headroom
```

### Why "best effort" instead of "guaranteed completion"

- Pre returning fast is the right behavior — blocking on cloud completion couples tool latency to whatever the cloud happens to be doing.
- For genuinely fast tools, Post is the *only* meaningful window. Promising 60s when tool_runtime ≈ 0 leaves ~35s.
- The pending-receipt path is **first-class**, not a fallback: many of the most useful checks (sandboxed integration tests, deep coordinator review) are inherently variable. Surfacing them in a later turn is the correct behavior, not a degraded one.

### Pending-receipt UX

When a cloud check overruns the Post window:

1. PostToolUse emits a one-line `additionalContext`: `[interlinked:cloud] receipt rcpt_abc pending — fetch with 'interlinked checks show rcpt_abc' or wait for next-turn auto-fetch.`
2. The next PostToolUse on the same session checks for newly-completed receipts (cheap O(1) lookup keyed by session_id) and surfaces them as part of *its* own additionalContext.
3. `interlinked checks show <receipt_id>` reads `.interlinked/checks/<receipt_id>.json` for human inspection.
4. `interlinked checks list` filters by status (pending / complete / failed).

The receipt is durable; the agent doesn't lose work even if the user closes the session before cloud completion.

### Provider hook timeout ceilings (cap, not target)

| Provider | Default | Default applies to Pre and Post? | Source |
|---|---|---|---|
| Claude Code | 600s (command-type) | yes (per-handler, not per-event) | Official docs |
| Codex CLI | 600s | yes | `codex-rs/hooks/src/engine/discovery.rs` |
| GitHub Copilot CLI | 30s | yes | Official schema |
| Gemini CLI | configurable (no published default) | yes | per-handler |
| Cursor | configurable | yes | per-handler |

These are **provider-imposed ceilings**, not the user-perceptible budget we design against. Per `three-product-architecture.md` §1, our perceptible budget is the tool-class envelope (300ms / 800ms / 2000ms) — we use the provider ceiling only as the safety stop on background work.

### Why a 60s budget specifically

What fits in 60s that doesn't fit at 2s:

- **Coordinator + 7 specialists** running to completion (typically 10-30s, fits with cushion)
- **Scoped mutation testing** on the changed function in a sandboxed Artifact fork (5-30s)
- **Sandboxed dry-run of the proposed diff** — apply patch to fork, run customer's `npm test` (5-60s)
- **Full SBOM + transitive CVE graph** via fresh OSV/Snyk feeds (1-10s)
- **Deep prompt-injection scan** over session history (1-10s)
- **Cross-session Vectorize retrieval** of similar past diffs + their verdicts (~1s)
- **Diff-the-diagnostics** type-error comparison before/after (3-10s)

What still doesn't fit and needs Agent CI's escalate-async tier:

- Full repo mutation testing (5-30 min)
- Full integration suites against staging (10 min - 2 hr)
- Compliance scans (1-6 hr)

---

## Part I: Pre+Post Pipelined Cloud Checks

### 1.1 The receipt_id wire format

The single durable identifier threading through Pre, cloud, Post, disk, and Logpush. Generated at PreToolUse, stamped on every artifact. UUID v7 (sortable by creation time; collision-resistant).

```typescript
// src/harness/types.ts (new export)
export interface ReceiptId {
  /** UUID v7. Format: rcpt_<32-hex>. */
  value: string;
}

export interface CheckReceipt {
  receipt_id: ReceiptId;
  /** When PreToolUse minted the receipt. */
  pre_started_at: string; // ISO8601
  /** What the agent proposed to do. Frozen at Pre. */
  pre_event: {
    session_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    diff_summary?: string;        // <= 4KB
    diff_full_path?: string;      // pointer into .interlinked/diffs/ if larger
  };
  /** Pre's synchronous decision. */
  pre_decision: {
    decision: "allow" | "ask" | "deny";
    reason?: string;
    deterministic_findings: Finding[];
  };
  /** Async cloud check status (mutated as cloud progresses). */
  cloud: {
    status: "pending" | "running" | "complete" | "failed" | "timeout";
    started_at: string;
    completed_at?: string;
    findings?: Finding[];
    workflow_instance_id?: string;
    error?: string;
  };
  /** Post's reconciliation against the actual diff that landed. */
  post?: {
    completed_at: string;
    actual_diff_matches_proposed: boolean;
    additional_findings?: Finding[];
    additional_context: string;   // what gets surfaced to the model
  };
}

export interface Finding {
  source: "pre-deterministic" | "pre-classifier" | "cloud-coordinator"
        | "cloud-specialist" | "cloud-mutation" | "cloud-sandbox"
        | "post-verification" | "failure-recovery";
  severity: "info" | "warning" | "error";
  category: string;
  message: string;
  file?: string;
  line?: number;
  fix_suggestion?: string;
}
```

### 1.2 Storage layout

Single canonical home; receipt_id is the filename:

```
.interlinked/
  checks/
    <receipt_id>.json         # CheckReceipt (full record)
    index.jsonl               # append-only log of {receipt_id, session_id, tool, status, ts}
  diffs/
    <receipt_id>.patch        # full diff if > 4KB (pre_event.diff_full_path)
  recurrences.jsonl           # existing — extends with kind: "tool_failure" rows
```

`.interlinked/checks/index.jsonl` is the fast lookup substrate for `interlinked checks list` / `interlinked checks show <id>`. Full receipts under `checks/` are read on demand.

### 1.3 Pre-side: kickoff + synchronous decision

Algorithm in pseudocode (target file: extend `src/harness/server.ts` PreToolUse handler):

```typescript
async function handlePreToolUse(event: HookEvent): Promise<HookDecision> {
  const receipt_id = mintReceiptId();
  const t0 = Date.now();

  // Phase 1 (parallel, ~200ms): all deterministic detectors
  const [cedar, sigDb, taint, intent, reservation] = await Promise.all([
    runCedarPolicy(event),
    sigDbLookup(event),
    taintTrailLookup(event),
    intentScopeCheck(event),
    reservationConflictCheck(event),
  ]);

  // Phase 2 (~400ms if invoked, 0ms otherwise): small classifier on signals
  let classifier: ClassifierResult | null = null;
  if (needsClassifier(event, [cedar, sigDb, taint, intent, reservation])) {
    classifier = await runClassifier({ ...signals, receipt_id });
  }

  // Decision-phase Cedar: merge signals → verdict
  const decision = decideFromSignals({ cedar, sigDb, taint, intent, reservation, classifier });

  // Persist initial receipt (cloud.status: "pending")
  const receipt: CheckReceipt = {
    receipt_id,
    pre_started_at: new Date(t0).toISOString(),
    pre_event: capturePreEvent(event),
    pre_decision: { decision: decision.verdict, reason: decision.reason, deterministic_findings: [...] },
    cloud: { status: "pending", started_at: new Date().toISOString() },
  };
  await writeReceipt(receipt);

  // Async kickoff: spawn cloud Workflow if any check warranted (non-blocking)
  if (shouldRunCloudCheck(event, decision)) {
    void spawnCloudWorkflow({ receipt_id, event, deterministic_findings: signals });
    //  ↑ void: explicitly fire-and-forget. Cloud runs after Pre returns.
  }

  // Decision returns immediately; cloud check continues independently.
  return {
    decision: decision.verdict,
    reason: decision.reason,
    receipt_id,            // stamped so Post can recover the thread
    additional_context: formatPreAdditionalContext(receipt),
  };
}
```

Key design points:

- **Pre doesn't wait for cloud.** The synchronous return happens within ~1-3s of t=0; cloud check continues for up to ~60s afterward.
- **Pre's decision is final unless cloud finds a blocker.** If cloud finds `severity: error` later, Post surfaces it for the agent's next turn — but the original tool call has already been allowed. This is a deliberate tradeoff: blocking on cloud completion would couple us to its latency. Side-effect-class calls that need cloud verification *before* allowing should escalate via the `decision: "ask"` path (defer to user / require confirmation).
- **`void spawnCloudWorkflow(...)`** uses an explicit `void` so it doesn't surface as a floating-promise warning — and triggers the cloud Workflow without awaiting it.

### 1.4 Cloud-side: Workflow + Artifact + Sandbox

The cloud check is a Cloudflare Workflow instance, parameterized by `receipt_id`. Per `three-product-architecture.md` §4:

```typescript
// Workers entrypoint receiving the Pre-side spawn call
export class CheckCoordinatorWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { receipt_id, pre_event } = event.payload;

    // Step 1: fork the workspace Artifact (deterministic per receipt)
    const fork = await step.do("fork-artifact", () =>
      env.ARTIFACTS.get(workspaceBaseline(pre_event.session_id))
        .fork(`check-${receipt_id}`, { defaultBranchOnly: true, readOnly: false }));

    // Step 2: apply proposed diff to fork — ONLY for diff-capable tools.
    // Bash, custom MCP tools, and partial provider payloads cannot
    // produce an applyable patch from tool_input alone. The diff-capable
    // set is bounded: Edit / Write / MultiEdit / NotebookEdit / apply_patch /
    // str_replace. For everything else, we either:
    //   (a) defer apply-diff until Post (use the actual landed bytes via
    //       reconciliation — no proposed-diff sandbox), OR
    //   (b) skip apply-diff entirely and run cloud checks against the
    //       baseline workspace (vectorize, sbom, coordinator-on-context).
    // The dispatcher picks the path from extractDiffFromToolInput's return:
    // `null` means "not diff-capable" — fall through to (a) or (b).
    const proposedDiff = extractDiffFromToolInput(pre_event);
    if (proposedDiff !== null) {
      await step.do("apply-diff", () => fork.applyPatch(proposedDiff));
    }

    // Step 3: parallel cloud checks. Mutation testing + sandbox dry-run
    // require an applied diff — gated on `proposedDiff !== null`. SBOM,
    // Vectorize, coordinator-on-context run regardless.
    const checks: Promise<Finding[]>[] = [
      step.do("sbom-cve",          () => buildSbomAndCheckCves(fork)),
      step.do("vectorize-similar", () => lookupSimilarPastDiffs(pre_event)),
      step.do("coordinator-on-context", () => runCoordinatorAndSpecialists(pre_event, fork)),
    ];
    if (proposedDiff !== null) {
      checks.push(
        step.do("scoped-mutation", () => runScopedMutationTesting(pre_event, fork)),
        step.do("sandbox-dry-run", () => runSandboxedDiff(pre_event, fork)),
      );
    }
    const findings = await Promise.all(checks);

    // Step 4: write findings back into the receipt (DO/SessionFacet keyed on receipt_id)
    await step.do("write-receipt", () =>
      writeFindings(receipt_id, mergeFindings(findings)));

    // Step 5: dispose fork
    await step.do("cleanup", () => fork.dispose());
  }
}
```

The Workflow's per-step retry/checkpointing means a mid-Workflow crash doesn't lose work. If the Workflow doesn't complete in 60s, Post times out and the receipt's `cloud.status` stays `running` — a later turn can poll for it via `interlinked checks show <id>` for after-the-fact reference.

### 1.5 Post-side: collection + reconciliation

```typescript
async function handlePostToolUse(event: HookEvent): Promise<HookDecision> {
  const receipt_id = recoverReceiptId(event);   // from session state, indexed by tool_use_id
  if (!receipt_id) {
    // No Pre-side receipt (e.g., session started mid-tool); fall back to local checks only.
    return runLocalPostChecks(event);
  }

  // Phase 1 (parallel): wait for cloud + run local post-only verification
  const cloudPromise = waitForCloudReceipt(receipt_id, { timeoutMs: 28_000 });
  const localPromise = runLocalPostChecks(event);  // tsc, biome, structural, etc.

  const [cloud, local] = await Promise.allSettled([cloudPromise, localPromise]);

  // Phase 2: reconcile proposed-vs-actual diff
  const proposed = readReceipt(receipt_id).pre_event.tool_input;
  const actual = capturePostEvent(event);
  const matches = diffsMatch(proposed, actual);

  // Phase 3: merge findings into receipt + emit
  const allFindings = mergeFindings([cloud, local], { reconciliation_drift: !matches });
  const additionalContext = formatPostAdditionalContext(allFindings, receipt_id);

  await updateReceipt(receipt_id, {
    post: {
      completed_at: new Date().toISOString(),
      actual_diff_matches_proposed: matches,
      additional_findings: allFindings,
      additional_context: additionalContext,
    },
  });

  return {
    decision: shouldBlockNextTurn(allFindings) ? "block" : "allow",
    additional_context: additionalContext,
  };
}
```

**Reconciliation step matters because:** the proposed diff (Pre-side `tool_input`) and the actual diff (Post-side bytes-on-disk) can drift. Examples:
- Hook-side input rewriting (Codex `updatedInput`)
- Tool execution that fails partially (only first few lines applied)
- Concurrent file modification by another process

If they drift significantly, cloud's findings on the proposed diff may not reflect the actual state. In that case, Post emits a warning like `[interlinked:reconciliation] cloud check ran on proposed diff (N findings); actual diff differs — re-run with 'interlinked checks rerun <receipt_id>' for verification on landed bytes.`

### 1.6 Output channels (model + disk + statusline)

Three audiences, three channels:

- **Model** — `additionalContext` injected into next-turn context. Concise summary, includes receipt_id pointer. Capped at ~2KB to avoid context bloat. Format:
  ```
  [interlinked:cloud] receipt rcpt_abc123: 2 warnings, 0 errors. Coordinator review found:
    - boolean_trap at src/foo.ts:42 — see .interlinked/checks/rcpt_abc123.json
    - missing test coverage for changed export `parseConfig`
  Run `interlinked checks show rcpt_abc123` for the full diff/audit trail.
  ```
- **Disk** — `.interlinked/checks/<receipt_id>.json` carries the full `CheckReceipt` (all findings, full diff, cloud reasoning, tool input/output). Replayable, inspectable, archivable.
- **Statusline** — one-liner: `✓ rcpt_abc123 (2 warn)` or `⚠ rcpt_abc123 (3 warn, 1 err)`. Multi-line outputs *never* go to the statusline; they go to disk and are referenced by id. Only format if `findings.length <= 1 && summary.length < 80`.

Per the existing memory `project_posttooluse_visibility.md`: the human user can't see `additionalContext` directly (Claude Code renders it as model-only system reminder). The disk file + `interlinked checks show` is the human's read path.

### 1.7 Failure modes

| Failure | Detection | Behavior |
|---|---|---|
| Cloud check times out at 60s | Post wait expires | Receipt stays `running`; Post emits "cloud check still running, see receipt later" + falls back to local-only verdict |
| Cloud Workflow crashes | Workflow error step | Receipt marked `failed` + error stored; Post returns local-only verdict + warning |
| Network error during Pre kickoff | spawn promise rejects | Receipt marked `failed`; PreToolUse returns local decision; no cloud findings |
| Receipt not found at Post (e.g. mid-session restart) | session-state lookup miss | Run local Post checks only; no reconciliation |
| Reconciliation drift detected | proposed-vs-actual hash mismatch | Cloud findings still surfaced + reconciliation warning |
| `additionalContext` exceeds size limit | format step | Truncate with "...see disk receipt for full details" suffix |

The system is **always fail-open on the cloud path**: cloud failures degrade to local-only behavior, never to a hard block. Per `feedback_safety_continuity.md`, fail-open > fail-closed for safety layers.

---

## Part II *(Phase 1)*: Local Failure-Recovery Channel

This is the **first thing we ship** — entirely local, no receipts, no cloud. The previous version of this doc had Pre+Post pipelining as Part I and failure recovery as Part II; that ordering was wrong. Failure recovery is independent and lower-risk.

### 2.0 Provider capability matrix (load-bearing)

The plan in earlier drafts assumed a uniform "PostToolUseFailure event with model-visible additionalContext." Verified against current code, that's not the universal contract:

| Provider | Dedicated `PostToolUseFailure` event? | Failure-detection in regular Post*? | `additionalContext` model-visible on failure path? | Hook installer registers failure event today? |
|---|---|---|---|---|
| Claude Code | Exists in API | Yes — `tool_response.is_error` | Yes (system reminder) | **No** — `CLAUDE_HOOK_EVENTS` in `src/lib/hook-installers.ts:31` deliberately omits it to avoid "2 PostToolUse hooks ran" duplicate-display UX |
| Codex CLI | No — folded into PostToolUse | Yes — `tool_response` field | Yes (Claude-shape) | n/a (no separate event to register) |
| GitHub Copilot CLI | No — separate `errorOccurred` event for non-tool errors; tool failures land on `postToolUse` with `toolResult.resultType: "failure"` | Yes — `toolResult.resultType` | **No — Copilot post output is stderr-only** per `src/lib/hook-template-chunks/provider-responses.ts:79` | n/a |
| Gemini CLI | No — folded into AfterTool | Yes — `tool_response.success: false` | Yes — `additional_context` on AfterTool | n/a |
| Cursor IDE | **Yes — `postToolUseFailure`** registered today (`src/lib/hook-installers.ts:144`, `src/harness/adapters/cursor.ts:67`) | Failures *can* also fold onto generic `postToolUse` if Cursor opts to | `additional_context` honored on generic `postToolUse` only (`POST_CONTEXT_EVENTS` in `adapters/cursor.ts:98`); the `postToolUseFailure` variant is **stderr-only** per `provider-responses.ts:101` | **Yes — registered** (in `CURSOR_HOOK_EVENTS`) |

**Implications that drive the design:**

1. **Failure detection is unified at the harness layer, regardless of which event the provider uses.** Two delivery shapes coexist:
   - **Folded-into-regular-Post*** (Claude Code / Codex / Gemini / Copilot) — failure is a `tool_outcome === "error"` (or provider-equivalent field) on the *regular* PostToolUse / AfterTool / postToolUse event. Claude Code's installer deliberately omits the dedicated `PostToolUseFailure` event to avoid the duplicate-display UX bug.
   - **Dedicated failure event** (Cursor's `postToolUseFailure`, registered today). The harness handler dispatches on either entry point; downstream channels see one normalized envelope.
   The adapter layer normalizes both into the same internal shape so Channels 1-6 see one wire.

2. **`additionalContext` is not universal.** Copilot post output is **stderr-only**; Cursor's `postToolUseFailure` variant is also stderr-only (only the generic `postToolUse` carries `additional_context`). The Phase 1 disk artifact (`.interlinked/failures/<failure_id>.json`) is the **universal** channel; in-context summary is best-effort per-provider.

3. **Failure payload normalization is required.** Each provider exposes the failure differently — `tool_response.is_error` (Claude/Codex), `toolResult.resultType` (Copilot/Cursor), `tool_response.success` (Gemini). The canonical internal field is `tool_outcome ∈ {"success" | "error" | "interrupted"}` (matching the existing wire-format vocabulary at `src/lib/hook-template-chunks/event-normalizers.ts:218`); adapters extract `{ tool_outcome, error_message, exit_code?, stderr?, stdout?, tool_response_sha256 }` from the provider-specific shape. Without this, downstream channels (especially triage classification) are blind to the actual error.

### 2.1 Current state (verified against codebase)

What we do today (`interlinked-activity.mjs:2602-2606`, `session-state.ts:122`, `hook-installers.ts:31`):

- We do **not** register PostToolUseFailure for Claude Code (intentional — see capability matrix).
- The hook script handles `hook_event === "PostToolUseFailure"` if Claude Code somehow sends it (defensive fallback) but we don't subscribe.
- For mutation-tool failures (Edit/Write/MultiEdit), we run the same quality pipeline as PostToolUse on the targeted file.
- `session-state.ts:122` tracks `error_count` and `consecutive_tool_failures` per tool.

What's missing, regardless of provider:

- **Triage**: classify the failure (agent-error / environmental / transient / unrecoverable)
- **Pattern recognition**: lookup similar past failures via the existing `recurrence.ts` substrate
- **Recovery suggestion**: "this looks like the X failure class; the canonical fix is Y"
- **Cross-session lookup**: another agent hit this exact failure — here's what worked
- **Auto-rollback feasibility check**: "the working tree is in a recoverable shape and Interlinked caused the change; here's a one-call rollback"
- **Failure-cause explanation**: human-readable explanation tied to diff + error message

**Phase 1 deliverable: five local channels + one deferred cloud channel.** Channels 1, 2-local, 3-local, 5, and 6-local ship in Phase 1; Channel 4 (cross-session lookup) requires cloud aggregation and is deferred to Phase 3 (see §2.3 for the channel-vs-phase matrix). All five local channels run on the **regular Post* event** for Claude/Codex/Gemini/Copilot and on **Cursor's dedicated `postToolUseFailure`** event; both paths converge in the harness handler with the canonical `tool_outcome === "error"` gate. **No Claude PostToolUseFailure subscription** (intentional — Claude's installer omits it); **Cursor's dedicated failure event remains supported and registered**. No receipts, no cloud.

### 2.2 The six channels in detail

#### Channel 1 — Failure-pattern recurrence lookup (local-first; ships immediately)

**What it does:** Every tool failure is recorded as a `recurrence` row with `kind: "tool_failure"`. The detail view (`interlinked recurrence detail <signature>`) shows all sessions in which this exact shape failed. Aggregation surfaces "this failure class has happened N times across M sessions in the last 7 days."

**Implementation:**

- Extend `src/harness/recurrence.ts`:
  - Add `kind: "tool_failure"` to the union in the `Recurrence` type
  - Add `recordToolFailure(event: ToolFailureEvent)` wrapper (mirrors existing `recordHarnessCaught`)
  - Signature: `<tool_name>:<error-class>:<error-code-or-first-30-chars-of-error-message>`
- Wire from **`src/harness/server.ts`'s PostToolUse / postToolUseFailure handler** — when the normalized event arrives with `tool_outcome === "error"`, the harness calls `recurrence.recordToolFailure(...)` *before* dispatching to Channels 2/3/5/6 so they can read the recurrence count.
  - **Why server-side, not .mjs-side:** the hook script (`.interlinked/hooks/interlinked-activity.mjs`) is generated as self-contained per the `Hook script is self-contained` convention in CLAUDE.md (no imports from `src/harness/`). Recording must live behind the socket. The .mjs only ships the wire payload over the socket; the harness writes to `.interlinked/recurrences.jsonl`.
- Surface in `interlinked recurrence list --kind tool_failure`

**Output:**

```
$ interlinked recurrence list --kind tool_failure
Edit:TS2307:Cannot find module    13 events    7 sessions    last 2h
Edit:TS2345:Argument of type      8 events     5 sessions    last 1d
Bash:exit-code-1:npm install      4 events     3 sessions    last 12h
```

When this signature fires again, the agent sees `[interlinked:recurrence] this failure has occurred 13 times across 7 sessions; same shape. See 'interlinked recurrence detail Edit:TS2307'`.

**Why local-first works:** Recurrence is just append + group-by over JSONL. No cloud needed.

**Effort:** ~1 day (extending an existing pattern).

---

#### Channel 2 — Triage classification

**What it does:** Classifies a failure as `agent-error | environmental | transient | unrecoverable`. Drives downstream behavior (e.g., suggest retry for transient, suggest specific fix for agent-error).

**Local tier (heuristic table; ships immediately):**

A registry of known error families maps to triage labels. Examples:

```typescript
// src/harness/checks/failure-triage.ts (new)
const TRIAGE_RULES: TriageRule[] = [
  { match: /\bTS2307\b: Cannot find module/, classify: "agent-error", category: "missing-import" },
  { match: /\bTS2345\b: Argument of type/, classify: "agent-error", category: "type-mismatch" },
  { match: /^E(NOENT|ACCES)/, classify: "environmental", category: "filesystem" },
  { match: /\bECONNREFUSED|ETIMEDOUT|EAI_AGAIN\b/, classify: "transient", category: "network" },
  { match: /\bnpm\s+ERR!\s+code E429\b/, classify: "transient", category: "rate-limit" },
  { match: /\bsegmentation fault|SIGSEGV\b/, classify: "unrecoverable", category: "process-crash" },
  // ... extensible registry, expected to grow
];
```

Pattern: regex match → label. ~30-50 entries cover the common cases (TS errors, npm errors, git errors, lint errors). Unknown shapes → `unknown` (default).

**Cloud tier (LLM classifier; lands when cloud is ready):**

For unknown shapes, send `{ tool_name, error_message, diff_summary }` to the same coordinator+specialist infrastructure used in Pre+Post pipelining. Specialist returns triage label + confidence score. Cache result keyed on signature so subsequent occurrences hit the cache.

**Output:** Adds `triage` to the **Phase 1 failure record** (no receipts yet — see §2.6 for the storage layout):

```json
{
  "failure_id": "fail_abc",
  "signature": "Edit:TS2307:Cannot find module './missing'",
  "triage": {
    "label": "agent-error",
    "category": "missing-import",
    "confidence": 0.95,
    "source": "local-heuristic"
  }
}
```

Phase 2 receipts (when they land) will reference this artifact via `receipt.post.failure_id` rather than duplicating the contents.

Surfaces to the agent: `[interlinked:triage] agent-error / missing-import (confidence 0.95)`. Channel 3 then offers a fix.

**Effort:** ~2 days for local heuristic tier with ~30 entries; extensible.

---

#### Channel 3 — Recovery suggestion

**What it does:** For known triage classifications, generate an actionable fix suggestion. The agent reads it in `additionalContext` and uses it to plan the next tool call.

**Local tier (canonical-fix table; ships immediately):**

Same registry as triage, extended with fix templates:

```typescript
const RECOVERY_SUGGESTIONS: Record<string, RecoverySuggestion> = {
  "agent-error/missing-import": {
    template: (ctx) =>
      `Add the missing import: \`import { ${ctx.symbol} } from "${ctx.module}";\`. ` +
      `Or check if the package is installed: \`npm ls ${ctx.module}\`.`,
    extract: (errorMessage) => /Cannot find module '(.+)' or its corresponding type declarations/.exec(errorMessage),
  },
  "agent-error/type-mismatch": {
    template: (ctx) =>
      `The argument type doesn't match the parameter type. ` +
      `Check the function signature at the call site. ` +
      `If the type is correct but the inference is wrong, add an explicit type assertion: \`fn(value as ExpectedType)\`.`,
    extract: () => null,
  },
  "transient/network": {
    template: () => `The network call failed transiently. Retry the same tool call; if it fails 3 times, escalate.`,
  },
  "transient/rate-limit": {
    template: () => `The provider rate-limited the request. Wait 30s and retry, or use a different provider.`,
  },
  // ...
};
```

**Cloud tier (LLM-generated unified diff; lands when cloud is ready):**

For unknown shapes — or for shapes where the local template is too generic — invoke the coordinator with `{ diff, error_message, surrounding_code }`. Coordinator returns a candidate fix as a unified diff. Pre-check: dry-run against a sandboxed Artifact fork before surfacing — if the fix doesn't compile, don't suggest it.

**Output:**

```
[interlinked:recovery] suggested fix for missing-import:
  Add: `import { Foo } from "./bar";`
  Or:  npm ls bar

For full context, see .interlinked/failures/fail_xyz.json (Phase 1 storage; Phase 2 receipts reference fail_xyz.json by id).
```

**Effort:** ~1-2 days for ~30 canonical-fix templates; extensible.

---

#### Channel 4 — Cross-session similar-failure lookup (cloud-only)

**What it does:** Given a failure signature, retrieve similar past failures from *other* sessions and return their resolutions. A different agent solved this exact problem yesterday — show me how.

**Implementation:**

- Local recurrence log (`.interlinked/recurrences.jsonl`) is per-session.
- Cloud aggregates recurrence logs across customer sessions (workspace-scoped — never cross-customer) into a Vectorize index keyed on signature embedding.
- At PostToolUseFailure, query Vectorize for top-K similar signatures, fetch their `recovery_suggestion` and `resolution_outcome` (did the agent recover successfully?).

**Output:**

```
[interlinked:cross-session] this failure pattern matched 3 previous failures in workspace:
  - 2026-05-02 (rcpt_def): resolved with `npm install missing-pkg` (success)
  - 2026-05-01 (rcpt_ghi): resolved with `import path fix` (success)
  - 2026-04-28 (rcpt_jkl): unresolved (agent gave up after 4 retries)
```

**Privacy:** Per `private-vs-shared-agent-state.md`, the boundary is workspace-scoped. Cross-workspace aggregation requires explicit opt-in for the Team/Enterprise tiers (it's a sales differentiator).

**Effort:** Cloud-dependent; ships with Phase 3+.

---

#### Channel 5 — Auto-rollback feasibility check (local-only)

**What it does:** When a tool failure leaves the working tree in a partial/inconsistent state, surface a one-call rollback option. Don't *do* the rollback — just tell the agent it's safe.

**Safety requirements (load-bearing):**

1. **No shell-string interpolation.** Use `execFileSync` with argv form, never `exec(string)`. Filenames cannot become shell metacharacters.
2. **`--` to terminate option parsing.** A filename like `--all` would otherwise reconfigure git's behavior silently.
3. **`--porcelain -z` for machine-parseable output.** Null-delimited entries; whitespace and unusual filenames don't break parsing.
4. **Provenance gate.** Only suggest rollback when we have evidence that *we* caused the change — otherwise we'd offer to wipe the user's own in-progress work. Tied to receipt presence (Phase 2) or to an in-session edit log (Phase 1 fallback: `session-state.ts` already tracks `files_written`).
5. **Returned command is argv, not a shell string.** Caller stringifies for display only; we never `eval` it.

**Implementation:**

```typescript
// src/harness/checks/rollback-feasibility.ts (new)
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

export interface RollbackAssessment {
  safe: boolean;
  /** argv-style; caller may stringify for display, never executes via shell. */
  command?: readonly string[];
  reason: string;
  /** True only if we have positive evidence Interlinked caused this change. */
  caused_by_us: boolean;
}

export function assessRollbackFeasibility(
  filePath: string,
  cwd: string,
  provenanceCheck: (path: string) => boolean,
): RollbackAssessment {
  const causedByUs = provenanceCheck(filePath);

  let porcelain: string;
  try {
    porcelain = execFileSync(
      "git",
      ["status", "--porcelain", "-z", "--", filePath],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return { safe: false, reason: "git status failed", caused_by_us: causedByUs };
  }

  // Null-delimited entries; first 2 chars are the status, then a space,
  // then the path. Empty output = file is clean (or untracked-and-stable).
  const entries = porcelain.split("\0").filter((e) => e.length > 0);
  if (entries.length === 0) {
    return { safe: false, reason: "no working-tree change to roll back", caused_by_us: causedByUs };
  }

  const statusBytes = entries[0].slice(0, 2);
  const isUntracked = statusBytes === "??";
  const isAddedToIndex = statusBytes[0] === "A";
  const isModifiedToIndex = statusBytes[0] === "M";
  const isModifiedInWorkingTree = statusBytes[1] === "M";

  // Untracked file we created: safe to remove.
  // We use `rm -- <path>` (still as argv to fs caller) ONLY when provenance
  // confirms — otherwise this could wipe the user's own scratchpad.
  if (isUntracked && causedByUs) {
    return {
      safe: true,
      command: ["rm", "--", filePath],
      reason: "untracked file created by Interlinked; safe to remove",
      caused_by_us: true,
    };
  }
  // Tracked file with unstaged modification only: `git checkout -- <path>`
  // reverts working-tree changes. Safe IF we caused them.
  if (
    !isAddedToIndex && !isModifiedToIndex &&
    isModifiedInWorkingTree && causedByUs
  ) {
    return {
      safe: true,
      command: ["git", "checkout", "--", filePath],
      reason: "tracked file with unstaged change caused by Interlinked",
      caused_by_us: true,
    };
  }
  // Mixed staged + unstaged, or no provenance evidence — refuse.
  return {
    safe: false,
    reason: causedByUs
      ? "complex git state (staged + unstaged); manual review needed"
      : "no provenance evidence Interlinked caused this change; refusing to recommend rollback",
    caused_by_us: causedByUs,
  };
}
```

**Provenance source in Phase 1** (no receipts yet) — *requires two upstream fixes first*, because the current `files_written` field can't answer the provenance question correctly:

1. **Path normalization** (`src/harness/session-state.ts:141`). Today the field stores raw `tool_input.file_path` strings (relative, possibly `~`-prefixed, possibly absolute — whatever the runner sent). A `resolvePath(p)`-based lookup misses for legitimate edits when the stored form differs. Fix: normalize on store via `resolve(event.cwd, filePath)` so all entries are absolute, then use the same normalization on lookup.
2. **Outcome-aware tracking** (`src/harness/session-state.ts:140`). Today `files_written.add(...)` runs on every write-class tool call regardless of whether the tool succeeded — so a *failed* Edit attempt gets attributed to us. Fix: gate on `event.tool_outcome === "success"` (available once Patch 4's wire-format extension lands).

After both fixes, `provenanceCheck` is called with the failure event in scope: `(p) => sessionState.files_written.has(resolve(event.cwd ?? process.cwd(), p))`. The cwd comes from the `HarnessEvent` (`types.ts:91` — `cwd?: string`); `SessionTrajectory` itself does **not** carry a `cwd` field, and we mirror the existing `normalizedWrittenSet(session, cwd)` helper at `src/harness/evaluator/tdd-new-file-gate.ts:249` which takes `cwd` as a parameter for exactly this reason. **Phase 2** (receipts available): pass a check that walks the receipt log for any successfully-applied edit at this absolute path. Receipts already record the resolved file path on the `tool_use_id → file_path` mapping at receipt-mint time.

**Surfaced output (only when `safe === true`):**

```
[interlinked:rollback] this file's change was made by Interlinked and is rollback-safe.
To revert: `git checkout -- src/foo.ts`
(receipt rcpt_xyz — see .interlinked/checks/rcpt_xyz.json)
```

**Why local-only:** No cloud needed. `git status` is local. Auto-rollback decisions are inherently local-state-dependent.

**Effort:** ~1 day.

---

#### Channel 6 — Failure-cause explanation

**What it does:** Generate a human-readable explanation of what went wrong, tied to the specific diff + error message.

**Local tier (template-substitution; ships immediately):**

For known failure families, substitute the error context into a pre-written explanation template:

```typescript
const EXPLANATION_TEMPLATES: Record<string, ExplanationTemplate> = {
  "agent-error/missing-import": {
    template: (ctx) =>
      `The module '${ctx.module}' couldn't be resolved. This usually means: ` +
      `(1) the package isn't installed (\`npm ls ${ctx.module}\`), ` +
      `(2) the import path is wrong (typo, case-sensitive on Linux), ` +
      `(3) the package's "exports" map doesn't include this subpath, or ` +
      `(4) tsconfig "paths" / "moduleResolution" needs updating.`,
  },
  // ...
};
```

**Cloud tier (LLM-generated explanation; lands when cloud is ready):**

For unknown shapes, send context to a small classifier specialist that generates a 1-3 sentence explanation. Cache by signature.

**Effort:** ~1 day for ~30 templates.

---

### 2.3 Channel summary table

| # | Channel | Local Phase 1 | Cloud upgrade |
|---|---|---|---|
| 1 | Recurrence lookup | ✅ extend `recurrence.ts` | Vectorize for cross-session (Channel 4) |
| 2 | Triage classification | ✅ ~30 regex rules | LLM classifier for unknowns |
| 3 | Recovery suggestion | ✅ ~30 fix templates | LLM-generated unified diff + sandbox dry-run |
| 4 | Cross-session lookup | ❌ requires cross-session aggregation | ✅ Vectorize-backed |
| 5 | Auto-rollback feasibility | ✅ local git inspection | n/a (local-only by nature) |
| 6 | Failure-cause explanation | ✅ ~30 explanation templates | LLM-generated for unknowns |

Phase 1 (no cloud): Channels 1, 2-local, 3-local, 5, 6-local. Five of six channels with no cloud dependency.

### 2.4 Wiring into the existing system

| File | Change |
|---|---|
| `src/harness/recurrence.ts:10-13` | Add `"tool_failure"` to `RecurrenceKind` union |
| `src/harness/recurrence.ts:90-110` | Extend `signatureFor()` to handle `kind: "tool_failure"`: signature = `tool_failure:<tool>:<error_class>:<first-30-chars-of-message>` |
| `src/harness/recurrence.ts` | Add `recordToolFailure(event: ToolFailureEvent)` wrapper, mirroring existing `recordHarnessCaught` |
| `src/commands/recurrence.ts:52` | Update CLI `--kind` filter: extend allowed values to include `tool_failure` |
| `src/index.ts:134` | Update `recurrence list --kind` choices in commander definition |
| `src/lib/hooks-template.ts:515-531` | **Add the missing Gemini detector to `CLIENT_HANDLERS` (load-bearing — without this, Gemini AfterTool events fall through to the Claude catch-all at line 530 and the Gemini-specific normalizer below is dead code).** Insert before the Claude catch-all: `{ name: "gemini", detect: (input, src) => src === "stdin" && (RUNNER_ENV === "gemini" \|\| !!input.gemini_session_id \|\| (typeof input.hook_event_name === "string" && /^(Before\|After)(Tool\|Model\|Agent)$/.test(input.hook_event_name))), normalize: normalizeGeminiEvent }`. Set `INTERLINKED_CLIENT="gemini"` in the Gemini install path (`src/lib/hook-installers.ts` Gemini installer). |
| `src/lib/hook-template-chunks/event-normalizers.ts` | **Per-provider failure-detection fix (load-bearing prerequisite for everything else).** The current `deriveToolOutcome()` only flips `tool_outcome` to `"error"` from `status === "error"` or Bash exit codes, and **never populates a canonical `error_message` field**. The per-provider normalizers above it leave provider failure fields **un-inspected** — so most failures land in `.mjs` flagged `tool_outcome: "success"` and silently miss every Phase 1 channel. Each provider's `PostToolUse` / `AfterTool` / `postToolUse(Failure)` normalizer must read its native failure indicator and feed it through `attachOutcome`: <br/>**Claude PostToolUse** (`event-normalizers.ts:392-413`): replace hardcoded `status: "success"` with `status: input.tool_response?.is_error ? "error" : "success"`. <br/>**Codex** delegates to Claude — fix inherits. <br/>**Copilot postToolUse** (`event-normalizers.ts:682-701`): extend `status` ternary to include `input.toolResult?.resultType === "failure"`. <br/>**Gemini AfterTool** (`event-normalizers.ts:586-607`): extend `status` ternary to include `input.tool_response?.success === false`. <br/>**Cursor `postToolUseFailure`** (`event-normalizers.ts:949-972`): add `attachOutcome(result, toolName, toolResponseRaw, errorDetail)` after the result literal — currently `status: "error"` is set but `tool_outcome` never is. <br/>**Add canonical `error_message` to `deriveToolOutcome`**: when `tool_outcome === "error"`, populate `result.error_message` from the most-specific provider field (Claude `tool_response.message`, Cursor `error_message`, Copilot `toolResult.error`/`error`, Gemini `tool_response.error`), falling back to the truncated `stderr` capture. |
| `src/lib/hooks-template.ts:878-889` | **Wire-format extension (depends on the fix above).** The harness event payload sent over the socket today carries only `{hook_event, session_id, agent_*, tool_name, tool_input, tool_use_id, cwd, model, timestamp}` — **no `tool_response`, no error fields**. Extend it with the canonical post-event fields produced by the now-correct `deriveToolOutcome()`: `tool_outcome`, **`error_message`** (canonical diagnostic text, populated from the most-specific provider field; required for triage/recovery/explanation classification), `exit_code`, `stderr` (truncated), `stdout` (truncated), `tool_response_sha256`. Without the prior fix, this just forwards stale "success" values; without `error_message`, Channels 2/3/6 see `tool_outcome: "error"` but have no stable text to classify. |
| `src/harness/types.ts` | Extend `HarnessEvent` / `HookEvent` types to carry the new wire-format fields. **`tool_outcome ∈ {"success" \| "error" \| "interrupted"}` is the canonical failure-detection field** — `is_error` does not exist on our wire format and would be redundant with the existing vocabulary. Also add `ToolFailureEvent`, `TriageRule`, `RecoverySuggestion`, `RollbackAssessment`, `ExplanationTemplate`. |
| `src/harness/adapters/<runner>.ts` | Each adapter's `parseHookInput` reads the now-populated wire fields from `HarnessEvent` (`tool_outcome`, `error_message`, `exit_code`, `stderr`, `stdout`) and copies them onto the unified event. **Adapters do not re-extract from raw `tool_response`** — that work is done in `event-normalizers.ts`, the source of truth for the .mjs path. For Cursor, both `postToolUse` and `postToolUseFailure` map to the same internal entry. |
| `src/lib/hook-template-chunks/event-normalizers.test.ts` | NEW — ≥1 positive case per provider failure shape: Claude `tool_response.is_error: true`, Copilot `toolResult.resultType: "failure"`, Gemini `tool_response.success: false`, Cursor `postToolUseFailure` payload. All must produce `tool_outcome: "error"`. |
| `src/harness/checks/failure-triage.ts` | NEW — TRIAGE_RULES registry + `classifyFailure()` |
| `src/harness/checks/recovery-suggestion.ts` | NEW — RECOVERY_SUGGESTIONS registry + `suggestRecovery()` |
| `src/harness/checks/rollback-feasibility.ts` | NEW — `assessRollbackFeasibility()` (uses `execFileSync`, argv-style, provenance-gated) |
| `src/harness/checks/failure-explanation.ts` | NEW — EXPLANATION_TEMPLATES + `explainFailure()` |
| `src/harness/server.ts` | Handler dispatches on PostToolUse (every provider) **and** Cursor's `postToolUseFailure` to the same internal entry: when `tool_outcome === "error"`, invoke `recurrence.recordToolFailure(...)` first (Channel 1), then run Channels 2/3/5/6 in parallel. Returns a `HarnessDecision` over the socket. **Channel output must be surfaced via the existing `warnings[]` array** (the .mjs only consumes `postResult.warnings` and `postResult.summary` — see `src/lib/hooks-template.ts:909-958`). The merged failure-recovery text becomes one `warnings[]` entry per channel; the .mjs's existing aggregation joins them with `\n\n` into the `summary`. |
| `src/lib/hooks-template.ts:909-958` | **Output contract clarification (no .mjs change required for Phase 1).** The .mjs reads `postResult.warnings` (joined into `issueList`) and feeds it through `formatProviderResponse(responseType, { reason, summary })` — both the `reason` and `summary` already flow into the per-provider envelope. So Phase 1 channel output piggybacks on the existing path. **A future Phase 2+ refinement** can add a richer `postResult.additional_context` field (separate from `warnings[]`) and extend the .mjs to surface it via `formatProviderResponse`'s context channel where the provider supports it (Claude `additionalContext`, Cursor generic `postToolUse` `additional_context`, Gemini AfterTool `additional_context`); but Phase 1 doesn't need that change. |
| `src/lib/hook-template-chunks/provider-responses.ts` | No change for Phase 1 — `formatProviderResponse(...)` already maps `{ reason, summary }` to each runner's stdout/stderr envelope. |
| `.interlinked/hooks/interlinked-activity.mjs` | Loosen the mutation-tool gate (`hooks-template.ts:861-874`) so non-mutation tool failures still reach the harness for triage + recurrence (today, non-mutation Post events fast-path-exit before the harness sees them). Failure detection uses the canonical `tool_outcome === "error"` produced by the (now-correct) `deriveToolOutcome()`. **No new Claude PostToolUseFailure subscription** (Claude's installer keeps omitting it); **Cursor's existing `postToolUseFailure` subscription stays in place** and routes through the same internal handler. |
| `src/harness/__tests__/failure-triage.test.ts` | NEW — ≥3 positive + ≥3 negative cases per channel |
| `src/harness/__tests__/rollback-feasibility.test.ts` | NEW — covers untracked/tracked/staged combinations + adversarial filenames (e.g. `--all`, files with spaces/newlines) to confirm argv path is shell-injection-safe |
| `src/harness/session-state.ts:140-145` | **Outcome-aware tracking + path normalization (load-bearing for Channel 5).** Today `files_written` stores raw `event.tool_input.file_path` strings unconditionally. Change: (a) gate the `add(...)` on `event.tool_outcome === "success"`; (b) store `resolve(event.cwd, filePath)` so all entries are absolute. Both required for the provenance check to be correct. |
| `src/harness/session-state.ts:121-130` | **Outcome-aware error counters (load-bearing).** Today `error_count++` is gated on `event.hook_event === "PostToolUseFailure"`, and `consecutive_tool_failures` is *cleared* on every `PostToolUse` (treating folded failures as success). With Phase 1's design — folded failures arrive as regular `PostToolUse` carrying `tool_outcome === "error"` — the existing logic is **inverted**: failures don't increment `error_count`, and consecutive-failure counters get cleared by the very events that should bump them. Replace event-name gates with outcome gates: `if (event.tool_outcome === "error") { error_count++; consecutive_tool_failures.set(...); } else if (event.tool_outcome === "success") { consecutive_tool_failures.delete(...); }`. The Cursor `postToolUseFailure` path keeps working because that adapter now also produces `tool_outcome === "error"` (per the 1a-fix step). |
| `src/harness/__tests__/session-state-outcome.test.ts` | NEW — confirms `error_count` increments and `consecutive_tool_failures` accumulates on a folded `PostToolUse` carrying `tool_outcome: "error"`, and resets on `tool_outcome: "success"`. |
| `src/harness/__tests__/session-state-provenance.test.ts` | NEW — confirms `files_written` rejects failed Edit attempts and stores absolute paths regardless of input form (relative / `~`-prefixed / already-absolute). |

### 2.6 Phase 1 storage layout (no receipts yet)

```
.interlinked/
  failures/
    <failure_id>.json          # FailureRecord — Channels 2/3/5/6 outputs (signature, triage, recovery, rollback, explanation)
    index.jsonl                # append-only: {failure_id, session_id, signature, ts}
  recurrences.jsonl            # extended with kind: "tool_failure" rows (Channel 1) — existing substrate
```

`failure_id` is UUID v7 (sortable by creation, collision-resistant) — same scheme as Phase 2's `receipt_id`. When Phase 2 lands, each `CheckReceipt` gets a `post.failure_id` field that *references* the failure record rather than duplicating its contents. Phase 1 deliverables stand alone; Phase 2 augments them.

### 2.7 Sample tool-failure flow (Phase 1, all-local)

```
[t=0] Tool fails: Edit src/foo.ts → TS2307: Cannot find module './missing'
        ↓
[t=20ms] Regular Post* event fires (PostToolUse on Claude/Codex/Gemini/Copilot;
         postToolUseFailure on Cursor) carrying tool_outcome="error".
         .mjs ships the wire-format-extended payload to harness over socket.
         Harness handler dispatches to the same internal entry regardless of
         which event triggered it.
        ↓
[parallel, ~50ms total]
        ├── Channel 1: recurrence.recordToolFailure({signature: "Edit:TS2307:..."})
        │   → returns: 13 prior occurrences across 7 sessions in last 7d
        ├── Channel 2: classifyFailure(error) → { label: "agent-error", category: "missing-import" }
        ├── Channel 3: suggestRecovery(triage, error) → "Add: import {...} from './missing'"
        ├── Channel 5: assessRollbackFeasibility(filePath) → { safe: true, command: "git checkout -- ..." }
        └── Channel 6: explainFailure(triage, error) → "Module './missing' couldn't be resolved..."
        ↓
[t=70ms] Merge into additionalContext + write .interlinked/failures/fail_xyz.json
         (Phase 1 storage; Phase 2 receipts arrive later and link by failure_id):

   [interlinked:failure] Edit src/foo.ts failed.
   Triage: agent-error / missing-import (local heuristic)
   Recurrence: 13 occurrences across 7 sessions (last 7d). See `interlinked recurrence detail`.
   Cause: Module './missing' couldn't be resolved.
   Suggested fix: Add `import { Foo } from './missing';` or check `npm ls missing`.
   Rollback option: `git checkout -- src/foo.ts` (working tree is recoverable)

   Full failure record: .interlinked/failures/fail_xyz.json
        ↓
[t=100ms] Hook returns
```

Total latency: ~100ms. All local. Compare to today's behavior: generic quality pipeline runs (~1-3s), no triage, no recurrence link, no recovery suggestion, no rollback hint.

---

## 3. Phased Build Order

Phase 1 is **fully cloud-independent** and **receipt-independent** — it ships on the regular PostToolUse event with normalized failure detection. Phase 2 introduces receipt plumbing as a separate concern. Phase 3 is the cloud pipeline.

### Phase 1 — Local Failure-Recovery Channel (no cloud, no receipts)

| # | Scope | Dependencies | Effort |
|---|---|---|---|
| **1a-fix** | **Per-provider failure-detection fix in `event-normalizers.ts`** (load-bearing prerequisite). Today most provider failures land flagged `status: "success"` because each per-provider normalizer ignores its native failure indicator. Patch each: Claude PostToolUse reads `tool_response.is_error`; Copilot extends its `status` ternary to include `toolResult.resultType === "failure"`; Gemini extends to include `tool_response.success === false`; Cursor `postToolUseFailure` adds the missing `attachOutcome(...)` call. Codex inherits the Claude fix. | none | 1-2 days |
| **1a-wire** | **Wire-format extension** in `hooks-template.ts:878-889` — extend the harness socket payload with `tool_outcome / exit_code / stderr / stdout / tool_response_sha256`. Forwards what the now-correct `deriveToolOutcome` produces. | 1a-fix | 0.5 day |
| **1a-adapter** | Harness adapters (`src/harness/adapters/<runner>.ts`) copy the wire fields onto the unified event. No re-extraction from raw `tool_response` — single source of truth is the .mjs normalizer. For Cursor, both `postToolUse` and `postToolUseFailure` route to the same internal entry. | 1a-wire | 1 day |
| **1b** | `RecurrenceKind` extension — add `tool_failure`, update `signatureFor`, add `recordToolFailure` wrapper, extend CLI filters in `src/commands/recurrence.ts` and `src/index.ts` | none | 1 day |
| **1c** | Channel 1 wiring (recurrence on every detected failure) | 1a-adapter + 1b | 0.5 day |
| **1d** | Channel 5 (rollback feasibility) — uses `execFileSync` argv path; provenance via `session-state.files_written` (after the Path-normalization + outcome-aware patches in §2.4) | none | 1 day + adversarial filename tests |
| **1e** | Channel 2-local (triage table) | new `failure-triage.ts` | 2 days |
| **1f** | Channel 3-local (recovery table) | 1e | 1-2 days |
| **1g** | Channel 6-local (explanation table) | 1e + 1f | 1 day |
| **1h** | Wire all five channels into the harness handler — same internal entry for both delivery shapes (regular PostToolUse for Claude/Codex/Gemini/Copilot; Cursor's `postToolUseFailure`). Gate on canonical `tool_outcome === "error"`. Channel output goes into `warnings[]` so the existing `.mjs` aggregation surfaces it via `formatProviderResponse`'s `summary`/`reason` (no .mjs change required for Phase 1). | 1a-adapter through 1g | 1 day |
| **1i** | Per-provider output: today's `formatProviderResponse` already emits `additionalContext` (Claude), `additional_context` (Cursor generic postToolUse, Gemini AfterTool), and stderr-fallback (Copilot, Cursor `postToolUseFailure`). Phase 1 ships using the existing `summary`/`reason` channels — **no new provider-response logic needed**. The Phase 2+ refinement adds a dedicated `additional_context` field on `HarnessDecision`. **Disk failure record** (`.interlinked/failures/<failure_id>.json`) is always written. | 1a-adapter | 0.5 day |

**Phase 1 ships in ~2 weeks** with no cloud and no receipts. Cursor's dedicated `postToolUseFailure` subscription remains in place (it's already registered today); Claude's PostToolUseFailure stays unsubscribed (existing intentional installer behavior). Five of six channels deliver immediately; cross-session (Channel 4) requires cloud and lands in Phase 3.

### Phase 2 — Receipt Plumbing (no cloud yet)

| # | Scope | Dependencies | Effort |
|---|---|---|---|
| **2a** | `receipt_id` minting + `CheckReceipt` type + `.interlinked/checks/` storage layout + `.interlinked/checks/index.jsonl` append-log | none | 2 days |
| **2b** | Pre-side hook: capture `pre_event` snapshot, mint receipt, persist with `cloud.status: "pending"` (even though no cloud yet — establishes the contract) | 2a | 1 day |
| **2c** | Session-state-keyed `tool_use_id → receipt_id` correlation table; Post-side recovers receipt by tool_use_id, with hash-based fallback when tool_use_id missing | 2a | 1-2 days |
| **2d** | Reconciliation step: hash proposed `tool_input` vs actual `tool_response`; flag drift; surface in receipt | 2c | 1 day |
| **2e** | `interlinked checks list` / `show` / `rerun` CLI surface | 2a | 1 day |

Phase 2 stands alone — Phase 1 keeps working without it. Receipts let Phase 1 channels reference findings by id (rich UX, audit trail) but are not required for the channels themselves.

### Phase 3 — Cloud-Augmented Pipelining (requires cloud infra)

| # | Scope | Dependencies | Effort |
|---|---|---|---|
| **3a** | Cloud Workflow stub spawned from Pre, writing receipts back via DO/SessionFacet keyed on receipt_id | Phase 2 + cloud infra ready | depends |
| **3b** | First real cloud check: Vectorize lookup for similar past diffs | 3a | depends |
| **3c** | Coordinator + specialists (LLM deep review on proposed diff) | 3a + AI Gateway routing | depends |
| **3d** | Sandboxed dry-run via Artifact fork (Cloudflare Sandbox + Artifacts) | 3a + Artifacts beta access | depends |
| **3e** | Channel 4 (cross-session via Vectorize over aggregated `recurrences.jsonl`) — workspace-scoped, Team/Enterprise opt-in | 3a + cross-session aggregation | depends |
| **3f** | Channels 2/3/6 LLM upgrades (classifier, recovery-diff generation, explanation prose) | 3c | depends |
| **3g** | Pending-receipt UX: next-turn auto-fetch on completed receipts; statusline indicator for in-flight checks | Phase 2c + 3a | 1-2 days |

Phase 3 lands incrementally — each row is independently shippable. A Phase 1 + Phase 2 + 3a deployment is a viable shape (receipts work, cloud is wired, no real checks yet).

---

## 4. Cross-cutting Concerns

### 4.1 CLI surface

```bash
interlinked checks list                           # recent receipts
interlinked checks show <receipt_id>              # full receipt
interlinked checks rerun <receipt_id>             # re-run cloud check on actual diff
interlinked recurrence list --kind tool_failure   # failure-pattern aggregation
interlinked recurrence detail <signature>         # all events for one signature
interlinked failure-rules list                    # show registered triage/recovery rules
interlinked failure-rules add ...                 # extensibility (optional, lower priority)
```

### 4.2 Telemetry

Every receipt is a Logpush event. Per `mcp-proxy-worker-attribution.md`, the receipt_id is included in every log line so end-to-end tracing across local + cloud is one query. Anonymous UUID for the agent handle (no emails in logs).

### 4.3 Error handling

- Hook script failures (e.g., `recordToolFailure` throws) → swallow + log to `.interlinked/sync-errors.jsonl`. Never let recovery-channel errors block the user.
- Receipt-write failures → fall back to in-memory + try again on next event.
- Cloud-receipt fetch timeout → fail-open, return local-only result + warning.

### 4.4 Performance contracts

Numbers are aligned with §1's verified-against-code framing. **Hard timeouts come from running code; budgets are design targets.**

| Path | Budget (typical) | Hard timeout (source) |
|---|---|---|
| Pre synchronous decision | <2s | **5s** — `HARNESS_PRE_TIMEOUT_MS` (`src/lib/hooks-template.ts:118`) |
| Post local checks + cloud collection | mode-dependent | **30 / 50 / 60s mode-based** (`src/harness/rules/modes.ts:55`) |
| Cloud check completion | best-effort by Post window | **No hard cap on the cloud side** — overruns become pending receipts surfaced via next-turn auto-fetch or `interlinked checks show <id>` |
| All five Phase 1 failure-recovery channels | <100ms total | 1s ceiling — drop laggards, surface a warning rather than block |

If any channel exceeds its budget, drop it and surface a warning rather than block.

### 4.5 Backward compat

Today's behavior on tool failure varies by provider:
- **Claude Code** — installer omits `PostToolUseFailure` (`hook-installers.ts:31-34`); failures arrive on regular PostToolUse; the .mjs runs the quality pipeline only on mutation tools.
- **Cursor** — `postToolUseFailure` is registered (`hook-installers.ts:144`) and reaches the harness as its own native event.
- **Codex / Gemini / Copilot** — failures fold into the regular Post* event; no dedicated event.

Phase 1 *adds* the five failure-recovery channels behind a `tool_outcome === "error"` gate; it doesn't remove the existing quality pipeline. Both flow into the existing `warnings[]` aggregation in `hooks-template.ts:909-958`, which the .mjs surfaces via `formatProviderResponse`'s `summary`/`reason` channels (the per-runner envelopes — Claude `additionalContext`, Cursor generic-postToolUse `additional_context`, Gemini `additional_context`, Copilot stderr — all consume that). Existing tests stay green; new tests cover the per-provider failure-detection fix, the wire-format extension, adapter wire-field reading, and the per-channel detectors.

---

## 5. Open Questions / Risks

| # | Question / Risk | Mitigation |
|---|---|---|
| 1 | additionalContext size limits across providers (Claude Code: ~? KB, Codex: ?, Copilot: ?) | Cap our output at 2KB; truncate with disk-receipt pointer. Verify per-provider limits when implementing. |
| 2 | recurrence.jsonl growing unbounded across sessions | Rotate at 100MB; keep latest 90 days per `harness-jsonl-output-contract.md`. |
| 3 | LLM-generated recovery diffs landing as bad fixes | Sandbox dry-run before suggesting; never auto-apply. |
| 4 | reconciliation drift detector being too sensitive (Edit's old_string vs actual file content) | Hash-based equality at the file level, not the diff level. |
| 5 | Phase 2 receipt_id propagation through hook events (Claude Code's hook payload doesn't include hook-injected fields) | Use a session-state side channel keyed on `tool_use_id`; the hook stamps receipt_id into session state, Post reads it back. |
| 6 | Recovery suggestion templates rotting as TS error messages change | Pin the regex set with a regression test; treat as a small registry that gets updated like guard rules. |
| 7 | Rollback feasibility false-positive on complex git states (rebases, merges) | Conservative default; "unsafe" when in doubt. Surface `git status` so the agent can decide. |
| 8 | Cross-session lookup requires consent/opt-in for Team/Enterprise tiers | Workspace-scope by default; aggregation requires explicit opt-in flag at workspace level. |
| 9 | Cloud check failures masquerading as agent-friendly results | Cloud receipt distinguishes `failed` from `complete` explicitly; Post checks `cloud.status` and surfaces failure cause. |
| 10 | Channel 3 (recovery suggestion) telling the agent the wrong thing | Always include the disclaimer: "suggested fix — verify before applying." Confidence score visible. |

---

## Architectural Principles (the things to never compromise)

1. **Fail-open on the cloud path.** Cloud failures degrade to local-only behavior, never to a hard block. Per `feedback_safety_continuity.md`.
2. **Tool runtime is incidental.** Designs target Pre+Post = 60s, not Pre+tool+Post.
3. **Local-first for failure recovery.** Five of six channels ship without cloud — value is delivered before the cloud arrives.
4. **failure_id now, receipt_id links later.** Phase 1 is intentionally **receipt-independent**: the durable per-failure record is `.interlinked/failures/<failure_id>.json` (UUID v7). Phase 2 cloud receipts at `.interlinked/checks/<receipt_id>.json` reference `failure_id` rather than duplicating its contents. The two ids share a generation scheme (UUID v7) but address different artifacts; one stays valid even if the other isn't yet implemented.
5. **The id is the durable thread.** Every artifact (cloud Workflow, Logpush log, additionalContext, disk file, statusline summary) carries `receipt_id` *and/or* `failure_id`. Tracing a decision end-to-end is one query against either substrate.
6. **No LLM in the hot path.** Phase 1 is all heuristic / template-driven. LLM calls are the cloud upgrade tier, gated by receipt_id and confidence-scored. Per `feedback_harness_deterministic_only.md`.
7. **Three-tier output: model + disk + statusline.** Each consumer reads the channel that matches its bandwidth.
8. **Reconciliation matters.** Cloud findings on the proposed diff must be reconciled against the actual landed bytes.
9. **Workspace-scoped privacy by default.** Cross-session lookup requires explicit opt-in at workspace level.
10. **Phase 1 ships visible value before cloud.** The whole point of the local-first ordering is to deliver before cloud is ready.
