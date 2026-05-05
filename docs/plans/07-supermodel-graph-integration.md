# Supermodel `.graph.*` Integration

PreToolUse-time blast-radius warnings sourced from Supermodel-emitted `.graph.*` shards, when present.

## Goal

When an agent is about to Write/Edit a file, and a Supermodel-generated `.graph.*` shard exists next to it on disk, surface the `[impact]` section as a PreToolUse warning so the agent has structural awareness *before* the edit lands. Read-only consumer — Interlinked never writes, generates, or modifies graph files.

## Context

[Supermodel](https://supermodeltools.com) is a paid SaaS that emits per-file code-graph shards (`Foo.tsx` → `Foo.graph.tsx`) containing imports/callers/blast-radius derived from a tree-sitter parse + call-graph build. Their `supermodel` daemon writes these shards on every PostToolUse via a Claude Code hook, keeping them current with the working tree.

Their tooling stops at *emission*: an agent reads `.graph.*` files via grep/cat (the file is the API), but nothing prevents a destructive edit before the agent thinks to look. Interlinked's harness already runs a PreToolUse decision path (`src/harness/evaluator/pre-tool.ts`), already surfaces structural context from its own in-memory graph (`getPreToolUseContext`), and already emits warnings the agent must read before proceeding. Wiring the two together means the agent sees blast-radius information before *every* edit on a Supermodel-equipped repo, not just when it remembers to grep.

This is a complementary integration, not a competing one. We add zero load to Supermodel's product (no API calls, no shard generation, no caching); they get a PreToolUse safety layer they don't currently ship; users of both tools get a stack that's strictly better than either alone.

See `docs/plans/06-file-reminders.md` for the prior structural-context pattern this mirrors. See `docs/integrations/supermodel.md` (created by this plan) for the user-facing writeup that doubles as the public artifact.

## `.graph.*` format (verified)

Filename derivation: insert `.graph` before the extension. `src/Foo.tsx` → `src/Foo.graph.tsx`. Comment prefix: `#` for `.py` and `.rb`; `//` for everything else (Go shards additionally carry a `//go:build ignore\n\npackage ignore\n` header so the Go toolchain skips them).

Three optional sections, any of which may be absent:

```
// @generated supermodel-sidecar — do not edit
// [deps]
// imports     internal/api/client.go
// imports     internal/cache/cache.go
// imported-by cmd/focus.go
// [calls]
// Run ← init    cmd/focus.go:10
// Run → getGraph    internal/focus/handler.go:342
// extract → reachableImports    internal/focus/handler.go:173
// [impact]
// risk        MEDIUM
// domains     CLIInfrastructure · SupermodelAPI
// direct      1
// transitive  2
// affects     cmd/focus.go
```

The `[impact]` block is the load-bearing one for our use case. Risk levels are HIGH / MEDIUM / LOW per Supermodel's renderer (`reference-repos/supermodel-cli/internal/shards/render.go:176-184`):

| Threshold | Risk |
|---|---|
| `transitive > 20 OR domains > 2` | HIGH |
| `transitive > 5 OR domains > 1` | MEDIUM |
| else | LOW |

## Files to add / change

| File | Status | Purpose |
|---|---|---|
| `src/harness/supermodel-graph.ts` | new | Parser + loader. Pure functions, no I/O dependencies beyond `node:fs` reads. |
| `src/harness/__tests__/supermodel-graph.test.ts` | new | Parser unit tests + evaluator integration tests. |
| `src/harness/__tests__/fixtures/supermodel/` | new | Hand-crafted shard fixtures (HIGH, MEDIUM, LOW, malformed, empty-sections). |
| `src/harness/evaluator/pre-tool.ts` | edit | Add a new `// CONTEXT: Supermodel graph awareness` block after the existing structural-context section (~line 688). |
| `docs/integrations/supermodel.md` | new | One-page writeup explaining the integration. Doubles as the public artifact for the post-build outreach. |

## Module surface (`src/harness/supermodel-graph.ts`)

```typescript
export interface SupermodelGraph {
  /** Absolute path of the shard file we read. */
  shardPath: string;
  /** Absolute path of the source the shard describes. */
  sourcePath: string;
  /** Parsed [impact] section, or null if the section is absent or unparseable. */
  impact: ImpactSection | null;
  /** Parsed [calls] section, or null if absent or unparseable. */
  calls: CallsSection | null;
  /** Parsed [deps] section, or null if absent or unparseable. */
  deps: DepsSection | null;
}

export interface ImpactSection {
  risk: "HIGH" | "MEDIUM" | "LOW";
  /** May be empty: Supermodel only emits this field when domain set is non-empty. */
  domains: string[];
  /** File-granularity count: union of importers and files containing callers
   *  of any function defined in the source. NOT a count of distinct callers
   *  or import statements — see render.go:128-150 for the union computation. */
  direct: number;
  /** Count of files transitively reachable through the import/call graph. */
  transitive: number;
  /** Listed files in the `direct` union. May be empty: Supermodel only emits
   *  this field when direct > 0. */
  affects: string[];
}

export interface CallsSection {
  /** "FuncName ← CallerName    file:line" */
  callers: Array<{ fn: string; caller: string; file: string; line: number }>;
  callees: Array<{ fn: string; callee: string; file: string; line: number }>;
}

export interface DepsSection {
  imports: string[];
  importedBy: string[];
}

/** Insert `.graph` before the extension. Mirrors Supermodel's ShardFilename.
 *  Operates on a string in/out — does not touch the filesystem. */
export function shardPathFor(sourcePath: string): string;

/** Read + parse a shard file for a source path.
 *
 *  `sourcePath` may be absolute or relative. `cwd` is required when the path
 *  is relative; the function resolves to absolute before deriving the shard
 *  filename and reading. Most call sites pass `event.cwd` directly.
 *
 *  Returns null on any of:
 *    - missing source path / cwd needed but not provided
 *    - resolved path escapes cwd via traversal (defensive)
 *    - shard file does not exist
 *    - shard file is larger than 1 MB (fail-open guard against pathological shards)
 *    - I/O error (permissions, etc.)
 *    - file contents are completely unparseable (no recognizable header or section)
 *
 *  Section-level parse failures (e.g. malformed `risk` value, garbled `direct`
 *  field) null only the affected section, not the whole graph. Never throws. */
export function loadGraphForFile(sourcePath: string, cwd?: string): SupermodelGraph | null;

/** Parse shard text. Exported for tests. Tolerant: unknown lines are ignored,
 *  unknown section names are ignored, malformed fields within a section
 *  null only that section. Returns null only when the input has no recognizable
 *  structure at all (no header, no sections). */
export function parseGraphFile(content: string, sourcePath: string, shardPath: string): SupermodelGraph | null;
```

Implementation notes:

- Use the existing `extractAllEditedFilePaths(event)` helper from `src/harness/server-tool-helpers.ts:79` at call sites — don't reinvent the `(file_path) || (path)` chain inline. The narrower `extractFilePath(event)` from `structural-checks/helpers.ts` is *not* sufficient: it misses Codex `apply_patch` payloads, the `filePath`/`target_file` shapes, and runner-supplied `files_modified` arrays. See the evaluator wiring section below for full rationale.
- Resolve the source path against `event.cwd` before deriving the shard path. PreToolUse payloads can carry relative paths (`src/foo.ts`) that won't locate the shard otherwise. Use `path.resolve(cwd, sourcePath)` and verify the result stays within `cwd` before reading (the existing `evaluateRepoConfinement` guard is a model for the traversal check).
- Strip the language comment prefix (`//` or `#`) before parsing each line. Detect prefix from the first non-empty content line.
- Skip the `//go:build ignore` / `package ignore` Go preamble if present.
- Section detection is exact-match on `[deps]` / `[calls]` / `[impact]` after prefix stripping.
- Field parsing inside `[impact]` uses an explicit head/tail split so multi-token values (the most important being `domains     A · B · C`) are preserved intact:

  ```typescript
  const trimmed = line.trim(); // "domains     A · B · C"
  const [key, ...valueParts] = trimmed.split(/\s+/);
  const value = valueParts.join(" "); // "A · B · C"
  ```

  A naive `const [key, value] = trimmed.split(/\s+/)` would drop everything after the first space-separated token and silently lose every domain past the first.
- `domains` is split on ` · ` (U+00B7 middle dot, the renderer's separator). Field is *omitted entirely* when the domain set is empty (`render.go:190`); parser treats absence as `domains: []`.
- `affects` uses the same separator. Field is *omitted entirely* when `direct === 0` (`render.go:197`); parser treats absence as `affects: []`.
- All numeric fields parsed via `Number.parseInt(_, 10)`; non-numeric → impact section nulled (whole-graph still returned with `impact: null`).
- File-level errors (missing, oversized, unreadable, no recognizable header) → whole-graph null.

## Evaluator wiring (`src/harness/evaluator/pre-tool.ts`)

Insert a new block after the existing `// CONTEXT: Structural context injection` section (around line 688, before `// PROJECT SETUP`). Pseudocode:

```typescript
// CONTEXT: Supermodel graph awareness — surface blast radius from
// Supermodel-emitted .graph.* shards if the user is running their daemon.
// Read-only consumer; silent when no shard exists. Loops over every
// edited path so multi-file Codex apply_patch payloads each get their
// own warning. Note: isFileWrite() already includes "apply_patch"
// (tool-classifiers.ts:75), so the existing gate covers Codex too.
if (isFileWrite(toolName)) {
  for (const filePath of extractAllEditedFilePaths(event)) {
    const graphWarning = getSupermodelGraphWarning(filePath, event.cwd);
    if (graphWarning) warnings.push(graphWarning);
  }
}
```

Where `getSupermodelGraphWarning(filePath, cwd)` is a small helper (kept in `pre-tool.ts` next to `getPreToolUseDiagnostics`) that:

1. Calls `loadGraphForFile(filePath, cwd)`. The `cwd` is forwarded so relative tool-input paths resolve to the right shard location.
2. Returns `null` if no graph or no `[impact]` section.
3. Builds a single warning string per the table below; returns `null` for LOW (don't add noise on routine edits).

Use `extractAllEditedFilePaths` from `src/harness/server-tool-helpers.ts:79` rather than `extractFilePath` from `structural-checks/helpers.ts` or any inlined `file_path || path` chain. The richer helper covers:
- `file_path` (Claude Code Write/Edit)
- `filePath` (camelCase variant)
- `path` (some MCP tool shapes)
- `target_file` (Cursor / OpenAI agents)
- Codex `apply_patch` payloads with one or more `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` sections — read from any of `tool_input.command`, `patch`, `content`, or `_raw_patch`, matching the hook-side normalizer in `lib/hooks-template.ts:1130` (server-side reading only `command` would silently drop every patch event delivered under one of the alternate field names)
- `event.files_modified` arrays surfaced by some runners

Single-file events return a length-1 array; multi-file `apply_patch` returns each touched path in source order, dedup'd. Looping handles both cases uniformly. The `extractFilePath` helper used in the previous draft only catches `file_path || path` and would silently miss every other shape — replacing it is the load-bearing fix here.

Tag prefix follows the existing `[interlinked:foo]` convention: `[interlinked:supermodel-graph]`. Each warning includes the relative source path so multi-file patches stay disambiguated.

| Risk | Warning fires | Format |
|---|---|---|
| HIGH | yes | `[interlinked:supermodel-graph] <relPath>: HIGH-risk edit per .graph shard: <direct> dependent file(s), <transitive> transitive[ across domains <A · B · …>]. Affects: <up to 5 file paths>. Confirm this is intentional.` |
| MEDIUM | yes (terser) | `[interlinked:supermodel-graph] <relPath>: <direct> dependent file(s)[ across <domains>]. Affects: <up to 3 paths>.` |
| LOW | no | silent — routine edit, no noise |
| no shard | no | silent — fully fail-open, zero overhead |
| malformed shard | no | silent — fail-open, no user-facing error |

`<relPath>` is the source path relative to `event.cwd` (or the absolute path if resolution fails) — matches existing `[interlinked:diagnostics]` wording at `pre-tool.ts:172`.

`direct` is a count of distinct dependent *files* — the union of importers and files containing callers of any function defined in the source — not a count of caller sites or import statements. Wording mirrors Supermodel's renderer (`render.go:128-150`). Sections in `[…]` brackets above are conditionally included: the `domains` clause is omitted when the parsed domain set is empty (Supermodel doesn't emit the field in that case), and the `affects` clause is omitted when `direct === 0` (same reason).

The warning is informational only — never blocks. Risk classification is heuristic and Supermodel's responsibility, not ours; downgrading or upgrading their thresholds would be presumptuous.

## Tests

`src/harness/__tests__/supermodel-graph.test.ts`:

**Parser** (`parseGraphFile`):
- HIGH-risk fixture → all fields parsed correctly
- MEDIUM-risk fixture → all fields parsed correctly
- LOW-risk fixture → all fields parsed correctly
- `[impact]` with no `domains` field (Supermodel omits when empty) → `domains: []`, no throw, other fields parsed
- `[impact]` with `direct: 0` and no `affects` field (Supermodel omits in that case) → `affects: []`, no throw
- `[impact]` with both `domains` and `affects` omitted → `{ domains: [], affects: [], direct: 0, transitive: N }` parsed correctly
- Empty content → null
- Only header, no sections → graph with all-null sections
- `[impact]` only → other sections null
- Python-style (`#` prefix) fixture → parses correctly
- Go-style (`//go:build ignore` preamble) fixture → preamble ignored, parses correctly
- Malformed `risk` value (e.g., `risk    UNKNOWN`) → only `impact` nulled; other sections still parsed if present
- Malformed numeric in `direct` / `transitive` → only `impact` nulled; other sections still parsed
- Unknown section name → ignored, doesn't break other sections
- Lines without expected format → ignored, doesn't break parsing

**Loader** (`loadGraphForFile`):
- Absolute source path, file exists → returns parsed graph
- Relative source path with cwd, file exists → returns parsed graph
- Relative source path without cwd → null (no throw)
- File missing → null (no throw)
- Source path resolves outside cwd (traversal attempt) → null (defensive — this is what makes the traversal test meaningful)
- Shard larger than 1 MB → null (fail-open)
- Read error (permissions) → null (no throw)

**Evaluator integration** (separate describe block, mocks `loadGraphForFile`):
- Write to file with HIGH graph → warning present, tag matches, wording uses "dependent file(s)", warning includes the relative source path
- Write to file with MEDIUM graph → terser warning present, with source path
- Write to file with LOW graph → no warning added
- Write to file with HIGH graph but empty `domains` → warning omits the "across domains" clause cleanly (no dangling " across .")
- Write to file with HIGH graph but `direct: 0, affects: []` → warning omits the "Affects:" clause cleanly
- Write to file with no graph → no warning, no error
- Relative `file_path` tool input + `event.cwd` → resolves correctly, finds shard
- Codex `apply_patch` payload touching three files, each with its own HIGH-risk shard → three warnings, each tagged with its own source path so the agent can disambiguate
- Codex `apply_patch` payload with a `*** Move to:` section → warning fires for the move destination, not the original path
- `target_file` tool input (Cursor-shape) with HIGH graph → warning fires (proves `extractAllEditedFilePaths` coverage)
- `files_modified` event-level array (no `tool_input.file_path`) with one HIGH graph → warning fires for that file
- Read tool (not a write) → never invokes graph load
- Existing 81 evaluator test cases still pass (run the whole `evaluator-unified.test.ts` to confirm)

**Fixtures** under `src/harness/__tests__/fixtures/supermodel/`:
- `high-risk.graph.ts` — `transitive: 50, domains: 4`, all fields populated
- `medium-risk.graph.ts` — `transitive: 8, domains: 2`, all fields populated
- `low-risk.graph.ts` — `transitive: 1, domains: 1`, all fields populated
- `no-domains.graph.ts` — `[impact]` with `risk` + counts but no `domains` line (single-domain repo case)
- `no-affects.graph.ts` — `[impact]` with `direct: 0, transitive: 0` and no `affects` line (orphan-file case)
- `malformed-impact.graph.ts` — section header with malformed `risk` value but valid `[deps]` section
- `python.graph.py` — `#`-prefixed sample
- `go.graph.go` — full Go preamble + sections (mirrors `reference-repos/supermodel-cli/internal/focus/handler.graph.go`)

## Demo plan (post-build)

1. Copy `reference-repos/supermodel-cli/internal/focus/handler.graph.go` next to a fixture source file under `tmp/` (or use the `tests/` sandbox).
2. Trigger an Edit on the source file via `interlinked harness test` or a manual hook payload.
3. Capture the resulting warning.
4. Screenshot for the writeup.

## `docs/integrations/supermodel.md`

One-page user-facing writeup, written for Supermodel users who'd benefit from the integration. Sections:

- **What it does** — one paragraph
- **Setup** — install Supermodel, install Interlinked, both run on PostToolUse / PreToolUse respectively
- **What you'll see** — example warning output
- **How it works** — read `.graph.*` shards on PreToolUse, surface `[impact]`, never block
- **Why this is useful** — fills the gap between "graph emitted" and "graph consulted"
- **Limitations** — only fires when shards exist, only on Write/Edit, advisory not enforcing
- **Credit** — graph data is Supermodel's contribution; we just consume it

This doc is the public artifact for the outreach phase. After build, the same content (or a condensed version) goes into a public writeup tagged `@supermodeltools` and a one-line DM to `abe@supermodel.software`.

## Out of scope (explicit)

- **Generating `.graph.*` files** — that is Supermodel's product, full stop.
- **Calling Supermodel's API** — no network, no API key, no auth surface to manage.
- **A new CLI subcommand** (e.g. `interlinked supermodel status`) — defer until there's user demand. The integration should be invisible until a shard exists.
- **PostToolUse handling** — the shard goes stale the moment the edit lands, and Supermodel's daemon repairs it on its own PostToolUse hook. No reason for us to touch PostToolUse.
- **Caching** — shard files are tiny (a few KB) and parsing is microseconds. The on-disk file IS the cache. Revisit only if profiling shows a hot path.
- **Rewriting Supermodel's risk thresholds** — they own the heuristic; we just surface it.
- **Rewriting our internal `project-graph.ts` to match Supermodel's format** — different shape, different purpose. Keep them independent.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Supermodel changes shard format | medium (it's an active project) | Parser is tolerant of unknown lines/sections; failure mode is "no warning fires," not "harness breaks." |
| FP rate too high (HIGH risk on routine edits) | medium | LOW is silent; MEDIUM is terse; HIGH wording invites override ("confirm this is intentional") rather than blocking. If the FP rate proves high in practice, raise the MEDIUM threshold or move MEDIUM to silent. |
| Performance regression on every edit | low | Shard files are <5 KB; parsing is regex-free; only fires on Write/Edit. Add timing assertion in test if concerned. |
| Stale shards lie to us | medium | Out of our control. Warning wording stays advisory ("per .graph shard") so the source of the claim is explicit and the agent can override. |
| Supermodel views this as competition | low | Integration is read-only and complementary; writeup credits them throughout; outreach is opt-in. |

## Acceptance criteria

- [ ] `src/harness/supermodel-graph.ts` parses all eight fixture types correctly.
- [ ] `loadGraphForFile` accepts both absolute and `cwd`-relative source paths, and returns `null` on every error path without throwing.
- [ ] Parser distinguishes section-level malformed data (nulls just that section) from file-level errors (returns whole-graph null).
- [ ] Warning wording uses "dependent file(s)" terminology (per Supermodel's renderer semantics), and omits empty `domains` / `affects` clauses cleanly.
- [ ] PreToolUse evaluator surfaces a warning on Write/Edit when a HIGH or MEDIUM shard exists, and is silent otherwise.
- [ ] Evaluator wiring uses `extractAllEditedFilePaths(event)` from `server-tool-helpers.ts` and loops over every returned path, so Codex `apply_patch` (single- and multi-file), Cursor `target_file`, and runner-supplied `files_modified` arrays are all covered.
- [ ] Each warning string includes the relative source path so multi-file patches stay disambiguated.
- [ ] `[impact]` field parsing uses an explicit head/tail split (`const [key, ...valueParts] = line.split(/\s+/)`) so multi-token values like `domains     A · B · C` are preserved.
- [ ] All existing tests pass (`npx vitest run`).
- [ ] New tests cover all rows in the test matrix above.
- [ ] Manual demo produces a screenshot-worthy warning.
- [ ] `docs/integrations/supermodel.md` is publishable as-is.
- [ ] No new runtime dependencies.

## Effort estimate

3-5 files, ~250 LOC (mostly tests + the parser), 1-2 hours of focused build time.

## Open questions for sign-off

1. **MEDIUM threshold** — do we surface MEDIUM at all, or only HIGH? Default in this plan: surface MEDIUM with a terse one-liner. Alternative: silence MEDIUM, only show HIGH.
2. **Warning style** — match existing `[interlinked:foo]` exactly, or open a new tag namespace like `[interlinked:supermodel]`? Default: `[interlinked:supermodel-graph]`.
3. **`docs/integrations/supermodel.md`** vs `docs/external-pulse/supermodel.md` — which directory? `docs/integrations/` is new but reads correctly; `docs/external-pulse/` is the established external-tool intake but it's an analysis lane, not a how-to-use lane. Default: `docs/integrations/`, create the directory.
4. **Demo subject** — fixture-only, or run Supermodel's CLI on this repo (requires their API key) to produce a real-world demo? Default: fixture-only for the build; real-world demo is a follow-up step optional for the writeup.
5. **Outreach timing** — DM Supermodel before publishing the writeup, after, or never? Default per the prior strategy turn: publish first, DM second.
