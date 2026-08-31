---
name: interlinked-setup
description: "Install, operate, and troubleshoot the Interlinked CLI harness in a repo — install/uninstall agent hooks, connect runners (Claude Code, Codex, Copilot CLI, Gemini, Cursor), start/stop/restart the local guard daemon, run `interlinked doctor`, switch server / sync-mode / check-policy, log in, and manage the two-tier `.interlinked/` config. Load when setting up Interlinked, when `interlinked doctor` reports problems, when the guard daemon is down or stale, when hooks are not firing, or when configuring or disabling Interlinked."
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
- The guard daemon is down, stale, a **zombie**, or tool calls are blocked with a "daemon unreachable" reason.
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
- **Semantic search is optional and local.** Setup never downloads model weights. The explicit
  `interlinked semantic install` command is the only model-acquisition path; see
  **interlinked-semantic-index**.

## Turning it on

| Command | What it does | When to use |
|---|---|---|
| bare `interlinked` (unconfigured repo) | **The harness-first setup wizard** (2026-08-16): six one-line decisions — runners to hook, enforcement mode (`strict` — the recommended default — /`lenient`/`balanced`), review scope (`diff`/`whole-file` → `guard-rules.json` `diff_aware.enabled`), cap overrides, brownfield `adopt`, and dead-code posture (2026-08-17: `flag` default / `delete` instructs the agent to remove flagged dead code in the same edit / `off`; writes `structural_checks` scoped to only the dead-code checks so the rest of the family stays a separate decision; the whole-repo sweep is `interlinked deadcode`) — each Enter-accepts a recommended default, shows the plan, then composes `enable` + `mode` + `caps set` + `adopt`. Local-first: never asks about a server. Non-TTY: env-driven (`INTERLINKED_MODE` / `INTERLINKED_SCOPE` / `INTERLINKED_ADOPT` / `INTERLINKED_CLIENTS`). A failed step reports and continues — every step is individually re-runnable via the owning command. Ends with a **posture receipt** (2026-08-17): one line per thing now enforced, each naming the command that changes it. | A new user's first touch; the fastest correct install. |

**A mode is a posture, not just check severities (2026-08-17).** `interlinked mode
strict|balanced|lenient` also ladders the philosophy-dependent gates into
`guard-rules.json` (merge-preserving; later hand edits win until the mode is
re-applied): the new-file TDD gate (`strict`=block, `balanced`=warn,
`lenient`=off), per-edit coverage (`strict`=no-debt blocking, `balanced`=debt
mode, `lenient`=off), and the session-end verification/commit-cadence nudges
(`lenient` turns them off). Security rails and tighten-only ratchets never
ladder. `custom` applies nothing.

**Folded into onboarding (2026-08-17), no longer separate steps:** `enable`
builds the trigram index when absent (grep acceleration works from session
one), and `adopt` step 6 snapshots existing manifests/lockfiles into the
install allowlist (`approved_by: "adopt"`) so the fail-closed install gate only
prompts on genuinely NEW packages.
| `interlinked enable` | Full setup: writes `.interlinked/` config, installs per-client hooks, updates `.gitignore`, installs statusline (Claude/Copilot), installs every bundled Interlinked skill, **auto-starts the daemon**. Idempotent; re-running **clears any stand-down**. | The normal way to turn Interlinked on. |
| `interlinked setup` | Runs `enable`, then `login` if no token (skips login on localhost / when a token is present). | You also want server auth right away. |
| `interlinked init` | Interactive/auto onboarding wizard (`--yes` for non-interactive): installs hooks on its own path, logs in, attaches a workspace — and installs **no skills**. | Guided team/workspace setup only. |
| `interlinked install-hooks` | **Adapter path**: writes only hook entries + `installer-manifest.json` (no config scaffold, **no skills**). | Precise, manifest-tracked hook install. |

> **`enable` is the canonical entry point** — the CLI `--help` epilog and the README both
> recommend it, and bare `interlinked` and `setup` just wrap it. Prefer it over `install-hooks`:
> only `enable` installs the skills that teach an agent how to read a block. Without them the
> first block is a message the agent must guess at, and the likeliest guess is to work around
> the gate.

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
> binary. Codex automatically detects skill changes; if an active session does not, restart it.
> Copilot needs `/skills reload` to pick up skill changes.

## Native shell sandbox posture

Enable each client's strictest usable native sandbox separately; Interlinked hook installation does
not turn the provider sandbox on. Bash PreToolUse reports `[interlinked:sandbox]` as `attested`,
`configured`, `disabled`, or `unknown`. Treat `configured` as weaker than per-call attestation because
CLI/profile overrides can change the active call. Explicit Codex escalated/`danger-full-access` calls
and Claude unsandboxed settings are reported as disabled evidence.

Native workspace-write sandboxes constrain host/network reach but still allow real writes inside the
project. They complement Interlinked's post-call filesystem ChangeSet and Stop residue backstop; they
do not provide rollback or replace the deterministic PreToolUse guards. See **interlinked-harness**
for interpreting the warning.

## Operating the daemon

| Command | Purpose |
|---|---|
| `interlinked harness start [--verbose] [--json]` | Start the daemon (background). Reaps orphans first and auto-rebuilds stale `dist/`, so a cold start can take a few seconds. |
| `interlinked harness stop` | SIGTERM the daemon. |
| `interlinked harness restart` | Stop + fresh start; **the only way to pick up config/mode changes**. Note: clears per-session trajectory state. Defers instead of killing when a start is already in flight, and backs off with "Too many restart attempts" if too many restarts (any trigger) went unresolved recently — see below. |
| `interlinked harness status [--json]` | **Liveness** (three states, below) + socket, RSS, mode, orphan count, build staleness. `--json` adds `liveness` and `socket_answered`. |
| `interlinked daemons [--cleanup]` | List **all** per-session daemons; `--cleanup` purges dead-PID records. |
| `interlinked harness reap [--force] [--all]` | List (default) or kill orphan daemons. |

```bash
interlinked harness status --json      # is it up? which mode?
interlinked harness restart            # after editing config / changing mode
```

### Liveness is a round-trip, not a PID

`status` and `doctor` both send a real event and wait for the answer, because a daemon can stay
process-alive while its listener is dead. Three states, and both surfaces use the same words:

| `harness status` | `doctor` | Meaning |
|---|---|---|
| `running (PID …) — socket answering` | `pass` — `Running (PID …) -- socket answering` | Verified: something answered. |
| `ZOMBIE — process alive (PID …), no socket answering` | **`fail`** — same remedy line | **The guard is off.** Tool calls fail closed (or run ungated on a fail-open runner). |
| `not running` | `warn` — inline fallback | Honest and expected; the inline subset still guards. |

Only an answered probe prints `running (PID …)`, so that line can no longer appear above
`Socket: not found`. **Fix a zombie with `interlinked harness restart`** — both surfaces print
that remedy inline. A pid-alive daemon gets one confirming re-probe, so a daemon still binding
right after `restart` is not mislabelled.

### Restart defers to an in-flight start, and backs off under churn (2026-08-22)

`interlinked harness restart` used to stop-then-start unconditionally, so two overlapping
restart triggers (a build-refresh handover, an rss-ceiling recycle, a second manual restart)
could kill a successor the other had just spawned, before it finished binding. Now:

- If a start is already in flight (the daemon is mid-boot), `restart` waits for its socket
  instead of killing it — printing "already in flight" and doing nothing further once it
  answers.
- If too many restart attempts (any trigger) went unresolved in the last ~10 minutes, `restart`
  refuses and prints "Too many restart attempts … backing off" instead of adding to the churn.
  Check `.interlinked/daemon-events.jsonl` for the pattern before retrying by hand.

Neither path is silent: every deferral or backoff writes a `handover` row to the daemon ledger
(`daemon-ledger.ts` / `handover-churn.ts`), so `daemon-events.jsonl` always explains what
`restart` actually did.

## Diagnosing problems

`interlinked doctor` is the first stop. It runs local + system + server checks and **exits
non-zero if any check fails**. `--fix` repairs common drift (regenerates a drifted hook
script, safely refreshes Interlinked-owned skill copies, strips malformed permission rules,
migrates legacy config).

```bash
interlinked doctor            # diagnose
interlinked doctor --fix      # auto-repair what it safely can
interlinked context --json    # show the effective merged config
interlinked env               # list supported env vars + current values
```

What "healthy" looks like in `doctor`: config dir + both config files present, hook script
present, per-client "Hooks installed", and **Harness server: Running (PID …) -- socket
answering**. A zombie is a **`fail`** here, never a pass. Hook detection shares one ownership
predicate with the installers, so an adapter (`hook-entry.js`) install is recognised as
installed rather than reported missing. A missing token on a non-localhost server is a `fail`;
on localhost it is only a `warn` (dev mode allows unauthenticated).

### When the daemon will not stay up

A daemon that fails **before** binding its socket exits **78** (`EX_CONFIG`) and appends an
`exit` row with `reason: "startup-failed"` to `.interlinked/daemon-events.jsonl`. It no longer
lingers as a zombie. Read that ledger before theorising — it separates a failed bind (78) from
a graceful stop, a lost ownership race (**0**, orderly, not a failure), and a crash.

```bash
tail -n 20 .interlinked/daemon-events.jsonl   # why did it leave?
interlinked harness reap                       # list orphan daemons (--force kills)
interlinked harness restart                    # the usual fix
```

Bind attempts are bounded with backoff, and a socket that **answers** is never unlinked — a
live incumbent wins and the newcomer exits instead of stomping it. Only a silent, stale socket
file is cleared and retried.

**Dev loop after editing the CLI source:** `interlinked reload` rebuilds the CLI in its own
checkout, refreshes this repo's hooks and deployed skills, and restarts the daemon **only if
something the daemon executes changed**.

## Config & environment

- **`.interlinked/config.json`** (committed): `server_url`, `default_project`, `mode`
  (operational tier), `skip_paths`, `pii_patterns`, nested `harness` feature flags.
- **`.interlinked/config.local.json`** (gitignored): `access_token`, `agent_name`,
  `workspace_id`, `sync_mode`, `active_server` + `servers` map, `guard_mode`, `data_dir`.
- **`.interlinked/semantic.json`** (committed): optional semantic-index enablement, exact pinned
  model reference, and source/test include policy.
- **`.interlinked/semantic.local.json`** (gitignored): local-only CPU/runtime topology. Remote URLs,
  API tokens, and cloud fallbacks are rejected by the v1 schema.
- **Env overrides** (win over both files): `INTERLINKED_SERVER_URL`,
  `INTERLINKED_ACCESS_TOKEN` (alias `INTERLINKED_TOKEN`), `INTERLINKED_AGENT_NAME`,
  `INTERLINKED_WORKSPACE_ID`, `INTERLINKED_SYNC_MODE`, `INTERLINKED_HOME` (relocates the whole
  config dir), `INTERLINKED_DATA_DIR`, `INTERLINKED_CLIENTS` (non-interactive bootstrap only).

**Two different `mode` commands — do not conflate them:**
`enable`, `adopt`, `doctor`, metrics, hooks, and search do not auto-download embedding weights.
The experimental semantic commands also require compatible local `llama-embedding` and
`llama-tokenize` executables (override their command names only in `semantic.local.json`). Model
weights live in the platform user cache; project vectors live under the gitignored
`.interlinked/index/functions/` directory and are never synced.

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
- **Gemini is a compatibility lane, not the Antigravity adapter.** Consumer Gemini CLI service
  ended in June 2026, while enterprise and paid API-key Gemini CLI use remain supported. The
  current `gemini` client installs Gemini CLI hooks/skills; do not treat it as Antigravity.
- **`reload` needs a source checkout** — it rebuilds the CLI checkout the running binary
  resolves to (typically a `~/.local/bin` symlink), not the current repo.
- `--json` support is per-command; unknown flags error. `doctor` takes only `--fix`/`--json`.

## Related skills
- **interlinked-harness** — what the guard blocks and how to respond when a tool call is refused.
- **interlinked-observability** — inspect the activity the hooks capture (`status`, `activity`, `logs`).
- **interlinked-coordination** — the optional server-backed side (tasks, messages, workspaces).
- **interlinked-semantic-index** — explicitly install a model and build/query the local function index.
