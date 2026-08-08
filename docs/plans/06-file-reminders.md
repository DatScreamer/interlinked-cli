# File Reminders: Agent-Created & CLI-Managed

> **RETIRED 2026-08-07 — SHIPPED. Do not build this.** `src/commands/reminder.ts`
> implements the add/list/remove surface this plan proposes. The premise below
> ("no CLI command — users must hand-edit JSON") is no longer true.

## Context

File reminders landed in `e89ff1b` (April 2) — `FileReminder` type, evaluator integration, hot-reload via `guard-rules.json`/`guard-rules.local.json`. But:

1. **Agents can't create reminders** — the primary use case ("remind me next time I touch this file") has no write path
2. **No CLI command** — users must hand-edit JSON to add/remove reminders
3. **No way to view active reminders** — `interlinked status` doesn't show them

Additionally, a bug was found and fixed: absolute `file_path` from tool input wasn't being relativized before glob matching (fix in `evaluator.ts:996-997`).

## Plan

### Step 1: Extend `FileReminder` type

**File:** `cli/src/harness/types.ts:234-245`

Add optional metadata fields:
- `created_at?: string` — ISO timestamp
- `created_by?: string` — agent name or `"cli"`

These are additive — evaluator ignores unknown fields, existing configs unaffected.

### Step 2: Guard-rules read/write helpers

**File:** `cli/src/harness/rules-loader.ts`

Add four exported functions (near the existing `watchRulesFiles`):
- `readLocalGuardRules(cwd?)` — parse `.interlinked/guard-rules.local.json`
- `writeLocalGuardRules(config, cwd?)` — atomic write with `mkdirSync` safety
- `readTeamGuardRules(cwd?)` — parse `.interlinked/guard-rules.json`
- `writeTeamGuardRules(config, cwd?)` — same for team file

Reuses existing path patterns (`join(cwd, ".interlinked", "guard-rules.local.json")`). The `watchFile` mechanism (2s poll) auto-detects writes — no manual reload needed.

### Step 3: Reminder CLI command

**New file:** `cli/src/commands/reminder.ts`

Three subcommands:

**`interlinked reminder add`**
```
--glob <pattern>     Required. File glob to match.
--message <text>     Required. Reminder message.
--ops <list>         Optional. Comma-separated operations (Edit,Write,Read).
--once               Default true. Fire once per session.
--id <id>            Optional. Auto-generated from glob hash if omitted.
--team               Write to guard-rules.json instead of local.
```

Flow: parse opts → build `FileReminder` with `created_at`/`created_by` → read target JSON → check duplicate ID → append to `file_reminders[]` → write back.

Agent usage: `interlinked reminder add --glob "src/auth/**" --message "Run auth tests" --ops Edit,Write`

**`interlinked reminder list`** (default subcommand)
```
--json / --short / --full    Output format.
```

Reads both team and local files directly (not via `loadRules` which merges them). Annotates each with `source: "team" | "local"`. Display:
```
File Reminders (3 active)
  src/auth/**         "Run auth tests"      [local] [Edit,Write] [once]
  servers/loinc/**    "Set LOINC creds"      [team]  [any op]     [once]
  src/schema.ts       "Run schema tests"     [team]  [Edit]       [every time]
```

**`interlinked reminder remove <id-or-glob>`**
```
--team       Remove from team file instead of local.
--all        Clear all reminders from the target file.
```

Matches by `id` first, then exact `glob` string. Removes first match. `--all` clears the array.

### Step 4: Register in index.ts

**File:** `cli/src/index.ts`

Add `reminder` command group with `add`, `list` (default), `remove` subcommands. Dynamic imports like other commands. Alphabetical sort at line 818 handles ordering.

### Step 5: Tests

**New file:** `cli/src/commands/__tests__/reminder.test.ts`

Key cases:
- `add` writes to local JSON, generates deterministic ID, sets `created_at`
- `add --team` writes to team file
- `add` with `--ops Edit,Write` parses correctly
- `add` with duplicate ID warns/skips
- `list` merges team + local, annotates source
- `remove` by ID and by glob
- `remove --all` clears everything
- Integration: `loadRules()` picks up added reminder

## Agent Workflow (End-to-End)

1. Agent edits `src/auth/handler.ts`, wants future sessions to know about auth tests
2. Agent runs: `interlinked reminder add --glob "src/auth/**" --message "Run auth tests" --ops Edit,Write`
3. CLI appends to `.interlinked/guard-rules.local.json`
4. Harness `watchFile` detects change within 2s, calls `loadRules()`, merges local reminders
5. Next Edit matching `src/auth/**` → evaluator fires `[interlinked:reminder]` warning

Zero changes to evaluator, hook script, or harness server.

## Files to Modify

| File | Change |
|------|--------|
| `cli/src/harness/types.ts` | Add `created_at`, `created_by` to `FileReminder` |
| `cli/src/harness/rules-loader.ts` | Add read/write helpers for guard-rules JSON |
| `cli/src/commands/reminder.ts` | **New:** add/list/remove commands |
| `cli/src/index.ts` | Register `reminder` command group |
| `cli/src/commands/__tests__/reminder.test.ts` | **New:** test coverage |

## Verification

1. `npm run build` in `cli/` — must compile cleanly
2. `npx vitest run src/commands/__tests__/reminder.test.ts` — all tests pass
3. Manual E2E:
   - `interlinked reminder add --glob "src/schema.ts" --message "Test reminder" --ops Edit`
   - `cat .interlinked/guard-rules.local.json` — verify reminder present
   - Edit `src/schema.ts` — verify `[interlinked:reminder]` fires in PostToolUse
   - `interlinked reminder list` — verify display
   - `interlinked reminder remove src/schema.ts` — verify removal
