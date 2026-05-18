# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Interlinked CLI** (`interlinked-cli`) is the local companion tool for **Interlinked MCP Server**. It captures AI agent activity via hooks, stores events locally (offline-first JSONL), and optionally syncs to the server. The server is the system of record — the CLI covers what it cannot: local process hooks, offline storage, and developer observability.

Terminology:
- **Interlinked MCP Server** = remote Worker/DO system used by server-backed commands.
- **Interlinked CLI** = this package.

Source of truth for the CLI is `QuentinCody/interlinked-cli`; current installs run from a linked source checkout. It has a single runtime dependency (`commander`) and zero external dependencies for formatting/output.

## Commands

```bash
npm run dev             # Run CLI directly via tsx (no build step)
npm run build           # Build to dist/ via tsup (ESM)
npm run typecheck       # TypeScript type checking (tsc --noEmit)
npm run test            # Run tests (vitest)
npm run test:watch      # Watch mode tests
```

Run the CLI in development:
```bash
npx tsx src/index.ts <command>        # e.g. npx tsx src/index.ts status
npx tsx src/index.ts enable --dry-run
```

Run a single test file:
```bash
npx vitest run src/commands/__tests__/cli-bugs.test.ts
```

## `interlinked verify` — two-tier mode

`interlinked verify` runs in two modes:

| Mode | Flag | Purpose |
|------|------|---------|
| **Default (high-signal gate)** | *(none)* | Tsc/biome/oxlint/gitleaks/semgrep/dep-audit + check-FP-safe generic checks. Intended to run clean; failures are actionable. |
| **Deep audit** | `--all-checks` | Adds heuristic smell/taste checks (complexity, magic numbers, data clumps, test-coverage signals, etc.). Intended for periodic review, not as a gate. |

The demoted list lives in `DEFAULT_ADVISORY_SKIPS` in `cli/src/commands/verify/advisory.ts` (re-exported from `verify.ts` for back-compat) and is pinned by a regression test so policy changes show up in diffs. Edit both together. Each entry has a rationale comment explaining why it's advisory.

**When adding a new check**: if false-positive rate is low and the check catches real bugs, leave it in the default set. If it's heuristic (style, complexity, coverage, smell), add it to `DEFAULT_ADVISORY_SKIPS` with a one-line rationale and update the regression test.

**When an existing check produces noise in production**: prefer refining the check's detection logic over demoting it. Demotion should be a last resort when the check can't cleanly separate true positives from legitimate patterns.

## Per-file line cap (`large-file-policy.ts`)

Hand-written code modules are capped at **1500 lines** (`DEFAULT_MAX_LINES`).
`src/harness/large-file-policy.ts` is the single source of truth — the
threshold, the `isCappableFile` predicate (generated / test / `.d.ts` /
non-code files are exempt), the baseline loader, and the ratchet verdict.

Three enforcement surfaces, one policy:
- **PreToolUse block** — `checkLargeFileLineCountWrite` (`pre-checks.ts`)
  blocks a Write/Edit that would grow a cappable file past the cap. It is a
  pure before/after delta against live file state — shrinking or holding an
  over-cap file is always allowed (the refactor-down path).
- **`interlinked verify`** — the `large_files` check (default gate, no
  longer in `DEFAULT_ADVISORY_SKIPS`) reports any cappable file over the cap.
- **PostToolUse nudge** — the `[interlinked:file-size]` warning on write/read.

The cap and the grandfather list live in `.interlinked/large-files-baseline.json`
(committed — carved out of the `.interlinked/*` gitignore). A grandfathered
file may shrink or hold but not grow; decompose it below `max_lines` to drop
its entry. Ratchet `max_lines` down (1500 → 1200 → 1000) as the list empties —
lowering the cap is a one-number edit to that file. The cap is a coarse proxy;
the `complexity` / `cyclomatic` checks do the fine-grained "is this file bad"
work, which is why the enforced line number sits well above the ~300–500-line
aspirational module size.

## Harness (Guard + Lifecycle + Auto-Reservation)

The CLI includes a **local harness server** (`src/harness/`) that runs on Node.js and evaluates agent actions via a Unix socket. Full documentation: `cli/docs/harness.md`. Auto-generated reference docs: `cli/docs/generated/`.

**Key commands:**
```bash
node cli/dist/harness/server.js --verbose  # Start harness (pre-compiled)
npx tsx src/harness/server.ts --verbose    # Start harness (dev mode)
interlinked harness start                  # Start as daemon
interlinked harness stop                   # Stop daemon
interlinked harness status                 # Show status + loaded rules
interlinked harness test "rm -rf /"        # Test command against rules
npm run docs                               # Regenerate reference docs
```

**Harness source files (core):**
| File | Purpose |
|------|---------|
| `src/harness/types.ts` | All type definitions |
| `src/harness/server.ts` | Node.js Unix socket server (main entry, `node:net`) |
| `src/harness/evaluator.ts` | Guard evaluation: PreToolUse blocking + PostToolUse feedback |
| `src/harness/rules-loader.ts` | 105 built-in rules + JSON config + hot-reload |
| `src/harness/session-state.ts` | Per-session trajectory tracking |
| `src/harness/cohort.ts` | Agent cohort manager |
| `src/harness/reservations.ts` | Auto file reservation with optimistic locking |
| `src/harness/quality-checks.ts` | PostToolUse: 31 checks across 8+ languages (tsc, biome, cargo, mypy, etc.) |
| `src/harness/server-bridge.ts` | Server coordination: reservation sync, guard event reporting |
| `src/harness/trigram-index.ts` | Trigram search index: build, query, serialize, dirty layer |
| `src/harness/regex-trigrams.ts` | Regex → trigram decomposition, rg command parsing |
| `src/harness/grep-accelerator.ts` | PreToolUse grep acceleration: index query + block-and-answer |
| `src/harness/large-file-policy.ts` | Per-file line cap: threshold, `isCappableFile` predicate, baseline loader, ratchet verdict |

**Harness source files (analysis):**
| File | Purpose |
|------|---------|
| `src/harness/structural-checks.ts` | 25 dependency-aware checks (export surface, import resolution, cycles, blast radius) |
| `src/harness/checks/<family>.ts` | 50+ inline code analysis checks split by family (SQL injection, complexity, async/await, PII, secrets, etc.). New detectors go here. |
| `src/harness/generic-checks.ts` | Compatibility barrel re-exporting from `checks/<family>.ts`. Do not add new detectors here; import from `checks/<family>.js` directly. |
| `src/harness/check-registry.ts` | Compatibility shim that auto-re-exports from `check-registry/index.js`. Do not edit. |

**Stop-event reflection helpers** (formatters returning `string | null`, called from the `server.ts` Stop / SessionEnd branch; never block — all stderr warnings only):
| File | Purpose |
|------|---------|
| `src/harness/commit-cadence.ts` | Stop nudge when too many uncommitted code-file edits this session + mid-session backstop. Escalates wording by session token band. Says "Don't push." |
| `src/harness/verification-stop-checks.ts` | Three nudges: unverified code (no tsc/test/lint/build), UI not interacted (no dev-server / browser MCP), stubs introduced (TODO/FIXME/disabled-test/throw-not-impl). Signal capture lives in `session-state.ts` (trajectory signals) and `evaluator/post-tool.ts` (content scan). See `docs/design/stop-event-checks.md` for the Tier 2 / 3 backlog. |

### Agent-quality checks (added 2026-04)

Ten new cold-agent-clarity checks landed as part of the agent-quality rollout
(see `docs/design/harness-agent-quality-checks-plan.md`). Each is registered
through `check-registry/entries-warnings.ts` (or `entries-errors.ts` for
`promise_reject_non_error`) and surfaces in `interlinked verify`.

| Check | Phase | Severity | Gate |
|-------|-------|----------|------|
| `floating_promises` | pre_warn | warning | default |
| `non_null_assertion_ratchet` (metric) | post | warning | default |
| `broad_object_types` | pre_warn | warning | default |
| `boolean_trap` | post | warning | advisory |
| `magic_literal_in_conditional` | post | warning | advisory |
| `promise_reject_non_error` | pre_block | error | default |
| `unvalidated_json_boundary` | post | warning | advisory |
| `dead_exports` (generic variant) | post | warning | advisory |
| `circular_imports` | post | warning | advisory |
| `lifecycle_cleanup` | post | warning | advisory |
| `default_export` | post | warning | advisory |

Advisory checks only run under `verify --all-checks`; default-gate ones run
on every edit. Non-null-assertion enforcement is a ratchet metric alongside
`as any` and suppression directives: the pre-edit count is baselined and any
post-edit increase is flagged.

Shared patterns when adding another agent-quality check (verified
against current code, May 2026):
1. Detector in `src/harness/checks/<family>.ts` (a new family file or
   an existing one — e.g. `iteration-safety.ts`, `b-series.ts`, `pii.ts`).
   The barrel `src/harness/generic-checks.ts` re-exports automatically;
   do not add new detectors directly to the barrel.
2. Canonical registry entry in `src/harness/check-registry/entries-warnings.ts`
   (or `entries-errors.ts` for `pre_block` errors). Phase contract is in
   `src/harness/check-registry/types.ts` — `pre_block` is reserved for
   fully-deterministic, zero-FP errors only.
3. Metadata entry in `src/harness/check-metadata.ts`.
4. ~~Legacy-mirror entry~~ — `src/harness/check-registry.ts` is now an
   auto-re-exporting compatibility shim. No manual sync step. Skip.
5. Verify wiring is split across `src/commands/verify/`:
   - `advisory.ts` — `DEFAULT_ADVISORY_SKIPS`, skip-set helpers
   - `file-checks.ts` — per-file check orchestration
   - `tool-results.ts` / `tool-results-types.ts` — tool result aggregation
   - `section-table.ts` / `output-json.ts` — formatters
   - `streaming-output.ts` — `streamCqSection` and friends
   The orchestrator `src/commands/verify.ts` still holds `VerifyOpts` /
   `ToolSpec` and re-exports `DEFAULT_ADVISORY_SKIPS`. Touch only the
   subfile your check actually surfaces in.
6. Update `AGGREGATED_IN_JSON` in `__tests__/check-pipeline-parity.test.ts`
   and `DEFAULT_ADVISORY_SKIPS` in `src/commands/verify/advisory.ts` +
   its regression test when demoting to advisory.
7. Each new check ships with ≥3 negative cases (legitimate patterns that
   must NOT fire) and ≥3 positive cases.
| `src/harness/project-graph.ts` | Multi-project file dependency graph with caching |
| `src/harness/impact-analysis.ts` | Cross-file dependency tracking and breaking change detection |
| `src/harness/change-propagation.ts` | Side-effect tracking across edits |
| `src/harness/error-history.ts` | Error pattern memory with optional embeddings support |
| `src/harness/language-profiles.ts` | Language-specific checks for 12+ languages |
| `src/harness/taint-tracker.ts` | Sensitivity classification (Public/Confidential/Secret) and flow tracking |
| `src/harness/pattern-detector.ts` | Cross-cutting pattern detection |
| `src/harness/suggestion-scorer.ts` | Weighted finding scoring and ranking |
| `src/harness/registry-parity.ts` | Configurable drift detector for paired registries / exception lists. Reads `.interlinked/registry-parity.json`; runs as part of `interlinked verify` and surfaces drift in both streaming and `--json` output. |
| `src/harness/suppressions.ts` | Inline suppression directives |
| `src/harness/check-metadata.ts` | Structural check metadata for docs generation |
| `src/harness/check-engine/` | Unified caching/memoization layer for checks |

**Harness source files (artifact structure):**
| File | Purpose |
|------|---------|
| `src/harness/structure/types.ts` | All structure type definitions (determinism, provenance, artifact kinds, graph shapes, config schemas) |
| `src/harness/structure/schema-validator.ts` | Validates `structure.json` and all 9 artifact file schemas (unknown-key rejection) |
| `src/harness/structure/structure-loader.ts` | Loads `interlinked/structure.json`, resolves mode defaults, loads artifact files |
| `src/harness/structure/artifact-graph.ts` | ArtifactGraph: node/edge CRUD, companion traversal, incremental refresh, serialization |
| `src/harness/structure/cache-manager.ts` | Read/write `.interlinked/structure-cache/` files, staleness detection, manifest hashing |
| `src/harness/structure/structure-checks.ts` | PostToolUse entry point: graph build, incremental refresh, declared artifact layering, rule evaluation |
| `src/harness/structure/structure-formatter.ts` | Human-readable `[interlinked:structure]` warnings, verify JSON output builder |
| `src/harness/structure/adoption.ts` | Coverage calculation per category (0.0–1.0) |
| `src/harness/structure/baseline.ts` | Baseline suppression matching, SHA-256 context hashing |
| `src/harness/structure/extractors/` | 7 generic extractors: module, package, env, config, test, docs, examples |
| `src/harness/structure/rules/` | 6 built-in rule families: public symbol companions, env/config key companions, layer/package boundaries, glossary residue |

**Auto-generated reference docs** (run `npm run docs` to regenerate):
| File | Contents |
|------|----------|
| `docs/generated/guard-rules.md` | All 105 built-in guard rules by category |
| `docs/generated/quality-checks.md` | All 31 PostToolUse quality checks |
| `docs/generated/structural-checks.md` | All 25 structural checks by tier |
| `docs/generated/configuration.md` | Default config: diff-aware filtering + structural check settings |

**How guard evaluation works:**
1. Hook script connects to `/.interlinked/harness.sock` on PreToolUse
2. Harness evaluates event against rules + reservations + trajectory state
3. For Grep/Bash-grep calls: queries trigram index for candidate files, runs rg on candidates
4. Returns `{decision: "block"|"allow", reason?, warnings?}`
5. If blocked: hook outputs decision to stdout, agent sees reason
6. If warnings: hook writes to stderr, agent sees on next turn
7. If harness unavailable: inline fallback patterns (sleep, rm -rf, force push, DROP)

**Grep acceleration:**
- Build index: `interlinked index build` (0.1-10s depending on repo size)
- Harness loads index on startup, refreshes incrementally on each SessionStart
- Intercepts Grep tool calls AND Bash rg/grep commands (including from subagents)
- Queries index in ~10-50μs, narrows to candidate files, runs rg on candidates only
- Agent sees results via block-and-answer pattern (formatted like normal grep output)
- Dirty layer tracks file edits in-memory so agent's own writes are immediately searchable

**Important patterns:**
- Guard rules are in `.interlinked/guard-rules.json` (team-shared) + `.interlinked/guard-rules.local.json` (personal overrides)
- Built-in rules cannot be modified, only disabled via `disabled_rules` in local config
- The evaluator uses OR logic for patterns within a rule (any pattern match fires the rule)
- Negated patterns (`negate: true`) act as exceptions (if matched, rule does NOT fire)
- Quality checks (tsc, lint, etc.) run on PostToolUse only — they need the file on disk and full project context
- Structural checks (export surface, import resolution, etc.) also run on PostToolUse
- Diff-aware filtering suppresses pre-existing findings, only reporting issues introduced by the current edit
- Secrets detection runs on BOTH PreToolUse (in file content) and PostToolUse (re-check)

## Findings carry a determinism tag

Every warning the harness sends to the agent is prefixed with a `[proven]`
or `[heuristic]` tag derived from the check's `Determinism`:
`fully_deterministic` → `[proven]` (compiler / linter / scanner / parser
ran the actual code); everything else → `[heuristic]` (regex / AST shape,
not behavior-verified). Unknown check ids get no tag rather than a
guessed one. The classifier lives in
`src/harness/quality-checks.ts::classifyDeterminism`; the proven
allow-list for tool-based checks is in
`src/harness/quality-checks/instructions.ts::PROVEN_TOOL_CHECKS`.

When adding a new tool-based check (one that wraps an external
verifier), add its id to `PROVEN_TOOL_CHECKS`. Inline checks in
`CHECK_REGISTRY` use their existing `determinism` field — no parallel
maintenance.

Suppression comments (`// @ts-ignore`, `// eslint-disable-next-line`,
`// biome-ignore`) are split into two warnings: `suppressions-unjustified`
(loud, line-numbered) and `suppressions` (soft, fired only when every
disable on the file carries a reason). Justification conventions: any
text after `@ts-ignore`/`@ts-expect-error`; ` -- ` for ESLint; `:` for
Biome. `@ts-nocheck` is exempt (file-level, no per-line convention).

## Recurrence — repeating-pattern aggregation

`interlinked recurrence` surfaces patterns that recur across sessions,
files, or agents. Three observation kinds, all stored in one
append-only JSONL log at `.interlinked/recurrences.jsonl`:

| Kind | Source | Suggested action |
|------|--------|------------------|
| `harness_caught` | Wired into `server.ts` after `errorHistory.recordError(...)` — fires automatically on every PostToolUse check failure | Ratchet (advisory → default → block) |
| `harness_missed` | Manual: `interlinked recurrence flag <signature>` for patterns the harness should have caught | Scaffold a new rule entry |
| `codebase_existing` | `interlinked recurrence scan [--record]` walks the working tree with the same inline detectors used at edit time | Cleanup PR |

```bash
interlinked recurrence list                        # Top rows by count
interlinked recurrence list --kind harness_caught  # Filter
interlinked recurrence detail <signature>          # All events for one row
interlinked recurrence flag raw-sql-concat \
  --message "spotted in db.ts" --file src/db.ts    # Manual harness_missed
interlinked recurrence scan --record               # Append codebase_existing
interlinked recurrence propose <signature>         # Suggested action
```

All deterministic — counting + grouping over the JSONL, no LLM-as-judge
in the aggregator (per `feedback_harness_deterministic_only.md`).
Aggregation is computed on demand from the log; no separate cache.

Source files:
- `src/harness/recurrence.ts` — types, storage, aggregation, `proposeAction`, `recordHarnessCaught` / `recordHarnessMissed` wrappers
- `src/harness/recurrence-scanner.ts` — `scanCodebaseForRecurrences` (walks the working tree, runs `buildAgentSafetyChecks` per file)
- `src/commands/recurrence.ts` — CLI subcommands (list/detail/flag/scan/propose)

The existing `non_null_assertion_ratchet` and `as any` ratchets are a
specialized form of `harness_caught` recurrence response. Future
unification: subsume them under the recurrence model (one place to
declare "this is a recurring shape; ratchet over time").

## Reservations are a single-source-of-truth state machine

`src/harness/reservations.ts` declares its state changes as one
`ReservationTxn` discriminated union and applies them through one
`applyTransition(state, txn)` function — Bitar's "edge-defined-once"
pattern adapted for TS. Both live execution and `replayTransitions(events)`
go through the same dispatch, so live state and replay can't drift.

Optimistic local grant + async server confirm: the server-confirm
rejection path now rolls back the local grant and emits a
`conflict` event with `conflict_reason: "server-rejected"` (was a
silent `.catch(() => {})` before — the silent-double-allocation bug
class). The conflict event carries the rollback reason for log
consumers (`reservation-events.jsonl`, `interlinked recurrence`
aggregation).

Property tests in `src/harness/__tests__/reservations.test.ts` use
`fast-check` to assert: replay==live, no double-grant, release
ownership-respecting + idempotent, evict_remote local-safe,
release_all targets exactly the named agent.

## Architecture

### Relationship to the MCP Server

The server (`Interlinked MCP Server`) is the remote Worker/DO system. Communication is strictly one-directional: CLI → server via HTTP. Key server endpoints consumed:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/hooks/activity` | Single event (fire-and-forget from hook script) |
| `POST /api/hooks/activity/batch` | Batch sync of buffered events |
| `POST /api/ui/call` | MCP tool proxy (used by `status`, `activity`, `doctor`, `workspace`) |
| `GET /api/workspaces` | List workspaces (registry endpoint) |
| `POST /register`, `POST /token` | OAuth dynamic client registration and token exchange |

### Entry Point and Command Registration

`src/index.ts` registers all commands via `commander`. When invoked with no arguments, `handleImplicitEntry()` from `src/commands/first-run.ts` runs an interactive wizard (TTY) or non-interactive bootstrap (non-TTY). If already configured, it falls through to `statusCommand`.

### Key Source Files

| File | Purpose |
|------|---------|
| `src/lib/config.ts` | Two-tier config system: `config.json` (shared/committed) + `config.local.json` (personal/gitignored). `resolveConfig()` merges both and resolves multi-server entries. |
| `src/lib/auth.ts` | Token resolution (CLI token → Claude Code credentials fallback) + OAuth PKCE flow |
| `src/lib/hooks.ts` | Orchestrator: hook script generation + per-client install/uninstall delegation through `CLIENT_INSTALL_REGISTRY`. Generates `.interlinked/hooks/interlinked-activity.mjs` (self-contained, zero imports). |
| `src/lib/hook-installers.ts` | Per-client install/uninstall implementations (Claude Code, GitHub Copilot CLI, Gemini CLI, OpenAI Codex CLI). Each `installXxxHooks` writes a settings file and tags commands with `INTERLINKED_CLIENT="<id>"` so the .mjs runtime can disambiguate clients with overlapping payload shapes. Codex additionally writes `.codex/config.toml` to set `[features] hooks = true` (legacy `codex_hooks` is recognized and auto-migrated; the writer lives at `src/lib/codex-feature-flag.ts`). |
| `src/lib/api-client.ts` | HTTP client wrapping `POST /api/ui/call` for MCP tool proxying |
| `src/lib/local-activity.ts` | JSONL append-only log, session state, sync cursor (byte-offset), merge/dedup |
| `src/lib/activity-utils.ts` | Shared `ActivityEvent` type, `parseDuration()`, `formatActivitySummary()` |
| `src/lib/formatter.ts` | ANSI colors, tables, timestamps — hand-coded, no external deps. Respects `NO_COLOR`/`CI`. |
| `src/lib/output.ts` | Output mode abstraction: `json`, `short`, `normal`, `full` |
| `src/lib/settings.ts` | Client detection and settings file paths for claude/copilot/gemini/codex (registry consumed by `interlinked enable`/`disable`) |

### Activity Event Pipeline

```
AI Agent hook fires → stdin JSON → hook script (.interlinked/hooks/interlinked-activity.mjs)
  ├── Connect to harness socket (if available, 500ms timeout)
  │   ├── PreToolUse: harness returns {decision: block/allow} → stdout
  │   └── PostToolUse: harness returns {warnings} → stderr
  ├── Local write (always, sync, ~0.1ms) → activity.jsonl + sessions/{id}.json
  ├── Fire-and-forget POST /api/hooks/activity (if sync_mode != "local", 3s timeout)
  └── Batch sync on session end (if sync_mode == "realtime", cursor-based, 100-event chunks)
```

Three sync modes: `realtime` (default), `local` (offline-only), `manual` (POST per event, no batch at session end).

### Two-Tier Config System

| File | Git | Contains |
|------|-----|----------|
| `.interlinked/config.json` | Committed | `server_url`, `default_project`, `version` |
| `.interlinked/config.local.json` | Gitignored | `access_token`, `agent_name`, `workspace_id`, `sync_mode`, `servers` map |

Multi-server isolation: `config.local.json` has an `active_server` key and `servers` map. Each server entry holds its own `server_url`, `workspace_id`, and `mcp_prefix`.

Environment variable overrides: `INTERLINKED_SERVER_URL`, `INTERLINKED_ACCESS_TOKEN`, `INTERLINKED_AGENT_NAME`, `INTERLINKED_WORKSPACE_ID`, `INTERLINKED_SYNC_MODE`.

### Auth Token Resolution

`resolveAuthToken()` priority:
1. CLI's own `access_token` from `config.local.json` (checks `token_expires_at`)
2. Claude Code credentials fallback from `~/.claude/.credentials.json` → `mcpOAuth`, matched by `mcp_prefix` key prefix or `serverName` containing "interlinked"

Dev mode bypass: when `server_url` is localhost/127.0.0.1, auth is skipped entirely.

## Three-tier policy enforcement (Tier 1 shipped 2026-05, Tier 2/3 designed)

`/enforce` runs three passes over agent-instruction markdown (AGENTS.md,
SKILL.md, CLAUDE.md, .clinerules/, etc.) and emits artifacts for three
enforcement tiers:

| Tier | Layer | Consumer | Artifact | Cadence |
|---|---|---|---|---|
| 1 | Local deterministic | Interlinked harness (sub-10ms) | `.interlinked/distilled-rules.json` | Every tool call |
| 2 | Cloud LLM policy gate | gpt-oss-safeguard-120b (~3-6s) | `.interlinked/policies/<group>.policy.md` + `.cedar` + `.interlinked.cedar` | Most tool calls (post-filter) |
| 3 | Cloud architectural review | Sonnet/Opus on staged commits (~30-120s) | `.interlinked/policies/<group>.prose.md` | Pre-push / on-demand `/review` / `/security-review` |
| — | Audit | Humans | `.interlinked/policies/skipped.report.md` | After /enforce runs |

The Cedar emission is Sondera-compatible by default (drops into Sondera's
`policies/` directory). Policies needing skill-scope or trajectory state
get a sibling `.interlinked.cedar` file using extensions documented at
`docs/design/interlinked-cedar-extensions.cedarschema`. Pass 3 prose
artifacts are consumed by the Tier 3 cloud agent during pre-push review
for after-the-fact evaluation against principles the deterministic layers
can't enforce. See `skills/enforce/SKILL.md` §15 for the full routing
contract and `docs/examples/policies/disk-forensics/` for a worked example.

Tier 2 and Tier 3 are designed but not built — full design memos at
`docs/design/tier-2-llm-policy-gate.md` (architecture, provider selection,
prompt caching, pre-filter, cost model, rollout cadence) and
`docs/design/tier-3-async-deep-review.md` (trigger model, scope, model
selection, prose-policy evaluation pipeline, warn-only contract). Only
Tier 1 (and the artifact-emission side of /enforce) is shipped. Local-only
mode (no cloud): policy and prose artifacts load as agent context but
aren't enforced; Cedar files work for self-hosted Sondera.

## External-pulse intake

Before "what can we do with X?" on a tool, paper, or repo found on the
internet, fill in the rubric at `docs/external-pulse/INTAKE.md` (six lanes
+ determinism filter + smallest-spike + which surface ships it). Output
goes to `docs/external-pulse/<slug>.md`, one page per project, committed.
Skip the rubric for drive-by curiosity — it's specifically for the things
that would otherwise become a paste-and-ask. See `docs/external-pulse/codewiki.md`
for a worked example, including the "marketing-vs-reality" failure mode
(read the load-bearing function in source, not the README).

## Conventions

- **Output mode pattern**: All commands support `--json`, `--short`, `--full` via `getOutputMode(opts)` and `output(mode, data, { json, short, normal, full })`.
- **Graceful degradation**: Commands use `Promise.allSettled` for local+server parallel fetches, falling back to local-only when server is unavailable.
- **Dry-run support**: `enable`, `sync`, `clean` support `--dry-run` / `--force` patterns.
- **Hook script is self-contained**: The generated `.mjs` has no imports from the CLI package — it must work standalone even if the CLI is uninstalled.
- **Hook uninstall walks to git root**: `uninstallAllHooks()` checks ancestor directories via `findProjectRoot()` to clean `.claude/settings.json` files above CWD.
- **CWD-relative paths**: All `.interlinked/` paths are resolved relative to `process.cwd()`.

## Testing

```bash
npx vitest run                                          # All 765 tests
npx vitest run src/harness/__tests__/evaluator.test.ts  # Harness guard tests
npx vitest run src/commands/__tests__/cli-bugs.test.ts  # CLI regression tests
```

Test files:
- `src/harness/__tests__/evaluator.test.ts` — destructive command blocking, sleep detection, protected files, curl-to-MCP, auto-reservations, safe command allowlist
- `src/harness/__tests__/trigram-index.test.ts` — trigram index, regex decomposition, grep accelerator
- `src/harness/__tests__/structural-checks-extended.test.ts` — structural check validation
- `src/harness/__tests__/generic-checks-extended.test.ts` — generic code analysis checks
- `src/harness/__tests__/impact-analysis.test.ts` — cross-file impact analysis
- `src/harness/__tests__/project-graph.test.ts` — project dependency graph
- `src/harness/__tests__/taint-tracker.test.ts` — sensitivity classification
- `src/harness/__tests__/diff-aware-checks.test.ts` — diff-aware filtering
- `src/harness/__tests__/command-guard-parity.test.ts` — guard rule parity with inline fallback
- `src/harness/__tests__/docs-freshness.test.ts` — validates generated docs match source
- `src/harness/__tests__/hook-conflicts.test.ts` — hook installation conflict detection
- `src/commands/__tests__/cli-bugs.test.ts` — regression tests for numbered bugs (Bug 4, 5, 10, 14, 18, 21, 23, 24, 26)
- `src/commands/__tests__/activity-workspace-regressions.test.ts` — activity feed API contract and workspace switch tests

Tests heavily mock the file system and network. The test infrastructure uses vitest with `vi.mock()` for module-level mocking.

Manual harness testing via Unix socket:
```bash
node cli/dist/harness/server.js --verbose &
echo '{"hook_event":"PreToolUse","session_id":"t","agent_source":"claude","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"timestamp":"2026-03-17T00:00:00Z"}' | nc -U .interlinked/harness.sock
# Expected: {"decision":"block","reason":"BLOCKED: Recursive deletion..."}
```

## Graph-prediction probes (checked-in regression harnesses)

Five end-to-end probes under `.interlinked/` exercise the full
predict/reveal/reconcile flow against the live daemon. Use them to
verify the system still works after any harness change. All five are
re-runnable, create + clean their own tmp fixtures, use unique session
ids; the first four require a running daemon, the cold-fallback probe
deliberately points at a non-existent socket to exercise fail-closed.

```bash
node .interlinked/e2e-protocol-probe.mjs    # core block→write→reveal flow (11 assertions)
node .interlinked/e2e-protocol-suite.mjs    # 6 cases × 3 modes (16 assertions)
node .interlinked/e2e-stability.mjs         # 5000-event burst, p99 + RSS budget
node .interlinked/e2e-hook-script.mjs       # dist/hook-entry.js → Claude Code envelope
node .interlinked/e2e-cold-fallback.mjs     # daemon unreachable → fail-closed gate fires (7 assertions)
```

See `docs/design/graph-prediction-verification-status.md` for what each
probe pins, plus the deployed-config snapshot.
