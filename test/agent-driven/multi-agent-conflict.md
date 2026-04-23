# Scenario 2: Multi-Agent Conflict — Claude Code + Codex

**Agents:** Two AI agents with different identities
**Prerequisites:**
- Interlinked MCP Server running (local or production)
- Agent A: Claude Code connected to MCP (identity: `lead-agent`)
- Agent B: Codex or second Claude Code instance (identity: `worker-agent`)
- Both agents sharing the same git repository

## Purpose

Tests that file reservation enforcement works correctly across agents:
- Agent A reserves files, Agent B's guard detects the conflict
- Own reservations are correctly excluded
- Block mode prevents commits
- Multiple overlapping reservations are all reported

## Setup

### Agent A Setup (Lead)
```bash
# In the shared test repo
mkdir /tmp/multi-agent-test && cd /tmp/multi-agent-test
git init && git commit --allow-empty -m "init"

interlinked attach --server http://localhost:8787 --agent lead-agent
interlinked guard install --mode warn
```

### Agent B Setup (Worker)
```bash
# Same repo, different agent identity
cd /tmp/multi-agent-test
interlinked attach --agent worker-agent
interlinked guard install --mode warn
```

## Test 1: Cross-Agent Conflict Detection

### Agent A Actions:
1. Reserve files:
   ```
   MCP tool: file_reservation_paths
   Args: { "agent_name": "lead-agent", "paths": ["src/auth/**"], "ttl_seconds": 1800 }
   ```
2. Verify reservation exists:
   ```
   MCP tool: list_file_reservations
   ```
3. Report: "Reservation created for src/auth/** by lead-agent"

### Agent B Actions:
1. Wait for Agent A to complete reservation (or poll `list_file_reservations`)
2. Create a conflicting file:
   ```bash
   mkdir -p src/auth
   echo "login code" > src/auth/login.ts
   git add src/auth/login.ts
   ```
3. Run `interlinked guard check --json`
4. **Verify:**
   - `clean: false`
   - `conflicts[0].reserved_by == "lead-agent"` (NOT "worker-agent")
   - `conflicts[0].file == "src/auth/login.ts"`
5. Attempt `git commit -m "Worker changes auth"` — should show warning but succeed (warn mode)

**Expected Result:** Agent B sees the conflict with lead-agent's reservation.

## Test 2: Own Reservation Not Flagged

### Agent A Actions:
1. Stage a file in own reservation:
   ```bash
   echo "lead auth code" > src/auth/admin.ts
   git add src/auth/admin.ts
   ```
2. Run `interlinked guard check --json`
3. **Verify:** `clean: true` — own reservation is excluded

### Agent B Actions:
1. Reserve different files:
   ```
   MCP tool: file_reservation_paths
   Args: { "agent_name": "worker-agent", "paths": ["src/api/**"], "ttl_seconds": 1800 }
   ```
2. Stage a file in own reservation:
   ```bash
   mkdir -p src/api
   echo "api code" > src/api/routes.ts
   git add src/api/routes.ts
   ```
3. Run `interlinked guard check --json`
4. **Verify:** `clean: true` — own reservation is excluded

## Test 3: Multiple Overlapping Reservations

### Setup:
1. Agent A reserves `src/auth/**`
2. Agent B reserves `src/api/**`
3. A third (simulated) reservation for `src/**` by `supervisor-agent`:
   ```
   MCP tool: file_reservation_paths
   Args: { "agent_name": "supervisor-agent", "paths": ["src/**"], "ttl_seconds": 1800 }
   ```

### Agent B Actions:
1. Stage files in multiple reserved areas:
   ```bash
   echo "x" > src/auth/x.ts    # conflicts with lead-agent AND supervisor-agent
   echo "y" > src/utils/y.ts    # conflicts with supervisor-agent only
   git add src/auth/x.ts src/utils/y.ts
   ```
2. Run `interlinked guard check --json`
3. **Verify:**
   - At least 2 conflicts reported
   - `src/auth/x.ts` shows conflict with `lead-agent`
   - `src/utils/y.ts` shows conflict with `supervisor-agent`
   - NO conflict for `src/api/**` (Agent B's own reservation)

## Test 4: Block Mode Enforcement

### Agent B Actions:
1. Switch to block mode:
   ```bash
   interlinked guard install --mode block
   ```
2. Stage a conflicting file:
   ```bash
   echo "blocked" > src/auth/blocked.ts
   git add src/auth/blocked.ts
   ```
3. Attempt commit: `git commit -m "Should be blocked"`
4. **Verify:**
   - Commit FAILS (non-zero exit code)
   - Error output mentions the reservation conflict
   - `git log -1` shows the PREVIOUS commit, not this one
5. Switch back to warn mode:
   ```bash
   interlinked guard install --mode warn
   ```

## Test 5: Cache Behavior Under Network Partition

### Agent B Actions:
1. Run `interlinked guard check --files src/auth/login.ts --json` (with server up)
2. Verify `cached: false` (fresh from server)
3. Run again immediately:
   - Should fetch from server again (cache is only for fallback)
4. **Simulate network failure:** Disconnect from MCP server (or stop the server)
5. Run `interlinked guard check --files src/auth/login.ts --json`
6. **Verify:**
   - `cached: true` — using cached reservations
   - `cache_age_seconds` is populated
   - Conflicts are still reported from cache
7. Restart/reconnect the server

## Test 6: Reservation Expiry

### Agent A Actions:
1. Create a SHORT reservation:
   ```
   MCP tool: file_reservation_paths
   Args: { "agent_name": "lead-agent", "paths": ["src/temp/**"], "ttl_seconds": 60 }
   ```

### Agent B Actions:
1. Immediately check: `interlinked guard check --files src/temp/file.ts --json`
2. **Verify:** Conflict exists
3. Wait 2 minutes for expiry
4. Check again: `interlinked guard check --files src/temp/file.ts --json`
5. **Verify:** `clean: true` (reservation expired)

## Report Format

Each agent should produce a report. Combine into a joint report:

```json
{
  "scenario": "multi-agent-conflict",
  "agents": {
    "agent_a": { "name": "lead-agent", "type": "claude-code" },
    "agent_b": { "name": "worker-agent", "type": "codex" }
  },
  "timestamp": "<ISO timestamp>",
  "results": [
    { "test": "cross_agent_conflict", "status": "pass|fail", "agent": "B", "notes": "" },
    { "test": "own_reservation_exclusion_a", "status": "pass|fail", "agent": "A", "notes": "" },
    { "test": "own_reservation_exclusion_b", "status": "pass|fail", "agent": "B", "notes": "" },
    { "test": "multiple_overlapping", "status": "pass|fail", "agent": "B", "notes": "" },
    { "test": "block_mode", "status": "pass|fail", "agent": "B", "notes": "" },
    { "test": "cache_fallback", "status": "pass|fail", "agent": "B", "notes": "" },
    { "test": "reservation_expiry", "status": "pass|fail", "agent": "B", "notes": "" }
  ]
}
```

Save to `cli/test/agent-driven/reports/multi-agent-<timestamp>.json`.
