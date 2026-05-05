# Hook ↔ Harness Server Protocol Mismatch

The `dist/hook-entry.js` hook script and `src/harness/server.ts` daemon speak different IPC protocols, so every PreToolUse call from the hook hits its 2-second deadline, falls back to a "timeout" stub, and never delivers the harness's real decision (warnings, blocks, or `additionalContext`) to the agent.

## TL;DR

- The hook sends **framed RPC** (`hook.pre_tool_use` method, request/response IDs).
- The daemon listens for **newline-delimited raw JSON** and replies in raw JSON.
- Frames look like JSON to the daemon's parser but never carry an `id` the client recognizes.
- The hook waits the full 2000 ms, hits the deadline in `daemon-client.ts:75`, and emits the cold-fallback string `[interlinked] timeout; evaluator skipped`.
- This silently breaks every PreToolUse advisory the harness emits — including the new Supermodel-graph blast-radius warning (`docs/plans/07-supermodel-graph-integration.md`) and the `additionalContext` visibility fix in `src/harness/adapters/claude-code.ts`.

The bug is not Supermodel-graph specific and is not new. It is the load-bearing reason PreToolUse warnings have never reached Claude Code agents in this repo.

## Empirical evidence

| Probe | Result |
|---|---|
| Raw-JSON socket call (`node net` client, framed protocol bypassed) for `Edit src/lib/activity-utils.ts` | `connected at 1 ms`, `first byte at 3 ms`, returns the expected `[interlinked:supermodel-graph]` HIGH warning |
| `printf '{...}' \| node ./dist/hook-entry.js --runner claude-code --event PreToolUse` for the same payload | Exits at exactly **2.027 s**, stdout is `{"hookSpecificOutput":{"additionalContext":"[interlinked] timeout; evaluator skipped"}}` |
| Real Edit on `src/lib/activity-utils.ts` with a HIGH-risk shard placed at `src/lib/activity-utils.graph.ts` | No supermodel warning visible to the agent. Activity log shows `PostToolUse Edit` recorded; no `PreToolUse Edit` recorded |
| `ls .interlinked/*.sock` | Only `harness.sock`. No `harness-<sessionId>.sock` exists |
| Bash hook visibility across the whole session | `PostToolUse:Bash` reminders fire continuously — confirms the **legacy** `interlinked-activity.mjs` hook (raw JSON) reaches the daemon and Claude Code surfaces its PostToolUse stderr. Zero `PreToolUse:` reminders ever. |

Round-trip cost is 3 ms; the timeout is not driven by daemon work. It is purely the client waiting for a framed reply that never arrives.

## The two protocols, side by side

### Hook side (`src/hook-entry.ts` + `src/harness/daemon-client.ts` + `src/harness/daemon-protocol.ts`)

```
src/hook-entry.ts:65   socketPath = opts.socketPath ?? discoverSocket(opts.cwd, event.session_id)
src/hook-entry.ts:74   const client = createDaemonClient(socketPath)
src/hook-entry.ts:77   const result = await safeCallDaemon(client, method, event, timeoutMs)
src/hook-entry.ts:134  async function safeCallDaemon(...)       // wraps client.call in try/catch
src/harness/daemon-protocol.ts:50    type RpcMethod = "hook.pre_tool_use" | "hook.post_tool_use" | ...
src/harness/daemon-protocol.ts:125   encodeFrame(message)        // adds the framing wrapper
src/harness/daemon-protocol.ts:147   decodeFrame(frame)          // requires the framing wrapper
src/harness/daemon-protocol.ts:185   methodForPhase(phase)       // "pre-tool" → "hook.pre_tool_use"
src/harness/daemon-client.ts:49      timeoutMs = opts.timeout_ms ?? 2000
src/harness/daemon-client.ts:75      setTimeout(reject(new Error("timeout")), timeoutMs)
src/harness/daemon-client.ts:86      if (message.id !== request.id) continue   ← drops every reply that lacks a matching id
```

`discoverSocket` (`src/hook-entry.ts:158-176`) tries:
1. `INTERLINKED_SOCKET` / `--socket` env override
2. Per-session `.interlinked/harness-<sanitized>.sock`
3. Legacy `.interlinked/harness.sock`
4. Any other `harness-*.sock` in the dir, alphabetical

In a normal install only #3 exists. The hook lands on the legacy socket, sends a framed `hook.pre_tool_use` request, and waits for a framed response with the same `id`. None comes.

### Daemon side (`src/harness/server.ts`)

```
src/harness/server.ts:2588   socketServer = createServer((sock) => { ... })
src/harness/server.ts:2592   let buffer = ""
src/harness/server.ts:2594   sock.on("data", async (data) => {
src/harness/server.ts:2595     buffer += data.toString("utf-8")
src/harness/server.ts:2597     // Handle newline-delimited JSON (may receive multiple events in one chunk)
src/harness/server.ts:2598     while (newlineIdx !== -1) {
src/harness/server.ts:2602       const decision = await processEvent(line)
src/harness/server.ts:...        sock.write(JSON.stringify(decision) + "\n")
```

There are no RPC method handlers in `server.ts` — the daemon only knows about hook events shaped like `{hook_event, session_id, tool_name, tool_input, ...}` and writes back raw `HarnessDecision` JSON. When it receives a framed envelope, the JSON.parse may either fail (silent skip) or succeed and read garbage fields, then respond with a default `{"decision":"allow"}` blob — which still has no matching `id`.

### The unwired third party

`src/harness/session-daemon.ts` and `src/harness/daemon-dispatcher.ts` exist in source. They implement the framed-RPC dispatcher the hook expects. They are **never started** — nothing in `src/commands/harness.ts` or anywhere else launches them. They were either work-in-progress or a refactor that landed half-way.

## What this blocks

- **Supermodel-graph PreToolUse warnings** (`docs/plans/07-supermodel-graph-integration.md`) — the wiring works (verified via direct socket), but the agent never sees the warning.
- **Every other PreToolUse advisory** the harness emits — protected files, repo confinement, structural context, project setup, edit diagnostics, content-scan findings, trajectory warnings. All are emitted into the `decision.warnings` array in `src/harness/evaluator/pre-tool.ts` and routed by the Claude Code adapter at `src/harness/adapters/claude-code.ts:120-160` — which now correctly fans them into `hookSpecificOutput.additionalContext`. None of that reaches the agent because the hook never receives the decision in the first place.
- **Future PreToolUse blocks** that depend on `decision: "block"` reaching Claude Code on time. They currently work via the legacy `.interlinked/hooks/interlinked-activity.mjs` path because that script speaks raw JSON, but the new `dist/hook-entry.js` path that ships in the package can't deliver them.
- **Latency telemetry honesty** — the `[interlinked] timeout` cold-fallback masks the real harness timing, and contaminates `additionalContext` with a misleading message.

## Why the legacy `.mjs` hook still partially works

`.interlinked/hooks/interlinked-activity.mjs` is a 178 KB self-contained script generated at install time from `src/lib/hooks-template.ts`. Its IPC code talks raw JSON to `harness.sock` and reads raw JSON back — the protocol the daemon actually speaks. That is why:

- Bash hooks are recorded in `activity.jsonl`.
- `[interlinked:Bash] observed` PostToolUse stderr surfaces as `additional context` reminders to the agent.
- Block decisions on `Write/Edit` (e.g. the TDD red/green gate) reach the agent — those go through the `.mjs` script, not the new dist hook.

The new `dist/hook-entry.js` hook is registered in parallel in `~/.claude/settings.json` (every event), but its calls all time out and fall through to the cold fallback. Claude Code merges output from both hooks; the `.mjs` script's output dominates whenever it succeeds, and the dist hook's timeout fallback produces a no-op stdout for events the legacy path didn't emit warnings for.

## Three ways to fix

The three options below trade scope against architectural cleanliness. They are not mutually exclusive — A buys time, C is the eventual landing place.

### A. Teach `dist/hook-entry.js` to fall back to raw-JSON IPC when the legacy socket is in use

**Smallest surface. Recommended for "fix it now."**

When `discoverSocket` lands on `harness.sock` (the legacy name), the hook should send a raw-JSON envelope `{hook_event, session_id, tool_name, ...}\n` instead of a framed RPC, then read one line of raw JSON back as the `HarnessDecision`. Detection can be by socket-name convention (`harness.sock` is legacy; `harness-*.sock` is new) or by an env var override.

Sketch:

```typescript
// src/hook-entry.ts (and src/harness/daemon-client.ts companion)
if (isLegacySocket(socketPath)) {
  return callOverLegacySocket(socketPath, event, timeoutMs);
}
return safeCallDaemon(client, method, event, timeoutMs);

function callOverLegacySocket(path, event, timeoutMs): Promise<HarnessDecision> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("timeout")); }, timeoutMs);
    sock.on("data", (c) => {
      buf += c.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buf.slice(0, nl))); }
      catch (e) { reject(e); }
      finally { sock.destroy(); }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    sock.write(JSON.stringify(toLegacyEnvelope(event)) + "\n");
  });
}
```

`toLegacyEnvelope` flattens the `UnifiedHookEvent` shape into the `{hook_event, session_id, agent_source, tool_name, tool_input, cwd, timestamp}` shape `server.ts:processEvent` expects.

**Pros**
- Unblocks every PreToolUse advisory immediately.
- No daemon-side changes; no risk of breaking the legacy `.mjs` hook.
- Implementation contained to two files (`hook-entry.ts`, optionally a small helper in `daemon-client.ts`).
- Easy to test: existing `daemon-client.test.ts` plus a new fixture pointed at a test legacy server.

**Cons**
- Bakes the legacy protocol into the new hook; we now have to maintain both.
- Doesn't help anything else that wants framed RPC.
- The cold-fallback still exists for genuinely unreachable daemons; we should probably stop polluting `additionalContext` with timeout messages while we're in there (small follow-on).

**Effort**: ~50 LOC + tests. 1-2 hours.

### B. Teach `server.ts` to accept framed RPC alongside raw JSON

**Server-side detect + dispatch. Mid-scope.**

In `server.ts:2594`, before treating the buffer as newline-delimited raw JSON, peek for the framing prefix that `encodeFrame` adds (likely a length header — confirm in `daemon-protocol.ts:125`). If framed, dispatch to a handler keyed by `RpcMethod`; otherwise fall through to the existing legacy parser.

Sketch:

```typescript
sock.on("data", async (data) => {
  buffer += data.toString("utf-8");
  while (true) {
    const framed = tryConsumeFrame(buffer);
    if (framed) {
      const { method, params, id, rest } = framed;
      buffer = rest;
      const result = await dispatchRpc(method, params);
      sock.write(encodeFrame({ schema_version: "1", id, result }));
      continue;
    }
    const nl = buffer.indexOf("\n");
    if (nl === -1) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const decision = await processEvent(line);
    sock.write(JSON.stringify(decision) + "\n");
  }
});

async function dispatchRpc(method: RpcMethod, params: UnifiedHookEvent): Promise<HarnessDecision> {
  if (method === "hook.pre_tool_use" || method === "hook.post_tool_use") {
    return processEvent(JSON.stringify(toLegacyEnvelope(params)));
  }
  // ...other methods
}
```

**Pros**
- Both protocols supported on one socket. No client-side conditional.
- Pays the architectural debt down — once landed, the framed protocol is the "real" one and raw JSON becomes the deprecation target.
- Aligns with `session-daemon.ts` / `daemon-dispatcher.ts` which already implement this dispatch shape.

**Cons**
- Touches the daemon's hot path. Risk of regressing the working raw-JSON path.
- Must reuse `daemon-dispatcher.ts` (don't reimplement) to avoid a third dialect.
- Still leaves `session-daemon.ts` unwired — that file will continue to drift.
- Larger test surface: the existing 372 test files include daemon round-trip tests that need to cover both formats.

**Effort**: ~150-250 LOC + tests. Half a day.

### C. Wire `interlinked harness start` to launch the new session-daemon as the dispatcher front of `server.ts`

**Biggest scope. Eventual landing place.**

Make `interlinked harness start` boot `session-daemon.ts` (which speaks framed RPC and is already factored to call into `daemon-dispatcher.ts`). The session daemon owns `harness-<session>.sock`; it forwards heavy-lifting events into `server.ts` (or absorbs server.ts's responsibilities entirely). Hook script discovery picks up the new socket first via `src/hook-entry.ts:163-168`.

This is the "what was probably intended" path. The presence of unwired session-daemon code suggests an in-flight refactor toward a per-session daemon model where `harness.sock` is legacy and `harness-<session>.sock` is canonical.

**Pros**
- Architecturally correct: one daemon per session, framed RPC end-to-end, no conditional dispatch.
- Per-session isolation — each session gets its own state, no cohort cross-talk.
- Eliminates the maintenance burden of two protocols and two daemon implementations.

**Cons**
- Largest behavioral change. Cohort manager, reservations, project graph, error history, and trajectory state all assume a single daemon per cwd today.
- Potentially incompatible with the existing `harness restart` semantics (kills one PID, restarts one PID).
- Forces a decision about what `server.ts` becomes — backend of the dispatcher? Deleted? Repurposed?
- Likely breaks the legacy `.mjs` hook unless the legacy socket is preserved as a compatibility shim.
- Requires understanding why the work was paused in the first place — the partial state suggests there was a blocker we should rediscover before recommitting.

**Effort**: 2-3 days minimum, plus careful migration of all per-session-state consumers.

## Recommendation

Do **A now**, plan **C later**.

A is small, reversible, and unblocks the visibility work (Supermodel-graph + every other PreToolUse advisory) within hours. It costs us a bit of duplicated protocol code but doesn't touch hot paths or per-session-state assumptions.

B is a tempting middle ground but ends up shipping the worst of both worlds: still two protocols, still two daemons, no architectural payoff. Skip B.

C is the right north star and worth doing once we understand why session-daemon was paused. Tracked as a separate plan; do not couple to the visibility unblock.

## Acceptance criteria for fix A

- [ ] `src/hook-entry.ts` (or a new `src/harness/legacy-client.ts`) sends raw-JSON envelopes when `socketPath` ends in `harness.sock` and reads one line of raw JSON back.
- [ ] Cold-fallback path stops polluting `additionalContext` with `[interlinked] timeout; evaluator skipped` — empty output is fine, the message is misleading and surfaces in the agent's view.
- [ ] Unit tests in `src/harness/daemon-client.test.ts` (or a new `legacy-client.test.ts`) cover the legacy round-trip, including the timeout path.
- [ ] Integration test: `printf '{...PreToolUse Edit...}' | node ./dist/hook-entry.js --runner claude-code --event PreToolUse` returns the actual harness `additionalContext` (e.g. a `[interlinked:supermodel-graph]` warning when a shard exists), not a cold-fallback.
- [ ] Manual demo: drop a HIGH-risk `.graph.ts` next to a real source, perform an Edit on that source, see the warning surface as a system-reminder to the agent.
- [ ] Activity log records both PreToolUse and PostToolUse Edit entries (proves both phases reach the daemon).
- [ ] All 5462 existing tests still pass.
- [ ] Latency telemetry remains accurate (the per-event `checks_timing_ms` field continues to record real elapsed time, not the new client overhead).

## Out of scope for A

- Migrating any other consumer of framed RPC.
- Touching `session-daemon.ts` or `daemon-dispatcher.ts`.
- Removing the legacy `.mjs` hook — it stays as the activity-log writer.
- The deeper question of "should `additionalContext` carry warnings on PostToolUse too?" — Claude Code already echoes PostToolUse stderr; routing duplicates would double-display. Leave the current adapter behavior alone.
- Whether warnings should be deduped before joining (some checks emit similar text). The current `decision.warnings` shape is the contract; trim noise upstream if needed.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| The "raw JSON when legacy socket" heuristic misclassifies a non-legacy socket that happens to be named `harness.sock`. | Make it env-overridable (`INTERLINKED_HOOK_PROTOCOL=raw\|framed\|auto`) and default to `auto` with the heuristic. |
| Future migration to framed RPC silently regresses. | Keep the framed path the primary code path; the legacy fallback should log (to stderr, not stdout) when it activates. |
| Cold-fallback removal hides genuine daemon failures from the user. | Continue emitting the timeout reason to **stderr** (which Claude Code shows to the human in CLI) but stop putting it in `additionalContext` (which goes to the model). |
| Existing `daemon-client.test.ts` covers the framed path; a regression there could go unnoticed since the framed path is currently broken in practice. | Keep the framed tests passing — they're future-load-bearing. Add legacy tests alongside. |

## Pointers for the next agent

- The bug is real and reproducible: `time printf '{"hook_event_name":"PreToolUse","session_id":"diag","tool_name":"Edit","tool_input":{"file_path":"src/lib/activity-utils.ts","old_string":"a","new_string":"b"},"cwd":"/Users/quentincody/interlinked-cli"}' | INTERLINKED_CLIENT=claude node ./dist/hook-entry.js --runner claude-code --event PreToolUse` exits at exactly 2.027 s.
- The harness daemon must be running for the repro: `interlinked harness status` should show a PID. Restart with `interlinked harness restart` if the dist changes.
- The harness response time can be confirmed independently with a small `node:net` client that writes raw JSON to the socket — round-trip lands at ~3 ms. Don't conflate "harness slow" with "client timeout."
- The legacy `.mjs` hook is a useful cross-check: if it's writing activity entries for a tool but the dist hook isn't surfacing warnings for the same tool, the bug is on the dist hook side.
- The existing `docs/plans/07-supermodel-graph-integration.md` is the consumer that exposed this — it's worth re-running its acceptance criteria after A lands as the live demo.
