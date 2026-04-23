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
- **Auto file reservation.** Lease-based locks with TTL auto-expiry
  prevent an agent from clobbering its own earlier edits or stepping
  on a peer.
- **Post-edit checks.** 18 quality checks across 8+ languages (tsc,
  biome, cargo, mypy, …) and 22 structural checks (export surface,
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

1. **Block-level rules** (can't be overridden): destructive shell
   commands, secrets in writes, recursive deletes, force-pushes to
   protected branches.
2. **Taste rules** (configurable): style, complexity, coverage, etc.

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
