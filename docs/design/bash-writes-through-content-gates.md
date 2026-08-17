# Route Bash-mediated writes through the harness content-quality pipeline

**Status:** Implemented for supported gated writers; tool-independent post-effect enforcement is in the Aug 13 working tree. Arbitrary Bash pre-commit transactions remain future work.
**Scope:** Bash pre-block routing, `interlinked write`/`multi-edit`, observed filesystem ChangeSets, and Stop residue reconciliation.
**Related:** `multi-edit-atomic-coordinated-edits.md` (the usual driver for why an agent wants to write via Bash in the first place).

## Problem

The harness runs a rich content-quality pipeline on Edit/Write tool
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

The local daemon now also snapshots Git-visible files plus standalone ignored local files around
potentially mutating calls and routes the observed ChangeSet through PostToolUse checks, including
successful Bash calls. Bulk ignored directory trees remain collapsed and make the snapshot
explicitly incomplete. That closes the ordinary tool-name bypass after execution; it does not make
arbitrary shell execution reversible.

## Goal

Preserve the gate's protection AND admit the legitimate multi-site-atomic
use case. In shape:

1. Keep blocking naive Bash writes that could have been Edit/Write.
2. Offer a supported path for Bash-mediated writes that **routes through**
   the same content-quality pipeline that Edit/Write use.
3. Report failures in the same structured form as Edit/Write diff-overlay
   output (no silent corruption; no bypass).

## Non-goals

- Predicting or transactionally intercepting arbitrary shell redirections (`cat > file`, `sed -i`)
  before execution. Current local coverage observes their repository effects after execution.
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
- Batch (gate final state together, then commit with rollback protection): `interlinked write --batch manifest.json`
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
   and leave all files untouched.
4. If all checks pass, stage sibling temp files and rename each target. A later rename failure
   triggers best-effort restoration of already-renamed targets and reports incomplete rollback.
   Existing target modes are preserved on both commit and rollback. Each rename is atomic; the
   multi-file sequence is not a filesystem transaction.

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

## Migration status

1. `gateProposedContent` reuses the content check/diff-overlay paths. **Done.**
2. `interlinked write` supports single-file and `--batch`. **Done.**
3. The Bash pre-block points writers to the supported gated path. **Done.**
4. An `ilw` shell alias remains optional and is not part of the CLI contract.

## Acceptance

- [x] `interlinked write` implemented with unit tests.
- [x] `--batch` accepts a manifest, gates the final state, and rollback-protects partial commit failure.
- [x] Output uses the shared gate failure shape.
- [x] Bash pre_block rule message points to the gated writer.
- [x] Round-trip test: a known-coordinated edit that previously tripped
      the Edit tool succeeds via `interlinked write --batch`.
- [x] Round-trip test: a deliberately broken batch fails cleanly, leaves
      files untouched.
- [ ] Arbitrary Bash runs in a local overlay and promotes only an approved ChangeSet.

## Security considerations

- Content comes from stdin or a user-controlled file — same trust model as
  Edit/Write (the agent itself supplies content).
- Path must be inside the project root or an explicit allowlist. No
  writes to `/etc`, `$HOME`, etc. without an explicit `--unsafe-outside-repo`
  flag. The current CLI flag is non-interactive, so an agent must not infer
  authorization to use it merely because the option exists.
- No shell interpolation of paths — all paths pass through strict
  `resolve()` + `startsWith(projectRoot)` validation.
