# Interlinked CLI Command Reference

This is the exact command surface for `interlinked` v0.1.0.

## Global Behavior

- `interlinked` (no subcommand):
1. Unconfigured + interactive terminal: setup wizard.
2. Unconfigured + non-interactive shell: non-interactive bootstrap.
3. Configured: runs `interlinked status`.
- `--json` is supported by most operational commands.
- `--short` and `--full` are supported by selected read/display commands.

## Setup Commands

### `interlinked enable`

Install hooks and initialize `.interlinked/` config.

Options:
- `--server <url>`
- `--agent <name>`
- `--clients <list>` (`claude,gemini,codex`)
- `--sync-mode <mode>` (`realtime`, `local`, `manual`)
- `--data-dir <path>`
- `--dry-run`

### `interlinked disable`

Remove installed hooks.

Options:
- `--keep-config`

### `interlinked login`

Authenticate to Interlinked MCP Server via OAuth PKCE (or manual token).

Options:
- `--server <url>`
- `--token <token>`

### `interlinked attach`

Attach local CLI config to workspace/agent and attempt remote identity linking.

Options:
- `--server <url>`
- `--workspace <id>` (`ws_...`, registry workspace ID for routing/sync)
- `--workspace-key <key>` (internal MCP `workspace_key`, default `main`)
- `--project <key>` (internal MCP `project_key`, default `main`)
- `--agent <name>`
- `--json`

### `interlinked setup`

Run `enable` then `login` when needed.

Options:
- `--server <url>`
- `--agent <name>`
- `--clients <list>`
- `--sync-mode <mode>`
- `--token <token>`
- `--dry-run`

## Observability Commands

### `interlinked status`

Local-first dashboard with optional server health.

Options:
- `--short`
- `--full`
- `--json`
- `--watch [seconds]`

### `interlinked activity`

Merged local + server activity feed with dedup.

Options:
- `--agent <name>`
- `--limit <n>`
- `--since <duration>`
- `--json`

### `interlinked explain`

Narrative timeline from activity events.

Options:
- `--agent <name>`
- `--since <duration>`
- `--full`
- `--json`

### `interlinked sync`

Push unsynced local events (`activity.jsonl`) to server in batches.

Options:
- `--dry-run`
- `--limit <n>`
- `--json`

## Maintenance Commands

### `interlinked doctor`

Run local checks and optional server checks.

Options:
- `--fix`
- `--json`

### `interlinked clean`

Inspect/remove stale local data.

Options:
- `--dry-run`
- `--force`
- `--json`

### `interlinked reset`

Remove all local Interlinked CLI state.

Options:
- `--force` (required)
- `--json`

## Checkpoint Commands

### `interlinked checkpoint [message]`

Create a checkpoint (default message if omitted).

Options:
- `--agent <name>`
- `--json`

Subcommands:
- `interlinked checkpoint list [--agent <name>] [--since <duration>] [--limit <n>] [--json]`
- `interlinked checkpoint show <id> [--json]`
- `interlinked checkpoint compare <id1> <id2> [--json]`
- `interlinked checkpoint prune [--older-than <days>] [--keep-latest <n>] [--json]`
- `interlinked checkpoint archive [--json]`

### `interlinked rewind [checkpoint-id]`

Restore working tree from checkpoint.

Options:
- `--force`
- `--list`
- `--json`

### `interlinked resume [checkpoint-id]`

Resume from latest/specified checkpoint with local context (plus server context when available).

Options:
- `--agent <name>`
- `--json`

## Workspace and Coordination Wrappers

### `interlinked workspace list`

Show available registry workspaces (`ws_...`) from the Interlinked MCP Server.

Options:
- `--json`

### `interlinked workspace switch <id>`

Set active workspace (`ws_...`) in local config for active server entry.

### `interlinked inbox`

Read recent server messages.

Options:
- `--all`
- `--agent <name>`
- `--limit <n>`
- `--since <duration>`
- `--json`
- `--short`
- `--full`

### `interlinked send <to> [message]`

Send a message via server.

Options:
- `--file <path>`
- `--importance <level>`
- `--json`

### `interlinked tasks list`

List tasks.

Options:
- `--status <status>`
- `--assignee <name>`
- `--priority <level>`
- `--limit <n>`
- `--json`
- `--short`
- `--full`

### `interlinked tasks create <title>`

Create task.

Options:
- `--description <text>`
- `--assignee <name>`
- `--priority <level>`
- `--json`

### `interlinked tasks show <id>`

Show task details.

Options:
- `--json`

### `interlinked tasks claim <id>`

Claim task.

Options:
- `--json`

### `interlinked tasks complete <id>`

Complete task.

Options:
- `--json`

### `interlinked handoff <from-agent> <to-agent>`

Send structured handoff with context.

Options:
- `--include-files`
- `--json`

## Index Commands (Grep Acceleration)

### `interlinked index build`

Build a full trigram search index from the current codebase. Scans all git-tracked files, extracts overlapping 3-character sequences, and stores an inverted index in `.interlinked/index/`.

Options:
- `--cwd <path>` (default: current directory)
- `--max-file-size <bytes>` (default: 1048576 = 1MB)
- `--stop-threshold <ratio>` (default: 0.4 — trigrams in > 40% of files are skipped as too common)

Output: file count, trigram count, stop trigram count, index size, base commit.

### `interlinked index update`

Incrementally update the index from git changes since the base commit. Only re-indexes files that changed.

Options:
- `--cwd <path>`

### `interlinked index status`

Show index statistics and freshness.

Options:
- `--cwd <path>`
- `--json`

### `interlinked index query <pattern>`

Debug tool: decompose a pattern into trigrams and show which files are candidates.

Options:
- `--cwd <path>`
- `--regex` (treat pattern as regex instead of literal)

## Trace / UX Commands

### `interlinked trace export`

Export local activity trace.

Options:
- `--since <duration>`
- `--agent <name>`
- `--output <file>`
- `--format <fmt>` (`json`, `jsonl`)
- `--json`

### `interlinked trace import <file>`

Import trace file into local activity log.

Options:
- `--json`

### `interlinked completions <shell>`

Emit shell completion script.

Args:
- `shell`: `bash`, `zsh`, `fish`

### `interlinked version`

Show CLI version and server reachability.
