# Hook-Data Expansion Plan

**Status:** Step 1 landed. Tier 1+ specified below; not yet implemented.
**Scope:** Single-agent, CLI-only. No server-sync concerns, no cost math, no multi-agent coordination.
**Providers in scope:** Claude Code, Gemini CLI, GitHub Copilot CLI.
**Providers out of scope:** Codex CLI (hook surface not yet stable — revisit after Codex's hook system settles), Cursor CLI (no hook support).

## Goal

The CLI already captures hook events in `.interlinked/activity.jsonl`. This plan
widens the captured surface, normalizes across providers, and aggregates at the
right unit of analysis (the *turn* — one user prompt → agent stops).
Everything here runs against local files; no CLI feature here depends on the
Interlinked MCP Server being reachable or even installed.

## Step 1 — Widen the existing normalizers (DONE)

All Claude Code hook invocations carry `cwd`, `transcript_path`, and
`session_id` in the payload. We were dropping them. They're now captured on
every event. Same pass also:

- Adds `cli_version` + `available_tools_count` on `SessionStart`
- Adds `prompt_chars` on `UserPromptSubmit`
- Adds `tool_input_bytes` on `PreToolUse` and `tool_output_bytes` on `PostToolUse`
- Adds a canonical `status: "success" | "error"` on tool events
- Adds `error_category` on `PostToolUseFailure` (timeout / permission / blocked /
  user_interrupt / not_found / aborted / tool_error / unknown) derived from a
  small heuristic
- Adds `thinking` / `reasoning` tokens to the `tokens` shape on Stop /
  SubagentStop (if the provider supplies them)
- Adds `permission_mode` on `PermissionRequest`
- Adds `context_size_hint` on `PreCompact`
- Adds `duration_ms` on `SessionEnd` and `SubagentStop`

Gemini side:

- Handles `AfterModel` (was falling through to `default`) — surfaces token
  usage, model, finish reason, and the assistant's text for later analysis
- Adds `duration_ms` + `tool_output_bytes` on `AfterTool`
- Adds `context_size_hint` on `PreCompress`

All changes are inside `src/lib/hook-template-chunks/event-normalizers.ts`.
The generated `.mjs` hook must be re-emitted (`npm run build` or
`interlinked enable`) to take effect on an installed CLI.

## Canonical event schema (v2)

Every line in `activity.jsonl` conforms to this shape regardless of source
provider:

```jsonc
{
  "v": 2,
  "ts": "2026-04-23T14:30:00.123Z",
  "session_id": "abc",
  "turn_id": "xyz",                 // attached by aggregation, see Tier 1
  "provider": "claude-code",        // claude-code | gemini-cli | copilot-cli
  "event": "tool_post",             // canonical set, see below
  "hook_event": "PostToolUse",      // provider-native event name, verbatim
  "tool": "Edit",
  "duration_ms": 42,
  "input_bytes": 812,
  "output_bytes": 110,
  "status": "success",              // success | error | timeout | blocked | denied
  "error_category": null,           // populated on status=error
  "tokens": { "input": 300, "output": 42, "cached": 0, "thinking": 0 },
  "model": "claude-sonnet-4-6",
  "cwd": "/Users/q/repo",
  "transcript_path": "/Users/q/.claude/transcripts/abc.jsonl",
  "files": { "read": ["a.ts"], "written": ["b.ts"] }
}
```

Canonical event set:
`session_start`, `session_end`, `user_prompt`, `agent_stop`, `tool_pre`,
`tool_post`, `tool_error`, `permission_request`, `permission_response`,
`context_compact_pre`, `context_compact_post`, `subagent_start`,
`subagent_stop`, `notification`, `model_response`, `thinking_block`,
`slash_command`, `memory_read`, `memory_write`.

Step 1 already moves us most of the way to this schema (fields widen, canonical
names stay; the `provider` field is already attached upstream in the hook).
Remaining normalizer gaps are addressed in Tier 1.

## Tier 1 — Per-turn aggregation

**New files:**

### `.interlinked/turns.jsonl`

One line per agent turn (user prompt → agent stops). Written on `Stop`
(Claude Code) / `AfterAgent` (Gemini) / equivalent Copilot signal:

```jsonc
{
  "v": 1,
  "turn_id": "turn-abc",
  "session_id": "session-xyz",
  "provider": "claude-code",
  "start_ts": "2026-04-23T14:30:00.000Z",
  "end_ts": "2026-04-23T14:31:42.100Z",
  "duration_ms": 102100,
  "user_prompt_summary": "add a logger to utils/",
  "prompt_chars": 34,
  "tool_count": 7,
  "tools_by_name": { "Read": 3, "Edit": 2, "Bash": 2 },
  "files_read": ["a.ts", "b.ts"],
  "files_written": ["c.ts"],
  "subagents_spawned": 0,
  "thinking_blocks": 2,
  "permission_requests": 0,
  "errors": 0,
  "stop_reason": "end_turn",
  "tokens_total": { "input": 12034, "output": 451, "thinking": 2002 },
  "model": "claude-sonnet-4-6",
  "git_start": { "sha": "abc123", "dirty": 0 },
  "git_end": { "sha": "abc123", "dirty": 3 }
}
```

**Implementation:** a small buffer in the hook tracks turn state keyed by
`session_id`. On `UserPromptSubmit` the buffer resets; every `PreToolUse` /
`PostToolUse` / `ThinkingBlock` / `PermissionRequest` increments counters;
on `Stop` the buffer flushes to disk and clears.

### `.interlinked/tool-timing.jsonl`

Per-tool-call record:

```jsonc
{
  "v": 1,
  "ts": "2026-04-23T14:30:05.123Z",
  "session_id": "abc",
  "turn_id": "xyz",
  "tool": "Bash",
  "duration_ms": 840,
  "input_bytes": 512,
  "output_bytes": 4096,
  "status": "success",
  "retry_of_tool_use_id": null,
  "input_similarity_prev": null
}
```

Unlocks per-tool p50/p95/p99 latency without additional instrumentation.

### `.interlinked/thinking.jsonl`

Per-thinking-block metadata (content optional, privacy-gated):

```jsonc
{
  "v": 1,
  "ts": "2026-04-23T14:30:00.800Z",
  "session_id": "abc",
  "turn_id": "xyz",
  "chars": 1280,
  "tokens": 256,
  "has_uncertainty": false,          // heuristic: contains "I'm not sure" / "might" / etc
  "snippet_sha": "sha256:..."
}
```

If `config.local.json` has `collect_sensitive: true`, a parallel
`.interlinked/thinking-content/{sha}.txt` holds the raw text (gitignored).

### `.interlinked/compaction-events.jsonl`

```jsonc
{
  "v": 1,
  "ts": "2026-04-23T14:45:00.000Z",
  "session_id": "abc",
  "trigger": "auto",                // auto | manual | overflow
  "context_size_before": 180000,
  "context_size_after": null,       // populated if provider emits PostCompact
  "custom_instructions": null,
  "tools_seen_count_before": 47
}
```

If/when Claude Code emits a `PostCompact` event, a paired record is written
and the canonical event `context_compact_post` fires.

**CLI surface unlocked:**

- `interlinked turns --last 10` — recent turn rollups
- `interlinked turn <turn_id>` — drill into a single turn
- `interlinked timing` — aggregate tool-latency distributions

**Effort:** ~300 lines in the hook template (turn buffer) + 2 new readers in
`src/commands/`. A new turn module under `hook-template-chunks/` keeps the
template under its size budget.

## Tier 2 — Raw provider-events archive

**New files:**

- `.interlinked/provider-events/claude-code.jsonl`
- `.interlinked/provider-events/gemini-cli.jsonl`
- `.interlinked/provider-events/copilot-cli.jsonl`

Untransformed provider payloads, one line per hook invocation, with only
secret-redaction applied. Purpose: forensic recovery when normalization
loses something we later need. All files gitignored, rotated at 50 MB with
truncation to newest 25 MB, deletable by `interlinked clean --providers`.

**Effort:** ~40 lines in the hook (one extra `appendFileSync` per event).

## Tier 3 — Session-scoped rollups

Written on `SessionEnd`:

- `.interlinked/sessions/{id}/files-touched.json` — `{path → { reads, writes,
  first_ts, last_ts, last_tool }}`
- `.interlinked/sessions/{id}/turn-index.jsonl` — `{ turn_id, activity_offset,
  turns_offset }` for O(1) random access when rendering a session
- `.interlinked/sessions/{id}/thinking.md` — human-readable reconstruction of
  thinking blocks in chronological order (gated on `collect_sensitive`)
- `.interlinked/sessions/{id}/stop-summary.json` — `{ total_turns, total_tools,
  files_touched, duration_ms, stop_reason, last_assistant_message,
  errors_seen, tokens_total }`

**CLI surface:** `interlinked session <id>` becomes an instant summary read.

**Effort:** ~200 lines, mostly file I/O in the hook's `SessionEnd` path.

## Tier 4 — Hook-pipeline self-telemetry

The hook itself should be observable. Three files, all written by the hook
about itself:

- `.interlinked/hook-latency.jsonl` — `{ ts, event, elapsed_ms,
  harness_reachable }` — one line per hook invocation; reveals slow hooks
  degrading the dev loop
- `.interlinked/hook-errors.jsonl` — when the hook itself throws or times
  out. Today these failures are silent. Tier 4 makes them visible.
- `.interlinked/hook-version-drift.json` — `{ installed_version, cli_version,
  last_regen_ts, ages_days }` — `interlinked doctor` reads this

**Effort:** ~50 lines. Zero risk — purely additive observability.

## Tier 5 — Retry / iteration detection

**New file:** `.interlinked/attempts.jsonl`

When the agent calls the same tool with similar-but-not-identical inputs 2+
times in a turn, emit:

```jsonc
{
  "v": 1,
  "ts": "...",
  "turn_id": "xyz",
  "tool": "Edit",
  "attempt_num": 3,
  "tool_use_id": "...",
  "prev_tool_use_id": "...",
  "input_similarity_prev": 0.87      // Jaccard of tokenized input
}
```

Surfaces the "agent is stuck in a loop" signal — one of the most common
agent-behavior pathologies.

**Effort:** ~100 lines. Similarity implemented as trigram Jaccard on the
tool_input JSON serialization. Threshold 0.7 by default, configurable.

## Privacy & retention

Every new file must:

1. Be gitignored by default. The hook-generator writes the `.gitignore` rules
   alongside the new files when `interlinked enable` runs.
2. Have an entry in `.interlinked/.meta/retention.json` with
   `{ max_mb, max_age_days, rotation }`. `interlinked clean` respects it.
3. Redact secrets before writing (the existing `redactSecrets` from
   `REDACTION_CHUNK` is called on all string fields of the payload before
   any new file gets an `appendFileSync`).
4. Gate any file that could carry user prompt content, raw tool output, or
   thinking content behind `config.local.json.collect_sensitive: true`. Defaults
   to false.

**Never-collect:**

- Raw prompt text beyond `prompt_chars` + truncated 200-char summary (unless
  `collect_sensitive`)
- Full tool output beyond byte counts + truncated 200-char summary (unless
  `collect_sensitive`)
- Env var *values* — names only on a `SessionStart`-time fingerprint if we
  add one later
- API keys / OAuth tokens (already handled by `redactSecrets`; remains true)

## Schema versioning

Every JSONL line carries `"v": N`. Readers ignore unknown versions rather than
crash. A breaking schema change bumps `v` and ships a migration reader that
understands both. No in-place migrations of existing data.

## Build order (post-subagent-completion)

1. **Step 1 widen** — DONE. Verify by diffing generated hook before/after; byte
   output for unchanged events should be subset-compatible (new fields added,
   old fields preserved).
2. **Tier 4** (hook self-telemetry) — do second. Small, additive, gives us
   visibility to detect regressions from subsequent tiers.
3. **Tier 1** (turns + timing + thinking + compaction) — the headline UX win.
   Ships `interlinked turns` as the flagship new command.
4. **Tier 3** (session rollups) — natural extension of Tier 1.
5. **Tier 2** (provider archive) — simple, low-risk, do when we want forensic
   replay.
6. **Tier 5** (attempts) — nice-to-have once everything above is stable.

## Open questions

- Should `turn_id` be generated deterministically from `(session_id,
  user_prompt_ts)` so it's reproducible across reads? Proposal: yes,
  `sha1(session_id + user_prompt_ts).slice(0, 12)`.
- Should `files-touched.json` track the content hash of each write, so we can
  detect "agent wrote a file and then someone else reverted it"? Cost: one
  SHA-1 per write. Probably yes at Tier 3 time.
- Do we expose any of this as an API a single-agent might query (read-only)
  vs. purely as developer-observability? Defer decision; start with
  developer-facing CLI commands.

## Acceptance criteria per tier

Each tier ships with:

1. A test that asserts the new file(s) get created on the right events with
   the expected schema.
2. A retention-policy entry in `.interlinked/.meta/retention.json`.
3. A corresponding `.gitignore` entry (added by the hook generator).
4. A new CLI command (reader) or an extension to an existing one.
5. A short section added to `cli/docs/how-to-use.md` documenting what the
   file is and how to consume it.
