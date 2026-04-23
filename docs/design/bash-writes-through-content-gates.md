# Route Bash-mediated writes through the harness content-quality pipeline

**Status:** Proposed.
**Scope:** `interlinked verify`'s pre_block Bash rule + new `interlinked write` CLI subcommand + harness coordination.
**Related:** `multi-edit-atomic-coordinated-edits.md` (the usual driver for why an agent wants to write via Bash in the first place).

## Problem

The harness runs a rich content-quality pipeline on every Edit/Write tool
call: pre_block registry rules, biome diff-overlay, tsc diff-overlay,
magic-literal / strong-typing / floating-promise inline checks, etc. The
gate decides whether the proposed new content may land.

Bash commands can also modify tracked source files — `node -e 'fs.writeFileSync(...)'`,
`sed -i`, `cat > file`, a generator script, `prettier --write`. Today the
pre_block rule hard-**blocks** any Bash write to a tracked source file with
this error:

```
BLOCKED: This Bash command writes to a tracked source file (foo.ts) via
inline node -e script, which bypasses the content-quality gates that run
on the Write and Edit tools (pre_block registry, biome diff-overlay, tsc
diff-overlay). Use the Write or Edit tool instead so the content is
checked before it lands.
```

Blocking is correct for the "Edit/Write would have been fine" case. It is
**wrong** for the "Edit can't do this cleanly" case — specifically
coordinated multi-site atomic edits where staging via two separate Edit
calls trips the diff-overlay because each intermediate state introduces a
transient error (e.g. "unused import" before the use is added, or "cannot
find name" before the constant is added). See the sibling design doc on
MultiEdit for the full shape.

The net effect today: agents sometimes have no legal path to a structural
change and get trapped in a ping-pong of diff-overlay rejections.

## Goal

Preserve the gate's protection AND admit the legitimate multi-site-atomic
use case. In shape:

1. Keep blocking naive Bash writes that could have been Edit/Write.
2. Offer a supported path for Bash-mediated writes that **routes through**
   the same content-quality pipeline that Edit/Write use.
3. Report failures in the same structured form as Edit/Write diff-overlay
   output (no silent corruption; no bypass).

## Non-goals

- Intercepting arbitrary shell redirections (`cat > file`, `sed -i`) at
  the kernel level. That's a kernel/syscall-interposition project.
- Making every Bash write free-gated — we explicitly do not want "just let
  node -e through."

## Proposed design

### Step 1 — New CLI subcommand: `interlinked write`

```
interlinked write <path> [--stdin] [--json] [--from-file <src>]
interlinked write --batch <manifest.json>
```

Shape:
- Single-file: `cat newcontent.ts | interlinked write src/foo.ts --stdin`
  or `interlinked write src/foo.ts --from-file /tmp/newcontent.ts`
- Batch (for multi-file atomic): `interlinked write --batch manifest.json`
  where manifest is:
  ```jsonc
  {
    "version": 1,
    "writes": [
      { "path": "src/a.ts", "content": "..." },
      { "path": "src/b.ts", "content": "..." }
    ]
  }
  ```

Behavior:
1. Reads the current on-disk content of each target path.
2. Runs the full content-quality pipeline against (previous, proposed)
   for each file, in the same shape as Edit/Write diff-overlay.
3. If **any** check fails, exit non-zero, print the same structured
   diagnostic the Edit hook would print (machine-readable via `--json`),
   and leave all files untouched. Transactional — all-or-nothing.
4. If all checks pass, write the files atomically (write to `<path>.tmp`
   then rename).

### Step 2 — Pre_block rule revision

The current pre_block rule blocks anything matching:
```
\b(node\s+-e|sed\s+-i|cat\s*>|tee\s+\S+(?!\|))\b
```
against tracked-file paths.

Change it to:
- **Block** bare invocations (as today) with an updated message pointing
  at `interlinked write` and the MultiEdit tool.
- **Allow** `interlinked write ...` invocations unconditionally —
  the command itself enforces the pipeline, so the pre_block rule doesn't
  need to duplicate it.

### Step 3 — Harness integration

The harness's existing diff-overlay pipeline is reusable. Expose it from
`src/harness/diff-overlay.ts` as a single entry:

```ts
export interface GateResult {
  ok: boolean;
  failures: GateFailure[];   // same shape as Edit diff-overlay today
  elapsedMs: number;
}

export function gateProposedContent(
  batch: Array<{ path: string; content: string }>,
  opts?: { projectRoot?: string }
): GateResult;
```

`interlinked write` calls this; Edit/Write tool hooks call this; one
source of truth.

### Step 4 — Error shape & UX

On failure, `interlinked write` prints:

```
✗ interlinked write: 2 gate failures in 1 file

  src/foo.ts
    tsc: TS2304 line 14 — Cannot find name 'FROZEN_NOW'
    biome: noUnusedImports line 4 — vi is declared but never used

No files changed. Fix the findings or restructure your edit.
```

With `--json`:

```jsonc
{
  "ok": false,
  "failures": [
    { "path": "src/foo.ts", "tool": "tsc", "code": "TS2304", "line": 14,
      "message": "Cannot find name 'FROZEN_NOW'" },
    { "path": "src/foo.ts", "tool": "biome", "code": "noUnusedImports",
      "line": 4, "message": "vi is declared but never used" }
  ]
}
```

## Migration

Step-by-step rollout:

1. Land `gateProposedContent` as a pure function reusing existing
   diff-overlay code paths.
2. Land `interlinked write` CLI subcommand (single-file + `--batch`).
3. Update the Bash pre_block message to mention `interlinked write` for
   multi-site coordination.
4. Optional: a lightweight shell wrapper `ilw` aliased to
   `interlinked write --stdin` for terse one-liners.

## Acceptance

- [ ] `interlinked write` implemented with unit tests.
- [ ] `--batch` accepts a manifest and applies transactionally.
- [ ] Output shape matches Edit diff-overlay (same failure JSON).
- [ ] Bash pre_block rule message updated.
- [ ] Round-trip test: a known-coordinated edit that previously tripped
      the Edit tool succeeds via `interlinked write --batch`.
- [ ] Round-trip test: a deliberately broken batch fails cleanly, leaves
      files untouched.

## Security considerations

- Content comes from stdin or a user-controlled file — same trust model as
  Edit/Write (the agent itself supplies content).
- Path must be inside the project root or an explicit allowlist. No
  writes to `/etc`, `$HOME`, etc. without an explicit `--unsafe-outside-repo`
  flag (which also requires an interactive confirmation).
- No shell interpolation of paths — all paths pass through strict
  `resolve()` + `startsWith(projectRoot)` validation.
