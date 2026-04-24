# interlinked-cli

Local hooks, taste enforcement, and developer observability for AI coding
agents (Claude Code, GitHub Copilot CLI, Gemini CLI, Cursor, Codex).

Runs local-first. The harness, activity log, and checks run on your machine;
server-backed collaboration commands are optional and require an Interlinked
MCP Server URL.

## Install

```bash
npm install -g interlinked-cli
```

Requires Node.js 22+. Supported on macOS and Linux (including WSL on
Windows — native Windows is not supported).

### From source

If you want to run from a local clone instead — to try an unreleased branch,
patch the harness, or use the CLI before the npm package publishes — the
full system works without the published package:

```bash
git clone https://github.com/QuentinCody/interlinked-cli.git
cd interlinked-cli
npm ci
npm run build          # produces dist/index.js + dist/hook-entry.js
npm link               # exposes `interlinked` and `interlinked-hook` on PATH
```

`interlinked install-hooks` from a cloned checkout records an absolute path
to `dist/hook-entry.js` in your agent's settings, so hooks will keep firing
as long as the clone stays put. If you move or delete the clone, rerun
`interlinked install-hooks` from the new location (or `interlinked
uninstall-hooks` first). The tarball-install smoke test in `.github/workflows/ci.yml`
exercises the same end-to-end path.

## What you get

- **Guard harness.** A local Unix-socket server evaluates every agent
  action against 77 deterministic safety rules (destructive commands,
  secrets in writes, sensitive-file reads, lockfile drift, etc.) and
  returns block/allow decisions in about 1–5 ms.
- **Content-quality gate.** `tsc` and `biome` run over the *proposed*
  file content before a write lands. The gate blocks only on net-new
  findings, never on pre-existing issues. Works for `Edit`/`Write`
  tools and — via `interlinked write` — for Bash-mediated writes like
  `sed -i` or `cat > file`.
- **Auto file reservation.** Every file write takes a lease-based
  reservation with a 5-minute TTL and a 30-second idle auto-release.
  When an Interlinked MCP Server is configured, a write that targets
  a file already reserved by another developer's agent is blocked with
  a pointer to coordinate via MCP messages; otherwise the reservation
  is local-only.
- **Post-edit checks.** 27 quality checks across 8+ languages (tsc,
  biome, cargo, mypy, …) and 25 structural checks (export surface,
  import resolution, cycles, blast radius) run after each edit.
- **Offline activity log.** Every hook event appends to
  `.interlinked/activity.jsonl` synchronously (~0.1 ms).
  `interlinked status`, `activity`, `explain`, and `doctor` read from
  this log.
- **Trigram grep.** Grep calls route through a cached trigram index,
  narrowing candidate files before `rg` runs.

## Quick start

```bash
# In the repo you want to instrument:
interlinked install-hooks --runner claude-code   # or omit --runner to auto-detect
interlinked harness start                        # start the local guard server
interlinked status                               # show what's configured
```

That's it for local use. Run your agent of choice and tool-use events flow
through the harness. Server commands such as `login`, `sync`, `tasks`, and
`inbox` are available when you point the CLI at an Interlinked MCP Server.

## Day-to-day commands

| Command | What it does |
|---|---|
| `interlinked status` | Summary of configured agents, active harness, recent events |
| `interlinked activity --since 1h` | Recent hook events (filterable by agent, tool, since) |
| `interlinked explain --since 1h` | Per-event explanation including guard decisions |
| `interlinked doctor` | Diagnostics: hook registration, harness liveness, config sanity |
| `interlinked write <path> --stdin` | Write a file through the content-quality gate |
| `interlinked multi-edit <path>` | Apply N edits to one file atomically (all or none) |
| `interlinked verify` | Run the full quality + structural gate over the current tree |
| `interlinked verify --all-checks` | Deep-audit mode: add advisory smell/taste checks |
| `interlinked mode` | Show or switch enforcement mode |
| `interlinked coverage` | Per-file coverage ratchet (needs a `coverage-summary.json`) |
| `interlinked mutation` | Per-file mutation-score ratchet (needs a Stryker report) |
| `interlinked structure` | Generic artifact structure management (manifests, adoption) |
| `interlinked harness start/stop/status/test` | Manage the harness daemon |
| `interlinked daemons` | List all active harness daemons and their health |
| `interlinked uninstall-hooks` | Remove hooks this CLI installed (manifest-driven) |

Run `interlinked --help` for the full command list, or `interlinked
<command> --help` for per-command flags.

## How it fits together

```
agent (Claude/Copilot/Gemini/Cursor/Codex) ──► interlinked-hook
                                        │
                                        ├─► harness Unix socket
                                        │     └─► guard eval (block/allow) in ~1–5 ms
                                        │     └─► post-edit quality + structural checks
                                        │
                                        └─► .interlinked/activity.jsonl (append, ~0.1 ms)
                                              └─► interlinked {status,activity,explain,doctor}
```

The installed hook invokes the packaged `interlinked-hook` binary. If you
uninstall the CLI, previously installed hook entries fail open until you run
`interlinked uninstall-hooks` or reinstall the package.

## Enforcement modes

Guard evaluation has two layers:

1. **Guard rules** — destructive shell commands, secrets in writes,
   recursive deletes, force-pushes to protected branches. These block
   by default and are not downgraded by mode selection. Individual
   rules can still be disabled via `disabled_rules` in
   `.interlinked/guard-rules.local.json` if you have a specific reason.
2. **Taste rules** — style, complexity, coverage, test quality. Mode
   selection governs these.

Switch modes with `interlinked mode <name>`:

- `balanced` (default): destructive commands are blocked; quality findings warn.
- `lenient`: findings surface as warnings, writes proceed.
- `strict`: findings block the write until the agent fixes them.

Team-shared policy lives in `.interlinked/guard-rules.json`. Personal
overrides go in `.interlinked/guard-rules.local.json` (gitignored).

## Privacy

- Harness decisions and activity capture are local by default. Data leaves
  your machine only when you run server-backed commands such as `login` or
  `sync`, or when you explicitly opt into another remote workflow.
- No telemetry, no analytics, no "phone home".
- Hook events, guard decisions, and quality findings stay in
  `.interlinked/` under the repo root.
- **One exception**: once per 24 hours, an anonymous GET request to the
  public npm registry checks whether a newer version is available. This
  is the same request `npm view interlinked-cli version` would make and
  carries no identifying data. Set `INTERLINKED_NO_UPDATE_CHECK=1` to
  disable; auto-disabled in CI and non-TTY environments.

## Contributing and reporting issues

- Contribution guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security policy: [SECURITY.md](./SECURITY.md)
- Bug reports and feature requests:
  <https://github.com/QuentinCody/interlinked-cli/issues>

## License

MIT. See [LICENSE](./LICENSE).
