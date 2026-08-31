# Changelog

All notable changes to `interlinked-cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Evidence-backed simplification suite** — `interlinked simplify
  scan|review|audit` composes local dead-code, structure, dependency, and
  complexity evidence into advisory findings with stable identities, exact
  scope/coverage receipts, explicit persistence, and a portable but
  never-implicitly-submitted Agent CI handoff. `simplify status` reads the
  append-only local run history and common findings corpus.
- **Manual debt-marker lifecycle** — `interlinked debt markers` recognizes
  source-owned decisions with ceilings and measurable upgrade triggers. The
  default scan is read-only; `--record` appends opened/changed/closed snapshot
  receipts without consulting or discharging automatic obligations.
- **Evidence-classed impact** — `interlinked impact` separates recorded
  potential, independently Sandbox-validated candidates, observed repository
  and lifecycle facts, and strictly manifest-gated causal experiments. It
  deliberately makes no universal gain or savings claim.
- **Agent CI simplification contracts** — canonical content-addressed request,
  partition/specialist/skeptic, protected Sandbox plan, capability-catalog,
  controlled-experiment, and adversarial-fixture schemas are available for
  the Interlinked MCP Server implementation. The CLI does not pretend that a
  remote job was submitted or executed.

### Removed

- **Update notifier** — the once-per-24-hours anonymous GET to the public
  npm registry is gone, along with `src/lib/update-check.ts`, the
  `~/.cache/interlinked-cli/update-check.json` cache, and the
  `INTERLINKED_NO_UPDATE_CHECK` env var. The CLI now makes zero outbound
  network calls on its own; only the server-backed commands you
  explicitly run touch the network.

## [0.1.0] - 2026-04-23

Initial public release. The codebase was extracted from an internal
monorepo as a squashed snapshot — earlier commits before this release
live only in the internal repo.

### Added

- **Hook capture** for Claude Code (14 events), GitHub Copilot CLI, and
  Gemini CLI — the CLI installs per-client settings to ferry tool-use
  events through a shared normalized schema.
- **Local guard harness** — a Unix-socket server that evaluates every
  PreToolUse against 77 deterministic safety rules (destructive commands,
  secrets in writes, sensitive-file reads, lockfile drift, etc.) and
  returns `{decision: block/allow}` in ~1–5 ms.
- **Auto file reservation** — lease-based file locking with TTL
  auto-expiry so multiple agents (or a single agent across turns) don't
  stomp on each other mid-edit.
- **Post-edit quality checks** — 18 checks across 8+ languages (tsc,
  biome, cargo, mypy, etc.) plus 22 structural checks (export surface,
  import resolution, cycles, blast radius).
- **Diff-overlay pre-block** — tsc and biome run against the *proposed*
  file content before the write lands and compare to cached diagnostics
  for the on-disk file; the gate blocks the write only on net-new
  findings, never on pre-existing issues.
- **`interlinked write`** — Bash-compatible content-gated write path.
  Routes `sed -i`, `node -e fs.writeFileSync`, `cat > file`, `tee`, and
  other Bash-mediated writes through the same diff-overlay gate.
  `interlinked write <path> --stdin` or `interlinked write --batch
  <manifest.json>` for atomic multi-file writes.
- **`interlinked multi-edit`** — atomic coordinated multi-site edit.
  Apply N edit operations (insert / replace / delete) against a single
  file and either commit all or none, so cases like "add a constant AND
  replace every usage" can't leave the file half-edited.
- **`package_json_publish_invariants` harness check** — blocks silent
  removal of publish-critical fields (`name`, `version`, `main`, `types`,
  `exports`, `bin`, `files`, `engines`, `publishConfig`, etc.) at
  PreToolUse, before a broken tarball could ship. Tree-root-gated
  (only real publish targets), skipped for `"private": true`.
- **Offline-first activity log** — every event appends to
  `.interlinked/activity.jsonl` synchronously (~0.1 ms); the CLI itself
  performs no network activity by default.
- **Update notifier** — background fetch of the npm registry "latest"
  dist-tag, cached in `~/.cache/interlinked-cli/update-check.json` with a
  24-hour TTL. On subsequent runs, a one-line notice prints to stderr if
  a newer version is available. Auto-disabled in CI, non-TTY, and tests.
  Opt out with `INTERLINKED_NO_UPDATE_CHECK=1`.
- **Developer observability commands** — `status`, `activity`,
  `explain`, `doctor`, `trace`.
- **Enforcement-mode switcher** — `interlinked mode` toggles between
  warn / balanced / block presets.
- **Per-file ratchets** — `interlinked coverage` and `interlinked
  mutation` block any per-file regression in coverage or Stryker
  mutation score.
- **Harness daemon lifecycle** — `interlinked harness
  start/stop/status/test` and `interlinked daemons` for multi-session
  inventory.
- **Trigram grep acceleration** — PreToolUse grep calls route through a
  cached trigram index, narrowing candidate files before `rg` runs.
- **`JsonObject` boundary type** (`src/lib/json-types.ts`) — shared
  narrow type for foreign JSON, so `broad_object_types` recognises a
  single named boundary instead of flagging every
  `Record<string, unknown>`.

### Harness false-positive reductions

These refinements make the harness quieter without weakening detection:

- `dead_exports` recognises dynamic `await import()` destructures, so
  exports wired via lazy imports are no longer flagged as unused.
- `supply_chain` typosquat check ships an allowlist of legitimate
  short-named packages (tsup, tsx, vite, vitest, esbuild, etc.) and
  skips when only version fields changed.
- `magic_literal_in_conditional` skips self-describing case-statement
  labels (shell names, event kinds, HTTP methods, log levels).
- `shotgun-surgery` warning auto-acks after firing once per threshold
  instead of repeating on every subsequent edit.
- `lockfile_drift` gets a short grace window so edit-then-regenerate
  workflows don't trip the check mid-stream.
- `broad_object_types` recognises `JsonObject` / `JsonValue` as named
  boundary types.
- `floating_promises` skips arrow-function and interface-signature
  declarations that aren't real async calls.
- `stripAllLiterals` now strips comments first so regex literals inside
  `//` comments can't self-match detection patterns.

### Distribution

- Node.js 22+ required (`engines.node: ">=22.0.0"`).
- Supported platforms: macOS, Linux (including WSL on Windows). Native
  Windows is not supported — `"os": ["darwin", "linux"]` in
  `package.json` enforces this at install time.
- ESM-only (`"type": "module"`).
- Single runtime dependency: `commander@^12`.
- `@typescript/native-preview` is an **optional** dev-time dependency
  (fast typechecking via `tsgo`); `tsc` via `typecheck:stable` is the
  publish gate.
- Published with npm OIDC trusted publishing + provenance.

### Known limitations

- `files_without_test` check has a known gap on files under `scripts/`
  and `test/agent-driven/` because the default `vitest` glob only picks
  up `src/**/*.test.ts`.

[0.1.0]: https://github.com/QuentinCody/interlinked-cli/releases/tag/v0.1.0
