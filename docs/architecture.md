# Interlinked CLI — Architecture

For user workflows and command playbooks, start with:
- `docs/how-to-use.md`
- `docs/command-reference.md`

## 1. Vision

The Interlinked platform has two components with distinct roles:

**Interlinked MCP Server** (Cloudflare Workers + Durable Objects)
- System of record for multi-agent coordination
- Manages workspaces, projects, agents, messages, tasks, file locks
- Provides the MCP protocol interface that AI agents connect to
- Hosts the web UI (dashboard, chat, map)

**Interlinked CLI** (this tool)
- Local glue that covers what a remote MCP server cannot touch
- Captures agent activity via hooks (Claude Code, Gemini CLI, Codex)
- Stores activity locally for offline use
- Syncs activity to the Interlinked MCP Server for cross-agent visibility
- Provides developer-facing observability (status, explain, activity)

The activity log is the **shared coordination substrate** — every agent action is timestamped, stored locally, and (optionally) synced to the Interlinked MCP Server where it becomes queryable by other agents and visible to humans.

### What the CLI is NOT

Interlinked CLI is not a replacement for Interlinked MCP Server and is not an alternate control plane to bypass MCP. The server remains authoritative for messages, tasks, file locks, workspace state, and agent records.

The CLI includes convenience wrappers (`workspace`, `tasks`, `inbox`, `send`, `handoff`) for human/operator workflows, but these wrappers call server APIs and do not replace MCP/DO coordination logic.

### Inspiration: Entire CLI

The local-first, hook-driven architecture draws inspiration from [Entire CLI](https://github.com/entireio/cli), which captures AI agent sessions via git hooks and stores them on a shadow branch. Key differences:

| Aspect | Entire CLI | Interlinked CLI |
|--------|-----------|----------------|
| Storage | Git branches (local) | JSONL files (local) + SQLite DO (remote) |
| Transport | Git push | HTTP POST to Interlinked MCP Server |
| Scope | Single agent, single repo | Multi-agent, multi-workspace |
| Data model | Session transcripts + checkpoints | Activity events (tool calls, errors, sessions) |
| Server | None (git remotes only) | Interlinked MCP Server with full coordination suite |

## 2. Command Inventory

| Command | Purpose | Server? | Category |
|---------|---------|---------|----------|
| `enable` | Install hooks into AI coding clients, create `.interlinked/` config | No | Setup |
| `disable` | Remove hooks from all clients | No | Setup |
| `login` | OAuth PKCE browser flow for server authentication | Yes | Setup |
| `setup` | One-command bootstrap (`enable` + conditional `login`) | Optional | Setup |
| `status` | Local-first dashboard: sessions, activity, sync, server health | Optional | Observability |
| `activity` | Activity feed merging local JSONL + server data | Optional | Observability |
| `explain` | Narrative timeline of agent actions from activity log | Optional | Observability |
| `sync` | Manual batch sync of buffered events to server | Yes | Sync |
| `doctor` | Diagnose config, hooks, auth, and server issues | Optional | Maintenance |
| `clean` | Remove stale sessions, truncate large logs | No | Maintenance |
| `reset` | Nuclear: remove all Interlinked CLI config and hooks | No | Maintenance |
| `workspace` | List/switch workspaces on the remote server | Yes | Workspace |
| `inbox` | Read server messages | Yes | Messaging |
| `send` | Send server message to an agent | Yes | Messaging |
| `tasks` | Task list/create/show/claim/complete wrappers | Yes | Tasks |
| `handoff` | Explicit agent-to-agent handoff helper | Yes | Tasks |
| `checkpoint` | Manage local Git checkpoints | No | Checkpointing |
| `rewind` | Restore working tree from checkpoint | No | Checkpointing |
| `resume` | Resume context from checkpoint | No | Checkpointing |
| `trace` | Export/import local activity trace | No | Interop |
| `completions` | Shell completions script output | No | UX |
| `version` | Show CLI version + server reachability | Optional | UX |

"Server?" indicates whether the command requires server connectivity. "Optional" means the command works offline with graceful degradation.

## 3. Auth Model

### Token Resolution (multi-source priority)

For API-wrapper commands (`workspace`, `inbox`, `send`, `tasks`, `handoff`, `version`), `resolveAuthTokenWithRefresh()` checks:

1. **CLI's own token** from `.interlinked/config.local.json` (`access_token` field)
2. If expired and refresh is available, **refresh token** at `POST /token` (`grant_type=refresh_token`)
3. **Claude Code credentials fallback** from `~/.claude/.credentials.json` -> `mcpOAuth` object — matches by `mcp_prefix` against config key prefix, or by `serverName` containing "interlinked"

For hook posting and `sync`, token resolution uses `resolveAuthToken()` (no refresh step in that path): CLI token first, then Claude Code fallback.

### OAuth PKCE Login Flow

The `login` command implements a full OAuth 2.1 PKCE flow:

1. Generate `code_verifier` (32 bytes, base64url) and `code_challenge` (SHA-256)
2. Dynamic Client Registration at `POST /register` (RFC 7591)
3. Open browser to `/authorize` with PKCE params and `resource=serverUrl`
4. Local HTTP callback server receives authorization code
5. Exchange code for tokens at `POST /token`
6. Save tokens to `config.local.json`

The CLI also stores `oauth_client_id` locally so refresh can include client identity when required by the authorization server.

### Dev Mode Bypass

When `server_url` is `localhost` or `127.0.0.1`, auth is skipped entirely. The server has a dev mode that accepts unauthenticated requests.

### Multi-Server Isolation

`config.local.json` supports a `servers` map with an `active_server` key. Each server entry has its own `server_url`, `workspace_id`, and `mcp_prefix`. This prevents token/workspace cross-contamination between dev and production environments.

## 4. Activity Log as Shared Substrate

### Event Capture Pipeline

```
AI Agent (Claude Code / Gemini / Codex)
    |
    v
Hook Event (stdin JSON)
    |
    v
Hook Script (.interlinked/hooks/interlinked-activity.mjs)
    |
    +--> Local Write (always, sync, ~0.1ms)
    |     +-- .interlinked/activity.jsonl
    |     +-- .interlinked/sessions/{sessionId}.json
    |
    +--> Fire-and-forget POST (if sync_mode != "local")
    |     +-- POST /api/hooks/activity (3s timeout, errors swallowed)
    |
    +--> Batch Sync on Session End (if sync_mode == "realtime")
          +-- POST /api/hooks/activity/batch (reliable, cursor-based)
```

### Event Normalization

The hook script normalizes events from different AI clients into a common shape:

```json
{
  "ts": "2026-02-16T10:30:00.000Z",
  "agent": "claude-code",
  "type": "tool_use",
  "tool": "Edit",
  "summary": "src/index.ts",
  "session": "session-abc123",
  "hook": "PostToolUse"
}
```

| Client | Events Captured | Hook Mechanism |
|--------|----------------|----------------|
| Claude Code | 13 events (session start/end, tool use, errors, subagents, etc.) | `.claude/settings.json` hooks |
| Gemini CLI | 2 events (AfterTool, SessionEnd) | `.gemini/settings.json` hooks |
| Codex | notify hook (currently `agent-turn-complete`) | `.codex/config.toml` hooks |

### Local Storage Layout

```
.interlinked/
+-- config.json            # Shared team config (committed)
+-- config.local.json      # Personal config + tokens (gitignored)
+-- activity.jsonl         # Append-only event log (gitignored)
+-- realtime-retry.jsonl   # Realtime POST retry buffer (gitignored)
+-- sync-errors.jsonl      # Sync/retry diagnostics log (gitignored)
+-- sync-state.json        # Byte-offset sync cursor (gitignored)
+-- sessions/              # Per-session state files (gitignored)
|   +-- session-abc.json
|   +-- session-def.json
+-- hooks/
    +-- interlinked-activity.mjs  # Generated hook script (gitignored)
```

### Server-Side Storage

Events synced to the server are stored in the `agent_activity` table within the Workspace Durable Object's SQLite database:

```sql
agent_activity (
    id, agent_id, workspace_id,
    event_type, tool_name, tool_input_summary,
    occurred_at, duration_ms
)
```

Queryable via the `query_activity_feed` MCP tool (available in `extended` tier and via the Code Mode SDK).

## 5. Sync Architecture

### Three Sync Modes

| Mode | Description | Hook: local write | Hook: POST | Session end: batch sync |
|------|-------------|-------------------|------------|------------------------|
| `realtime` (default) | Best-effort real-time + retry buffer + reliable on session end | Always | Yes | Yes |
| `local` | Offline-only, no server communication | Always | No | No |
| `manual` | Best-effort real-time, sync manually when ready | Always | Yes | No |

Set via: `interlinked enable --sync-mode <mode>` or edit `config.local.json`.

### Byte-Offset Cursor

The sync system uses a byte-offset cursor (`sync-state.json`) rather than event IDs:

```json
{
  "synced_through_bytes": 48230,
  "last_sync_at": "2026-02-16T10:30:00.000Z"
}
```

This enables efficient partial reads: `openSync` + `readSync` from the cursor position to EOF, without scanning the entire JSONL file. The cursor only advances after a successful batch sync (all batches return 2xx).

### Batch Sync Protocol

Events are pushed to `POST /api/hooks/activity/batch` in chunks of 100:

```json
{
  "events": [
    { "agent_name": "...", "event_type": "...", "tool_name": "...", "tool_input_summary": "...", "occurred_at": "..." }
  ]
}
```

The server deduplicates events (same agent + tool within a 1-second window is skipped) and prunes records older than 24 hours.

### Deduplication Strategy

When local and server activity are merged for display (`activity` and `explain` commands), `mergeAndDedup()` uses a composite key: `${agent}|${type}|${tool}|${2-second-bucket}`. Server events are authoritative — if a local event matches a server event, the server version is kept.

## 6. Offline-First Design

Every command works without server connectivity:

| Command | Offline behavior |
|---------|-----------------|
| `status` | Shows local sessions, activity, sync status. Server section shows "unreachable". |
| `activity` | Shows local JSONL events only. Notes "server unavailable" in output. |
| `explain` | Builds narrative from local events only. |
| `sync` | Fails with clear error: "Cannot reach server at {url}". |
| `doctor` | Runs all local checks. Server checks report "unreachable". |

The JSONL file is always written synchronously before any network call. Even if the process is killed mid-hook, the local event is preserved.

## 7. Config System

### Two-Tier Design

| File | Purpose | Git behavior | Read by |
|------|---------|-------------|---------|
| `config.json` | Team-shared settings: `server_url`, `default_project` | Committed | CLI + hook script |
| `config.local.json` | Personal: tokens, agent name, workspace, sync_mode, multi-server map | Gitignored | CLI + hook script |

### Multi-Server Support

```json
{
  "active_server": "production",
  "servers": {
    "production": {
      "server_url": "https://interlinked.example.workers.dev",
      "workspace_id": "ws_abc123",
      "mcp_prefix": "Interlinked-production"
    },
    "local": {
      "server_url": "http://localhost:8787",
      "workspace_id": "ws_dev456"
    }
  }
}
```

`resolveConfig()` merges both files and resolves the active server entry into a flat config object.

## 8. Harness Server (Guard + Lifecycle + Auto-Reservation)

The CLI includes a local harness server (`src/harness/`) that evaluates agent actions in real-time. It runs as a Node.js process with a repo-scoped legacy raw socket (`.interlinked/harness.sock`) and, in the default dual-protocol mode, a framed RPC front door (`.interlinked/harness-<session>.sock`, falling back to `.interlinked/harness-default.sock`).

**Full documentation: `cli/docs/harness.md`** — includes architecture, all design decisions with rationale, complete guard rule reference, and testing instructions.

### Key Architectural Choices

1. **Node.js on Unix socket** (not HTTP, not inline) — sub-5ms evaluation latency, stateful trajectory tracking, agent-agnostic
2. **PreToolUse blocking + PostToolUse feedback** — fast pattern matching blocks before execution, slow checks (tsc, lint) provide stderr feedback after execution
3. **Optimistic file reservation** — check local cache (instant), confirm with server (async), 30s auto-release
4. **Agent cohort model** — tracks all agents for one developer, distinguishes "my agent" from "other developer's agent"
5. **Sleep/terminal prevention** — enforces MCP-first communication (agents should use `wait_for_work`, not `bash sleep`)
6. **Graceful degradation** — falls back to inline pattern matching when harness is unavailable

### Harness Protocol State Model

Option C uses a **single repo daemon with per-session framed sockets**. One long-lived `server.ts` process owns cohort state, reservations, project graphs, route maps, error history, classifier state, activity/latency logging, and async analysis. The framed `session-daemon.ts` socket is a thin dispatcher front door in that same process, and hook RPCs are converted back into the legacy `HarnessEvent` path before evaluation so raw and framed transports share runtime side effects.

This keeps `.interlinked/harness.sock` working for the generated legacy hook script while making the adapter-based `dist/hook-entry.js` framed path real. A true per-session state split would require a separate coordinator or durable on-disk locking for reservations and cohort awareness, so it is intentionally deferred until framed transport parity is proven.

### Inspiration

The harness architecture draws from [Sondera](https://github.com/sondera-ai/sondera-coding-agent-hooks) (Cedar policies, YARA signatures, Unix socket harness) and [Entire CLI](https://github.com/entireio/cli) (local-first capture, git-native checkpoints). The key differentiator is server coordination — the harness syncs file reservations and guard events with the Interlinked MCP Server for team-wide visibility.

## 9. Relationship to Entire CLI

The local-first, hook-driven architecture draws inspiration from Entire CLI. Both projects share the philosophy that AI agent activity should be captured locally, durably, and transparently. The key divergence is scope: Entire captures session transcripts for single-agent, single-repo workflows; Interlinked MCP Server + Interlinked CLI capture activity events for multi-agent, multi-workspace orchestration.
