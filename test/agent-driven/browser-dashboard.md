# Scenario 3: Browser Dashboard Verification (Playwright)

**Agent:** Any agent with Playwright MCP tools (browser_navigate, browser_snapshot, etc.)
**Prerequisites:**
- Interlinked MCP Server running at http://localhost:8787
- Playwright MCP tools available
- CLI configured and guard installed in a test repo

## Purpose

Verifies that the dashboard UI correctly reflects:
- Active file reservations
- Guard hook status
- Agent state and reservation conflicts

## Test 1: Dashboard Shows Active Reservations

### Setup:
1. Create a file reservation via MCP:
   ```
   MCP tool: file_reservation_paths
   Args: { "agent_name": "browser-test-agent", "paths": ["src/auth/**"], "ttl_seconds": 1800 }
   ```

### Browser Actions:
1. Navigate to dashboard:
   ```
   browser_navigate url="http://localhost:8787/dashboard"
   ```
2. Wait for page to load:
   ```
   browser_wait_for time=3
   ```
3. Take a snapshot:
   ```
   browser_snapshot
   ```
4. **Verify:** The snapshot contains text about active reservations or file locks
5. Look for the reservation pattern `src/auth/**` in the page content
6. Look for the agent name `browser-test-agent` in the page content

### Expected:
- Dashboard loads without errors
- Active reservations section is visible
- `src/auth/**` reserved by `browser-test-agent` is displayed

## Test 2: Chat UI Shows Reservation Warnings

### Browser Actions:
1. Navigate to chat:
   ```
   browser_navigate url="http://localhost:8787/chat"
   ```
2. Wait for load:
   ```
   browser_wait_for time=3
   ```
3. Take snapshot to identify workspace selector:
   ```
   browser_snapshot
   ```
4. If workspace selector visible, select the test workspace
5. Look for any reservation/guard indicators in the agent sidebar

### Expected:
- Chat UI loads
- Agent list shows active agents with their reservations
- No JavaScript errors in console

## Test 3: Dashboard After Guard Install

### CLI Setup (before browser test):
```bash
cd /tmp/interlinked-guard-test
interlinked guard install --mode warn
interlinked guard status --json
```

### Browser Actions:
1. Navigate to dashboard:
   ```
   browser_navigate url="http://localhost:8787/dashboard"
   ```
2. Snapshot and look for guard/hook status indicators:
   ```
   browser_snapshot
   ```
3. Check console for errors:
   ```
   browser_console_messages level="error"
   ```

### Expected:
- No JavaScript errors
- Dashboard reflects the connected agent's state

## Test 4: Network Request Verification

### Browser Actions:
1. Navigate to dashboard:
   ```
   browser_navigate url="http://localhost:8787/dashboard"
   ```
2. Check network requests:
   ```
   browser_network_requests includeStatic=false
   ```
3. **Verify:**
   - API calls to `/api/workspaces` return 200
   - No 401/403 errors (auth is working)
   - No failed fetches

## Test 5: Map View Shows Agent File Ownership

### Browser Actions:
1. Navigate to map:
   ```
   browser_navigate url="http://localhost:8787/map"
   ```
2. Wait for visualization to render:
   ```
   browser_wait_for time=5
   ```
3. Take screenshot for visual verification:
   ```
   browser_take_screenshot type="png"
   ```
4. Take snapshot for accessibility tree:
   ```
   browser_snapshot
   ```
5. **Verify:**
   - Map renders without errors
   - Agent nodes or file ownership indicators are visible

## Test 6: Mobile Viewport

### Browser Actions:
1. Resize to mobile:
   ```
   browser_resize width=375 height=812
   ```
2. Navigate to dashboard:
   ```
   browser_navigate url="http://localhost:8787/dashboard"
   ```
3. Snapshot:
   ```
   browser_snapshot
   ```
4. **Verify:** Dashboard is usable at mobile width

5. Reset viewport:
   ```
   browser_resize width=1280 height=800
   ```

## Report Format

```json
{
  "scenario": "browser-dashboard",
  "agent": "<agent name>",
  "timestamp": "<ISO timestamp>",
  "server_url": "http://localhost:8787",
  "results": [
    { "test": "dashboard_reservations", "status": "pass|fail", "notes": "" },
    { "test": "chat_ui_loads", "status": "pass|fail", "notes": "" },
    { "test": "dashboard_after_guard", "status": "pass|fail", "notes": "" },
    { "test": "network_requests", "status": "pass|fail", "notes": "" },
    { "test": "map_view", "status": "pass|fail|skip", "notes": "" },
    { "test": "mobile_viewport", "status": "pass|fail", "notes": "" }
  ],
  "screenshots": ["<paths to any screenshots taken>"]
}
```

Save to `cli/test/agent-driven/reports/browser-dashboard-<timestamp>.json`.
