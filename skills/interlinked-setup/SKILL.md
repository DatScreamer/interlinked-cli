---
name: interlinked-setup
description: Install, operate, and troubleshoot the Interlinked CLI harness in a repo — install/uninstall agent hooks, connect runners (Claude Code, Codex, Copilot CLI, Gemini, Cursor), start/stop/restart the local guard daemon, run `interlinked doctor`, switch server / sync-mode / check-policy, log in, and manage the two-tier `.interlinked/` config. Load when setting up Interlinked, when `interlinked doctor` reports problems, when the guard daemon is down or stale, when hooks are not firing, or when configuring or disabling Interlinked.
---

# interlinked-setup — install, operate & troubleshoot the harness

Interlinked is a **local, offline-first guard layer** for AI coding agents. Everything
lives under `<repo>/.interlinked/`, and a **local daemon** ("the harness", a Unix-socket
server) evaluates every agent tool call. This skill covers turning it on, keeping the
daemon healthy, configuring it, and turning it off. The remote server is **optional** —
hooks, guard, and activity capture work with zero network.

## Load this when
- Installing Interlinked or connecting a runner (Claude Code / Codex / Copilot CLI / Gemini / Cursor).
- `interlinked doctor` reports failures, or hooks are not firing / not capturing events.
- The guard daemon is down, stale, or tool calls are being blocked with a "daemon unreachable" reason.
- Changing the server URL, sync mode, or check-policy/operational tier.
- Disabling or fully removing Interlinked.

## Mental model
- **Per-`cwd`, offline-first.** All state is `<cwd>/.interlinked/`. Two-tier config:
  `config.json` (committed, shared) + `config.local.json` (gitignored, personal).
- **A daemon does the work.** `harness start` runs a background Unix-socket server. When it
  is up you get the full check set; when it is down the hook falls back to a small inline
  subset and **fails closed on the dangerous stuff** (destructive commands, package installs,
  line-cap, merge conflicts).
- **The server is optional.** Auth / sync only matter for server-backed coordination
  (see `interlinked-coordination`). Skip it entirely for local-only use.

## Turning it on

| Command | What it does | When to use |
|---|---|---|
| `interlinked enable` | Full setup: writes `.interlinked/` config, installs per-client hooks, updates `.gitignore`, installs statusline (Claude/Copilot), installs the `/enforce` skill, **auto-starts the daemon**. Idempotent; re-running **clears any stand-down**. | The normal way to turn Interlinked on. |
| `interlinked setup` | Runs `enable`, then `login` if no token (skips login on localhost / when a token is present). | One-shot bootstrap with server auth. |
| `interlinked init` | Interactive/auto onboarding wizard (`--yes` for non-interactive). | Guided first-run. |
| `interlinked install-hooks` | **Adapter path**: writes only hook entries + `installer-manifest.json` (no full config scaffold). | Precise, manifest-tracked hook install. |

Key `enable` flags: `--server <url>` · `--agent <name>` · `--clients <list>`
(`claude,copilot,gemini,codex,cursor`) · `--sync-mode <realtime|local|manual>` ·
`--data-dir <path>` · `--structure <mode>` · `--dry-run`.
`install-hooks` uses different vocabulary: `--runner <claude-code,copilot-cli,cursor,gemini-cli,codex>`
· `--scope <user|project|local>` · `--mode <balanced|strict|lenient>`.

```bash
interlinked enable --agent my-bot                 # detects clients, starts daemon
interlinked enable --clients claude --dry-run      # preview without writing
interlinked install-hooks --runner claude-code --scope project
```

> Client detection = presence of the config **directory** (`.claude/`, `.codex/`, …), not the
> binary. After enabling, **Codex needs a session restart** and **Copilot needs `/skills reload`**
> to pick up hooks.

## Operating the daemon

| Command | Purpose |
|---|---|
| `interlinked harness start [--verbose] [--json]` | Start the daemon (background). Reaps orphans first and auto-rebuilds stale `dist/`, so a cold start can take a few seconds. |
| `interlinked harness stop` | SIGTERM the daemon. |
| `interlinked harness restart` | Stop + fresh start; **the only way to pick up config/mode changes**. Note: clears per-session trajectory state. |
| `interlinked harness status [--json]` | Running/PID, socket, RSS, mode, orphan count, build staleness. |
| `interlinked daemons [--cleanup]` | List **all** per-session daemons; `--cleanup` purges dead-PID records. |
| `interlinked harness reap [--force] [--all]` | List (default) or kill orphan daemons. |

```bash
interlinked harness status --json      # is it up? which mode?
interlinked harness restart            # after editing config / changing mode
```

## Diagnosing problems

`interlinked doctor` is the first stop. It runs local + system + server checks and **exits
non-zero if any check fails**. `--fix` repairs common drift (regenerates a drifted hook
script, strips malformed permission rules, migrates legacy config).

```bash
interlinked doctor            # diagnose
interlinked doctor --fix      # auto-repair what it safely can
interlinked context --json    # show the effective merged config
interlinked env               # list supported env vars + current values
```

What "healthy" looks like in `doctor`: config dir + both config files present, hook script
present, per-client "Hooks installed", and **Harness server: Running (PID …)** (vs
"Not running — inline fallback"). A missing token on a non-localhost server is a `fail`; on
localhost it is only a `warn` (dev mode allows unauthenticated).

**Dev loop after editing the CLI source:** `interlinked reload` rebuilds the CLI in its own
checkout, refreshes this repo's hooks, and restarts the daemon **only if something changed**.

## Config & environment

- **`.interlinked/config.json`** (committed): `server_url`, `default_project`, `mode`
  (operational tier), `skip_paths`, `pii_patterns`, nested `harness` feature flags.
- **`.interlinked/config.local.json`** (gitignored): `access_token`, `agent_name`,
  `workspace_id`, `sync_mode`, `active_server` + `servers` map, `guard_mode`, `data_dir`.
- **Env overrides** (win over both files): `INTERLINKED_SERVER_URL`,
  `INTERLINKED_ACCESS_TOKEN` (alias `INTERLINKED_TOKEN`), `INTERLINKED_AGENT_NAME`,
  `INTERLINKED_WORKSPACE_ID`, `INTERLINKED_SYNC_MODE`, `INTERLINKED_HOME` (relocates the whole
  config dir), `INTERLINKED_DATA_DIR`, `INTERLINKED_CLIENTS` (non-interactive bootstrap only).

**Two different `mode` commands — do not conflate them:**
- `interlinked mode <balanced|strict|lenient>` → per-check **policy** preset → `check-policy.json`.
- `interlinked harness mode <budget|quality|ci>` → operational **timeout tier** → `config.json`
  `mode` + regenerates the hook. Requires `harness restart` to take effect.

## Auth & server (optional)

```bash
interlinked login --server https://your-server.dev   # OAuth PKCE (opens browser)
interlinked login --token "$INTERLINKED_TOKEN"        # CI / headless
interlinked attach --agent my-bot --auto              # link identity + workspace
interlinked logout [--all]
```

- **localhost/127.0.0.1 = dev mode → auth skipped** (`setup`/`init` skip login for local servers).
- Token resolution: CLI token in `config.local.json` → auto-refresh → Claude Code
  credential fallback (`~/.claude/.credentials.json`).
- Sync modes: `realtime` (default; per-event post + session-end batch), `manual`
  (per-event only), `local` (no server posts at all).

## Turning it off

| Command | Effect |
|---|---|
| `interlinked disable [--reason <t>] [--until <dur>] [--team]` | **Non-destructive** stand-down: records a marker + stops the daemon. Hooks and config stay. Re-arm with `interlinked enable`. |
| `interlinked disable --uninstall [--keep-config]` | Destructive teardown: removes hooks + the installed skills **and deletes the `.interlinked/` config dir** — pass `--keep-config` to keep the config. |
| `interlinked reset --force` | **Nuclear**: delete the entire `.interlinked/` dir and strip hook entries. Irreversible; `--force` required. |
| `interlinked uninstall-hooks` | Remove **only** what `install-hooks` recorded in its manifest. |

> A **live daemon ignores the stand-down marker**. If `disable` reports the daemon is still
> running, run `interlinked harness stop` — the project stays guarded until the daemon dies.

## Gotchas
- **`disable` is non-destructive by default now** — bare `disable` just stands down; use
  `--uninstall` (or `reset --force`) for real teardown.
- **`clean` defaults to dry-run**; `reset` requires `--force`.
- **Two install paths, non-interchangeable uninstall.** `uninstall-hooks` only cleans an
  `install-hooks`-style install; use `disable --uninstall` / `reset` to clean an `enable` install.
- **Claude Code merge-up dedup:** `enable` refuses to install Claude hooks when an ancestor
  `.claude/settings.json` already has them (would double-fire) — run `enable` from that ancestor.
- **`reload` needs a source checkout** — it rebuilds the CLI checkout the running binary
  resolves to (typically a `~/.local/bin` symlink), not the current repo.
- `--json` support is per-command; unknown flags error. `doctor` takes only `--fix`/`--json`.

## Related skills
- **interlinked-harness** — what the guard blocks and how to respond when a tool call is refused.
- **interlinked-observability** — inspect the activity the hooks capture (`status`, `activity`, `logs`).
- **interlinked-coordination** — the optional server-backed side (tasks, messages, workspaces).
