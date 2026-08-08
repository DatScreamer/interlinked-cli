# Data Collection Enhancements — Plan (Rev 4)

> **PARTIALLY SUPERSEDED (noted 2026-08-07).** Two things to know before acting:
> §2 proposes adding `checkPiiInSource()` as new work, but `src/harness/checks/pii.ts`
> already ships PII detection (with a different design — reconcile against the code
> before building anything). And file paths throughout are written as `cli/src/…`, a
> layout that no longer exists; sources live at `src/…`.

Based on competitive analysis of [Entire CLI](https://github.com/entireio/cli), gaps identified in Interlinked's data collection, deep codebase exploration, and code-level review of Rev 3.

## Product Vision

Interlinked solves multi-agent collaboration in two phases:

**Phase 1 (current target)**: One human overseeing multiple AI agents collaborating on code. The human watches agents work via the chat view — their primary observation surface. Today, the chat view shows what agents *say* (messages), but not what they *do* (code edits). This plan bridges that gap: the human should see code activity alongside communication, not in a separate panel they have to open per-agent. When three agents are working on an auth module, the human should see who wrote what, how much, and how the code evolved — in real time, in the same view where agents coordinate.

**Phase 2 (future)**: Multiple humans, each with their own agents, communicating and collaborating with each other. "Some of my agents will talk to your agents." Human A's `worker-1` and Human B's `worker-3` both edit `auth.ts` — the system tracks attribution per human, not just per agent. The existing `human_email` field on `file_contributions` and `agents.spawned_by_human_email` already support this data model. Workspace federation (documented, not yet implemented) will enable cross-workspace agent collaboration. No Phase 2 implementation work is in this plan, but the data model and architecture are designed to support it without breaking changes.

## Design Principles

- **Chat view is the human's control surface**: Attribution and code activity must surface in the chat view — not just in CLI session files or isolated sidebar panels. If the human can't see it in the chat, it doesn't exist for oversight purposes.
- **Independence**: The CLI works standalone without the MCP Server. The MCP Server works standalone without the CLI. Together they're better — the CLI provides high-fidelity edit capture, the server provides collaboration context and the human-facing display. But neither requires the other. Encourage CLI adoption, never require it.
- **Three tiers of agent connectivity**: (1) CLI + MCP Server (highest fidelity — automatic diff capture from hooks), (2) MCP Server only (agents report edits via SDK methods in coordination scripts), (3) MCP Client only (e.g., Claude Desktop — can call `report_file_edit` tool directly). All three tiers feed the same attribution pipeline. Don't penalize lower tiers for incomplete reporting.

**Revision history**:
- Rev 1: 4 features (transcript capture, line-range attribution, token aggregation, PII detection)
- Rev 2: Dropped transcripts (fragile Claude Code dependency). Replaced line ranges with diff counting (ranges corrupt on subsequent edits). Dropped subagent token breakdown.
- Rev 3: Deep codebase exploration revealed existing infrastructure missed in prior revisions — `file_contributions` table, `attribution.ts` module, `agent_sessions` linkage, intent scoping. Restructured around end-to-end flow: CLI capture → server ingestion → chat view display.
- Rev 4: Code-level review caught implementation gaps. Token aggregation already exists (reframed as polish). Hook PostToolUse matcher is scoped to `Edit|Write|MultiEdit` — Bash and MCP tools like `get_started` are never seen by hooks. `file_contributions` has a CHECK constraint blocking edit events. `code_events[]` fights the cursor-based sync model. Commit cards now use synthetic messages. Edit-summary cards and `code_activity` waiters deferred to v2.

---

## 1. Token Usage Polish

**Status**: Mostly implemented. Reframed from "new feature" to "polish task."

**What already works**:
- `hooks.ts:753-760` — hook script already accumulates `tokens_total` as a running sum across events
- `local-activity.ts:97` — `SessionState` already exposes `tokens_total?: TokenUsage`
- `status.ts:364-369` — `interlinked status` already renders per-session token usage with `formatTokens()` and `estimateCost()`

**What to add**:
- `token_events: number` counter on `SessionState` — tracks how many events contributed token data (useful for "average tokens per tool call" metrics)
- `activity` command output — show token usage inline with activity events, add aggregate totals to the activity summary

**Files to modify**:
- `cli/src/lib/hooks.ts` — increment `token_events` counter when `event.tokens` is present
- `cli/src/lib/local-activity.ts` — add `token_events` field to `SessionState`
- `cli/src/commands/activity.ts` — show token data in activity output

**Effort**: Small. Half a day.

---

## 2. PII Detection in `interlinked verify`

**Goal**: Detect PII patterns in source code as a verify check, with a focus on minimizing false positives.

**Implementation approach**:
- Add `checkPiiInSource()` function to `cli/src/harness/generic-checks.ts`
- **Default-on patterns** (high signal-to-noise): SSN, custom team patterns
- **Opt-in patterns** (noisy without tuning): email, phone, IP address
- Team-configurable custom patterns via `.interlinked/config.json`
- Skip test fixtures, mock data, and `.env.example` files
- Skip patterns inside comments that document the format (e.g., "format: EMP-XXXXXX")

**Why narrow defaults**: Email regexes flag `user@example.com` in test fixtures, npm scopes, and git configs. Phone regexes (`\d{3}[-.]?\d{3}[-.]?\d{4}`) match port numbers, timestamps, and numeric IDs. These patterns are useful when tuned for a specific codebase, but create noise as universal defaults. SSN format (`\d{3}-\d{2}-\d{4}`) has very few false positives outside of date-like strings, making it safe to enable by default.

**Default patterns**:
```typescript
// Default-on: high signal, low noise
const DEFAULT_PII_PATTERNS = [
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/, skip: /0{3}-0{2}|123-45|000-|666-|9\d{2}-/ },
];

// Opt-in: useful but noisy without per-project tuning
const OPTIN_PII_PATTERNS = [
  { name: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, skip: /noreply|example\.com|test\.com|localhost|users\.noreply/ },
  { name: "phone_us", pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, skip: /port|timeout|0{3}|version|127\.|192\./ },
  { name: "ip_address", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/, skip: /127\.0\.0\.1|0\.0\.0\.0|255\.255|10\.0\.|172\.1[6-9]\.|192\.168\./ },
];
```

**Team-configurable custom patterns**:
```json
{
  "pii_patterns": [
    { "name": "employee_id", "pattern": "EMP-\\d{6}", "severity": "high" },
    { "name": "mrn", "pattern": "MRN-\\d{8}", "severity": "critical" }
  ],
  "pii_opt_in": ["email", "ip_address"]
}
```

**Integration points**:
- `interlinked verify` — runs as a code quality check alongside existing checks
- `PostToolUse` harness pipeline — optionally flag PII introduced by agent edits
- `secrets.ts` — extend existing secret detection with PII category

**Files to modify**:
- `cli/src/harness/generic-checks.ts` — add `checkPiiInSource()` function
- `cli/src/commands/verify.ts` — wire into the verify pipeline
- `cli/src/lib/config.ts` — add `pii_patterns` and `pii_opt_in` to `SharedConfig` type
- `cli/src/harness/quality-checks.ts` — optionally add to PostToolUse pipeline
- `cli/src/lib/secrets.ts` — extend with PII detection for redaction use cases

**Testing**: Needs adversarial test cases — port numbers that look like phones, version strings that look like IPs, date strings that look like SSNs, npm scopes that look like emails.

**Effort**: Medium. ~2-3 days. Regex work is straightforward; tuning false positives is the real work.

---

## 3. Code Activity Tracking & Attribution

**Goal**: Track what code each agent writes, surface it in the chat view where the human overseer is watching, and store attribution data for multi-agent collaboration analytics. The system must work standalone (local-only, no MCP Server) and scale to the full multi-agent + multi-human vision.

### Constraints discovered during code review

Rev 3 proposed mechanisms that conflict with how the codebase actually works. Rev 4 addresses these honestly:

| Rev 3 assumption | Reality | Rev 4 approach |
|-----------------|---------|----------------|
| Hook script sees PostToolUse for Bash (to detect `git commit`) | `POST_TOOL_USE_MATCHER = "Edit\|Write\|MultiEdit"` at `hooks.ts:60`. Bash PostToolUse events never reach the hook script. Widening to match-all inflates Claude Code's hook invocation count (see comment at hooks.ts:56-58). | Move commit detection to **session-end reconciliation** or **harness-side detection** (the harness sees all events via the Unix socket). |
| Hook script sees PostToolUse for `get_started` (to detect MCP registration and extract agent name) | Same matcher limitation. Also, `get_started` is called through the MCP transport, not through Claude Code's tool system — it's an MCP tool call, not a local tool call. The CLI's `onboarding.ts` calls it directly from CLI code. | Agent name linkage happens through the existing `resolveActivityAgent()` name-based matching. `hook_session_id` linkage is deferred (see "Unresolved: hook_session_id acquisition" below). |
| Edit events can be upserted into `file_contributions` | `CHECK(event_type IN ('acquired', 'released', 'expired', 'revoked'))` at `tables.ts:281`. The table is reservation-lifecycle data, not edit-event data. | Store per-edit data in `agent_activity` (already happens — `files_modified`, `tool_input_json`). Create a new `commit_attributions` table for commit-level attribution. Leave `file_contributions` for reservation lifecycle. |
| `code_events[]` array alongside messages in `sync_since` | `sync_since` is cursor-based on `messages.id`. The chat client only merges `data.messages` in `sync.ts`. Adding a parallel event stream means a second cursor, client-side timeline merging, and dual rendering paths. | **Commit cards are ordinary messages** stored in the `messages` table. The chat client picks them up through the existing sync flow with zero changes to the sync protocol. Use subject prefix convention or a new `message_type` column for styled rendering. |
| Tier 1 covers Claude Code, Gemini CLI, and Codex equally | Codex hook normalization (`normalizeCodexEvent` at `hooks.ts:1535`) only handles notify/turn/approval events — no Edit/Write tool payloads. | Tier 1 coverage is **Claude Code and Gemini CLI only** for v1. Codex requires normalizer work, documented as a prerequisite. |
| `agent_activity` can serve as sole source for per-edit attribution | `recordActivity()` at `activity.ts:90` deduplicates by agent_id + tool_name within a 1-second window. Rapid Edit calls to different files within 1 second collapse to one record. | Agent detail panel contribution summary must query with dedup-aware aggregation, or dedup must be narrowed to include `file_path` in the key. See "Dedup issue" section below. |
| CLI onboarding can pass `hook_session_id` to `get_started` | `onboarding.ts:62` only sends `{ name, program }`. The CLI process has no access to the hook session ID — that's assigned by Claude Code to the hook script process, not to the CLI command process. `handleGetStarted` at `get-started.ts:47` whitelists args and would drop unknown fields. | `hook_session_id` linkage deferred. The name-based correlation via `resolveActivityAgent()` is the v1 path. See "Unresolved" section. |

### Architecture: end-to-end data flow (three tiers)

```
┌─ TIER 1: CLI + MCP Server (highest fidelity) ──────────────────────┐
│                                                                     │
│  CLI (Local) — automatic capture from hook events                   │
│                                                                     │
│  PostToolUse:Edit/Write event (hook matcher already covers these)   │
│    ├── Capture diff (old_string/new_string or full_write flag)      │
│    ├── Compute lines_added / lines_removed                          │
│    ├── Resolve agent_name from session state                        │
│    ├── Append CodeEdit to session's edits[] (local, append-only)    │
│    └── Include in activity event POST to server                     │
│                                                                     │
│  SessionEnd / Stop hook event                                       │
│    ├── Run git log to find commits made during this session         │
│    ├── For each commit: git diff <hash>~1 <hash> --numstat          │
│    ├── Compute proportional attribution per agent per file          │
│    ├── Store CommitAttribution locally                               │
│    └── POST commit attribution event to server                      │
│                                                                     │
│  Agent name linkage                                                 │
│    └── Activity events include agent_name; server resolves via      │
│       resolveActivityAgent(). hook_session_id linkage deferred.     │
│                                                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ POST /api/hooks/activity
                           ▼
┌─ TIER 2: MCP Server only (SDK-reported) ───────────────────────────┐
│                                                                     │
│  Agents without the CLI report edits via coordination scripts:      │
│    chat.reportFileEdit({ file_path, lines_added, lines_removed })   │
│    chat.reportCommit({ commit_hash, commit_message, files })        │
│                                                                     │
│  OR via MCP tool calls (Tier 3: MCP Client like Claude Desktop):   │
│    report_file_edit({ file_path, lines_added, lines_removed,       │
│      workspace_key, project_key })                                  │
│    report_commit({ commit_hash, commit_message, files,             │
│      workspace_key, project_key })                                  │
│    (agent identity resolved from bound MCP session — see below)    │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  MCP Server — unified ingestion (all tiers converge here)           │
│                                                                     │
│  Activity Ingestion (activity-api.ts) — existing flow, unchanged    │
│    ├── Resolve agent by name (resolveActivityAgent)                 │
│    ├── Scrub secrets (scrubSensitiveFields)                         │
│    └── Store in agent_activity (existing 45-column table)           │
│         └── files_modified, tool_input_json already captured        │
│                                                                     │
│  SDK / Tool Handlers (report_file_edit, report_commit) — NEW        │
│    ├── Validate caller is registered agent                          │
│    └── For commits: store in commit_attributions + insert message   │
│                                                                     │
│  On commit attribution (from any tier):                             │
│    ├── Store in commit_attributions table (NEW)                     │
│    └── Insert synthetic commit card as ordinary message             │
│         └── Picked up by existing sync_since cursor — no protocol  │
│             changes needed                                          │
│                                                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ sync_since (existing protocol, unchanged)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Chat View (Human's observation surface)                            │
│                                                                     │
│  Message stream (existing sync, existing rendering)                 │
│    └── Commit card messages appear as regular messages              │
│         ├── body_md contains formatted attribution table            │
│         ├── Readable as plain markdown in any client                │
│         └── Chat UI can detect subject prefix for styled rendering  │
│                                                                     │
│  Agent detail panel (existing: activity log, tasks, file locks)     │
│    └── ENHANCED: per-agent file contribution summary                │
│         aggregated from agent_activity WHERE tool_name IN           │
│         ('Edit','Write') AND agent_id = ?                           │
└─────────────────────────────────────────────────────────────────────┘
```

**Tier comparison**:

| Tier | Agent type | How edits are reported | Fidelity | Example |
|------|-----------|----------------------|----------|---------|
| **1: CLI + Server** | Claude Code and Gemini CLI with Interlinked CLI installed. Codex requires normalizer work (see prerequisites). | Automatic — hook script captures every Edit/Write PostToolUse, includes old_string/new_string diffs | Highest — per-edit diffs with full content | Claude Code agent with `interlinked enable` |
| **2: Server only** | Any MCP-connected coding agent without CLI | Explicit — agent calls `chat.reportFileEdit()` in coordination scripts | Medium — agent reports what it chooses to report, no automatic capture | Custom agent using Code Mode SDK |
| **3: MCP Client** | Non-CLI MCP clients (Claude Desktop, custom MCP clients) | Explicit — calls `report_file_edit` MCP tool directly | Lower — no coordination script context, manual reporting | Claude Desktop connected to Interlinked |

All three tiers write to `agent_activity` (for raw events) and `commit_attributions` (for commit-level data). The chat view renders commit cards identically regardless of which tier produced the data.

### Part A: CLI-side capture (standalone capable)

The CLI captures diffs locally from hook events. This works without the MCP Server.

**What the hook script already sees**: PostToolUse events for `Edit`, `Write`, and `MultiEdit` (per the `POST_TOOL_USE_MATCHER`). Each event includes `tool_input` with `file_path`, `old_string`/`new_string` (Edit) or `content` (Write). This is sufficient for per-edit diff capture — no matcher changes needed.

**What the hook script does NOT see**: Bash tool calls (including `git commit`), MCP tool calls (including `get_started`). These are excluded by the matcher and cannot be captured via PostToolUse hooks without widening the matcher or adding separate hook registrations.

**Agent identity resolution**:

| Priority | Source | Example | When available |
|----------|--------|---------|----------------|
| 1 | `event.agent_name` | `"worker-1"` | If client provides it |
| 2 | `config.agent_name` | `"alice-dev"` | Set in `.interlinked/config.local.json` |
| 3 | Fallback | `"claude-a1b2c3d4"` | Always (`${agent_source}-${session_id.slice(0,8)}`) |

Note: Rev 3 proposed detecting `get_started` PostToolUse responses to extract agent names. This is not possible — MCP tool calls don't fire PostToolUse hooks. Instead, when the CLI's onboarding code calls `get_started`, it can write the returned agent name to session state directly (the CLI code has access to both the session_id and the MCP response).

**Commit detection — session-end reconciliation**:

Since the hook script can't see Bash `git commit` events, commit attribution is computed at session end:

1. On `SessionStart`, the hook script captures a baseline:
   ```
   session_start_head = $(git rev-parse HEAD)
   ```
   This is stored in session state alongside `session_start_time`.

2. On `SessionEnd` or `Stop` hook event (which the hook IS registered for), the hook script finds commits made *after* the baseline:
   ```
   git log <session_start_head>..HEAD --format="%H %s" --no-merges
   ```
   This scopes to commits that landed after the session started, excluding all historical commits regardless of which files they touched.

3. **File-overlap filter**: Among those commits, only attribute ones where the changed files overlap with the session's accumulated `CodeEdit` entries. A commit that touches `README.md` when this session only edited `src/auth.ts` was likely made by a human or another agent:
   - For each commit, run `git diff <hash>~1 <hash> --name-only`
   - Intersect with the set of files in this session's `CodeEdit[]`
   - Skip commits with zero intersection

4. For qualifying commits, run `git diff <hash>~1 <hash> --numstat` and compute proportional attribution per agent per file.

5. **Idempotency**: Use `commit_hash` as the dedup key. The server's `commit_attributions` table has `UNIQUE(project_id, commit_hash)` and uses `INSERT OR IGNORE`. The commit card message uses the existing idempotent message insert path (see below). Repeated reconciliation (e.g., Stop hook fires twice) is safe.

6. Store `CommitAttribution` in session state and POST to server.

This is slightly delayed (attribution computed at session end, not at commit time) but avoids the matcher problem entirely. For long-running sessions, the `Stop` hook event also triggers reconciliation.

**Alternative: harness-side commit detection**: The harness receives ALL tool events via the Unix socket (including Bash events for guard evaluation). It could detect `git commit` in Bash commands and trigger attribution in near-real-time. This is a v2 optimization — session-end reconciliation is simpler for v1.

**Tier 1 prerequisite — Codex normalizer**:
`normalizeCodexEvent()` at `hooks.ts:1535` only handles `agent-turn-complete`, `approval-request`, and a generic fallback. It does not produce Edit/Write-style events with `tool_input.file_path` / `old_string` / `new_string`. Codex Tier 1 support requires either extending the normalizer to handle Codex's edit payload format, or accepting that Codex agents fall back to Tier 2 (SDK-reported) for v1.

Note: The PostToolUse matcher at `hooks.ts:60` includes `MultiEdit` alongside `Edit|Write`, but there is no `MultiEdit` tool in Claude Code today. It was added speculatively. If a batch-edit tool is introduced in the future, `extractFilePath()` and `summarize()` would need updates, and the `CodeEdit` type would need a capture rule for multi-file payloads.

**Local data model**:

```typescript
/** A single code edit captured from a PostToolUse event. Append-only. */
interface CodeEdit {
  timestamp: string;
  session_id: string;
  agent_name: string;         // resolved at capture time
  file: string;               // absolute or cwd-relative path
  tool: "Edit" | "Write";
  lines_added: number;        // computed from diff
  lines_removed: number;
  // For Edit: store the actual strings (enables replay and review)
  old_string?: string;
  new_string?: string;
  // For Write: flag it (full content is too large to store per-edit)
  full_write?: boolean;
}

/** Per-agent aggregation within a session. Computed from CodeEdit array. */
interface AgentContribution {
  agent_name: string;
  session_id: string;
  files_touched: string[];
  total_added: number;
  total_removed: number;
  edit_count: number;
}

/** Session-level attribution. Stored in sessions/{id}.json. */
interface SessionAttribution {
  edits: CodeEdit[];                          // append-only edit log
  by_agent: Record<string, AgentContribution>; // aggregated per agent
  commits?: CommitAttribution[];              // populated at session end
}

/** Attribution reconciled against an actual git commit. */
interface CommitAttribution {
  commit_hash: string;
  timestamp: string;
  message?: string;
  files: {
    file: string;
    net_added: number;            // from git diff --numstat
    net_removed: number;
    agents: {
      agent_name: string;
      added: number;              // proportional from tracked edits
      removed: number;
      percentage: number;         // 0-100
    }[];
  }[];
  human_email?: string;           // for multi-human future
}
```

**Subagent handling**: Claude Code spawns subagent sessions with their own `session_id` but the same MCP Server identity. The hook script already sees `parent_session_id` in `SubagentStart` events. Subagent edits roll up to the parent's registered agent name via the existing `SubagentState` tracking in `SessionState`.

**Integration with existing `attribution.ts`**: The existing module does coarse pre/post `git diff --numstat` snapshots. The new CodeEdit tracking provides per-edit granularity. At session end, both sources inform the `CommitAttribution`: `git diff --numstat` provides the ground truth, and the CodeEdit log provides the per-agent breakdown. The existing module can be refactored to use the new data or kept as a fallback.

**Storage considerations**:
- Edit diffs (`old_string`/`new_string`) can be large. Cap at 10KB per string; above that, store only line counts.
- Write events: don't store full file content. Just `full_write: true` and line count.
- Session file size: ~1-5MB for 500 edits with diffs. Acceptable for local storage.
- Redaction: run diffs through `secrets.ts` before storage.

**CLI files to modify**:
- `cli/src/lib/local-activity.ts` — add `CodeEdit`, `AgentContribution`, `SessionAttribution`, `CommitAttribution` types; extend `SessionState`
- `cli/src/lib/hooks.ts` — update generated hook script to:
  - Capture Edit/Write diffs on PostToolUse events (matcher already covers these)
  - On SessionEnd/Stop: run git log + git diff for commit reconciliation
  - Include edit metadata in activity event POST payloads
- `cli/src/lib/attribution.ts` — refactor to use CodeEdit data when available, keep as fallback
- `cli/src/commands/status.ts` — display per-session attribution summary
- `cli/src/commands/activity.ts` — show per-agent contribution in activity feed

### Part B: Server-side ingestion & commit cards as messages

The MCP Server receives edit data through the existing activity pipeline and generates commit card messages.

**Unresolved: `hook_session_id` acquisition path**

Rev 3 proposed adding `hook_session_id` to `get_started` so the server could explicitly link a CLI hook session to a registered agent. This is the right end state but has no viable acquisition path today:

- The hook session ID is assigned by Claude Code to the hook script process. The CLI command process (which runs `interlinked enable` / onboarding) is a separate process with no access to it.
- `onboarding.ts:62` currently sends only `{ name, program }` to `get_started`.
- `handleGetStarted` at `get-started.ts:47` builds `registerArgs` from a whitelist — unknown fields are dropped.
- There's no shared state (file, env var, or IPC) between the hook script and the CLI process.

**v1 approach**: Rely on name-based correlation. Activity events POST to `/api/hooks/activity` with `agent_name` and `session_id`. The server resolves the agent by name via `resolveActivityAgent()`. This already works and doesn't require new plumbing.

**Future options** (when explicit linkage becomes necessary):
- The hook script could write the session ID to `.interlinked/hook-session` on SessionStart; the CLI command could read it and pass to `get_started`
- The activity pipeline could set `hook_session_id` on the agent record when it receives the first activity event with a matching agent name
- A new `link_session` tool or SDK method could be called from a coordination script after registration

For now, `hook_session_id` is removed from the v1 scope. The column and index can be added later without breaking changes.

**Activity ingestion — dedup issue**:

Edit events already flow through `activity-api.ts` and are stored in `agent_activity` with `files_modified` and `tool_input_json`. However, `recordActivity()` at `activity.ts:90` deduplicates by `agent_id + tool_name` within a 1-second window. This means rapid Edit calls to *different files* within 1 second collapse to a single record, making per-file attribution totals incorrect.

**Options**:
1. **Narrow the dedup key** to include the first entry from `files_modified` (e.g., `agent_id + tool_name + file_path`). This preserves dedup for genuine duplicate events while keeping distinct file edits separate.
2. **Bypass dedup for edit events** by checking `tool_name IN ('Edit', 'Write', 'report_file_edit')` and skipping the dedup query.
3. **Accept the gap for v1** — the CLI-side `CodeEdit` log in `sessions/{id}.json` is the source of truth for per-edit data. The server-side `agent_activity` is a best-effort mirror. The agent detail panel summary should note it may undercount rapid edits.

Recommendation: Option 1 (narrow the dedup key). Smallest change, fixes the correctness issue without disabling dedup entirely.

`file_contributions` is left untouched — it has a CHECK constraint limiting `event_type` to reservation lifecycle events, and altering that is unnecessary for v1.

**Commit attribution — new table and message generation**:
When the CLI (or Tier 2/3 agent) reports a commit, the server stores it and generates a synthetic message:

```sql
CREATE TABLE IF NOT EXISTS commit_attributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  commit_hash TEXT NOT NULL,
  commit_message TEXT,
  committed_at TEXT NOT NULL,
  attribution_json TEXT NOT NULL,  -- JSON: CommitAttribution structure
  source_agent_id INTEGER REFERENCES agents(id),
  source_tier TEXT DEFAULT 'cli',  -- 'cli', 'sdk', 'mcp_tool'
  intent_id INTEGER REFERENCES intents(id),
  human_email TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, commit_hash)  -- idempotency: same commit can't be attributed twice per project
);
```

The `UNIQUE(project_id, commit_hash)` constraint prevents duplicate commit cards from repeated reconciliation (e.g., if the Stop hook fires twice, or if the same commit is reported by both Tier 1 and Tier 2 paths). The insert uses `INSERT OR IGNORE` to silently skip duplicates.

**Commit cards as ordinary messages**:
When a commit attribution is stored, the server inserts a regular message into the `messages` table:

```typescript
// In the commit attribution handler
const body = formatCommitCardMarkdown(attribution);
// Example output:
// **Commit `abc1234`**: "Add auth middleware and tests"
//
// | File | Changes | Attribution |
// |------|---------|-------------|
// | `src/auth.ts` | +45 / -12 | worker-1 (78%), lead (22%) |
// | `tests/auth.test.ts` | +89 / -0 | worker-2 (100%) |
//
// **Total**: +134 / -12 lines across 2 files

// Cannot use handleSendMessage() — it requires `to` with at least one
// recipient (messaging.ts:48) and recipient validation throws when
// missing (recipients.ts:169). Commit cards are ambient messages with
// no recipients, so we need a dedicated insert helper.
const idempotencyKey = `commit:${projectId}:${hash}`;
insertAmbientMessage(sql, {
  projectId,
  senderId: sourceAgentId,
  subject: `[commit] ${hash.slice(0, 7)}`,
  body_md: body,
  idempotency_key: idempotencyKey,
});
```

**`insertAmbientMessage` helper** (new, in `src/tools/helpers/activity.ts`):
A thin wrapper that does an idempotency pre-check and direct INSERT — no recipients, no recipient validation, no dedup detection. This is distinct from the send_message path:

```typescript
function insertAmbientMessage(sql: SqlStorage, params: {
  projectId: number;
  senderId: number;
  subject: string;
  body_md: string;
  idempotency_key: string;
}): boolean {
  // Idempotency check (same pattern as messages-send.ts:295-300)
  const existing = sql.exec(
    "SELECT id FROM messages WHERE idempotency_key = ?",
    params.idempotency_key
  ).toArray();
  if (existing.length > 0) return false; // already inserted

  sql.exec(
    `INSERT INTO messages (project_id, sender_id, subject, body_md, importance, idempotency_key)
     VALUES (?, ?, ?, ?, 'normal', ?)`,
    params.projectId, params.senderId, params.subject,
    params.body_md, params.idempotency_key
  );
  return true;
  // No message_recipients rows — ambient message
}
```

**Commit card recipient model**:
Commit cards are **ambient, human-observer-only messages** with no `message_recipients` rows. This means:
- They appear in the chat view's `sync_since` stream (which queries `messages` directly, not through recipients)
- They do NOT appear in agents' `fetchInbox()` or `wait_for_work()` flows (which filter by `message_recipients.agent_id`)
- This is intentional: agents don't need to "read" commit cards. The human sees them in the chat stream as ambient status updates.

If a future use case requires agents to react to commits (e.g., "worker-2 should rebase after worker-1 commits"), that should use the `code_activity` work waiter event (deferred to v2) rather than routing commit messages through inbox flows.

**Why this is better than `code_events[]`**: The sync_since protocol, client-side merge logic, and message renderer all work unchanged. Zero risk of breaking the existing chat flow. The commit card is just a message with a specific format — the simplest possible v1.

**Server files to modify**:
- `src/schema/migrations.ts` — create `commit_attributions` table with UNIQUE constraint
- `src/activity-api.ts` — on commit attribution events, store in `commit_attributions` and insert message
- `src/tools/helpers/activity.ts` — narrow dedup key to include file_path; new `recordCommitAttribution()` and `formatCommitCardMarkdown()` helpers

### Part B.5: Server-standalone SDK path (no CLI required)

Agents that don't use the Interlinked CLI — or aren't CLI-based at all — can still report code activity directly to the MCP Server.

**Why this matters**: The CLI provides highest-fidelity capture (automatic, every edit, includes diffs). But not every agent will have the CLI installed. A custom agent using Code Mode scripts, a Claude Desktop user connected via MCP, or a future non-CLI tool should all be able to contribute attribution data. The server should encourage CLI installation (higher fidelity, automatic) but never require it.

**New SDK methods** (available in coordination scripts via `chat.*`):

```typescript
// Report a file edit — called by agents that don't have CLI hook capture
// workspace_key and project_key are auto-injected by the SDK via argDefaults
chat.reportFileEdit({
  file_path: "src/auth.ts",
  lines_added: 45,
  lines_removed: 12,
  edit_type: "modify",           // "create" | "modify" | "delete"
  description: "Added JWT validation middleware",  // optional
});

// Report a commit with attribution
chat.reportCommit({
  commit_hash: "abc1234",
  commit_message: "Add auth middleware and tests",
  files: [
    { file: "src/auth.ts", lines_added: 45, lines_removed: 12 },
    { file: "tests/auth.test.ts", lines_added: 89, lines_removed: 0 },
  ],
});
```

**New MCP tools** (for Tier 3: MCP Clients like Claude Desktop):

```typescript
// In src/tool-registry/entries/activity.ts (extend existing file — already has
// queryActivityFeedEntry and agentPerformanceMetricsEntry)

export const reportFileEditEntry: ToolEntry = {
  name: "report_file_edit",
  description: "Report a file edit for code attribution tracking",
  schema: z.object({
    // Project-scope dispatch context (required for Tier 3 MCP clients,
    // auto-injected for Tier 2 SDK callers via argDefaults).
    // Matches existing project-scope tools like query_activity_feed.
    workspace_key: z.string().optional().describe("Workspace key"),
    project: z.string().optional().describe("Project context"),
    project_key: z.string().optional().describe("Project key"),
    agent_handle: z.string().optional().describe("Agent handle for caller identification"),
    // Payload
    file_path: z.string().describe("Path to the edited file"),
    lines_added: z.number().int().min(0).describe("Lines added"),
    lines_removed: z.number().int().min(0).describe("Lines removed"),
    edit_type: z.enum(["create", "modify", "delete"]).default("modify"),
    description: z.string().optional().describe("What changed"),
  }),
  handler: handleReportFileEdit,
  tier: "extended",
  scope: "project",
  mcpVisible: false,       // not in default tools/list (reduces noise)
  searchVisible: true,     // discoverable via search tool (top-level field per types.ts:130)
  sdk: {
    methodName: "reportFileEdit",   // camelCase per ToolSdkMetadata.methodName (types.ts:72)
    moduleKey: "activity",          // grouping key per ToolSdkMetadata.moduleKey (types.ts:74)
    argDefaults: {
      workspace_key: { inject: "workspaceKey" },
      project_key: { inject: "projectKey" },
    },
  },
};

export const reportCommitEntry: ToolEntry = {
  name: "report_commit",
  description: "Report a git commit with per-file attribution",
  schema: z.object({
    // Project-scope dispatch context
    workspace_key: z.string().optional().describe("Workspace key"),
    project: z.string().optional().describe("Project context"),
    project_key: z.string().optional().describe("Project key"),
    agent_handle: z.string().optional().describe("Agent handle for caller identification"),
    // Payload
    commit_hash: z.string().describe("Git commit hash"),
    commit_message: z.string().optional(),
    files: z.array(z.object({
      file: z.string(),
      lines_added: z.number().int().min(0),
      lines_removed: z.number().int().min(0),
    })),
  }),
  handler: handleReportCommit,
  tier: "extended",
  scope: "project",
  mcpVisible: false,
  searchVisible: true,
  sdk: {
    methodName: "reportCommit",
    moduleKey: "activity",
    argDefaults: {
      workspace_key: { inject: "workspaceKey" },
      project_key: { inject: "projectKey" },
    },
  },
};
```

**Handler behavior** (shared by SDK methods and MCP tools):
1. Resolve the calling agent's identity using this priority:
   - `ctx.resolvedFromHandle.agentId` — set when `agent_handle` is provided in args (explicit override)
   - `getSessionBoundAgent(sql, ctx.sessionId)` from `sessions.ts:41` — primary path for Tier 3 MCP clients; looks up the agent bound to this MCP transport session (dispatch runs this when `!authorizedAgentName`, per `tool-dispatch.ts:509`)
   - `ctx.authorizedAgentName` — only set for Code Mode token auth (Tier 2 SDK callers), not for ordinary MCP sessions (`types.ts:13`)
   - If none resolve, reject the call (agent must be registered before reporting edits)
2. For `report_file_edit`: store in `agent_activity` as a tool_use event with `files_modified` (subject to the narrowed dedup key from Part B — file_path included so distinct files aren't collapsed)
3. For `report_commit`: store in `commit_attributions` (with `INSERT OR IGNORE` for idempotency), insert ambient commit card message via `insertAmbientMessage()` with `idempotency_key: "commit:${projectId}:${hash}"` (same format as Part B — includes projectId to avoid cross-project collisions on the globally-unique column)
4. Populate `human_email` from `agents.spawned_by_human_email` (for multi-human attribution)

**CLI install suggestion** (deferred): The `get_started` response could hint at CLI installation for higher-fidelity tracking, but there's no reliable way to distinguish CLI vs non-CLI callers in v1 (`hook_session_id` is deferred, and `handleGetStarted` at `get-started.ts:47` forwards a fixed whitelist of args). Revisit when `hook_session_id` or an equivalent signal is implemented.

**Fidelity gap between tiers**:
- Tier 1 captures every Edit/Write tool call automatically. However, commit attribution is an approximation: the session-end reconciliation uses `session_start_head..HEAD` + file-overlap filtering to identify qualifying commits, but if a human or another agent commits the same files after the baseline, that commit will also qualify. The attribution percentages for such commits will be split based on the session's tracked edits, which may overcount this session's contribution. This is an acceptable approximation for v1 — the alternative (signing commits or tracking commit authorship) adds significant complexity.
- Tier 2/3 attribution may be incomplete — agents report what they choose to
- The system should never penalize Tier 2/3 agents for incomplete reporting
- Consider an `attribution_confidence` field on `commit_attributions` to distinguish "reported 0 edits" from "didn't report"

**Server files to modify** (in addition to Part B files):
- `src/tool-registry/entries/activity.ts` — extend existing file (already has `queryActivityFeedEntry`, `agentPerformanceMetricsEntry`) with `reportFileEditEntry` and `reportCommitEntry`
- `src/tools/handlers/activity-report.ts` — new file: `handleReportFileEdit` and `handleReportCommit` handlers
- No changes to `src/codemode/helpers-template.ts` — it builds the SDK dynamically from registry entries with `sdk` metadata. Adding `reportFileEditEntry` and `reportCommitEntry` with their `sdk` fields is sufficient; `chat.reportFileEdit()` and `chat.reportCommit()` will be auto-generated.

### Part C: Agent detail panel enhancement

For v1, commit cards in the message stream (Part B) are the primary chat view integration. The agent detail panel already shows activity data — enhance it with a code contributions summary.

**Agent detail panel** (`src/ui/chat/script-parts/agent-detail.ts`):
Add a "Code Contributions" section below the existing activity log:
- Per-file summary: "src/auth.ts: +45/-12 (3 edits)"
- Session total: "230 lines added across 8 files"
- Data source: aggregate from `agent_activity` WHERE `tool_name IN ('Edit','Write') AND agent_id = ?`
- **Caveat**: If dedup narrowing (Part B) is not yet implemented, rapid edits to different files within 1 second will be undercounted. The section should display "approximate" or "at least N edits" until dedup is resolved.

**Files to modify**:
- `src/ui/chat/script-parts/agent-detail.ts` — code contributions section
- `src/tools/handlers/activity-query.ts` — add optional `aggregate_by_file` mode to `query_activity_feed`

### Deferred to v2

These features from Rev 3 are architecturally sound but should wait until the v1 path (commit cards as messages) works end to end:

| Feature | Why defer | Prerequisite |
|---------|-----------|-------------|
| **Edit-summary cards** ("worker-2 edited 3 files — +67/-23") | Adds noise between messages without clear UX benefit over commit cards. Need user feedback on whether commit-level granularity is sufficient. | v1 commit cards working |
| **`code_activity` work waiter event** | Useful for agents watching files, but adds complexity to the waiter registry. Only needed when agents should react to other agents' commits. | v1 commit cards working, demonstrated demand |
| **Styled commit card rendering** | Chat UI can detect `[commit]` subject prefix and render with tables/colored bars. But plain markdown is readable enough for v1. | v1 commit cards working |
| **Harness-side commit detection** | The harness sees Bash events and could detect `git commit` in near-real-time (rather than session-end). Better UX but more complex. | v1 session-end reconciliation working |
| **Intent-scoped attribution** | Wire `intent_id` into attribution flow. Infrastructure exists (`file_contributions.intent`, `getAgentActiveIntentId()`). Low effort but depends on commit attribution working first. | v1 commit cards working |

### Part E: Multi-human future

The system is designed for one human overseeing multiple agents today, scaling to multiple humans with their own agent teams later. The attribution model supports this:

**Already in place**:
- `agents.spawned_by_human_email` — knows which human spawned which agent
- `human_members` table — humans in workspace with presence tracking
- `commit_attributions.human_email` — tracks which human's agent committed
- Workspace federation (documented, not yet implemented) — cross-workspace agent collaboration

**What this means for attribution**:
When Human A's `worker-1` and Human B's `worker-3` both contribute to a commit, the commit card shows:
```
| File | Changes | Attribution |
|------|---------|-------------|
| `src/auth.ts` | +120 / -30 | worker-1 @alice (65%), worker-3 @bob (35%) |
```

**No implementation work for Phase 1** — the data model supports it. Rendering changes happen when multi-human workspaces are implemented.

---

## Priority Order

1. **PII detection in verify** — cleanest standalone feature. No cross-system dependencies. Ship as written. ~2-3 days.
2. **Token usage polish** — small task, mostly done. Add `token_events` counter, improve activity output. ~0.5 day.
3. **Code activity tracking — Part A (CLI capture)** — standalone diff tracking from Edit/Write PostToolUse events. Session-end commit reconciliation with file-overlap scoping and idempotency. Works without server. ~2-3 days.
4. **Code activity tracking — Part B (Server ingestion)** — `commit_attributions` table (with UNIQUE constraint), ambient commit card messages (via `insertAmbientMessage` helper with idempotency pre-check), dedup narrowing in `recordActivity()`. ~2-3 days.
5. **Code activity tracking — Part B.5 (Server-standalone SDK)** — `report_file_edit` / `report_commit` tools and SDK methods. Shares handlers with Part B. ~1-2 days.
6. **Code activity tracking — Part C (Agent detail panel)** — code contributions summary in existing panel. Depends on Part B dedup fix for accurate counts. ~1 day.
7. **v2 features** — edit-summary cards, styled commit card rendering, `code_activity` waiters, harness-side real-time commit detection, intent-scoped attribution, `hook_session_id` explicit linkage, Codex Tier 1 normalizer. Deferred until v1 path is validated.

Parts A, B, and B.5 can be developed in parallel (A is CLI-side, B and B.5 are server-side). Part C depends on B (dedup fix). v2 features depend on v1 validation.

---

## Removed from Plan

| Original feature | Why removed | What replaces it |
|-----------------|-------------|------------------|
| **Full session transcript capture** | Depends on undocumented Claude Code internals (`~/.claude/projects/` JSONL format) that will change without notice. High effort, fragile. | Diff-based code tracking captures the "what code was written" story from tool call data the hook script already sees. |
| **Line-range attribution** (`line_ranges: [number, number][]`) | Line ranges invalidate on subsequent edits — insertions shift all downstream ranges with no correction mechanism. The attribution numbers silently become wrong. | Diff counting (lines_added/lines_removed per edit) is append-only and immune to subsequent edits. Commit-time reconciliation via `git diff --numstat` provides the final accurate numbers. |
| **Subagent token breakdown** (`subagent_tokens: Record<string, TokenUsage>`) | Adds complexity for a v1. No demonstrated demand yet. | Defer. Subagent edits already roll up to parent via existing `SubagentState` tracking. Token breakdown can be added later if needed. |

---

## Non-Goals

- **Content overlap / transcript dedup** (Entire's `content_overlap.go`): 622 lines solving a problem specific to their Git-native architecture. Our server-side storage doesn't need this.
- **Git orphan branch storage**: Their approach of storing metadata on Git branches is clever but adds complexity. Our `.interlinked/` directory + server sync is simpler and already works.
- **AI-generated session summaries**: Would require LLM invocation from the CLI (no API access) or a non-interactive Haiku call on hook events. Revisit if we add a lightweight LLM integration to the harness.
- **Commit trailers for attribution**: Adds noise to git history. Store attribution in session state and server-side instead.
- **Per-harness hook adapters** (Cursor, Copilot, etc.): Entire has a pluggable agent interface for different tools. We support non-CLI agents via the SDK/MCP tool path (Part B.5), which is harness-agnostic. Building custom hook adapters per tool is unnecessary unless a specific tool has hooks we can leverage (the CLI already supports Claude Code, Gemini CLI, and Codex hooks).
- **Real-time per-keystroke tracking**: Edit events arrive at PostToolUse granularity (per tool call), not per keystroke. This is the right level — per-keystroke would be prohibitively noisy and expensive.
- **Altering `file_contributions` CHECK constraint**: The table serves reservation lifecycle tracking. Adding edit event types would conflate two different concerns. Use `agent_activity` for edit events and `commit_attributions` for commit-level data.
