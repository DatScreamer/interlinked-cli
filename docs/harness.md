# Interlinked Harness — Architecture & Decision Record

## What Is The Harness?

The Interlinked Harness is a local server that runs on each developer's machine. It intercepts AI coding agent actions (Claude Code, Gemini CLI, Codex) via hook events, evaluates them against guard rules, manages file reservations, and enforces agent lifecycle policies.

It is the **third component** of the Interlinked platform:

| Component | Role | Runs Where |
|-----------|------|------------|
| Interlinked MCP Server | System of record: agents, messages, tasks, reservations, team state | Cloudflare Workers (shared) |
| Interlinked CLI | Hook installation, activity capture, local storage, developer observability | Each developer's machine |
| **Interlinked Harness** | Guard evaluation, auto-reservations, agent lifecycle, quality checks | Each developer's machine (Node.js) |

The CLI and harness are shipped together as the `interlinked-cli` npm package.

## Why A Local Harness Server?

### The Problem

AI coding agents can:
- Run destructive shell commands (`rm -rf /`, `git push --force`, `DROP DATABASE`)
- Write secrets into source files
- Go to "sleep" in the terminal instead of staying in their MCP work loop
- Ask the human for input via the terminal instead of via MCP messages
- Edit files that another agent (on the same or a different developer's machine) is already editing
- Curl localhost URLs when they should be using MCP tools (indicating a disconnected MCP server)
- Write code with type errors, security vulnerabilities, or invalid syntax

### Why Not Just Inline Pattern Matching?

The original approach was a standalone `command-guard-hook.ts` file that pattern-matched shell commands. This had limitations:

1. **No state** — couldn't track what the agent had done previously in the session (trajectory)
2. **No coordination** — couldn't check file reservations from the server
3. **No quality checks** — couldn't run `tsc` or linters after file edits
4. **No cohort awareness** — couldn't distinguish "my other agent" from "someone else's agent"
5. **Single agent only** — was Claude Code-specific, didn't work for Gemini or Codex

### Why Not Call the Remote Server for Every Check?

Adding 50-200ms of network latency to every PreToolUse event would be too slow. The agent would feel sluggish. The harness runs locally with <5ms evaluation latency.

### The Sondera Inspiration

[Sondera](https://github.com/sondera-ai/sondera-coding-agent-hooks) built a similar architecture in Rust: a local harness server on a Unix socket that evaluates Cedar policies with YARA signature matching. Their key insights that we adopted:

- **Unix socket for speed** — sub-millisecond IPC, no HTTP overhead
- **Agent-agnostic event normalization** — same evaluation engine regardless of which agent
- **Default-permit with targeted forbid** — allow everything except known-bad patterns
- **STEER over BLOCK** — deny with reasoning so agents can self-correct

What we added that Sondera doesn't have:
- **Remote server coordination** — file reservation sync, team-wide visibility
- **Agent lifecycle enforcement** — sleep prevention, MCP-first communication
- **Cohort awareness** — tracking all of one developer's agents together
- **Auto file reservation** — transparent lease management without explicit MCP calls
- **Quality checks** — PostToolUse TypeScript compilation, lint, secrets scanning

### Runtime: Node.js

The harness runs on Node.js using `node:net` for Unix socket IPC. The server is pre-compiled to JavaScript via tsup (`cli/dist/harness/server.js`) for fast startup, or can be run from TypeScript source via `npx tsx` during development.

**Why Node.js?**
1. **Universal** — no extra runtime install required (Node.js is already a dependency)
2. **Pre-compiled startup** — tsup-compiled JS starts in ~100ms, eliminating the need for a separate runtime
3. **Same language** as the rest of the CLI codebase (TypeScript)
4. **Standard Unix socket support** via `node:net` `createServer({ path: ... })`
5. **npm distribution** — ships as a standard npm package, no binary compilation needed

> **Historical note:** The harness originally used Bun for its fast startup and native TypeScript support. It was migrated to Node.js to eliminate the Bun dependency and simplify distribution. Pre-compiling to JS via tsup achieves comparable startup performance.

## Architecture

```
Coding Agent (Claude Code / Gemini / Codex)
    │
    │ Hook event (stdin JSON)
    ▼
Hook Script (.interlinked/hooks/interlinked-activity.mjs)
    │
    ├─── Local JSONL write (always, sync, ~0.1ms)
    │
    ├─── Connect to harness Unix socket (~1-5ms)
    │    │
    │    ▼
    │  Interlinked Harness Server (Node.js)
    │    │
    │    ├─ Guard Evaluator
    │    │  ├─ Lifecycle: sleep blocking, AskUserQuestion redirect
    │    │  ├─ Destructive: rm -rf, force push, DROP DATABASE, pkill
    │    │  ├─ Security: secrets, path traversal, exfiltration, pipe-to-bash
    │    │  ├─ Code quality: JSON validity, Edit old_string verification
    │    │  ├─ Reservations: auto-reserve files, check for conflicts
    │    │  └─ MCP connectivity: curl-to-localhost detection
    │    │
    │    ├─ Grep Accelerator (PreToolUse Grep/Bash interception)
    │    │  ├─ Trigram index query (~10-50μs)
    │    │  ├─ Candidate file narrowing
    │    │  └─ Block-and-answer with ripgrep results
    │    │
    │    ├─ Quality Checks (PostToolUse, 18 checks across 8+ languages)
    │    │  ├─ TypeScript (tsc), Biome, ESLint, secrets, strong typing, affected tests
    │    │  ├─ Python (mypy, ruff), Rust (cargo check/clippy), Go (go build, golangci-lint)
    │    │  ├─ C/C++ (compile, clang-tidy), Semgrep, gitleaks, dependency audit
    │    │  └─ Prompt injection detection
    │    │
    │    ├─ Structural Checks (PostToolUse, 22 dependency-aware checks)
    │    │  ├─ Export surface, import resolution, hallucinated imports, dead imports/exports
    │    │  ├─ Import cycles, interface change impact, blast radius, smart tsc
    │    │  └─ Stale read warnings, sibling awareness, route context, completion tracking
    │    │
    │    ├─ Analysis Subsystems
    │    │  ├─ Project graph (multi-file dependency tracking with cache)
    │    │  ├─ Impact analysis (cross-file breaking change detection)
    │    │  ├─ Change propagation (side-effect tracking)
    │    │  ├─ Error history (pattern memory, optional embeddings)
    │    │  ├─ Taint tracker (sensitivity classification: Public/Confidential/Secret)
    │    │  └─ Suggestion scorer (weighted finding ranking)
    │    │
    │    ├─ Trigram Index (.interlinked/index/)
    │    │  ├─ Loaded on startup, incremental update on SessionStart
    │    │  └─ Dirty layer updated on PostToolUse file edits
    │    │
    │    ├─ Cohort Manager (tracks all agents for this developer)
    │    ├─ Session Tracker (per-session trajectory state)
    │    ├─ Reservation Manager (local cache + server sync)
    │    └─ Server Bridge (reservation sync, guard event reporting)
    │
    ├─── Fire-and-forget POST to Interlinked MCP Server
    │
    ▼
  PreToolUse: stdout {decision: "block"|"allow", reason?}
  PostToolUse: stderr warnings (agent sees and self-corrects)
```

### Graceful Degradation

If the harness is not running:
- The hook script falls back to **inline pattern matching** (a minimal subset of critical rules embedded in the `.mjs`)
- No quality checks run (PostToolUse is observe-only)
- No grep acceleration (agents use full ripgrep scan — slower but correct)
- No auto-reservations (relies on server-side reservation system via MCP tools)
- Activity capture still works (JSONL + server sync are independent of harness)

This means the system is safe even if:
- The developer doesn't start the harness
- The harness crashes
- The Unix socket is unreachable

## Key Design Decisions

### 1. PreToolUse vs PostToolUse — What Goes Where?

**PreToolUse** (blocks before the tool executes):
- All checks that can be done with the tool call arguments alone (no execution needed)
- Pattern matching on commands, file paths, content
- File reservation conflict detection
- Sleep/terminal-input prevention
- Must be fast (<500ms total, ideally <50ms)

**PostToolUse** (feedback after the tool executes):
- Checks that need the full project context or take significant time
- TypeScript compilation (`tsc --noEmit`) — needs tsconfig.json, node_modules, all source files
- Lint checks — need full project context
- Results written to stderr so the agent sees them on the next turn and self-corrects

**Why not PreToolUse for type checking?**
Running `tsc` on PreToolUse would mean:
1. The proposed code needs to be written to a temp file first (the agent's Edit hasn't landed yet)
2. `tsc --noEmit` on one file still needs the full project context
3. It adds 5-15 seconds to every `.ts` file edit
4. The agent would feel very slow

PostToolUse is better because:
1. The file is already written to disk — `tsc` can check it directly
2. The agent continues working while the check runs
3. If errors are found, they appear as stderr output — the agent self-corrects on the next turn
4. Two tool calls (write + fix) is more efficient than blocking repeatedly

### 2. Auto File Reservation — Optimistic Locking

**Decision:** Reservations are checked against a local cache (instant), confirmed with the server asynchronously (non-blocking).

**Why:** Checking the server synchronously on every file write would add 50-200ms latency. The optimistic approach means:
- First write: check local cache → no conflict → allow immediately → reserve on server in background
- Subsequent writes to same file: local cache already shows reservation by this agent → allow instantly
- Conflict detection: another developer's agent reserved the file → local cache (refreshed every 30s) shows the conflict → block

**Trade-off:** There's a ~30 second window where two developers could both start editing the same file before the cache syncs. In practice this is rare, and the server's reservation system is the authoritative conflict resolver.

**Release timing:** Files are auto-released 30 seconds after the last edit. This prevents rapid reserve/release churn during multi-file edits while ensuring files don't stay locked when the agent moves on.

### 3. Agent Cohort Model

**Decision:** The harness tracks all agents belonging to one human developer as a "cohort."

**Why:** A developer often has multiple agents running:
- A primary Claude Code session
- Subagents spawned by the primary (researcher, test-writer)
- A secondary Gemini CLI for quick tasks

The cohort model lets the harness:
- **Warn** when two of the developer's own agents conflict (instead of blocking)
- **Block** when a different developer's agent holds a reservation
- Track agent health across all sessions (detect "lost" agents that stopped responding)

**Lifecycle events:**
- `agent_join` — agent connects, registered in cohort
- `agent_leave` — agent disconnects gracefully
- `agent_lost` — no events for 5 minutes, likely crashed or disconnected
- `subagent_join/leave` — subagents tracked as children of their parent

### 4. No Agent Sleep — MCP-First Communication

**Decision:** The harness blocks `bash sleep` commands and warns agents that use `AskUserQuestion`.

**Why:** The biggest friction in multi-agent development is agents going idle in the terminal. They sleep, they ask the terminal for input, they exit their work loop. This forces the human developer to constantly monitor terminals and type responses.

The correct pattern is:
1. Agent calls `wait_for_work()` on the MCP server (blocks server-side, ~1-5ms wakeup)
2. Human sends messages/tasks through the MCP web UI (`/chat`)
3. Agent receives work via `wait_for_work` and acts on it
4. Agent reports results via MCP tools

The harness enforces this by:
- **Blocking** `sleep` commands with a message: "Use wait_for_work MCP tool instead"
- **Warning** on `AskUserQuestion` with: "Send a message via MCP instead of asking the terminal"
- Detecting when agents curl localhost (MCP server likely disconnected) and escalating

### 5. Multi-Agent Provider Support

**Decision:** All guard rules work identically across Claude Code, Gemini CLI, and Codex.

**How:** The hook script normalizes events from all agents into a common format (`HarnessEvent`) before sending to the harness. The evaluator doesn't know or care which agent produced the event. Tool names are matched flexibly:
- Claude Code: `Bash`, `Read`, `Write`, `Edit`
- Gemini CLI: `Shell`, `ReadFile`, `WriteFile`, `EditFile`
- Both: matched by the evaluator's helper functions (`isBash`, `isFileWrite`, etc.)

**Limitation:** Codex currently only has `notify` hooks (post-execution). PreToolUse blocking is not available for Codex until they add a pre-execution hook. The harness still processes Codex events for activity tracking and quality checks.

### 6. Rules Configuration — Team-Shared + Personal Overrides

**Decision:** Two-tier rule configuration mirroring the Interlinked CLI config pattern.

| File | Git | Purpose |
|------|-----|---------|
| `.interlinked/guard-rules.json` | Committed | Team-shared rules, protected files, quality check config |
| `.interlinked/guard-rules.local.json` | Gitignored | Personal overrides: disable specific rules, add exceptions |

**Why:** Teams need shared safety policies (everyone should be blocked from `rm -rf /`), but individual developers may need exceptions (e.g., a DevOps engineer who legitimately uses `terraform destroy`).

The rules are loaded at harness startup and hot-reloaded when files change. Built-in rules (77 rules across 16 categories — see `docs/generated/guard-rules.md` for the full reference) are always active unless explicitly disabled in the local override file.

### 7. Server Bridge — Coordination Without Dependency

**Decision:** The harness works standalone but coordinates with the Interlinked MCP server when available.

**When server is available:**
- File reservations are synced every 30 seconds
- Guard events (blocks, warnings) are reported to the server for team dashboard visibility
- `X-Interlinked-Harness-Version` header on activity POSTs identifies harness-processed events

**When server is unavailable:**
- Harness continues working with local-only reservation cache
- Guard events are queued and flushed when connectivity returns
- Quality checks and pattern matching are unaffected (entirely local)

## File Reference

**Core:**
| File | Purpose |
|------|---------|
| `cli/src/harness/types.ts` | All type definitions: events, decisions, rules, cohort, reservations, config |
| `cli/src/harness/server.ts` | Node.js Unix socket server — the main entry point (`node:net`) |
| `cli/src/harness/evaluator.ts` | Guard evaluation — PreToolUse blocking + PostToolUse feedback |
| `cli/src/harness/rules-loader.ts` | Rule loading: 77 built-in + team JSON + personal overrides + hot-reload |
| `cli/src/harness/session-state.ts` | Per-session trajectory tracking (files, commands, tool counts) |
| `cli/src/harness/cohort.ts` | Agent cohort manager (join/leave/lost detection, file tracking) |
| `cli/src/harness/reservations.ts` | Auto file reservation (optimistic lock, 30s release, server sync) |
| `cli/src/harness/quality-checks.ts` | PostToolUse runners: 18 checks across 8+ languages |
| `cli/src/harness/server-bridge.ts` | Server coordination: reservation sync, guard event reporting |
| `cli/src/harness/trigram-index.ts` | Trigram search index: build, query, serialize, dirty layer, incremental git update |
| `cli/src/harness/regex-trigrams.ts` | Regex → trigram decomposition, ripgrep command parsing, shell tokenizer |
| `cli/src/harness/grep-accelerator.ts` | PreToolUse grep acceleration: intercept search tools, query index, block-and-answer |

**Analysis subsystems:**
| File | Purpose |
|------|---------|
| `cli/src/harness/structural-checks.ts` | 22 dependency-aware checks (export surface, imports, cycles, blast radius) |
| `cli/src/harness/generic-checks.ts` | 50+ inline code analysis checks (SQL injection, complexity, async/await, etc.) |
| `cli/src/harness/project-graph.ts` | Multi-project file dependency graph with caching |
| `cli/src/harness/impact-analysis.ts` | Cross-file dependency tracking and breaking change detection |
| `cli/src/harness/change-propagation.ts` | Side-effect tracking across edits |
| `cli/src/harness/error-history.ts` | Error pattern memory with optional embeddings support |
| `cli/src/harness/language-profiles.ts` | Language-specific checks for 12+ languages |
| `cli/src/harness/taint-tracker.ts` | Sensitivity classification and flow tracking |
| `cli/src/harness/pattern-detector.ts` | Cross-cutting pattern detection |
| `cli/src/harness/suggestion-scorer.ts` | Weighted finding scoring and ranking |
| `cli/src/harness/suppressions.ts` | Inline suppression directives |
| `cli/src/harness/check-metadata.ts` | Structural check metadata for docs generation |
| `cli/src/harness/check-engine/` | Unified caching/memoization layer for checks |

**CLI commands and config:**
| File | Purpose |
|------|---------|
| `cli/src/commands/harness.ts` | CLI commands: `interlinked harness start/stop/status/test` |
| `cli/src/commands/index-cmd.ts` | CLI commands: `interlinked index build/update/status/query` |
| `cli/scripts/generate-docs.ts` | Auto-generates reference docs from source code |
| `.interlinked/guard-rules.json` | Default team-shared guard rules configuration |
| `.interlinked/index/trigram.bin` | Binary trigram index (generated by `interlinked index build`) |
| `.interlinked/index/meta.json` | Index metadata: file count, trigram count, base commit, build time |

**Auto-generated reference docs** (run `npm run docs` to regenerate):
| File | Contents |
|------|----------|
| `cli/docs/generated/guard-rules.md` | All 77 built-in guard rules by category |
| `cli/docs/generated/quality-checks.md` | All 18 PostToolUse quality checks |
| `cli/docs/generated/structural-checks.md` | All 22 structural checks by tier |
| `cli/docs/generated/configuration.md` | Default config: diff-aware filtering + structural check settings |

## Grep Acceleration — Trigram Search Index

### What It Does

The harness intercepts Grep and Bash (rg/grep) tool calls and uses a trigram inverted index to narrow the file set before running ripgrep. Instead of scanning every file in the repo, ripgrep only scans the files that could possibly contain the search pattern.

This accelerates searches from all tools: Claude Code's `Grep` tool, `Bash` commands running `rg`/`grep`, and subagent searches (Explore, Search agents). The acceleration is transparent — agents don't need to change how they search.

### How It Works

1. **Build an index**: `interlinked index build` scans all git-tracked files, breaks content into overlapping 3-character sequences (trigrams), and builds an inverted index: trigram → file list.

2. **Harness loads the index** on startup and incrementally updates it from `git diff` on each `SessionStart`.

3. **On every Grep/rg call**: the harness decomposes the search pattern into trigrams, intersects the posting lists, and gets a set of candidate files. If the candidates are a small subset of the total, it runs ripgrep only on those files and returns results via the block-and-answer pattern.

4. **Dirty layer**: when agents edit files (PostToolUse), the harness re-extracts trigrams for the edited file in memory. Agent writes are searchable immediately.

### Performance

Measured on the Interlinked monorepo (612 files, 3.8 MB index):

| Pattern | Index query | Candidates | Compared to full rg |
|---------|-------------|------------|---------------------|
| `handleAuthCallback` | 10μs | 1/612 | ~1,000x faster |
| `evaluatePreToolUse` | 13μs | 7/612 | ~900x faster |
| `OAuthProvider` | 12μs | 10/612 | ~900x faster |
| `execute_coordination_script` | 35μs | 59/612 | ~330x faster |

Index build: **0.4 seconds** for 612 files. Incremental update after branch switch: **< 1 second**.

The speedup is more dramatic on larger repos. On a 50K-file monorepo, ripgrep scans take 5-15 seconds; the index query still takes ~10-50μs.

### CLI Commands

```bash
interlinked index build               # Full build from git HEAD
interlinked index update              # Incremental from git diff since base commit
interlinked index status              # Show index stats and freshness
interlinked index query <pattern>     # Debug: show candidate files for a pattern
interlinked index query --regex <pat> # Debug: regex pattern decomposition
```

### Decision Logic

When the harness intercepts a search tool call:

| Condition | Action |
|-----------|--------|
| No index loaded | Pass through (normal grep) |
| Pattern has < 3 literal characters | Pass through (can't form a trigram) |
| Pattern is pure wildcard (`.*`, `.+`) | Pass through (no extractable literals) |
| 0 candidate files | Block with "no files match" (saves agent a slow empty search) |
| 1–500 candidates (< 30% of repo) | Block with ripgrep results on candidates only |
| > 500 candidates or > 30% of repo | Allow with warning: "broad pattern, consider narrowing" |

### What Agents See

When the index intercepts a search, the agent sees results like:

```
[interlinked:index] Searched 7 candidate files (from 612 total, 1.14% selectivity)

src/harness/evaluator.ts:112: export function evaluatePreToolUse(
src/harness/server.ts:263:   const preDecision = evaluatePreToolUse(
...
```

This includes selectivity metadata that helps the agent assess whether results are complete.

### Index Freshness

| Trigger | What happens | Speed |
|---------|-------------|-------|
| `interlinked index build` | Full rebuild from `git ls-files` | 0.1-0.5s for small repos, ~10s for 50K files |
| `SessionStart` hook | Incremental update from `git diff` since base commit | < 1 second |
| Agent edits a file | Dirty layer update (in-memory, per-file) | ~5μs |
| `interlinked index update` | Explicit incremental CLI update | < 1 second |

### Files

| Path | Contents |
|------|----------|
| `.interlinked/index/trigram.bin` | Binary index (gitignored) |
| `.interlinked/index/meta.json` | Metadata: file count, trigram count, base commit, build time |

The index should be added to `.gitignore` — it's machine-local and fast to rebuild.

## Guard Rules — Overview

> **Full reference:** See `docs/generated/guard-rules.md` (auto-generated, 77 rules across 16 categories).

### Lifecycle Enforcement

| Check | PreToolUse | Action | Condition |
|-------|-----------|--------|-----------|
| Sleep blocking | Yes | Block | `sleep` in Bash command |
| AskUserQuestion redirect | Yes | Warn | Tool name is `AskUserQuestion` |
| Curl-to-MCP detection | Yes | Warn → Block | `curl localhost:PORT` (escalates after 5 calls) |

### Built-in Rule Categories (77 rules across 16 categories)

Category counts below are derived from `docs/generated/guard-rules.md` (the
auto-generated source of truth — regenerate with `npm run docs` after adding
or removing a rule).

| Category | Rules | Examples |
|----------|-------|---------|
| Process Killing | 9 | `pkill -f`, `killall`, `kill -9`, multi-PID kill |
| Process Safety | 5 | `sleep` in agent commands, infinite-retry loops |
| File Deletion | 3 | `rm -rf /`, `rm .wrangler`, `rm node_modules` |
| Git Operations | 9 | `--force` push, `reset --hard`, `clean -f`, `filter-branch`, `stash drop` |
| Database | 5 | `DROP DATABASE/TABLE`, `TRUNCATE`, `DELETE` without WHERE, MongoDB drop, Redis flush |
| Cloud Providers | 5 | AWS destructive ops, S3 recursive, GCP/Azure destructive |
| Containers | 8 | Docker prune/rm -f/volume rm, kubectl mass delete/drain, helm uninstall |
| Infrastructure | 3 | Terraform destroy/auto-approve, Pulumi destroy |
| Supply Chain | 6 | Lock file deletion/tampering, build script injection, registry override |
| Filesystem | 4 | `dd` to block device, `shred`, disk format, `wipefs` |
| System Operations | 4 | `sudo rm`, `chmod 777`, shutdown/reboot, LVM removal |
| Wrangler | 5 | State deletion, worker deletion, KV bulk delete, D1 destructive SQL |
| Vercel | 2 | Deployment/project removal, env var deletion |
| Inline Scripts | 2 | Destructive ops in inline scripts, `bash -c` destructive |
| Language Destructive | 6 | Python/Rust/Go/C/Java destructive filesystem operations |
| Information Flow | 1 | Env exfiltration via shell redirection |

### Security Checks (evaluator-level)

| Check | PreToolUse | Action | What It Detects |
|-------|-----------|--------|-----------------|
| Secrets in file writes | Yes | Block | API keys, tokens, private keys, JWTs in Write/Edit content |
| Protected file paths | Yes | Block | .env, .pem, .key, CI configs, migration files |
| Path traversal | Yes | Block | `../`, `/etc/`, `/usr/` in file paths |
| Pipe-to-bash | Yes | Warn | `curl \| bash`, `wget \| sh` |
| Environment exfiltration | Yes | Block | `env \| curl`, `printenv \| nc` |
| Data exfiltration | Yes | Warn | `curl -d` POST to external URLs |
| Dependency confusion | Yes | Warn | `npm install --registry`, `pip install -i` |
| `--no-verify` bypass | Yes | Warn | `--no-verify` flag on any git command |
| `file://` protocol | Yes | Block | `WebFetch file://` |

### Code Quality (PreToolUse)

| Check | Action | What It Detects |
|-------|--------|-----------------|
| JSON validity | Warn | Invalid JSON syntax in `.json` file writes |
| Edit old_string verification | Block | `old_string` not found in file (edit will fail, saves a wasted tool call) |
| Oversized file read | Warn | Files >10MB (context consumption risk) |

### Code Quality (PostToolUse) — 18 checks

> **Full reference:** See `docs/generated/quality-checks.md` (auto-generated).

| Language | Checks | Default |
|----------|--------|---------|
| TypeScript/JS | tsc, Biome, ESLint, strong typing, affected tests | tsc + strong typing enabled |
| Python | mypy, ruff | Disabled |
| Rust | cargo check, cargo clippy | Disabled |
| Go | go build, golangci-lint | Disabled |
| C/C++ | compile, clang-tidy | Disabled |
| Cross-language | Secrets-in-source, Semgrep, gitleaks, dependency audit, prompt injection | Secrets enabled |

### Structural Checks (PostToolUse) — 22 checks

> **Full reference:** See `docs/generated/structural-checks.md` (auto-generated).

| Tier | Checks | Examples |
|------|--------|---------|
| Tier 1 (fast, sub-100ms) | 15 | Export surface, import resolution, dead imports/exports, hallucinated imports, stale read warnings |
| Tier 2 (medium, sub-1s) | 5 | Import cycles, interface change impact, test proximity, blast radius, layer violations |
| Tier 3 (conditional, 1-5s) | 2 | Smart tsc (single-file when safe), full impact analysis |

### Diff-Aware Filtering

> **Full reference:** See `docs/generated/configuration.md` (auto-generated).

Quality and structural checks support **diff-aware filtering** — pre-existing findings are suppressed so agents only see issues they introduced. Configurable per-check via `guard-rules.json`.

### Auto File Reservation

| Behavior | Trigger | Action |
|----------|---------|--------|
| Auto-reserve | PreToolUse Write/Edit | Reserve file, check for conflicts |
| Same-agent re-edit | PreToolUse Write/Edit on reserved file | Allow (already holds lock) |
| Same-cohort conflict | PreToolUse Write/Edit | Warn ("your other agent has this file") |
| Remote conflict | PreToolUse Write/Edit | Block ("Bob's agent has src/auth/*") |
| Auto-release | 30s after last edit | Release reservation |
| Session end | SessionEnd event | Release all reservations for agent |
| Agent lost | 5 min no events | Release all reservations |

## Testing

```bash
# All CLI tests (~765 total, includes harness)
cd cli && npx vitest run

# Guard evaluator tests
cd cli && npx vitest run src/harness/__tests__/evaluator.test.ts

# Trigram index + grep accelerator tests
cd cli && npx vitest run src/harness/__tests__/trigram-index.test.ts

# Structural checks, generic checks, impact analysis, etc.
cd cli && npx vitest run src/harness/__tests__/structural-checks-extended.test.ts
cd cli && npx vitest run src/harness/__tests__/generic-checks-extended.test.ts
cd cli && npx vitest run src/harness/__tests__/impact-analysis.test.ts

# Docs freshness (validates generated docs match source code)
cd cli && npx vitest run src/harness/__tests__/docs-freshness.test.ts

# Manual harness test
node cli/dist/harness/server.js --verbose &
interlinked harness test "rm -rf /"          # → BLOCKED
interlinked harness test "git push --force"  # → BLOCKED
interlinked harness test "sleep 30"          # → BLOCKED
interlinked harness test "npm run build"     # → ALLOWED
interlinked harness stop

# Build and test index
interlinked index build
interlinked index status
interlinked index query "handleAuth"

# Regenerate reference docs
cd cli && npm run docs
```

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **macOS** | Fully supported | Unix socket IPC, primary development platform |
| **Linux** | Fully supported | Unix socket IPC |
| **Windows (WSL)** | Supported | Runs inside WSL with Unix socket IPC |
| **Windows native** | Not yet supported | Future: TCP localhost fallback (Unix sockets unavailable natively) |

The harness communicates via a Unix domain socket at `.interlinked/harness.sock`. This provides sub-millisecond IPC latency on macOS and Linux. Windows users should use WSL, which supports Unix sockets natively.

## Quality Check Configuration

Quality checks, structural checks, and diff-aware filtering are all configurable via `.interlinked/guard-rules.json` (team-shared) and `.interlinked/guard-rules.local.json` (personal overrides).

See `docs/generated/configuration.md` for the full default configuration reference.

**Key configuration sections:**
- `quality_checks` — enable/disable each of the 18 PostToolUse checks
- `structural_checks` — enable/disable each of the 22 structural checks + thresholds
- `diff_aware` — control which checks suppress pre-existing findings
- `error_memory` — error pattern history with optional embeddings support

## Future Work (Not Yet Implemented)

- **Layer 3: LLM classifier** — Ollama or Claude API for semantic evaluation of complex cases (deferred to Phase 2)
- **Auto-checkpointing** — harness triggers git checkpoints before destructive operations or after N tool calls
- **Server-pushed team rules** — workspace owners configure rules via dashboard, harness pulls them
- **Agent loop enforcement** — detect when agent hasn't called `wait_for_work` in 5+ minutes, alert human
