# Multi-Agent CLI Support -- Hook Capabilities and Integration Plan

> **RETIRED 2026-08-07 — SHIPPED. Do not use the effort estimates below to plan work.**
> `src/lib/hook-installers.ts` exports `installCursorHooks`, `installCopilotHooks`,
> `installGeminiHooks`, and `installCodexHooks`. The runners this doc frames as
> upcoming ("Cursor (Lowest Effort) … estimated effort: 1-2 hours") are installed and
> tagged with `INTERLINKED_CLIENT` so the .mjs runtime can disambiguate them. Kept for
> the per-runner hook-capability research, which is still accurate and still useful
> when adding the NEXT runner.

## Current State

Interlinked currently supports three agent CLIs in production:

| Agent CLI | Status | Events Supported | Integration Type |
|-----------|--------|-----------------|------------------|
| **Claude Code** | Production | 14 events | Full PreToolUse/PostToolUse with JSON stdin/stdout |
| **Gemini CLI** | Production | 7 events (mapped to Claude-compatible) | Full BeforeTool/AfterTool with JSON stdin/stdout |
| **Codex CLI** | Fire-and-forget | 1 event (SessionStart only) | No tool hooks -- activity logging only |

## Full Hook Support Matrix

| Capability | Claude Code | Gemini CLI | Cursor | Copilot CLI | Amp | Codex CLI |
|------------|-------------|------------|--------|-------------|-----|-----------|
| **PreToolUse** | Yes | Yes (BeforeTool) | Yes | Yes | Yes (tool.call) | No |
| **PostToolUse** | Yes | Yes (AfterTool) | Yes | Observational only | Yes (tool.result) | No |
| **Can deny** | Yes | Yes | Yes | Yes (deny only) | Yes | N/A |
| **Can modify input** | Yes | Yes | Yes | No | Yes | N/A |
| **MCP support** | Yes | Yes | Yes | Yes | Yes | Yes |
| **Protocol** | JSON stdin/stdout | JSON stdin/stdout | JSON stdin/stdout | JSON stdin/stdout | TS callbacks or declarative | JSON stdin/stdout |
| **Status** | Production (14 events) | Production (11 events) | Beta (19+ events) | GA (6 events) | Experimental | Experimental (3 events) |

## Interlinked vs Sondera Support Cross-Reference

| Agent CLI | Interlinked Status | Sondera Status | Can Guard? |
|-----------|-------------------|----------------|------------|
| **Claude Code** | Production | Full support | Yes |
| **Gemini CLI** | Production | Full support | Yes |
| **Cursor** | Commented-out stub | Full support | Not yet, but most Claude-compatible |
| **Copilot CLI** | Commented-out stub | Full support | Yes (deny only, no input modification) |
| **Amp** | Commented-out stub | Not supported | Yes (declarative hooks or plugin API) |
| **Codex CLI** | Fire-and-forget | Not supported | No (no tool-level hooks) |

## Agent CLI Details

### Claude Code (Production)

- **14 hook events**: PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, Stop, SubagentStart, SubagentStop, UserPromptSubmit, Notification, and more
- **Protocol**: JSON on stdin, JSON on stdout (block decision), stderr (warnings)
- **Hook config**: `.claude/settings.json` with `hooks` array
- **Exit codes**: stdout JSON `{ decision: "block", reason: "..." }` blocks the tool call
- **Key feature**: Can modify tool input by returning modified parameters in the response

### Gemini CLI (Production)

- **11 hook events**: BeforeTool, AfterTool, BeforeModel, AfterModel, BeforeToolSelection (unique model-level hooks), SessionStart, SessionEnd, and more
- **Protocol**: JSON on stdin, JSON on stdout
- **Exit codes**: Exit code 2 = system block (tool call is denied)
- **Regex matchers**: Can match on tool name patterns
- **Unique features**: BeforeModel and AfterModel hooks allow intercepting LLM calls, not just tool calls. BeforeToolSelection fires before the model decides which tool to use.
- **Interlinked mapping**: BeforeTool -> PreToolUse, AfterTool -> PostToolUse (normalized in `hooks.ts`)

### Cursor (Beta -- Near-Zero Effort to Add)

- **19+ hook events**: PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, and many more
- **Protocol**: JSON stdin/stdout -- **explicitly Claude-compatible format** (same `hooks.json` structure, same environment variables)
- **Key insight**: Cursor deliberately adopted Claude Code's hook format to enable ecosystem compatibility. Our existing hook script would work with minimal changes (primarily detection in `hooks.ts` and settings file path).
- **Additional events**: `prompt`-based hooks that can modify system prompts

### Copilot CLI (GA -- Guardable but Limited)

- **6 hook events**: PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit, Notification
- **PreToolUse**: Can deny tool calls (return `{ deny: true, reason: "..." }`)
- **PostToolUse**: Observational only -- cannot modify or retry
- **Cannot modify input**: Unlike Claude/Gemini/Cursor, Copilot hooks cannot change tool parameters
- **No matcher system**: Hooks fire for all tool calls; filtering must happen in hook logic
- **Limitation**: Post-tool feedback is informational only; the agent sees it but cannot be forced to retry

### Amp (Experimental -- Different Architecture)

- **Declarative hooks**: `tool:pre-execute` and `tool:post-execute` in configuration
- **Plugin API**: Experimental TypeScript plugin system with `tool.call` and `tool.result` events
- **Synthesize action**: Can return fake tool results without executing the real tool
- **LLM-in-the-loop**: `amp.ai.ask()` API enables asking an LLM for policy decisions within hook execution
- **Different format**: Not JSON stdin/stdout -- uses TypeScript callbacks or declarative YAML
- **Integration effort**: Medium -- requires a separate hook adapter, not just detection/normalization

### Codex CLI (Experimental -- Ungardable)

- **3 events only**: SessionStart, SessionStop, UserPromptSubmit
- **No tool-level hooks**: OpenAI rejected community PRs for tool hooks (multiple attempts)
- **Cannot deny, modify, or observe tool calls**: Fundamentally ungardable at the tool level
- **MCP support**: Yes, but MCP-level guards are the only option (server-side)
- **Integration**: Fire-and-forget activity logging only; no guard capability

## Implementation Priority

### 1. Cursor (Lowest Effort)

Cursor explicitly adopted Claude Code's hook format. Implementation requires:
- Add Cursor detection in `cli/src/lib/hooks.ts` (detect Cursor settings path)
- Add Cursor normalizer (likely identity function -- same format as Claude)
- Test with Cursor's `hooks.json` configuration

**Estimated effort**: 1-2 hours. The hook script and evaluation pipeline are already compatible.

### 2. Copilot CLI (Medium Effort, Guardable)

Copilot has meaningful PreToolUse deny capability, but limited PostToolUse:
- Add Copilot detection and normalizer in `hooks.ts`
- Map Copilot's deny response format (`{ deny: true, reason: "..." }`)
- Accept that PostToolUse feedback is informational only
- No input modification support -- guard rules work, but smart suggestions are less effective

**Estimated effort**: 4-8 hours. Different response format requires adapter work.

### 3. Amp (Higher Effort, Different Format)

Amp's declarative/plugin architecture is fundamentally different:
- Need to create an Amp plugin or declarative hook adapter
- Map `tool:pre-execute` / `tool:post-execute` to our evaluation pipeline
- The `synthesize` action (fake tool results) could enable novel guard patterns
- `amp.ai.ask()` for LLM-in-the-loop policy is interesting for future work

**Estimated effort**: 1-2 days. Different protocol requires more significant adapter work.

### 4. Skip Codex

Codex CLI has no tool-level hooks and OpenAI has actively rejected adding them. Guard coverage is impossible at the hook level. MCP-server-side guards (via tool handler validation) are the only option.

## Existing Architecture Supports Easy Addition

The current codebase uses a **detector + normalizer** pattern in `cli/src/lib/hooks.ts`:

1. **Detection**: Identify agent CLI from environment variables, process name, or settings file presence
2. **Normalization**: Map agent-specific event names to a common format (e.g., BeforeTool -> PreToolUse)
3. **Evaluation**: Agent-source-agnostic evaluation in `server.ts` -- the evaluator does not know or care which agent CLI fired the event

This means adding a new agent CLI requires:
1. A detector function (which CLI is this?)
2. A normalizer function (map events to common format)
3. A response formatter (map our decision to the CLI's expected response format)

The entire evaluation pipeline (`evaluator.ts`, `quality-checks.ts`, `structural-checks.ts`, `rules-loader.ts`) is shared across all agent CLIs.

## Current Codebase Architecture Details

### Event Normalization (`cli/src/lib/hooks.ts`)

Three normalizer functions exist today:
- `normalizeClaudeEvent()` — line 1288, handles 14 Claude Code events
- `normalizeGeminiEvent()` — line 1378, maps BeforeTool→PreToolUse, AfterTool→PostToolUse, extracts token usage from `llm_response.usageMetadata`
- `normalizeCodexEvent()` — line 1431, handles only `agent-turn-complete`, synthesizes session IDs from thread-id or cwd hash

### Client Detection (`cli/src/lib/hooks.ts`, lines 934-941)

Detection order (first match wins):
1. **Codex**: Detected by `argv` input method (command-line args, not stdin)
2. **Gemini**: Detected by event name matching (`BeforeTool`, `AfterTool`, `AfterModel`, `PreCompress`)
3. **Claude**: Fallback stdin detector (catch-all)

### Planned Clients (`cli/src/lib/settings.ts`, lines 51-54)

Commented-out `ClientConfig` entries exist for:
| Client | Config Dir | Settings File | Detection Hint |
|--------|-----------|---------------|----------------|
| Cursor | `.cursor` | `settings.json` | `input.cursor_session_id` |
| Copilot | `.copilot` | `config.json` | `input.copilot_version` |
| Opencode | `.opencode` | `config.json` | `input.client === "opencode"` |
| Amp | `.amp` | `settings.json` | `input.amp_session` |

### Hook Installation (`cli/src/commands/enable.ts`)

Current hook installation counts:
- Claude Code: 13 events (all hooks)
- Gemini CLI: 2 events (AfterTool, SessionEnd)
- Codex: 1 event (agent-turn-complete)

### Guard Evaluation (`cli/src/harness/server.ts`)

Agent-source-agnostic evaluation via helper functions:
```typescript
function isPreToolUse(event) {
    return event.hook_event === "PreToolUse" || event.hook_event === "BeforeTool";
}
function isPostToolUse(event) {
    return event.hook_event === "PostToolUse" ||
           event.hook_event === "AfterTool" ||
           event.hook_event === "PostToolUseFailure";
}
```

### Type Definitions (`cli/src/harness/types.ts`)

```typescript
export type AgentSource = "claude" | "gemini" | "codex";
// Needs extending: "cursor" | "copilot" | "amp"
```

### Testing Gap

All 66 evaluator tests use `agent_source: "claude"` hardcoded. No tests verify Gemini or Codex event normalization works correctly through the full pipeline. Multi-agent test coverage should be added alongside new agent support.

## Sources

- [Gemini CLI Hooks Reference](https://geminicli.com/docs/hooks/reference/)
- [Cursor Hooks Documentation](https://cursor.com/docs/hooks)
- [Copilot CLI Hooks Documentation](https://docs.github.com/en/copilot/reference/hooks-configuration)
- [Amp Plugin API](https://ampcode.com/manual/plugin-api)
- [Codex CLI Changelog](https://developers.openai.com/codex/changelog)
- [Sondera Coding Agent Hooks](https://github.com/sondera-ai/sondera-coding-agent-hooks)
