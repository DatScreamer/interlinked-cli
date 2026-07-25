---
name: interlinked
description: "Overview and router for the Interlinked CLI — a local guard, quality-enforcement, and observability layer for AI coding agents. Load this when working in a repo that has a `.interlinked/` directory, when you see any `[interlinked:*]` output or a `BLOCKED: … Suggestion: …` reason and are not sure which area it belongs to, or when you need to know what the `interlinked` command can do. This skill explains the mental model, the `.interlinked/` layout, the `[proven]`/`[heuristic]` tags, and routes you to the focused `interlinked-*` skill for setup, guard blocks, verify/checks, quality ratchets, supply-chain, spec-audit, observability, or coordination."
---

# interlinked — overview & skill router

**Interlinked is a local control plane for AI coding agents.** A local daemon ("the harness")
hooks into Claude Code, Codex, Copilot CLI, Gemini CLI, and Cursor, and on **every** tool call
it: enforces deterministic policy (block/allow in milliseconds, no model in the decision path),
fails closed on what causes incidents (destructive commands, secrets, unvetted deps), and writes
a replayable local activity log. It is **offline-first** — no cloud dependency, no telemetry —
with an **optional** server for multi-agent coordination.

If you're an agent working in a repo with a `.interlinked/` directory, you are being guarded by
it. This skill orients you and points to the right focused skill.

## The three surfaces
| Surface | Role |
|---|---|
| **Interlinked CLI** (`interlinked …`) | Local hooks, guard, quality checks, activity capture, diagnostics. |
| **Interlinked MCP Server** | Optional remote source of truth for tasks, messages, reservations, agent state. |
| **Web UI** (`/chat`, `/map`) | Optional human oversight and coordination. |

## The `.interlinked/` directory
Everything is per-`cwd` under `<repo>/.interlinked/`. Key files:

| File | Git | Purpose |
|---|---|---|
| `config.json` | committed | server URL, defaults, operational mode, feature flags |
| `config.local.json` | gitignored | token, agent name, workspace, sync mode |
| `guard-rules.json` / `.local.json` | team / local | guard rules, protected files, `disabled_rules` |
| `package-allowlist.json` | committed | approved dependencies (default-deny installs) |
| `verify-suppressions.json` | committed | file/glob check suppressions |
| `*-baseline.json`, `metric-caps.json` | mixed | ratchet water-lines (coverage/mutation/line-cap/caps) |
| `activity.jsonl`, `collection.jsonl`, `timeline.jsonl` | local | captured agent activity (`enable` gitignores the first two) |
| `harness.sock` / `harness.pid` | — | the running daemon |

## What warnings mean: `[proven]` vs `[heuristic]`
Every message the harness sends you is tagged:
- **`[proven]`** — a real compiler/linter/scanner/parser/test-runner produced it (tsc, biome,
  gitleaks, semgrep, …). Authoritative — **fix it**.
- **`[heuristic]`** — a regex/AST-shape match that could be a false positive. **Evaluate it.**
- No tag — an unknown check id (never guessed).

A **block reason is always surfaced.** Allow-time warnings are surfaced but easy to overlook
(PreToolUse via `additionalContext`, PostToolUse via stderr) — read them.

## Where things run (server / auth / offline)
| Commands | Server needed | Works offline |
|---|---|---|
| `enable`, `disable`, `doctor`, `verify`, `harness …`, `caps`, `allowlist`, `logs`, `status` | no | yes |
| `sync`, `watch` | yes | no |
| `tasks`, `send`, `inbox`, `handoff`, `workspace` | yes (auth) | no |
| `checkpoint`, `rewind`, `resume`, `guard` | no | yes |

## Which skill to load for what

| Situation | Load |
|---|---|
| Installing / enabling Interlinked, connecting a runner, daemon down, `doctor` fails, config/mode | **interlinked-setup** |
| A Bash command or edit was **BLOCKED** by a guard rule; a `[interlinked:*]` warning; suppressions | **interlinked-harness** |
| Running `interlinked verify`; a `pre_block` check blocked an edit; landing a cross-file refactor; scratch scripts | **interlinked-verify** |
| Blocked by a **line-cap / coverage / complexity / CRAP** ratchet; "can't lower a baseline"; `adopt`; debt | **interlinked-quality-gates** |
| An `npm/pip/cargo/…` install or manifest edit was blocked; the package **allowlist** | **interlinked-supply-chain** |
| Spec/doc facts, drift, invariants, review **findings**, `doctest`; `[interlinked:spec-*]` | **interlinked-spec-audit** |
| Inspect activity/logs, tail live, guard-block history, **recurrence**, `viz`, `audit`, `sync` | **interlinked-observability** |
| Server-backed **tasks/messages/reservations/handoff**; local **checkpoints** (git-mutating!) | **interlinked-coordination** |
| Distill AGENTS.md / CLAUDE.md guidance into enforced harness rules | **enforce** (`/enforce`) |

## Quick orientation
```bash
interlinked status          # dashboard: sessions, recent activity, health
interlinked doctor          # is everything installed & the daemon running?
interlinked harness status  # is the guard daemon up?
interlinked harness checks   # how many checks / rules are active
interlinked --help          # full command list
```

## Golden rules for an agent in a guarded repo
1. **When blocked, read the `Suggestion:` and take the safe path** — don't rewrite to dodge the pattern.
2. **Meet quality gates by fixing code** (decompose, add a test, cover the line) — never lower a baseline.
3. **`[proven]` findings are real** — fix them; triage `[heuristic]` ones.
4. **Package installs are default-deny** — surface an unapproved dep to the human, don't `--force`.
5. **Checkpoints/rewind mutate git** — never run them without explicit per-turn authorization.
