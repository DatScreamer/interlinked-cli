---
name: interlinked-observability
description: Inspect what AI agents did — the local, offline-first activity log and observability commands. Load this when you want to see what happened this session, tail activity live, review what the guard blocked/warned, find recurring mistakes, inspect a specific session/event, view the dependency graph, backfill external (Codex) sessions, verify the tamper-evident guard-decision log, or push buffered events to the server. Covers `status`, `activity`, `logs` (with `--type`/`--follow`), `explain`, `watch`, `telemetry`, `trace`, `search`, `recurrence`, `viz`, `audit`, `collect`, `compact`, `sync`, and the activity.jsonl / collection.jsonl / timeline.jsonl event-log model.
---

# interlinked-observability — inspect what agents did

Interlinked captures **every AI-agent tool call locally** via hooks, offline-first, into
append-only JSONL under `.interlinked/`. The hook writes synchronously (~0.1ms), so the log is
current the moment a tool returns. You can answer *what did I (or a parallel agent) just do?
what ran, on what files, with what tokens? what did the guard block? what mistakes keep
recurring?* — **all without a server** (the server is optional enrichment).

## Load this when
- "What did I / another agent do this session?" — or you want to tail activity live.
- Reviewing what the guard blocked or warned.
- Finding recurring mistakes to harden against.
- Inspecting a specific session, event, or the repo dependency graph.
- Backfilling external (Codex) sessions, verifying the audit log, or syncing to the server.

## Command surface
Output-mode flags are **per-command** (not uniform); all support `--json`. `--since` grammar is
strict: `\d+(s|m|h|d)` (e.g. `30m`, `2d`) — `15` or `1.5h` throw.

**Dashboard / feed**
| Command | Purpose | Key flags |
|---|---|---|
| `status` | Local-first dashboard: sessions, recent activity, sync + optional server health | `--watch [s]` · `--short --full --json` |
| `activity` | Recent feed (local+server merged/deduped, token/cost totals) | `--agent --limit --since` · `--json` |
| `logs` | View/tail **local activity.jsonl** (offline, no server) | `-f/--follow --agent --tool --type --since --limit --raw` · `--json --short` |
| `explain` | Narrative chronological timeline + agent/human line-attribution | `--agent --since` (def 1h) `--full` · `--json` |
| `watch` | **Server** poll: unread messages, pending tasks, active agents (diffs between polls) | `--interval` (def 10s) · `--short --json` |

**Event log & raw**
| Command | Purpose |
|---|---|
| `telemetry [-f] [--limit] [--spool <p>]` | Tail the raw guard telemetry spool (`offline-spool.jsonl`: `hook_decision` rows). |
| `trace export [--since --agent --output --format json\|jsonl]` / `trace import <file>` | Export/import a portable agent-trace (dedups). |
| `collect [--provider codex --since --dir --dry-run]` | Fold external Codex sessions (`~/.codex/sessions/`) into `timeline.jsonl` (Claude is captured live). |
| `search <query> [--path --glob --type --limit --context --engine]` | Local codebase search (ripgrep, native fallback; multi-term → OR + density rank). |

**Audit & maintenance**
| Command | Purpose |
|---|---|
| `audit verify` | Verify the **tamper-evident, hash-chained guard-decision log** (`compact` archives read first). Bare `interlinked audit` just prints help — you must pass `verify`. *Not* a dependency audit — that's `interlinked allowlist verify`. |
| `compact [--dry-run --keep-recent-mb --all]` | Lossless gzip + rotate `activity.jsonl` (archives a safe prefix ≤ sync cursor; recoverable via `gunzip`). |
| `sync [--dry-run --limit]` | Push buffered events to the server (`POST /api/hooks/activity/batch`, secret+PII scrubbed at egress). Network — use `--dry-run` for a safe pending count. |

`interlinked metrics` (whole-repo code-quality scan) lives in **interlinked-quality-gates**;
`interlinked context` (effective config) in **interlinked-setup**.

## The event-log model
Data dir: `INTERLINKED_DATA_DIR` → `config.local.json.data_dir` → `INTERLINKED_HOME` →
`<cwd>/.interlinked/` (CWD-relative — run from the repo root).

| File | Holds |
|---|---|
| `activity.jsonl` | **Full-fidelity legacy stream — ALL event types** (lifecycle, prompts, tokens, guard telemetry, tool events). Also the hash-chained audit log. |
| `collection.jsonl` | **Canonical normalized records for TOOL events only** (richer projection). Non-tool types are not here. |
| `timeline.jsonl` | Unified time-sorted records of everything an agent did (incl. thinking/text); cross-model. `collect` target. |
| `sessions/<id>.json` | Per-session state: agent, phase, tool_count, files, tokens. |
| `sync-state.json` | Sync cursor = **byte offset** into activity.jsonl. |

`activity.jsonl` and `collection.jsonl` **overlap on tool events by design**; readers dedup by
event identity (`tool_use_id` + projected type), not by type — no double-counting, no lost
history. Don't "clean up" by deleting collection rows or dropping tool types from activity.jsonl.

**`logs --type <t>`** filters the raw `event.type` exactly (not the uppercase display labels).
Values: `session_start`, `session_end`, `tool_use_start`, `tool_use`, `tool_use_error`,
`permission_request`, `user_prompt`, `subagent_start`, `subagent_stop`, `notification`,
`context_compact`, `task_completed`, `agent_stop`, and guard telemetry `guard_allow` /
`guard_warn` / `guard_block`.

**Sync modes** (`sync_mode`, or `INTERLINKED_SYNC_MODE`): `realtime` (default — per-event POST +
session-end batch), `local` (never posts), `manual` (per-event POST, no auto batch — you run
`interlinked sync`).

## `interlinked recurrence` — repeating-pattern aggregation
Deterministic counting/grouping over `.interlinked/recurrences.jsonl` (no LLM), ranked by count.
Four observation kinds (all filterable via `--kind`):

| Kind | Source | Suggested action |
|---|---|---|
| `harness_caught` | auto — every PostToolUse check failure | ratchet (advisory→default→block) |
| `harness_missed` | manual — `recurrence flag <sig>` | scaffold a new rule |
| `codebase_existing` | `recurrence scan --record` (walks the tree, runs inline detectors) | cleanup PR |
| `tool_failure` | auto — repeated tool failures (same tool + error class) | inspect the pattern |

```bash
interlinked recurrence list --kind harness_caught --top 10
interlinked recurrence detail <signature>          # every event for one row
interlinked recurrence flag raw-sql-concat --message "spotted in db.ts" --file src/db.ts
interlinked recurrence scan --record               # append codebase_existing rows
interlinked recurrence propose <signature>         # suggested action for one signature
```

## `interlinked viz` — the living code-graph dashboard
```bash
interlinked viz serve [--port 6403] [--root <dir>]   # loopback-only HTTP dashboard, live SSE tail of activity
interlinked viz snapshot [--json] [--full]           # print the graph snapshot (no server): "N cells · M interlinks · stem <id>"
```
`viz serve` renders the repo as a cell/edge graph and tails `activity.jsonl` live over SSE
(daemon not required). It surfaces unscrubbed tool I/O, so it **binds loopback only** and
**blocks until Ctrl-C** — don't call it in a one-shot step.

## Common workflows
```bash
interlinked status                       # sessions + last events + sync/server health
interlinked explain --since 30m          # narrative timeline of the window
interlinked logs -f --type tool_use_error # tail only failing tool calls, live
interlinked logs --type guard_block --since 1h   # what the guard blocked
interlinked recurrence list --kind harness_caught --top 10   # recurring mistakes
interlinked status --full                # per-session tools + files + tokens
interlinked viz snapshot                 # one-line dependency-graph summary
interlinked sync --dry-run               # safe: pending count, no send
```

## Gotchas
- **`activity` vs `logs`:** `activity` = merged local+server feed (`--json` only); `logs` =
  local activity.jsonl only (offline, `--tool`/`--type`/`--follow`). Prefer `logs`/`status`/
  `explain` for pure introspection — they never touch the network.
- **`watch` and the send half of `sync` are server-only** — they need auth (and `workspace_id`
  for localhost dev); `watch` prints "Not authenticated" offline.
- **`viz serve` / `logs -f` / `watch` / `telemetry -f` block** until Ctrl-C.
- **`--type` filters the raw type** (`tool_use_error`, `guard_block`), not display labels
  (`ERROR`). Passing an unsupported mode flag to a command errors (flags are per-command).
- **Don't hand-truncate `activity.jsonl`** — the sync cursor is a byte offset; use
  `interlinked compact` (it respects the cursor and audit chain).

## Related skills
- **interlinked-quality-gates** — `interlinked metrics` (code-quality hotspots) and `recurrence scan`.
- **interlinked-harness** — the guard whose block/warn telemetry you're inspecting.
- **interlinked-coordination** — the server-backed side (tasks, messages) `watch`/`sync` reach.
