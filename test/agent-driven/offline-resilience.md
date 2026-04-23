# Scenario 4: Offline Resilience

**Agent:** Claude Code (or any agent that can start/stop local server)
**Prerequisites:**
- Interlinked MCP Server running locally at http://localhost:8787
- Interlinked CLI configured and connected
- Guard hooks installed

## Purpose

Verifies the guard system degrades gracefully when the server is unavailable:
- Cache fallback works
- Network errors never block commits in warn mode
- Stale cache warnings are shown
- Fresh data is fetched when server returns

## Test 1: Establish Baseline (Server Online)

### Steps:
1. Verify server is running:
   ```bash
   curl -s http://localhost:8787/health | head -1
   ```
2. Create a reservation:
   ```
   MCP tool: file_reservation_paths
   Args: { "agent_name": "other-agent", "paths": ["src/protected/**"], "ttl_seconds": 3600 }
   ```
3. Run guard check:
   ```bash
   interlinked guard check --files src/protected/file.ts --json
   ```
4. **Verify:**
   - `cached: false` (fetched live from server)
   - `clean: false` (conflict detected)
   - Conflict shows `reserved_by: "other-agent"`

## Test 2: Server Goes Down — Cache Fallback

### Steps:
1. Stop the local server:
   ```bash
   # Find and kill the dev server process
   pkill -f "wrangler dev" || pkill -f "miniflare"
   ```
2. Verify server is down:
   ```bash
   curl -s http://localhost:8787/health || echo "Server down"
   ```
3. Run guard check immediately (cache should be fresh):
   ```bash
   interlinked guard check --files src/protected/file.ts --json
   ```
4. **Verify:**
   - `cached: true`
   - `cache_age_seconds` is a small number (< 60)
   - Conflict is STILL detected from cache
   - No crash or unhandled error

## Test 3: Stale Cache Warning

### Steps:
1. Wait 5+ minutes (or manually edit `.interlinked/guard-cache.json` to set `fetched_at` to 10 minutes ago)
2. Run guard check:
   ```bash
   interlinked guard check --files src/protected/file.ts --json 2>stderr.txt
   ```
3. **Verify:**
   - `cached: true`
   - `cache_age_seconds` > 300
   - stderr contains a warning about stale cache
   - Conflicts are still reported (stale data is better than no data)

## Test 4: No Cache, No Server — Clean Pass

### Steps:
1. Delete the guard cache:
   ```bash
   rm -f .interlinked/guard-cache.json
   ```
2. Run guard check (server still down, no cache):
   ```bash
   interlinked guard check --files src/protected/file.ts --json 2>stderr.txt
   ```
3. **Verify:**
   - `clean: true` (no data to report conflicts)
   - stderr contains warning about no cache available
   - Exit code 0 (never blocks when no data)

## Test 5: Commit Succeeds Despite Server Outage

### Steps:
1. Install guard in warn mode (if not already):
   ```bash
   interlinked guard install --mode warn
   ```
2. Stage a file:
   ```bash
   echo "test" > src/protected/test.ts
   git add src/protected/test.ts
   ```
3. Commit (server down, no cache):
   ```bash
   git commit -m "Commit during outage"
   ```
4. **Verify:**
   - Commit SUCCEEDS (exit code 0)
   - No unhandled errors in output
   - `git log -1` shows the new commit

## Test 6: Commit Succeeds in Block Mode During Outage

### Steps:
1. Switch to block mode:
   ```bash
   interlinked guard install --mode block
   ```
2. Delete cache again:
   ```bash
   rm -f .interlinked/guard-cache.json
   ```
3. Stage and commit:
   ```bash
   echo "block test" > src/protected/block-test.ts
   git add src/protected/block-test.ts
   git commit -m "Block mode during outage"
   ```
4. **Verify:**
   - Commit SUCCEEDS even in block mode (no server = no data = allow)
   - This is critical: network failures must never block developer work

## Test 7: Server Returns — Fresh Data

### Steps:
1. Restart the server:
   ```bash
   npm run dev &
   sleep 5
   ```
2. Verify server is up:
   ```bash
   curl -s http://localhost:8787/health
   ```
3. Run guard check:
   ```bash
   interlinked guard check --files src/protected/file.ts --json
   ```
4. **Verify:**
   - `cached: false` (fetched fresh)
   - Conflicts are reported if reservation is still active
   - Cache file is updated with fresh data

## Test 8: git context Offline Degradation

### Steps:
1. Stop server again
2. Run `interlinked git context --json`
3. **Verify:**
   - Local fields (branch, head, trailers) are present
   - `server.error` field contains "unreachable"
   - No crash or unhandled error
   - Exit code 0

## Report Format

```json
{
  "scenario": "offline-resilience",
  "agent": "<agent name>",
  "timestamp": "<ISO timestamp>",
  "results": [
    { "test": "baseline_online", "status": "pass|fail", "notes": "" },
    { "test": "cache_fallback", "status": "pass|fail", "notes": "" },
    { "test": "stale_cache_warning", "status": "pass|fail", "notes": "" },
    { "test": "no_cache_no_server", "status": "pass|fail", "notes": "" },
    { "test": "commit_during_outage_warn", "status": "pass|fail", "notes": "" },
    { "test": "commit_during_outage_block", "status": "pass|fail", "notes": "" },
    { "test": "server_returns", "status": "pass|fail", "notes": "" },
    { "test": "git_context_offline", "status": "pass|fail", "notes": "" }
  ]
}
```

Save to `cli/test/agent-driven/reports/offline-resilience-<timestamp>.json`.
