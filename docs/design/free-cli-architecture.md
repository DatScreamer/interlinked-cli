# Free CLI Architecture — `interlinked`

**Status:** Plan / not yet implementation. Part of the three-product architecture — see `three-product-architecture.md`.

**Scope:** The free `interlinked` CLI — what it is, what exists today, what needs building, and the shape of the daemon, configuration, and output surfaces. Hook normalization across runners has its own doc (`cli-hook-normalization.md`); the build order for an agent has its own doc (`cli-implementation-plan.md`).

**Audience:** Engineering and any agent working on the CLI.

---

## Quick index

- §1 Scope and identity; what exists vs what needs building
- §2 Distribution
- §3 Complete check inventory
- §4 Installer architecture
- §5 Daemon architecture
- §6 `.interlinked/` directory layout
- §7 Configuration file schemas
- §8 Check declaration format (extended)
- §9 Telemetry wire format
- §10 Future-proofing for cloud tiers
- §11 Output formatting
- §12 Commercial purpose

Companion docs:
- `cli-hook-normalization.md` — adapter interface, unified event envelope, tool-class classifier, per-runner decision translation
- `cli-implementation-plan.md` — phased build order for a coding agent (Phases A–J)

## §1 Scope and identity

The free CLI is the `interlinked` binary. It runs **entirely locally**, requires no authentication, and performs no network I/O for any core function. It owns all deterministic "Tier 0" checks per `three-product-architecture.md` §1 and the hook wiring for every supported coding-agent CLI.

**Existing in-repo infrastructure this plan extends** (do not rewrite — build on these):

| Concern | Existing file(s) |
|---|---|
| CLI entry | `cli/src/index.ts` |
| Command implementations | `cli/src/commands/` (~45 commands) |
| Hook installation | `cli/src/lib/hooks.ts` |
| Runner enum | `cli/src/lib/settings.ts` |
| Evaluator (Pre/Post, block/warn) | `cli/src/harness/evaluator.ts` (~3,700 LOC) |
| Daemon / Unix socket | `cli/src/harness/server.ts` |
| Guard rules (67 built-in) | `cli/src/harness/rules-loader.ts` |
| Generic inline checks (~50) | `cli/src/harness/generic-checks.ts` |
| Check-registry types | `cli/src/harness/check-registry/types.ts` |
| Check entries | `cli/src/harness/check-registry/entries-*.ts` |
| Structural checks (22) | `cli/src/harness/structural-checks.ts` |
| Quality checks (18, PostToolUse) | `cli/src/harness/quality-checks.ts` |
| Check policy | `cli/src/harness/check-policy.ts` |
| Coverage ratchet | `cli/src/harness/coverage-ratchet.ts` |
| Mutation gate | `cli/src/harness/mutation-gate.ts` |
| Suppressions | `cli/src/harness/suppressions.ts` |
| Trigram / reservations / session | `cli/src/harness/trigram-index.ts`, `reservations.ts`, `session-state.ts` |
| Shared types | `cli/src/harness/types.ts` |
| Current hook script | `.interlinked/hooks/interlinked-activity.mjs` |
| Current daemon socket | `.interlinked/harness.sock` |

**What is missing today** (the work this doc plans):

| Area | State today |
|---|---|
| Runner normalization | Claude Code and Copilot CLI handled directly in `lib/hooks.ts`; Cursor commented out; Gemini stubbed; Codex absent |
| Unified event envelope | Evaluator consumes Claude-shaped events directly; no cross-runner schema |
| Adapter layer | No per-runner adapter modules |
| Tool-class classifier | Implicit in evaluator heuristics; no first-class `ToolClass` type |
| Daemon RPC schema | Socket exists but has no versioned JSON-RPC schema or typed contract |
| Warm `tsgo` integration | `tsgo` runs cold in `quality-checks.ts`; no persistent process |
| Simulated-edit type check | Does not exist |
| Telemetry wire format | Not defined for cloud export |

## §2 Distribution

- Single static binary via Bun-compile: `bun build --compile --outfile=dist/interlinked cli/src/index.ts` for macOS arm64/x64, Linux arm64/x64, Windows x64
- Also published to npm as `@interlinked/cli` for node users
- Homebrew tap: `brew install interlinked/tap/interlinked`
- Release pipeline publishes all three surfaces from a single tag
- No auth, no network for any core function
- Telemetry strictly opt-in via `interlinked telemetry enable` (anonymous-only when enabled)

## §3 Complete check inventory

Already implemented (keep as-is; extend with new metadata only):

| Source | Count | Location |
|---|---|---|
| Guard rules | 67 | `.interlinked/guard-rules.json` + `rules-loader.ts` |
| Generic inline checks | ~50 | `generic-checks.ts` |
| Structural checks | 22 | `structural-checks.ts` |
| Quality checks (PostToolUse) | 18 | `quality-checks.ts` |
| Check-registry: warnings | — | `check-registry/entries-warnings.ts` |
| Check-registry: errors | — | `check-registry/entries-errors.ts` |
| Check-registry: taste | — | `check-registry/entries-taste.ts` |
| Check-registry: C/C++ | — | `check-registry/entries-c-cpp.ts` |

Planned additions per this doc:

| Category | New checks |
|---|---|
| Compilers (warm) | `tsgo` single-file check via daemon; `tsgo` simulated-edit check on `Edit` ops |
| Test-quality extensions | Per `test-lint-parity-policy.md` |
| Schema migration-order | Static AST check per `harness-think-vocabulary.md` |
| Secret regex (expanded) | Provider patterns + project-authored |
| Bundle / perf budgets | Parse build output; enforce deltas |

Every check carries `tool_classes[]` (which tool classes it applies to) and `runners[]` (which runners to run under) — see §8 below.

## §4 Installer architecture

One user-facing command:

```bash
# Interactive — detects installed runners and prompts
interlinked install-hooks

# Explicit
interlinked install-hooks --runner=claude-code --scope=project
interlinked install-hooks --runner=all --scope=user
interlinked install-hooks --runner=claude-code,copilot-cli --scope=project

# Cloud opt-in (non-default; writes .interlinked/cloud.json)
interlinked install-hooks --cloud=guardrails --token-env=INTERLINKED_TOKEN
```

Scopes (following Sondera's precedent):

| Scope | Target file (Claude Code example) | Committed? |
|---|---|---|
| `user` | `~/.claude/settings.json` | No |
| `project` | `.claude/settings.json` | Yes |
| `local` | `.claude/settings.local.json` | No (gitignored) |

Per-runner per-scope algorithm:

1. Read existing settings file (or start from `{}`)
2. Deep-merge the adapter's `renderSettingsFragment()` output using the declared `mergeStrategy`
3. For hook arrays, **append** (never replace) so user's existing hooks are preserved
4. Write atomically: temp file → fsync → rename
5. Record what was added in `.interlinked/installer-manifest.json` so uninstall can undo exactly what we did

Uninstall:
```bash
interlinked uninstall-hooks --runner=claude-code --scope=project
```
Reads the installer manifest, removes only entries it added, never touches unrelated config.

Detection: `interlinked install-hooks` with no `--runner` runs each adapter's `detectFromEnv()` and checks for the presence of settings-file parents. Prompts for ambiguous cases; **never silent-installs to a runner the user didn't ask for.**

## §5 Daemon architecture

### §5.1 Lifecycle

`interlinked-hookd` is a long-lived Bun process started automatically by `SessionStart` hook, killed automatically by `SessionEnd` hook. One daemon per CLI session; multiple sessions may run concurrently (different sockets).

Flow:
1. `SessionStart` hook runs → spawns `interlinked-hookd start --session-id=<id>` (detached, `nohup`-equivalent)
2. Daemon writes `.interlinked/daemon-<session_id>.pid`
3. Daemon opens `.interlinked/harness-<session_id>.sock`
4. Daemon initializes: loads config, warms tsgo (`tsgo --watch --noEmit` child process with project graph loaded), primes mtime cache, sets up log rotation
5. Hook binary (`interlinked-hook`) is a thin client: discovers socket via env var (`INTERLINKED_SOCKET`) or pid file; POSTs event JSON; reads response; exits
6. `SessionEnd` hook → `interlinked-hookd stop --session-id=<id>` (flushes caches, writes final telemetry, exits cleanly)
7. Idle shutdown: daemon self-terminates if no events for `idle_shutdown_ms` (default 15 min)
8. Orphan cleanup: `interlinked doctor` finds stale `.sock`/`.pid` files (from crashed sessions) and removes them

Existing `cli/src/harness/server.ts` already implements a Unix-socket daemon. **Extend it, don't replace it.** Add per-session addressing and the tsgo child process.

### §5.2 Socket RPC protocol

Newline-delimited JSON, request/response keyed by `id`. Simple enough to debug with `socat UNIX-CONNECT:harness.sock -`.

Request envelope:
```json
{ "schema_version": "1", "id": "req-abc", "method": "hook.pre_tool_use", "params": { /* UnifiedHookEvent */ } }
```

Response envelope:
```json
{ "id": "req-abc", "result": { /* HarnessDecision */ } }
```

Error response:
```json
{ "id": "req-abc", "error": { "code": "timeout" | "bad_request" | "internal", "message": "...", "recoverable": true } }
```

Methods:

| Method | Params | Result | Purpose |
|---|---|---|---|
| `hook.pre_tool_use` | UnifiedHookEvent | HarnessDecision | Gate path |
| `hook.post_tool_use` | UnifiedHookEvent | HarnessDecision (usually allow + additional_context) | Advisory path |
| `hook.session_start` | UnifiedHookEvent | `{ ack: true }` | Lifecycle |
| `hook.session_end` | UnifiedHookEvent | `{ ack: true }` | Lifecycle; triggers flush |
| `hook.user_prompt` | UnifiedHookEvent | HarnessDecision | Optional pre-prompt scan |
| `hook.pre_compact` | UnifiedHookEvent | `{ ack: true }` | Optional ingest trigger for Agent Memory (future) |
| `daemon.health` | `{}` | `{ status, warm_caches, uptime_ms, tsgo_status }` | Health |
| `daemon.shutdown` | `{ reason }` | `{ ack: true }` | Explicit shutdown |
| `daemon.invalidate` | `{ path }` | `{ ack: true }` | Drop mtime cache for path |
| `tsgo.check_file` | `{ path }` | `{ diagnostics: Diagnostic[] }` | Single-file type check |
| `tsgo.simulate_edit` | `{ path, old_string, new_string }` | `{ new_diagnostics: Diagnostic[] }` | Pre-edit type-regression check |

All types in new file `cli/src/harness/daemon-protocol.ts`. Every request includes `"schema_version": "1"`.

### §5.3 Health, PID, logs

- PID file: `.interlinked/daemon-<session_id>.pid` (gitignored)
- Socket: `.interlinked/harness-<session_id>.sock` (gitignored)
- Log: `.interlinked/logs/daemon-<session_id>.log`, JSONL, rotated at 10 MB, keep last 3
- `daemon.health` RPC returns: `{ status: "ready" | "warming" | "degraded", uptime_ms, warm_caches: ["tsgo", "mtime", "trigram"], tsgo_status: "ready" | "starting" | "unavailable", rpc_inflight: N }`
- `interlinked status` surfaces all active daemons, their sessions, and health

### §5.4 Cold-start fallback

If the hook binary cannot reach the daemon socket within 100 ms:

1. Log `"daemon unreachable, falling back to cold"` to stderr (invisible unless `INTERLINKED_DEBUG=1`)
2. Run the checks directly inline in the hook process (synchronous)
3. **Skip `tsgo`** — cold tsgo startup blows the gate budget; emit `additional_context` note "type-check skipped (daemon unavailable)"
4. Still enforce the tool-class budget; return decision before budget expires
5. On hook exit, emit telemetry event `daemon_fallback_cold` for visibility

Cold-path performance targets: <500 ms p99 Read-class, <1.2 s p99 Modify-class. Worse than warm, but never catastrophic.

## §6 `.interlinked/` directory layout

```
.interlinked/
├── config.json                      # main config; versioned with repo
├── check-policy.json                # per-check enable/disable/severity
├── suppressions.json                # explicit suppressions w/ reason + TTL
├── custom-checks.json               # project-authored regex/AST checks
├── tool-class-overrides.json        # cross-runner classification overrides
├── runner-config.json               # per-runner paths and quirks
├── cloud.json                       # (optional) cloud endpoint + token ref
├── installer-manifest.json          # what the installer added (for clean uninstall)
├── guard-rules.json                 # 67 built-in rules + project overrides (existing)
├── .gitignore                       # shipped template
│
├── cache/                           # gitignored
│   ├── tsgo-graph.json              # serialized tsgo graph
│   ├── check-mtime.db               # mtime-keyed result cache (SQLite)
│   └── trigram-index.db             # existing trigram index
│
├── hooks/                           # shipped assets
│   ├── interlinked-hook.mjs         # self-contained hook entry (Bun-compiled)
│   └── interlinked-activity.mjs     # existing activity hook (legacy)
│
├── logs/                            # gitignored, rotated
│   └── daemon-<session_id>.log
│
├── offline-spool.jsonl              # gitignored; telemetry ring buffer
│
├── daemon-<session_id>.pid          # gitignored; per-session daemon PID
└── harness-<session_id>.sock        # gitignored; per-session daemon socket
```

`.interlinked/.gitignore` template:

```
cache/
logs/
offline-spool.jsonl
daemon-*.pid
harness-*.sock
```

## §7 Configuration file schemas

Full JSON Schemas live at `cli/schemas/*.json` for editor autocomplete. Summary:

**`.interlinked/config.json`**:

```json
{
  "schema_version": "1",
  "binary_version": "0.1.0",
  "workspace_id": null,
  "runners_enabled": ["claude-code", "copilot-cli"],
  "daemon": {
    "auto_start": true,
    "idle_shutdown_ms": 900000,
    "log_level": "info",
    "tsgo_enabled": true
  },
  "tool_classes": {
    "read_budget_ms": 300,
    "modify_budget_ms": 800,
    "side_effect_budget_ms": 2000,
    "long_running_budget_ms": 5000
  },
  "cloud": {
    "enabled": false,
    "product": null,
    "portal_url": null,
    "token_env": null
  }
}
```

**`.interlinked/check-policy.json`** (extends existing format in `check-policy.ts`):

```json
{
  "defaults": { "severity": "warning", "scope": "diff", "action": "warn_before" },
  "checks": {
    "focused_tests": { "enabled": true, "severity": "error", "scope": "diff", "tool_classes": ["modify"] },
    "rm_rf": { "enabled": true, "severity": "error", "tool_classes": ["side-effect"] }
  }
}
```

**`.interlinked/suppressions.json`**:

```json
{
  "suppressions": [
    {
      "check_id": "focused_tests",
      "path": "src/experimental/",
      "reason": "WIP feature behind flag",
      "added_by": "alice@example.com",
      "added_at": "2026-04-20",
      "expires_at": "2026-05-20"
    }
  ]
}
```

Every suppression must carry `reason` + one of (`fix_pr`, `expires_at`). Enforced by `interlinked verify --suppressions-strict`.

**`.interlinked/custom-checks.json`**:

```json
{
  "checks": [
    {
      "id": "no-deprecated-api",
      "phase": "pre",
      "tool_classes": ["modify"],
      "scope": "diff",
      "severity": "error",
      "pattern": "\\boldDeprecatedFn\\(",
      "fix_instruction": "Use newFn(...) instead."
    }
  ]
}
```

Regex + optional AST extension files (`type: "ast-extension", path: "./checks/foo.mjs"`).

**`.interlinked/runner-config.json`**:

```json
{
  "claude-code": { "settings_path": null, "extra_events": [] },
  "copilot-cli": { "cli_path": null },
  "gemini-cli": { "cli_path": null, "experimental": true },
  "codex":      { "cli_path": null, "experimental": true },
  "cursor":     { "settings_path": null }
}
```

**`.interlinked/cloud.json`** (only when cloud opted in):

```json
{
  "enabled": true,
  "product": "guardrails",
  "portal_url": "https://portal.interlinked.dev/mcp",
  "token_source": { "env": "INTERLINKED_TOKEN" },
  "zdr": false,
  "redactors_before_send": ["secrets", "paths"]
}
```

## §8 Check declaration format (extended)

Existing `CheckRegistration` in `cli/src/harness/check-registry/types.ts` is extended with optional metadata for tool-class routing and future cloud escalation. **Backward-compatible** — existing checks keep working; new fields are optional.

```typescript
// cli/src/harness/check-registry/types.ts (extended)

export interface CheckDeclaration {
  // --- existing fields (keep unchanged) ---
  id: string;
  name: string;
  description: string;
  phase: "pre" | "pre_warn" | "post" | "verify-only";
  tier: 1 | 2 | 3;                          // 1=<100ms, 2=<1s, 3=<5s
  determinism: "fully_deterministic" | "heuristic";
  severity: "error" | "warning" | "info";
  pipeline: "agent_safety" | "taste" | "suggestion" | "security";
  fix_instruction: string;
  fn: CheckFn;
  resultsPropName: string;

  // --- new optional fields ---

  /** Which unified tool classes this check applies to. Empty/missing = all. */
  tool_classes?: ToolClass[];

  /** Which runners this check applies to. Empty/missing = all. */
  runners?: RunnerId[];

  /** Hard timeout; aborted if exceeded. Defaults to tier budget. */
  timeout_ms?: number;

  /** True if the check can auto-produce a fix. */
  auto_fixable?: boolean;
  auto_fix_fn?: (match: InlineMatch) => Promise<Patch>;

  /** Telemetry export policy (future cloud). */
  telemetry?: {
    export: boolean;
    payload: "summary" | "full" | "with_diff";
    redactors: string[];
  };

  /** Cloud escalation (future Guardrails integration). */
  escalation?: {
    mcp_method: string;                      // e.g., "policy.evaluate_tool_call"
    trigger: "always" | "on_finding" | "on_ambiguity";
    context_builder?: (ctx: CheckContext, local_result: CheckResult) => unknown;
  };
}
```

Add `tool_classes` and `runners` to checks incrementally as you touch them; **do not bulk-migrate** existing entries. Checks without these fields run for all tool classes and all runners, which matches today's behavior.

## §9 Telemetry wire format

Even without cloud opt-in, the CLI writes a local JSONL telemetry spool at `.interlinked/offline-spool.jsonl` (user can inspect via `interlinked logs --telemetry`). When cloud is opted in, the same JSONL is shipped as fire-and-forget batches.

Every line is a complete, self-contained JSON event (Pattern 7 from the orchestration skill — parser can stop reading whenever and what it has is valid).

Event kinds:

```jsonl
{"schema":"v1","kind":"hook_decision","event_id":"evt-01H...","session_id":"...","ts":"2026-04-23T14:22:11.412Z","runner":"claude-code","phase":"pre-tool","tool_name":"Edit","tool_class":"modify","decision":"allow","latency_ms":42,"checks_run":["focused_tests","placeholder_test","rm_rf"],"findings_count":0,"gate_class":"local"}
{"schema":"v1","kind":"check_finding","event_id":"evt-...","check_id":"focused_tests","file":"src/foo.test.ts","line":42,"severity":"error","suppressed":false,"fix_instruction":"Remove .only"}
{"schema":"v1","kind":"session_lifecycle","session_id":"...","event":"start","runner":"claude-code","cwd":"/path/to/repo","git_head":"abc123","ts":"..."}
{"schema":"v1","kind":"daemon_event","session_id":"...","event":"started","pid":12345,"ts":"..."}
{"schema":"v1","kind":"suppression_applied","check_id":"focused_tests","path":"src/experimental/foo.test.ts","reason":"WIP","session_id":"...","ts":"..."}
{"schema":"v1","kind":"daemon_fallback_cold","session_id":"...","reason":"socket_unreachable","ts":"..."}
```

Ring buffer: max 100 MB, oldest events dropped first; `session_lifecycle` and `check_finding` preferentially preserved over `hook_decision` when the buffer is full.

## §10 Future-proofing for cloud tiers

The free CLI is designed to **add cloud escalation with zero architectural changes** — only config + check metadata.

When cloud is opted in (`interlinked install-hooks --cloud=guardrails --token-env=...`):

1. `.interlinked/cloud.json` is written with the Portal URL and token source
2. Daemon loads cloud config at startup
3. For checks with `escalation.mcp_method` set, after running the local check the daemon makes a synchronous MCP call to the Portal with the check's local result as input
4. Local deterministic result is the floor; cloud can only **tighten** the verdict, never loosen (conservative override)
5. Cloud response merged into `HarnessDecision` before returning to hook
6. Latency budget still enforced: if cloud call exceeds budget, return local-only with a `warnings[]` entry noting the timeout

No code changes required in checks or adapters. Purely orchestration at the daemon layer.

For Agent CI triggers from the CLI: new command `interlinked scan request --scope=policy` makes an MCP call to `scan.request_deep_scan`, returns `job_id`, exits. The CLI does not wait — user checks status via `interlinked scan status <job_id>` or the dashboard.

## §11 Output formatting

Three modes (existing in `cli/src/lib/output.ts`; extend):

| Mode | Flag | Audience |
|---|---|---|
| Human | default | Terminal devs; colorized, hyperlinked file paths, severity badges |
| JSON | `--format=json` | Batch / CI consumers |
| JSONL streaming | `--format=jsonl` | Agents and post-processors; one finding per line, crash-safe |

Per `harness-jsonl-output-contract.md`: every JSONL line is complete + self-contained; no line depends on a previous line's content.

## §12 Commercial purpose

Lands the developer. Source-available (Business Source License → MIT after 4 years, or similar; decide before first public release). Mindshare and onboarding funnel into Guardrails. Must work fully alone — see Principle 1 in `three-product-architecture.md` §Architectural Principles.
