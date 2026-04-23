# MultiEdit — atomic coordinated edits across multiple sites

**Status:** Proposed.
**Scope:** New `interlinked multi-edit` CLI subcommand + harness integration.
**Related:** `bash-writes-through-content-gates.md` (the delivery vehicle).

## Problem

The Edit tool applies exactly one `old_string → new_string` replacement per
call. The tsc and biome diff-overlays check each Edit against the
**pre-edit** state of the file, so any Edit that introduces a new error
relative to the baseline is rejected.

This creates a deadlock for coordinated changes that cross distant sites in
the same file:

**Example 1 — import + use**

```
// File state: no FROZEN_NOW import, no FROZEN_NOW usage.
Edit A:
  add `import { FROZEN_NOW } from "./constants";` at L3
  → biome: noUnusedImports (FROZEN_NOW is declared but never used) — BLOCKED

Edit B:
  replace `Date.now()` with `FROZEN_NOW` at L108
  → tsc: TS2304 Cannot find name 'FROZEN_NOW' — BLOCKED
```

Either order fails. There's no "commit only if both apply" primitive.

**Example 2 — type widen + caller update**

Widening a function signature often requires updating both the signature
and the call-sites in one logical step. Splitting across Edit calls trips
tsc diff-overlay on the intermediate state.

**Example 3 — interface add + registry entry**

Adding `gemini` to `ClientName = "claude" | "copilot" | "gemini"` requires
updating the `CLIENT_INSTALL_REGISTRY: Record<ClientName, ...>` in the
same logical step so the Record stays exhaustive.

Today's escape valves:
1. **Write the whole file** — viable but requires the agent to reproduce
   the entire file correctly, including every detail it isn't changing.
2. **Use a larger `old_string`** that spans both sites — only works when
   the sites are a few lines apart. Fails for sites 300+ lines apart.
3. **Bash `node -e '...'`** — blocked by the harness pre_block rule (see
   the sibling `bash-writes-through-content-gates.md` doc).

## Goal

Provide a first-class primitive for coordinated atomic edits that:

1. Accepts N `old_string → new_string` pairs for one or more files.
2. Applies them against the same pre-edit state, producing one final
   content per file.
3. Runs the full content-quality pipeline **once**, on the final combined
   content, not on each individual Edit's intermediate state.
4. Is transactional — all edits land or none do.

## Non-goals

- Replacing the simple `Edit` tool for single-site edits.
- Reordering edits automatically. The agent declares an order; we apply
  in order. This is important when two edits affect overlapping text.

## Proposed design

### Step 1 — New CLI subcommand: `interlinked multi-edit`

```
interlinked multi-edit [--file <path>] --stdin
interlinked multi-edit --manifest <manifest.json>
```

Single-file-mode manifest (stdin or file):

```jsonc
{
  "version": 1,
  "edits": [
    { "old_string": "import { foo } from ...",
      "new_string": "import { foo, bar } from ..." },
    { "old_string": "return foo(x);",
      "new_string": "return bar(foo(x));" }
  ]
}
```

Multi-file-mode manifest:

```jsonc
{
  "version": 1,
  "batches": [
    {
      "path": "src/a.ts",
      "edits": [
        { "old_string": "...", "new_string": "..." },
        { "old_string": "...", "new_string": "..." }
      ]
    },
    {
      "path": "src/b.ts",
      "edits": [ ... ]
    }
  ]
}
```

### Step 2 — Semantics

For each file:
1. Read pre-edit content.
2. Apply each `old_string → new_string` in sequence. Each `old_string`
   must be unique in the current (post-prior-edits) buffer. If it's not,
   the whole manifest fails with `AMBIGUOUS_OLD_STRING`.
3. Produce the final content.

Across files:
4. Call `gateProposedContent([{path, finalContent}, ...])` — the same
   harness pipeline `interlinked write` uses (see sibling doc).
5. On gate failure: exit non-zero, print structured diagnostic, touch no
   files.
6. On gate success: write all files atomically (temp + rename).

### Step 3 — Ambiguity rules

Edit today requires the `old_string` to be unique in the file (fallback:
use `replace_all`). MultiEdit keeps the same rule **evaluated after prior
edits in the manifest**, not against the original file:

```
manifest.edits[0].old_string  ← must be unique in the pre-edit content
manifest.edits[1].old_string  ← must be unique in the content AFTER edits[0]
...
```

This lets later edits target text produced by earlier edits when needed.

### Step 4 — Error shape

Failure modes, each with a machine-readable code:

| Code | Cause |
|---|---|
| `OLD_STRING_NOT_FOUND` | Edit `k`'s `old_string` doesn't appear in current buffer |
| `AMBIGUOUS_OLD_STRING` | Edit `k`'s `old_string` appears 2+ times |
| `GATE_REJECTED` | Final content failed tsc / biome / harness check |
| `READ_FAILED` | Path not readable |
| `WRITE_FAILED` | Atomic write failed (disk full, permissions, etc.) |

`--json` output:

```jsonc
{
  "ok": false,
  "error_code": "GATE_REJECTED",
  "file_changes_applied": [],
  "gate_failures": [
    { "path": "src/foo.ts", "tool": "tsc", "code": "TS2304", "line": 14,
      "message": "Cannot find name 'FROZEN_NOW'" }
  ]
}
```

### Step 5 — Integration with Edit

Optionally expose a parallel Edit tool mode: `Edit({ file_path, edits: [...] })`
where `edits` is a MultiEdit-style array. Internally calls the same
pipeline. Keeps the one-edit form for trivial cases.

## Migration

Same order as the sibling doc (content-gates), because both share
`gateProposedContent`:

1. Land `gateProposedContent` (shared function).
2. Land `interlinked multi-edit` CLI.
3. Document the failure-mode table in the CLI `--help`.
4. Update the Edit tool's rejection message to mention `interlinked multi-edit`
   when diff-overlay blocks a coordinated edit.

## Acceptance

- [ ] `interlinked multi-edit` implemented with unit tests covering the
      ambiguity rule across pre/post-prior-edit text.
- [ ] Multi-file `--manifest` applies transactionally.
- [ ] A known pathological case from the refactor session lands cleanly
      via this tool (e.g., adding an import + use where Edit serial fails).
- [ ] Gate failure on the final content produces the same JSON shape as
      Edit diff-overlay.

## Examples — real cases this session

### Case 1 — Adding Gemini to CLIENT_INSTALL_REGISTRY

Needed to add an import from `./hook-installers.js` AND a new entry in
`CLIENT_INSTALL_REGISTRY: Record<ClientName, ClientInstallEntry>`.
Serial edits: adding the import alone = biome noUnusedImports; adding the
registry entry alone = tsc TS2304 on the unresolved identifiers.

With `interlinked multi-edit`:

```jsonc
{
  "version": 1,
  "edits": [
    {
      "old_string": "import { buildHookScript } from \"./hooks-template.js\";",
      "new_string": "import {\n\tGEMINI_HOOK_EVENTS,\n\tinstallGeminiHooks,\n\tuninstallGeminiHooks,\n} from \"./hook-installers.js\";\nimport { buildHookScript } from \"./hooks-template.js\";"
    },
    {
      "old_string": "\tcopilot: {...},\n\t// Future clients:",
      "new_string": "\tcopilot: {...},\n\tgemini: {\n\t\tevents: GEMINI_HOOK_EVENTS,\n\t\tinstall: installGeminiHooks,\n\t\tuninstall: uninstallGeminiHooks,\n\t},\n\t// Future clients:"
    }
  ]
}
```

One tool call, gate runs once on the final content, both sites land.

### Case 2 — FROZEN_NOW constant + replace Date.now() in multiple test bodies

```jsonc
{
  "version": 1,
  "edits": [
    { "old_string": "import { … } from \"vitest\";", "new_string": "import { …, …beforeEach, afterEach, vi } from \"vitest\";\n\nconst FROZEN_NOW = 1767225600000;" },
    { "old_string": "Date.now() - 30 * 24 * 60 * 60 * 1000", "new_string": "FROZEN_NOW - 30 * 24 * 60 * 60 * 1000" },
    { "old_string": "Date.now() - 60 * 1000", "new_string": "FROZEN_NOW - 60 * 1000" },
    { "old_string": "Date.now() - 60 * 60 * 1000", "new_string": "FROZEN_NOW - 60 * 60 * 1000" },
    { "old_string": "Date.now() - 25 * 60 * 60 * 1000", "new_string": "FROZEN_NOW - 25 * 60 * 60 * 1000" }
  ]
}
```

Five coordinated sites in one file. Serial Edits deadlock; MultiEdit lands
clean.
