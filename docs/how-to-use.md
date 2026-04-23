# Interlinked CLI: How and When To Use It

This guide is for humans using the CLI directly.
For exact command syntax/options, use `cli/docs/command-reference.md`.

## 1. Mental Model

Interlinked has three surfaces:

| Surface | Best For |
|---|---|
| Interlinked MCP Server | Source of truth for workspaces, tasks, messages, reservations, agents |
| Web UI (`/chat`, `/dashboard`, `/map`) | Human coordination and visibility |
| Interlinked CLI (`interlinked`) | Local hooks, activity capture, sync, diagnostics, and convenience automation |

Use the CLI to capture and inspect what your local coding agents are doing.
Use MCP tools (through your coding agent) and the web UI for coordination decisions.

## 2. Install and Bootstrap

### In this repository

```bash
cd cli
npm install
npm run build
npx ./dist/index.js setup --server http://localhost:8787
```

### If installed globally

```bash
interlinked setup --server http://localhost:8787
```

`setup` does:
1. `enable` (installs hooks + writes config)
2. `login` if no token is present
3. best-effort `get_started` to auto-link your agent identity on the Interlinked MCP Server

If `agent_name` is not set, activity capture still works in project-level mode using automatic
session-scoped agent IDs. Set a stable identity later with:

```bash
interlinked attach --agent <name>
```

If your Interlinked MCP Server uses non-`main` internal context, set it once:

```bash
interlinked attach --workspace <ws_id> --workspace-key <workspace_key> --project <project_key>
```

## 3. What `interlinked` (No Args) Does

Running `interlinked` with no subcommand is an entrypoint shortcut:
1. If `.interlinked/config.json` is missing and you are in a TTY: launch setup wizard.
2. If config is missing and you are non-interactive (CI): run non-interactive bootstrap.
3. If config exists: run `status` and print a compact command quick-start list.

## 4. Core Files The CLI Manages

Under `.interlinked/`:

| File | Purpose |
|---|---|
| `config.json` | Team/shared config (server URL, defaults) |
| `config.local.json` | Personal config (token, workspace, agent name, sync mode) |
| `activity.jsonl` | Local append-only activity log |
| `realtime-retry.jsonl` | Buffered realtime POST payloads waiting for retry |
| `sync-errors.jsonl` | Sync/retry failure diagnostics |
| `sync-state.json` | Cursor for reliable batch sync |
| `sessions/*.json` | Local session metadata |
| `hooks/interlinked-activity.mjs` | Generated hook script invoked by coding clients |

## 5. Daily Workflow

### Start of day

```bash
interlinked status
interlinked doctor
```

### During coding

Hooks capture events automatically. You do not need to run a command each time a tool executes.

### Inspect what happened

```bash
interlinked activity --since 1h --limit 100
interlinked explain --since 1h
```

### Ensure server has latest local events

```bash
interlinked sync
```

## 6. Sync Modes

Choose based on reliability vs network behavior:

| Mode | Behavior | When to Use |
|---|---|---|
| `realtime` | Best-effort per-event post + reliable batch sync at session end | Default; most teams |
| `manual` | Best-effort per-event post; no automatic session-end batch | You want explicit sync points |
| `local` | No server posts at all | Fully offline, demos, or temporary isolation |

Set mode:

```bash
interlinked enable --sync-mode realtime
```

## 7. Auth and Tokens

`interlinked login` uses OAuth PKCE.

For API-wrapper commands (`workspace`, `inbox`, `send`, `tasks`, `handoff`, `version`), token resolution order is:
1. CLI token in `.interlinked/config.local.json`
2. Auto-refresh via refresh token (if expired)
3. Claude Code credential fallback (`~/.claude/.credentials.json`)

For hook posting and `interlinked sync`, token resolution order is:
1. CLI token in `.interlinked/config.local.json`
2. Claude Code credential fallback (`~/.claude/.credentials.json`)

Local dev note:
- On `localhost`/`127.0.0.1`, server commands can run without OAuth tokens.
- `interlinked sync` still needs `workspace_id` set in `.interlinked/config.local.json` for local dev routing.

For CI/headless:

```bash
interlinked login --token "$INTERLINKED_TOKEN"
```

## 8. When To Use CLI vs Server Tools

Use CLI when:
- You need local/offline-first activity durability
- You are debugging hooks/sync/auth issues
- You want quick human-readable telemetry views (`status`, `doctor`, `explain`)

Use MCP tools (via agent) when:
- You are coordinating tasks/messages/files between agents
- You need authoritative state updates in the server

Use web UI when:
- You are acting as human overseer
- You need cross-agent visibility, messaging, and task triage

## 9. Command Behavior Matrix

| Command(s) | Server Needed | Auth Needed (remote) | Works Offline | Primary Purpose |
|---|---|---|---|---|
| `enable`, `disable`, `clean`, `reset`, `completions` | No | No | Yes | Local setup and maintenance |
| `status`, `activity`, `explain`, `doctor` | Optional | No for local-only output | Yes (degraded) | Local observability with optional server enrichment |
| `sync` | Yes | Usually yes | No (for sync action) | Push buffered local events to server |
| `workspace list/switch` | Yes | Yes | No | Set active server workspace |
| `inbox`, `send`, `tasks`, `handoff` | Yes | Yes | No | Human/operator wrappers over server MCP tools |
| `checkpoint`, `rewind`, `resume`, `trace` | No | No | Yes | Local git/activity workflows |
| `version` | Optional | No (falls back to reachability status) | Yes (CLI version still shown) | CLI + server reachability check |

## 10. High-Value Commands

| Command | Purpose |
|---|---|
| `interlinked setup` | One-command bootstrap |
| `interlinked status` | Current local + remote health snapshot |
| `interlinked doctor` | Diagnose common failures |
| `interlinked activity` | Raw activity feed |
| `interlinked explain` | Narrative timeline |
| `interlinked sync` | Push buffered local events |
| `interlinked workspace list/switch` | Select remote workspace context |
| `interlinked checkpoint ...` | Create/list/compare/rewind checkpoints |

## 11. Common Operator Checks

1. `interlinked status` shows expected `server_url` and workspace.
2. `interlinked doctor` has no critical failures.
3. `interlinked sync` reports zero pending events after completion.
4. Hooks are installed in your coding client config.

## 12. Failure Patterns and Recovery

| Symptom | Action |
|---|---|
| Unauthorized / token expired | `interlinked login` |
| Events captured but not on server | `interlinked sync`, then `interlinked doctor` |
| No events captured | Re-run `interlinked enable`; verify client hook config |
| Wrong workspace data | `interlinked workspace list` then `interlinked workspace switch <id>` |

Context mismatch note:
- `workspace switch` selects registry workspace ID (`ws_...`) for routing/sync.
- `workspace_key`/`project_key` are internal MCP tool context defaults.
- Configure internal context with `interlinked attach --workspace-key <key> --project <key>`.
