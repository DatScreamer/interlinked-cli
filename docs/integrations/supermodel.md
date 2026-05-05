# Supermodel × Interlinked

> Consume Supermodel's `.graph.*` shards as PreToolUse warnings — so the agent
> sees blast radius **before** it edits, not just when it remembers to grep.

[Supermodel](https://supermodeltools.com) emits per-file code-graph shards
next to your sources (`Foo.tsx` → `Foo.graph.tsx`) containing imports,
callers, and impact ranking derived from a tree-sitter parse and call-graph
build. The shards stay current via Supermodel's PostToolUse hook.

The shards are an excellent piece of context, but only if the agent reads
them. Nothing forces that today. **Interlinked** runs a PreToolUse decision
path on every Write/Edit/`apply_patch`, so it's the natural place to surface
the `[impact]` block automatically — turning the file-as-API into a
warning-as-API.

## What you'll see

When the agent is about to edit a file Supermodel has classified as HIGH or
MEDIUM impact, Interlinked emits a one-line warning the agent must read
before proceeding. LOW-impact edits are silent.

```
[interlinked:supermodel-graph] internal/focus/handler.go: HIGH-risk edit per
.graph shard: 8 dependent file(s), 50 transitive across domains API ·
Database · Auth · Notifications. Affects: src/api/users.ts ·
src/api/posts.ts · src/api/comments.ts · src/api/admin.ts ·
src/api/auth.ts · …. Confirm this is intentional.
```

For a more routine edit:

```
[interlinked:supermodel-graph] src/components/Form.tsx: 3 dependent file(s)
across UI · Forms. Affects: src/components/Form.tsx ·
src/components/SignupForm.tsx · src/components/LoginForm.tsx.
```

## Setup

You need both tools installed and active in the same repo:

1. **Supermodel** — emits the shards. Follow Supermodel's setup; their
   PostToolUse hook will keep `.graph.*` files in sync with your source.
2. **Interlinked** — `npm i -g interlinked-cli && interlinked enable` from
   inside your project. Interlinked's PreToolUse hook will pick up shards
   automatically; there is nothing to configure.

That's it. No flags, no config keys, no API token. Interlinked checks for a
shard next to the edited file on each Write/Edit and emits a warning when
one exists.

## How it works

On every `PreToolUse`, Interlinked:

1. Resolves the edited file path. Handles all of: `file_path`, `filePath`,
   `path`, `target_file` (Cursor), `event.files_modified`, and Codex
   `apply_patch` payloads (multi-file with `*** Update File:` /
   `*** Add File:` / `*** Move to:` headers).
2. Looks for a sibling `<file>.graph.<ext>` shard on disk.
3. Parses the `[impact]` section (tolerant: malformed shards fail open).
4. Emits the warning per the format above when risk is HIGH or MEDIUM.
5. For multi-file patches, emits one warning per touched path so the agent
   can disambiguate.

The integration is **read-only**: Interlinked never writes, generates, or
modifies graph files. Risk classification is Supermodel's responsibility —
Interlinked just surfaces what the shard already says. Warnings are
informational and never block.

## Why this is useful

The shard format treats "the file IS the API" — the agent reads it via grep
or cat. That works when the agent thinks to look. But the failure mode is
the destructive case where the agent goes straight to `Edit`, doesn't
consult the shard, and ships a 30-file blast-radius change with no one
noticing. PreToolUse is exactly when you want the data, and is the gap this
integration fills.

## Limitations

- **Only fires when a shard exists.** No shard, no warning. (Interlinked
  doesn't generate shards — that's Supermodel's job.)
- **Only on Write / Edit / `apply_patch`.** Reads are silent.
- **Advisory, not enforcing.** The agent can ignore the warning. The wording
  invites override (`Confirm this is intentional`) rather than blocking,
  because risk classification is a heuristic.
- **Stale shards lie.** If Supermodel's daemon hasn't run since the last big
  edit, the warning may reflect outdated structure. The wording is explicit
  about its source (`per .graph shard`) so the agent can override.

## Credit

The graph data — imports, callers, transitive blast radius, domain
classification, risk thresholds — is entirely Supermodel's contribution.
Interlinked just consumes it.

If you find this integration useful, it's because the underlying graph is
useful. Go give the Supermodel team a look:
[supermodeltools.com](https://supermodeltools.com).
