# Investigation: Claude Code PostToolUse Hook Count N+1

## Status: Confirmed — Claude Code internal hook (cosmetic, no impact)

Claude Code v2.1.81 registers an internal PostToolUse hook that adds +1 to the displayed count for Edit/Write tool calls. This is cosmetic — it does not affect hook behavior, output, or the agent's experience (the count is only visible via Ctrl+O expansion).

## The Problem

Claude Code displays "2 PostToolUse hooks ran" after Edit tool calls, despite only 1 PostToolUse hook being registered in settings.json. The hook script produces exactly 1 stdout output.

## Root Cause

Claude Code's binary (Mach-O arm64, minified JS) registers **6 internal PostToolUse matchers** via `hT.registeredHooks` during session initialization:

1. **5 from `registerSessionFileAccessHooks`** — callbacks for Read, Grep, Glob, Edit, Write (team memory file tracking, marked `internal:true`, telemetry: `tengu_team_mem_file_*`)
2. **1 additional matcher** — matches Edit/Write but not Read, NOT marked `internal:true`

The `internal:true` callbacks are filtered from the display count. The 6th matcher is not, so it adds +1 to Edit/Write calls.

### Evidence

**Debug log** (`~/.claude/debug/latest`) from a clean test with 0 user hooks:
```
PostToolUse query: Read → Found 6 matchers → Matched 1
PostToolUse query: Edit → Found 6 matchers → Matched 2
```

**Controlled test** (2026-03-24, v2.1.81):
- Matcher scoped to `"Edit|Write|MultiEdit"` (Read excluded)
- Single Edit with no Read in the turn
- **Still shows "2 PostToolUse hooks ran"**
- Also confirmed: Stop hook shows "2 Stop hooks ran" with 1 registered
- Persists across session restart

### Binary analysis (key functions)

| Symbol | Name | Purpose |
|--------|------|---------|
| `_CR` | `registerSessionFileAccessHooks` | Registers 5 internal callbacks via `x6_` |
| `eLR` | (callback) | Checks `isTeamMemFile()`, fires telemetry, returns `{}` |
| `x6_` | (registeredHooks setter) | Pushes to `hT.registeredHooks` |
| `Yc` | (getter) | Returns `hT.registeredHooks` — fed into `OIR` → `Diq` |
| `Diq` | (hook resolver) | Merges settings + registered + session hooks, filters by matcher |
| `bNT` | (display component) | Renders `inProgressHookCounts` per toolUseID per hookEvent |
| `Gq9` | (internal check) | `hook.type === "callback" && hook.internal === true` |

## What We Ruled Out

1. **Duplicate hook registrations** — checked all settings files, only 1 PostToolUse hook
2. **Dual output format** — fixed earlier (was outputting both `decision` and `hookSpecificOutput`)
3. **Multiple harness processes** — killed all, still 2
4. **Harness involvement** — stopped entirely, still 2
5. **Warning content** — identical output for both file types, still 2
6. **code-simplifier plugin** — disabled, still 2; plugin has no hooks (only agent definition)
7. **Read+Edit in same turn** — scoped matcher to `"Edit|Write|MultiEdit"`, tested Edit-only turn, still 2
8. **Session-specific** — persists across session restart

## Resolution

**No action needed.** The +1 is cosmetic — it's only visible when expanding hook details (Ctrl+O). It does not affect:
- Hook script execution (still runs once per matching tool call)
- Hook output or `additionalContext` delivery
- Agent behavior or quality check results

### Change made

Scoped the Interlinked PostToolUse matcher from `""` (all tools) to `"Edit|Write|MultiEdit"` in `cli/src/lib/hooks.ts`. This is unrelated to the N+1 but eliminates unnecessary hook invocations on Read/Bash/Grep calls. Applied via `interlinked enable`.
