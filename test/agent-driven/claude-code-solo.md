# Scenario 1: Claude Code Solo — Git/Guard Basic Flow

**Agent:** Claude Code with Interlinked MCP Server connection
**Prerequisites:**
- Interlinked CLI installed (`npm install -g interlinked-cli` or dev mode with `npx tsx`)
- Interlinked MCP Server running (local or production)
- Claude Code connected to the MCP server
- A test git repository (create a throwaway one)

## Setup

```bash
# Create a throwaway test repo
mkdir /tmp/interlinked-guard-test && cd /tmp/interlinked-guard-test
git init && git commit --allow-empty -m "init"

# Configure interlinked
npx interlinked-cli attach --server http://localhost:8787 --agent test-claude-agent
```

## Test 1: Guard Install and Hook Verification

**Steps:**
1. Run `interlinked guard install --json`
2. Verify output contains `"installed": true` and `"mode": "warn"`
3. Check `.git/hooks/pre-commit` exists and is executable
4. Read the hook file — verify it contains `interlinked-guard` marker
5. Run `interlinked guard status --json` — verify `pre_commit: true`

**Expected:**
```json
{
  "mode": "warn",
  "pre_commit": { "installed": true }
}
```

**Verify:**
```bash
interlinked guard install --json
cat .git/hooks/pre-commit
interlinked guard status --json
```

## Test 2: Git Context (Local Only)

**Steps:**
1. Create a commit with trailers:
   ```bash
   echo "test" > test.ts
   git add test.ts
   git commit -m "Add test file

   Interlinked-Checkpoint: 99
   Interlinked-Agent: test-claude-agent"
   ```
2. Run `interlinked git context --json`
3. Verify `branch`, `head`, and `trailers` fields are present
4. Verify `trailers["Interlinked-Checkpoint"] == "99"`
5. Verify `trailers["Interlinked-Agent"] == "test-claude-agent"`

**Expected output structure:**
```json
{
  "branch": "main",
  "head": "<7-char-sha>",
  "trailers": {
    "Interlinked-Checkpoint": "99",
    "Interlinked-Agent": "test-claude-agent"
  }
}
```

## Test 3: File Reservation Conflict Detection

**Steps:**
1. Create a file reservation via the SDK in a coordination script:
   ```
   Use execute_coordination_script with code:
   await chat.reserveFiles({ paths: ["src/auth/**"], ttl_seconds: 1800, reason: "test reservation" });
   Run this as agent "other-agent" (register that agent first if needed).
   ```
   Or use the MCP tool directly:
   ```
   Tool: file_reservation_paths
   Args: { "agent_name": "other-agent", "paths": ["src/auth/**"], "ttl_seconds": 1800 }
   ```
2. Create a conflicting file:
   ```bash
   mkdir -p src/auth
   echo "login code" > src/auth/login.ts
   git add src/auth/login.ts
   ```
3. Run `interlinked guard check --json`
4. Verify output has `"clean": false`
5. Verify `conflicts[0].reserved_by == "other-agent"`
6. Verify `conflicts[0].file == "src/auth/login.ts"`
7. Verify `conflicts[0].reservation_pattern == "src/auth/**"`

**Expected:**
```json
{
  "clean": false,
  "conflicts": [{
    "file": "src/auth/login.ts",
    "reservation_pattern": "src/auth/**",
    "reserved_by": "other-agent"
  }],
  "mode": "warn"
}
```

## Test 4: Own Reservation Exclusion

**Steps:**
1. Create a reservation for THIS agent:
   ```
   Tool: file_reservation_paths
   Args: { "agent_name": "test-claude-agent", "paths": ["src/api/**"], "ttl_seconds": 1800 }
   ```
2. Create a file in the reserved path:
   ```bash
   mkdir -p src/api
   echo "api code" > src/api/routes.ts
   git add src/api/routes.ts
   ```
3. Run `interlinked guard check --files src/api/routes.ts --json`
4. Verify output has `"clean": true` (own reservation excluded)

## Test 5: Guard Hook Fires During Commit

**Steps:**
1. Ensure guard is installed (from Test 1)
2. With the reservation from Test 3 still active:
   ```bash
   echo "more code" > src/auth/handler.ts
   git add src/auth/handler.ts
   ```
3. Run `git commit -m "Test guard hook"`
4. In warn mode: commit should SUCCEED but print a warning about the conflict
5. Check `git log -1` — the commit should exist

**Expected behavior:**
- Warning printed to stderr about `src/auth/handler.ts` conflicting with `other-agent`'s reservation
- Commit succeeds (exit code 0 in warn mode)

## Test 6: Block Mode

**Steps:**
1. Switch to block mode: `interlinked guard install --mode block --json`
2. Stage a conflicting file:
   ```bash
   echo "blocked" > src/auth/blocked.ts
   git add src/auth/blocked.ts
   ```
3. Run `git commit -m "Should be blocked"`
4. Commit should FAIL (exit code 1)
5. Verify no new commit was created: `git log -1` should show previous commit

## Test 7: Guard Uninstall and Restore

**Steps:**
1. Run `interlinked guard uninstall --json`
2. Verify `.git/hooks/pre-commit` is removed
3. Run `interlinked guard status --json` — verify `pre_commit: false`, `mode: "off"`
4. Stage and commit a conflicting file — should succeed with no warnings

## Test 8: Git Link Checkpoint (Server Required)

**Steps:**
1. Run `interlinked git link-checkpoint --json`
2. If server has checkpoints: verify `checkpoint_id` and `trailers` are returned
3. If no checkpoints: verify clear error message about no checkpoint available
4. (Optional) Run with `--apply` on a throwaway branch to test trailer application

## Report

After completing all tests, generate a JSON report:

```json
{
  "scenario": "claude-code-solo",
  "agent": "claude-code",
  "timestamp": "<ISO timestamp>",
  "server": "<server URL used>",
  "results": [
    { "test": "guard_install", "status": "pass|fail", "notes": "" },
    { "test": "git_context_local", "status": "pass|fail", "notes": "" },
    { "test": "reservation_conflict", "status": "pass|fail", "notes": "" },
    { "test": "own_reservation_exclusion", "status": "pass|fail", "notes": "" },
    { "test": "guard_hook_fires", "status": "pass|fail", "notes": "" },
    { "test": "block_mode", "status": "pass|fail", "notes": "" },
    { "test": "guard_uninstall", "status": "pass|fail", "notes": "" },
    { "test": "link_checkpoint", "status": "pass|fail|skip", "notes": "" }
  ]
}
```

Save the report to `cli/test/agent-driven/reports/claude-code-solo-<timestamp>.json`.
