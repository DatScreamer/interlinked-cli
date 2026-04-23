# Agent-Driven E2E Tests for Git/Guard Integration

These tests are designed to be run by AI agents (Claude Code, Codex, or any MCP-connected agent) to validate the git and guard CLI features in realistic production scenarios.

## Test Scenarios

### Scenario 1: Claude Code Solo (Basic Flow)
**Agent:** Claude Code with Interlinked MCP connection
**File:** `claude-code-solo.md`
**Tests:**
- Install guard hooks, verify they fire on commit
- Run `git context` and verify output matches actual git state
- Create a file reservation via MCP, then verify `guard check` detects it
- Link a checkpoint to a commit

### Scenario 2: Multi-Agent Conflict (Claude Code + Codex)
**Agents:** Two agents, each with their own identity
**File:** `multi-agent-conflict.md`
**Tests:**
- Agent A reserves `src/auth/**`, Agent B tries to commit `src/auth/login.ts`
- Verify guard check reports the conflict with correct agent attribution
- Verify own-reservation exclusion (Agent A can commit to own reservation)
- Test block mode: Agent B's commit should be rejected

### Scenario 3: Browser Dashboard Verification (Playwright)
**Agent:** Any agent with Playwright MCP tools
**File:** `browser-dashboard.md`
**Tests:**
- Navigate to /dashboard, verify reservation state is visible
- After guard install, verify CLI state matches dashboard
- After conflict detection, verify dashboard shows the conflicting reservation

### Scenario 4: Offline Resilience
**Agent:** Claude Code (server stopped)
**File:** `offline-resilience.md`
**Tests:**
- With server running: create reservations, verify guard check works
- Stop server: verify guard check falls back to cache
- Restart server: verify fresh data is fetched

## Running

Each `.md` file contains step-by-step instructions that an AI agent should follow. The agent reads the file, executes each step, and reports results.

### Quick Start (Claude Code)
```
# From the repo root
cat cli/test/agent-driven/claude-code-solo.md
# Follow the instructions in order
```

### Multi-Agent Setup
```
# Terminal 1 (Agent A):
cat cli/test/agent-driven/multi-agent-conflict.md  # Section: Agent A Setup

# Terminal 2 (Agent B):
cat cli/test/agent-driven/multi-agent-conflict.md  # Section: Agent B Actions
```

## Test Report Format

After running each scenario, the agent should produce a JSON report:

```json
{
  "scenario": "claude-code-solo",
  "agent": "claude-code",
  "timestamp": "2026-02-19T10:00:00Z",
  "results": [
    { "test": "guard_install", "status": "pass", "duration_ms": 1200 },
    { "test": "git_context_local", "status": "pass", "duration_ms": 800 },
    { "test": "reservation_conflict_detection", "status": "pass", "duration_ms": 2100 }
  ],
  "summary": { "passed": 3, "failed": 0, "skipped": 0 }
}
```
