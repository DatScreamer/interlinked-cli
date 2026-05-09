# Hooks Ecosystem Comparison

**Last updated:** 2026-04-26
**Scope:** Hooks systems exposed by Claude Code, OpenAI Codex CLI, Gemini CLI, GitHub Copilot CLI, and Cursor IDE (the editor — *not* `cursor-agent`).
**Why this doc:** Interlinked CLI's hook installer (`src/lib/hooks.ts`, `src/lib/hook-installers.ts`) targets Claude / Gemini / Codex today. This reference captures how the five major agentic hook systems differ so we can decide what to support next, what wire format to standardize on, and what semantics to map across providers.

---

## Executive summary

- **Claude Code's hook wire format is becoming the de facto standard.** Codex CLI's engine is internally named `ClaudeHooksEngine` and copies the schema field-for-field. Gemini CLI ships a `CLAUDE_PROJECT_DIR` env-var alias so Claude-Code scripts work unchanged. Copilot CLI uses Claude Code's `permissionDecision` field shape. Cursor diverges most in surface (snake_case, different field names) but the decision model is compatible.
- **The systems disagree about what hooks are *for*.** Copilot is deny-only veto. Cursor adds an `ask` defer-to-user value. Claude Code, Codex, and Gemini support full modify-and-rewrite; Gemini goes furthest with synthetic LLM responses and tool-call rerouting.
- **Three event-surface tiers:** narrow (Codex 6, Copilot 8 — session/tool boundaries only), mid (Gemini 11, Cursor 20 — wraps the model loop or the IDE event loop), wide (Claude Code 28 — also wraps instruction loading, worktrees, filesystem, MCP elicitation).
- **Trust models diverge:** Gemini fingerprints project hooks and re-prompts on any change after `git pull`. Cursor exposes a per-hook `failClosed` knob. The others trust-on-first-use.
- **Distribution models diverge:** Copilot is the only one without a user-scope — hooks ship via PR in `.github/hooks/*.json` and govern both local CLI and GitHub's hosted Cloud Agent. Cursor ships an Enterprise/MDM scope and a team-cloud scope on day one.

---

## At-a-glance matrix

| | **Claude Code** | **Codex CLI** | **Gemini CLI** | **Copilot CLI** | **Cursor IDE** |
|---|---|---|---|---|---|
| **Status (2026-04)** | GA, broadest | `[features].hooks` (canonical, default-enabled, Stable as of 2026-05); legacy `codex_hooks` accepted with deprecation warning | GA stable (v0.39.1) | GA, no preview banner | Beta, introduced in 1.7 (Sept 2025) |
| **Config files** | `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` | `~/.codex/config.toml` *or* `hooks.json` | `~/.gemini/settings.json`, `.gemini/settings.json`, `/etc/gemini-cli/`, extensions | `.github/hooks/*.json` (repo-only) | `~/.cursor/hooks.json`, `.cursor/hooks.json`, MDM, team-cloud |
| **Format** | JSON | TOML or JSON | JSON | JSON, dual `bash`/`powershell` per entry | JSON |
| **Event count** | 28 | 6 | 11 | 8 | 20 |
| **Decision values** | allow / deny / ask / **defer** | allow / deny / ask + legacy approve/block | allow / deny / block | **deny-only** in practice | allow / deny / **ask** |
| **Input rewrite** | ✓ (`updatedInput`) | ✓ (`updatedInput`) | ✓ (`tool_input` merge + model I/O rewrite) | ✗ | ✓ (`updated_input` on `preToolUse`) |
| **Fail-open default** | Allow on hook crash | Allow on non-zero/unparsable | Allow if stdout isn't valid JSON | Allow if no JSON output | **Allow** (toggle with `failClosed: true`) |
| **Handler types** | `command`, `http`, `mcp_tool`, `prompt`, `agent` | `command`, `prompt`, `agent` (only `command` fully wired) | `command` | `command` | `command`, `prompt` |

---

## Cross-cutting comparisons

### Configuration & scope

All five converge on JSON-with-event-keyed-arrays-of-matchers, but the scoping models diverge:

- **Claude Code** and **Gemini CLI** use the classic three-tier user/project/local hierarchy. Gemini adds a 4th merge layer for **extension-contributed hooks** and a managed `/etc/gemini-cli/` system layer.
- **Cursor** layers four scopes too — but with an explicit **enterprise MDM** scope above project (macOS/Linux/Windows central policy paths) and a **team cloud-distributed** scope. The only system where hook policy is part of the SaaS plane.
- **Copilot CLI** is the outlier — there is **no user/global scope at all**. Hooks live exclusively in `.github/hooks/*.json` checked into the repo, and the same files govern both the local CLI and GitHub's hosted Cloud Agent. Hook policy is shipped via PR, not installed per machine.
- **Codex CLI** allows **TOML or JSON** in the same directory and warns if both are populated. It also has a managed-hooks path that loads bundles from `requirements.toml` for MDM-style distribution.

### Event surface

Three tiers:

- **Narrow (6–8 events)** — Codex CLI, Copilot CLI. Cover only the irreducible loop: session boundaries, prompt submit, pre/post tool, stop. Codex adds the unique **`PermissionRequest`** (intercept the approval UI rather than the tool call). Copilot adds **`subagentStop`** and **`errorOccurred`**.
- **Mid (11–20 events)** — Gemini CLI, Cursor IDE. Both wrap the **model loop**, not just the tool loop. Gemini exposes `BeforeModel`/`AfterModel` (per-chunk during streaming) and `BeforeToolSelection`. Cursor exposes `beforeMCPExecution`/`afterMCPExecution` and **IDE-only** events that no terminal agent has: `beforeTabFileRead` and `afterTabFileEdit` for Tab completions, plus `afterAgentResponse` and `afterAgentThought`.
- **Wide (28 events)** — Claude Code. Goes furthest into observability: `InstructionsLoaded`, `WorktreeCreate`/`WorktreeRemove`, `FileChanged`, `CwdChanged`, `ConfigChange`, `Elicitation`/`ElicitationResult`, `PostCompact`, `TeammateIdle`. Most are observability-only, not blockable.

Events that are **unique to one system**:

| Event | Only in | Why it matters |
|---|---|---|
| `BeforeModel` / `AfterModel` (per-chunk) | Gemini | Synthetic LLM responses, real-time PII redaction, model-swapping mid-loop |
| `BeforeToolSelection` | Gemini | Filter the toolset *before* the LLM picks |
| `PermissionRequest` (distinct from PreToolUse) | Codex | Intercept approval UI itself |
| `beforeTabFileRead` / `afterTabFileEdit` | Cursor | IDE Tab-completion gating |
| `InstructionsLoaded`, `FileChanged`, `WorktreeCreate/Remove`, `CwdChanged`, `Elicitation` | Claude Code | Filesystem + MCP-elicitation observability |
| `errorOccurred` | Copilot | First-class error hook |

### Input contract

Effectively uniform — **single JSON object on stdin** with `session_id`/`conversation_id`, `cwd`, event name, plus event-specific fields. Surface differences:

- **Claude Code** also exposes `$CLAUDE_PROJECT_DIR`/`$CLAUDE_ENV_FILE` env vars; `SessionStart` hooks can write exports to `$CLAUDE_ENV_FILE` to persist into the agent's shell.
- **Gemini CLI** provides parallel `GEMINI_*` env vars **and** a `CLAUDE_PROJECT_DIR` alias explicitly so Claude-Code hook scripts run unchanged.
- **Codex CLI** uses stdin only (no env, no argv) — and the wire schema is intentionally near-identical to Claude Code's.
- **Copilot CLI** is stdin-only with a per-hook declared `env` map; tool args are a JSON-encoded **string**, not an object.
- **Cursor** has the richest envelope — adds `cursor_version`, `workspace_roots[]`, `user_email`, `is_background_agent`, `composer_mode` (agent/ask/edit).

### Output / decision contract — the most interesting axis

This is where the systems actually disagree about what hooks are *for*:

- **Copilot CLI** is **effectively deny-only**. Schema accepts `permissionDecision: "allow" | "deny" | "ask"`, but the docs explicitly state only `"deny"` is processed today. Hooks cannot grant, cannot rewrite, cannot defer. Pure veto.
- **Cursor** uses a **three-valued** `permission: allow | deny | ask`, where `ask` defers to the user. Cursor also exposes `failClosed: true` to flip the default from allow-on-crash to deny-on-crash — a real security primitive no competitor exposes.
- **Claude Code** has the richest decision model: `allow | deny | ask | **defer**`. `defer` is unique — pauses the session in headless `-p` mode so an external UI can answer, then resumes. Plus `updatedInput` (rewrite), `updatedPermissions` (programmatically modify rules), `additionalContext` (inject text), and `asyncRewake` (background hook can wake Claude on exit 2 with stderr as system reminder).
- **Codex CLI** copies Claude Code's shape almost verbatim — same fields, `updatedInput`, `additionalContext`, `permissionDecision` — but adds the distinct `PermissionRequest` event so approval-UI interception is a separate channel from PreToolUse rewriting.
- **Gemini CLI** has the strongest **modify** capability. `BeforeModel.hookSpecificOutput.llm_response` lets a hook **return a synthetic response** and skip the model call entirely (caching, mocking, model-swapping). `AfterTool.tailToolCallRequest` chains a tool whose result *replaces* the original — programmatic tool routing. `BeforeToolSelection.toolConfig` lets multiple hooks union a whitelist of allowed function names.

Universal pattern: exit code 0 means "parse stdout JSON," exit code 2 means "block with stderr as reason." Non-zero-non-2 is a logged failure that doesn't block. Stderr is logs everywhere except in exit-2 cases where it becomes the rejection reason.

### Security & trust

| | Trust model | Sandboxing | Ratchet |
|---|---|---|---|
| **Claude Code** | Settings precedence; managed-policy MDM can `allowManagedHooksOnly` | None — runs as user | `allowedEnvVars` whitelist for HTTP hooks |
| **Codex CLI** | Stable + default-enabled via `[features] hooks`; system layer normally MDM-only. Legacy `[features] codex_hooks` still accepted with a deprecation warning | None | Validates managed-hook directory is absolute |
| **Gemini CLI** | **Project hooks fingerprinted** (name+command); re-prompts trust on any change after `git pull` | None | Optional `environmentVariableRedaction` for secrets, off by default |
| **Copilot CLI** | "Trusted directory" gate before *any* file/exec; per-tool 3-option approval prompt; `--allow-tool` allowlist | None | Plus broader Copilot CLI auth (`/login`) |
| **Cursor IDE** | Enterprise MDM scope wins over user; **fail-open by default** | None | Per-hook `failClosed: true` flips to fail-closed |

Gemini's **fingerprint-on-change** trust model is a genuine standout — every other system trusts what's on disk once the directory is trusted. Cursor's **`failClosed`** knob is the only first-class deny-on-crash primitive.

---

## Distinctive features per system

### Claude Code
- Widest event surface (28).
- Only system with **`defer`** for headless approval (pauses session for external UI).
- Only system with multiple handler types beyond `command` actually wired: `http`, `mcp_tool`, `prompt`, `agent`.
- Programmatic permission-rule mutation via `updatedPermissions` (replaceRules, addRules, removeRules, setMode, addDirectories).
- `asyncRewake` background hooks that wake Claude on exit 2.
- Matchers support **JavaScript regex** for non-alphanumeric patterns.

### Codex CLI
- Only system with a **distinct `PermissionRequest` event** separate from `PreToolUse`.
- TOML-or-JSON dual format in the same directory.
- Intentionally Claude-Code-wire-compatible — engine module is literally `ClaudeHooksEngine`.
- Managed-hooks bundle path via `requirements.toml`.
- Three handler types declared (`command`, `prompt`, `agent`), but only `command` is fully wired today.

### Gemini CLI
- Deepest **model-loop integration**: per-chunk `AfterModel`, synthetic `llm_response`, `tailToolCallRequest`.
- **Fingerprint-based trust** on project hooks (re-prompts on any change after `git pull`).
- Built-in `/hooks` slash command for runtime management.
- **Extension-contributed hooks** as a 4th merge layer.
- Explicit `CLAUDE_PROJECT_DIR` alias for Claude-Code script compatibility.
- Stable Model API decouples hooks from underlying SDK shapes.

### Copilot CLI
- Only system where hooks govern **both local CLI and a cloud agent** with the same files.
- Only one with **dual `bash`/`powershell`** per entry baked into schema.
- Only one strictly **deny-only** in practice (despite schema).
- Only one without a user-scope — everything is repo-committed.
- Cloud agent requires hooks be on the default branch; PR-driven distribution.

### Cursor IDE
- Only system with **IDE-context** events: Tab completions, `beforeReadFile` with full file content + attachments.
- First-class `ask` decision (defer to user without exiting hook).
- First-class `failClosed` for deny-on-crash semantics.
- `loop_limit` + `stop.followup_message` for bounded auto-re-prompting.
- First-class **enterprise/team scopes** on day one (MDM + cloud-distributed team policy).
- Distinct `beforeMCPExecution`/`afterMCPExecution` events.

---

## Convergence and divergence

Where they agree:

- **Stdin JSON input.** All five.
- **Stdout JSON for decisions, exit code 2 for emergency block.** All five.
- **Per-event arrays of matcher-grouped handlers.** All five.
- **Claude Code's wire field names.** Codex copies them; Gemini aliases env vars; Copilot uses `permissionDecision` shape; Cursor mirrors the model with snake_case rename.

Where they disagree:

- **Scope of "what counts as a hook"** — Copilot keeps it at session/tool boundaries; Gemini extends into the model loop; Cursor extends into the IDE event loop; Claude Code extends into instruction-loading and worktree lifecycle.
- **Whether hooks can modify, not just gate** — Copilot says no (deny-only); the others say yes, with Gemini going furthest (synthetic LLM responses).
- **Where policy lives** — Copilot puts it in the repo for cloud-distribution; Cursor and Codex put system policy in MDM-controlled paths; Claude Code and Gemini stick to per-user files.
- **Trust assumptions** — Gemini fingerprints and re-prompts; the others trust-on-first-use.

---

## Implications for Interlinked CLI

The current hook installer (`src/lib/hooks.ts`, `src/lib/hook-installers.ts`) targets Claude / Gemini / Codex. All three converge on the same wire shape, so the existing `.mjs` template is well-positioned.

If we extend coverage:

- **Adding Copilot CLI** would require:
  - Mapping our hook output to **deny-only** semantics — we cannot grant or rewrite, only block.
  - Adopting **`.github/hooks/*.json`** as a repo artifact (a new placement vs. our current `.interlinked/hooks/` model — Copilot does not honor user-global scope).
  - Generating both `bash` and `powershell` entries per hook (or one or the other).
  - Accepting that the *same file* governs both local CLI and GitHub's Cloud Agent — there's no way to scope to "local only."

- **Adding Cursor IDE** would require:
  - **snake_case envelope** (`permission`, `user_message`, `agent_message`, `updated_input`).
  - Honoring Cursor's `failClosed` knob if we want fail-closed semantics.
  - Mapping IDE-specific events (Tab completion hooks) — likely out of scope for an activity-capture/guard CLI.
  - Cursor 1.7+ runtime; still beta as of 2026-04.

- **Standardizing on Claude Code's wire format** for our hook template is justified — it is the format the rest of the ecosystem is converging toward, and Codex/Gemini already accept it almost as-is.

---

## Per-system reference detail

The full reports below are the underlying source material the comparison was built from. Use these when implementing or debugging a specific provider.

### Claude Code (full reference)

> Source: [Claude Code hooks docs](https://code.claude.com/docs/en/hooks.md)

**Configuration.** Hooks defined in three-tier scope: `~/.claude/settings.json` (user global), `.claude/settings.json` (project, committed), `.claude/settings.local.json` (project, gitignored). Nested JSON under `hooks` key, organized by event. Each event maps to an array of definitions; each definition has a `matcher` (string, list, or regex) and `hooks` array of handler objects. Matchers use exact match for alphanumerics/pipes (e.g. `Bash`) and JavaScript regex for other patterns. Multiple hooks compose sequentially in declaration order with no short-circuiting except where exit codes block (code 2). Handler types: `command` (shell), `http` (POST endpoint), `mcp_tool` (remote tool call), `prompt` (LLM evaluation), `agent` (experimental subagent). Common fields: `type`, `if` (permission filter), `timeout` (600s default), `statusMessage`.

**Lifecycle events** (28 as of April 2026): `SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `Notification`, `SessionEnd`.

**Input contract.** All hooks receive JSON stdin with: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. Optional: `agent_id`, `agent_type`. Tool-specific subsets per `PreToolUse` (Bash: `command`, `description`, `timeout`, `run_in_background`; Write: `file_path`, `content`; Edit: `file_path`, `old_string`, `new_string`, `replace_all`; etc.). `SessionStart` and `FileChanged` expose `CLAUDE_ENV_FILE` env var for persisting exports. `InstructionsLoaded` includes `file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path`, `parent_file_path`.

**Output / control contract.** Exit 0 → parse stdout JSON. Exit 2 → block (PreToolUse/PermissionRequest/UserPromptSubmit/UserPromptExpansion/Stop/SubagentStop/ConfigChange/TaskCreated/TaskCompleted/PreCompact, stderr shown to Claude). Other codes → non-blocking. Stdout JSON shape: `{ continue?, stopReason?, suppressOutput?, systemMessage?, decision?: "block", reason?, hookSpecificOutput?: { hookEventName, additionalContext?, permissionDecision?: "allow"|"deny"|"ask"|"defer", permissionDecisionReason?, updatedInput?, updatedPermissions? } }`. `defer` pauses session in headless mode (process exits with `stop_reason: "tool_deferred"`). `PermissionRequest` can return `updatedPermissions` array to programmatically modify rules.

**Security model.** Four permission modes: `default`, `acceptEdits`, `auto`, `dontAsk`, plus `plan` and `bypassPermissions` (flag-required). Managed policies (enterprise) can enforce `allowManagedHooksOnly`, `disableAllHooks`, force-enable plugins. HTTP hooks support `allowedEnvVars` whitelist; unlisted vars become empty strings. Reference variables: `$CLAUDE_PROJECT_DIR`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.

**Distinguishing features.** JavaScript regex matchers; `AsyncRewake` pattern (background hooks wake Claude on exit 2 with stderr as system reminder); **defer for headless**; MCP tool hooks with `${tool_input.field}` substitution; programmatic permission updates via `updatedPermissions`; `FileChanged` watches literal filenames (not regex); session-scoped skill hooks (YAML frontmatter); `InstructionsLoaded` observability for CLAUDE.md loading.

**What's new in 2026.** MCP tool hooks; `Async` & `AsyncRewake`; `defer` permissionDecision; Elicitation events; agent-based hooks (experimental `type: "agent"`); permission-update entries; `InstructionsLoaded` event; `PostCompact` event.

---

### OpenAI Codex CLI (full reference)

> Sources: [Codex hooks crate](https://github.com/openai/codex/tree/main/codex-rs/hooks), [config schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json), [docs/config.md](https://github.com/openai/codex/blob/main/docs/config.md), [rust-v0.125.0 release](https://github.com/openai/codex/releases/tag/rust-v0.125.0), [codex config reference](https://developers.openai.com/codex/config-reference)

**Configuration.** `config.toml` (TOML) under top-level `[hooks]` table, OR sibling `hooks.json` (JSON). Three discovery layers, low→high precedence: **system → user (`~/.codex/`) → project (`<repo>/.codex/`)** plus MDM-managed and session-flag layers. Schema (`HookEventsToml`): each event name is an array of `MatcherGroup { matcher: string?, hooks: HookHandlerConfig[] }`. Each handler is `{ type: "command"|"prompt"|"agent", command?, timeout?, async?, statusMessage? }`. Hooks are gated by `[features] hooks = true` (stable + `default_enabled: true` as of 2026-05; the legacy `[features] codex_hooks` key is still accepted but emits a deprecation warning per `codex-rs/features/src/lib.rs:836-841`).

**Lifecycle events** (6 from `HookEventsToml`):
- `SessionStart` — sub-source `startup`/`resume`/`clear`.
- `UserPromptSubmit` — after user submits, before model sees; can block or inject context.
- `PreToolUse` — before any tool call (function/custom/local_shell/MCP); can rewrite input or block.
- `PermissionRequest` — inside the approval path before user sees a UI prompt; can return concrete allow/deny.
- `PostToolUse` — after a tool returns; can post feedback or block continuation.
- `Stop` — when agent finishes a turn; can block to keep agent looping.

A separate "legacy notify" hook (`notify` config key) still exists for fire-and-forget after-turn notifications, being superseded by `Stop`.

**Input contract.** Subprocesses invoked via configured shell. Single JSON object on **stdin** (no env vars, no argv). PreToolUse payload: `hook_event_name`, `session_id`, `cwd`, `model`, `permission_mode` (`default | acceptEdits | plan | dontAsk | bypassPermissions`), `tool_name`, `tool_use_id`, `tool_input` (raw JSON), `transcript_path`, `turn_id`. Other events have analogous payloads.

**Output / control contract.** Hook decides via JSON on **stdout** (parsed by `output_parser.rs`). Wire schema borrows Claude Code shape almost verbatim:
- Universal: `continue` (default true), `stopReason`, `suppressOutput`, `systemMessage`.
- PreToolUse: legacy `decision: "approve"|"block"` + `reason`, OR new `hookSpecificOutput: { permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason, updatedInput, additionalContext }`.
- PermissionRequest: `hookSpecificOutput.decision` is an **object** — `{ behavior: "allow"|"deny", message?: string, updatedInput?, updatedPermissions?, interrupt?: bool }`. The Rust deserializer (`PermissionRequestDecisionWire` in `codex-rs/hooks/src/schema.rs`) uses `#[serde(deny_unknown_fields)]`, so any extra top-level keys cause Codex to reject the JSON silently. Deny wins across multiple matching hooks; otherwise last allow wins.
- PostToolUse / UserPromptSubmit / Stop: `decision: "block"` + `reason`, plus `additionalContext`.
- Empty / non-zero exit / unparseable JSON → hook failure (logged, surfaced in TUI). Non-zero exit alone does NOT block.

**Security model.** Hooks run as **trusted local subprocesses** spawned by user's shell; outside the sandbox that constrains tool calls. Three guardrails: (1) system layer normally writable only by admin/MDM, (2) hooks were originally off-by-default behind a feature flag — the canonical key is now `[features] hooks` (Stable, `default_enabled: true`); the legacy `codex_hooks` key still works but emits a deprecation warning, (3) "managed hooks" path ships hook bundles from `requirements.toml` and validates the directory exists, is absolute, and is a directory. Hooks matched against `tool_name` plus `matcher_aliases` via `matcher` regex.

**Distinguishing features.** `PermissionRequest` distinct from PreToolUse (no competitor has this); `updatedInput` rewrite; TOML-or-JSON dual format; MDM/managed hook layer via `requirements.toml`; three handler types declared (`command`/`prompt`/`agent`, only `command` wired); async handlers with `statusMessage`; wire format intentionally near-identical to Claude Code's (`ClaudeHooksEngine`).

**Status as of 2026-04.** Behind feature flag, actively shipping. Latest stable `rust-v0.125.0` (2026-04-24); `0.126.0-alpha.3` cut 2026-04-26. Crate (`codex-rs/hooks/`) ships generated wire-schema fixtures and full event coverage. Implementation past prototype but feature not on by default; 0.125.0 release notes don't mention hooks publicly. User-facing `docs/config.md` only documents legacy `notify`.

---

### Gemini CLI (full reference)

> Sources: [hooks index](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md), [reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md), [writing hooks](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md), [best practices](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/best-practices.md), [settings](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md), [trusted folders](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md)

**Configuration.** Under `hooks` object in `settings.json`. Four merge layers, high→low: **project** (`.gemini/settings.json` in CWD) > **user** (`~/.gemini/settings.json`) > **system** (`/etc/gemini-cli/settings.json`) > **extensions**. `GEMINI.md` is unrelated (system-prompt/context, not hook config). Schema:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "write_file|replace",
        "sequential": false,
        "hooks": [
          { "type": "command", "command": "$GEMINI_PROJECT_DIR/.gemini/hooks/sec.sh",
            "name": "security-check", "timeout": 5000, "description": "..." }
        ]
      }
    ]
  }
}
```

`type` currently only `"command"`. `matcher` is regex for tool events, exact-string for lifecycle events, `*` or `""` for all. `sequential` toggles serial vs parallel within a group.

**Lifecycle events** (11):
- `SessionStart` — startup, resume, or `/clear`; advisory + can inject context.
- `SessionEnd` — exit/clear; best-effort cleanup, CLI doesn't wait.
- `BeforeAgent` — after user submits, before planning; can block turn or append context.
- `AfterAgent` — after agent loop ends; can deny → forces retry turn.
- `BeforeModel` — before LLM call; can rewrite request, swap models, return synthetic response.
- `AfterModel` — after each LLM response chunk (per-chunk during streaming); can redact/replace.
- `BeforeToolSelection` — before LLM picks tools; filter via `toolConfig.mode` (AUTO/ANY/NONE) + `allowedFunctionNames`.
- `BeforeTool` — before tool execution; can deny, rewrite arguments, kill loop.
- `AfterTool` — after tool execution; can hide result, append context, chain a "tail tool call" replacing the response.
- `PreCompress` — before context compression; advisory only.
- `Notification` — observability for system alerts; cannot block.

**Input contract.** Common stdin JSON: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`. Per-event extras: `tool_name`/`tool_input`/`tool_response`/`mcp_context`/`original_request_name` (tool hooks); `prompt`/`prompt_response`/`stop_hook_active` (agent hooks); `llm_request`/`llm_response` (model hooks); `source` (SessionStart); `reason` (SessionEnd); `notification_type`/`message`/`details` (Notification); `trigger` (PreCompress). Env vars provided: `GEMINI_PROJECT_DIR`, `GEMINI_PLANS_DIR`, `GEMINI_SESSION_ID`, `GEMINI_CWD`, plus `CLAUDE_PROJECT_DIR` as Claude-Code compat alias. Optional `environmentVariableRedaction` (off by default) scrubs secrets.

**Output / control contract.** Three signal channels:
- **Exit 0 (preferred)** — stdout parsed as JSON. "Silence is mandatory" — any plain text breaks parsing, defaults to allow.
- **Exit 2** — system block; stderr becomes rejection reason. Action aborts, turn continues.
- **Other non-zero** — non-fatal warning; interaction proceeds with original parameters.

JSON schema (common): `decision: "allow"|"deny"|"block"`, `reason`, `systemMessage`, `suppressOutput`, `continue` (false = kill loop), `stopReason`. Event-specific under `hookSpecificOutput`: `additionalContext` (BeforeAgent/AfterTool/SessionStart), `tool_input` (rewrite in BeforeTool — merges with model args), `tailToolCallRequest` (chain in AfterTool), `llm_request`/`llm_response` (override or synthesize in model hooks), `toolConfig` (BeforeToolSelection — whitelists union across hooks), `clearContext` (AfterAgent — wipe LLM history while keeping UI). Stderr is logs only.

**Security model.** Hooks run as user with full shell privileges. Project-level hooks **untrusted by default** — Gemini CLI **fingerprints** each project hook (name + command). On any change (e.g. `git pull` modifying `.gemini/settings.json`), it re-prompts trust before running. User and system hooks aren't fingerprinted. Hooks tie into broader `trusted-folders` mechanism. Optional env-var redaction off by default. No process sandboxing.

**Distinguishing features.** Largest hook surface of any CLI agent — explicit hooks for model I/O (`BeforeModel`/`AfterModel`), tool selection (`BeforeToolSelection`), and context compression (`PreCompress`). **Synthetic LLM responses** via `BeforeModel.hookSpecificOutput.llm_response` skip model call entirely. **Tail tool calls** in `AfterTool` enable programmatic tool routing — chained tool's result replaces original. **Stable Model API** decouples hooks from underlying SDK shapes. Built-in `/hooks` slash command (`/hooks panel`, `/hooks enable <name>`, `/hooks disable-all`). **Extensions** can ship hooks (4th merge layer). Per-chunk streaming in `AfterModel`. `CLAUDE_PROJECT_DIR` env-var alias for Claude-Code-compatible scripts.

**Status as of 2026-04.** Stable in mainline. Latest tagged `v0.40.0-preview.4` (2026-04-25); latest stable `v0.39.1` (2026-04-24); `main` is `0.41.0-nightly.20260423`. Requires Node >=20. Production-ready, no "experimental" flag.

---

### GitHub Copilot CLI (full reference)

> Sources: [about-hooks](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-hooks), [hooks-configuration](https://docs.github.com/en/copilot/reference/hooks-configuration), [use-hooks](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-hooks), [copilot-cli-hooks tutorial](https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks), [about-copilot-cli](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli)

GitHub Copilot CLI **does** have a real user-extensible hooks system, modeled closely on Claude Code's. It is shared between Copilot Cloud Agent and Copilot CLI. There's also an orthogonal interactive approval policy ("allowed tools" / `--allow-tool` / `--allow-all-tools`); both mechanisms coexist.

**Configuration.** JSON files in `.github/hooks/*.json` at repo root. For Cloud Agent the file must be on the default branch; for Copilot CLI it's loaded from the current working directory. Multiple JSON files supported. Schema:

```json
{ "version": 1, "hooks": { "<eventName>": [
  { "type": "command", "bash": "...", "powershell": "...",
    "cwd": "...", "env": {...}, "timeoutSec": 30 } ] } }
```

`type` must be `"command"`. `bash` required on Unix, `powershell` on Windows. Default `timeoutSec` is 30. Multiple entries per event run sequentially.

**Lifecycle events** (8):
- `sessionStart` — new session begins or resumes (also fires on `startup`).
- `sessionEnd` — session completes/errors/aborts/times out/user exits.
- `userPromptSubmitted` — user submits a prompt.
- `preToolUse` — before any tool call (`bash`, `edit`, `view`, `create`, etc.); only event that can block.
- `postToolUse` — after tool finishes (success/failure/denied).
- `agentStop` — main agent finishes responding.
- `subagentStop` — subagent completes before returning to parent.
- `errorOccurred` — error during agent execution.

**Input contract.** Single JSON object on stdin. No CLI args, no event-specific env vars (only the `env` map declared in hook definition). All events include `timestamp` (ms) and `cwd`. Per-event: `sessionStart` adds `source` (`new`|`resume`|`startup`) and `initialPrompt`; `sessionEnd` adds `reason` (`complete`|`error`|`abort`|`timeout`|`user_exit`); `userPromptSubmitted` adds `prompt`; `preToolUse` adds `toolName` and `toolArgs` (a JSON-encoded **string**); `postToolUse` adds `toolResult` (`{resultType: success|failure|denied, textResultForLlm}`); `errorOccurred` adds `error` (`{message, name, stack}`).

**Output / control contract.** `preToolUse` may write a single-line JSON object to stdout: `{"permissionDecision": "allow"|"deny"|"ask", "permissionDecisionReason": "..."}`. Per the official reference, **only `"deny"` is currently processed** — effectively a deny-only decision channel; `allow`/`ask` accepted syntactically but no-ops. Omitting output also allows. All other events: output is ignored. `userPromptSubmitted` explicitly notes prompt modification is not supported. `postToolUse` cannot rewrite tool result. `errorOccurred` cannot suppress. Exit codes are not documented as semantic — hooks expected to `exit 0` for success and signal block via JSON, not exit code.

**Security model.** Trust gate before hooks even matter: Copilot CLI requires "trusted directory" confirmation per directory (one-time-or-remembered), gating all file read/modify/execute. `/add-dir` extends, `/cwd` switches. Interactive approval policy (separate from hooks): three-option prompt per first tool use — allow once / allow tool for session / deny + tell-Copilot-otherwise. Bypass with `--allow-tool='shell(git)'` or `--allow-all-tools`. Hooks themselves run as user with no extra sandboxing; docs warn to validate stdin, escape shell args, avoid logging secrets, set timeouts. No OAuth/token requirement on hook side. Copilot CLI itself uses `/login` GitHub auth.

**Distinguishing features.** Same hook contract spans **local CLI and cloud agent** — single `.github/hooks/*.json` set governs both. Repo-scoped, committed config rather than user-scoped settings. Cross-platform dual-script schema: `bash` + `powershell` per entry. Effectively deny-only PreToolUse despite schema accepting `allow`/`ask`. Coexists with: MCP servers, custom agents (`~/.copilot/agents/`, `.github/agents/`, org-level `.github-private/agents/`), custom instructions (`.github/copilot-instructions.md`, `AGENTS.md`). Multiple hooks per event execute in declared order; `subagentStop` for sub-agent boundaries.

**Status as of 2026-04.** Hooks documented as GA customization surface, no preview/beta banner. Copilot CLI itself launched public preview late 2025, currently a documented product with stable command surface (`copilot`, `-p/--prompt`, plan mode, `/resume`, `/agent`, etc.). The `permissionDecision` field carries the explicit caveat that only `"deny"` is acted on today, signaling more decision values are planned.

---

### Cursor IDE (full reference)

> Sources: [cursor.com/docs/hooks](https://cursor.com/docs/hooks), [InfoQ Cursor 1.7 hooks](https://www.infoq.com/news/2025/10/cursor-hooks/), [GitButler deep dive](https://blog.gitbutler.com/cursor-hooks-deep-dive), [johnlindquist/cursor-hooks types](https://github.com/johnlindquist/cursor-hooks)

Cursor hooks are a real, event-driven extension API for the Cursor editor's Agent loop (Cmd+K / Agent Chat) and Tab completions — distinct from `.cursorrules` / Project Rules (static instruction files, not hooks).

**Configuration.** JSON files named `hooks.json`, resolved with this precedence:
1. Enterprise (MDM): `/Library/Application Support/Cursor/hooks.json` (macOS), `/etc/cursor/hooks.json` (Linux/WSL), `C:\ProgramData\Cursor\hooks.json` (Win)
2. Team (cloud-distributed, Enterprise dashboard)
3. Project: `<project-root>/.cursor/hooks.json`
4. User: `~/.cursor/hooks.json`

Schema:

```json
{ "version": 1,
  "hooks": { "afterFileEdit": [
    { "command": "./hooks/format.sh", "type": "command",
      "timeout": 30, "loop_limit": 5, "failClosed": false, "matcher": "regex" } ] } }
```

Per-entry: `command`, `type` (`command` | `prompt`), `timeout`, `loop_limit`, `failClosed`, `matcher`. Project hooks run from project root.

**Lifecycle events** (20):

Agent loop: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`.

Tab completions: `beforeTabFileRead`, `afterTabFileEdit`.

**Input contract.** Single JSON document on **stdin**. Common base envelope: `conversation_id`, `generation_id`, `model`, `hook_event_name`, `cursor_version`, `workspace_roots[]`, `user_email`, `transcript_path`. Per-event:
- `beforeShellExecution`: `command`, `cwd`, `sandbox`
- `beforeMCPExecution`: `tool_name`, `tool_input`
- `beforeReadFile`: `file_path`, `content`, `attachments[]`
- `preToolUse`: `tool_name`, `tool_input`, `tool_use_id`, `cwd`, `agent_message`
- `afterFileEdit`: `file_path`, `edits[{old_string,new_string}]`
- `stop`: `status` (`completed`|`aborted`|`error`), `loop_count`
- `sessionStart`: `session_id`, `is_background_agent`, `composer_mode` (`agent`|`ask`|`edit`)

**Output / control contract.** Hooks write JSON to **stdout**. Three-valued **permission decision model**:

```
{ "permission": "allow" | "deny" | "ask",
  "user_message": "...", "agent_message": "...",
  "updated_input": { ... } }      // preToolUse only — input rewriting
```

Other shapes: `sessionStart` returns `{env:{}, additional_context}`; `stop` returns `{followup_message}` (auto-submitted to keep agent looping, hence `loop_limit`).

Exit codes: `0` = use JSON; `2` = block (equivalent to `deny`); other = failure. Default is **fail-open**; `failClosed: true` flips that for security-critical hooks.

**Security model.** Fail-open by default — a crashed/timed-out/invalid-JSON hook lets the action through unless `failClosed: true`. Enterprise scope wins over user scope for MDM-enforced policy. Hooks see workspace roots and full file contents in `beforeReadFile`, so they can implement DLP/secret redaction that Rules cannot — Rules are model-side instructions, hooks are out-of-process executables that physically gate the action.

**Distinguishing features vs Claude Code.** Three-valued `permission`: `allow` / `deny` / **`ask`** (defer to user). Input rewriting via `updated_input` on `preToolUse`. MCP-aware: dedicated `beforeMCPExecution`/`afterMCPExecution` with structured `tool_name`/`tool_input`. Tab-completion hooks (`beforeTabFileRead`, `afterTabFileEdit`) — IDE-context events with no terminal-agent analogue. Loop control: `stop.followup_message` auto-re-prompts, bounded by `loop_limit`. Sub-agent events (`subagentStart`/`subagentStop`) and compaction (`preCompact`) first-class. `type: "prompt"` hooks return `{ok, reason?}` — lighter-weight check shape. Enterprise/Team scopes are part of design, not bolted on.

**Status as of 2026-04.** Beta, introduced in Cursor 1.7 (released ~Sept 2025; covered by InfoQ Oct 2025, which explicitly calls them a "beta feature"). Schema is `version: 1`. Docs page no longer prominently labels beta but no GA announcement has appeared in cursor.com/changelog through 2026-04. Cursor CLI (`cursor-agent`) implements only `beforeShellExecution`/`afterShellExecution` — explicitly out of scope.

---

## Sources

- **Claude Code:** [hooks documentation](https://code.claude.com/docs/en/hooks.md)
- **Codex CLI:** [hooks crate](https://github.com/openai/codex/tree/main/codex-rs/hooks), [config schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json), [docs/config.md](https://github.com/openai/codex/blob/main/docs/config.md), [v0.125.0 release](https://github.com/openai/codex/releases/tag/rust-v0.125.0), [config reference](https://developers.openai.com/codex/config-reference)
- **Gemini CLI:** [hooks index](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md), [reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md), [writing hooks](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md), [best practices](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/best-practices.md), [settings](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md), [trusted folders](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md)
- **Copilot CLI:** [about-hooks](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-hooks), [hooks-configuration](https://docs.github.com/en/copilot/reference/hooks-configuration), [use-hooks](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-hooks), [copilot-cli-hooks tutorial](https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks), [about-copilot-cli](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli)
- **Cursor IDE:** [hooks docs](https://cursor.com/docs/hooks), [InfoQ Cursor 1.7 hooks](https://www.infoq.com/news/2025/10/cursor-hooks/), [GitButler deep dive](https://blog.gitbutler.com/cursor-hooks-deep-dive), [johnlindquist/cursor-hooks](https://github.com/johnlindquist/cursor-hooks)
