# Claude Code "Always allow" extractor produces malformed permission rules

**Affected product:** Claude Code CLI (the interactive permission-rule extractor reachable via the "Always allow" button in the permission prompt UI).

**Effect:** Settings file ends up containing entries that Claude Code's own settings reader then refuses to load. The user sees on every subsequent session start:

```
/path/to/.claude/settings.json
   └ permissions
     └ allow: Invalid permission rule "Bash(PID=$(cat *)" was skipped:
             Mismatched parentheses. Ensure all opening parentheses have
             matching closing parentheses
```

The rule never matches anything, so the user is reprompted on the next equivalent command — the "Always allow" click silently fails to actually allow.

## Reproducer

1. From inside a Claude Code session, run a command that contains a process substitution, e.g.

   ```bash
   PID=$(cat .interlinked/harness.pid)
   ```

2. When Claude Code prompts for permission, click **Always allow**.
3. Inspect `.claude/settings.json` — there is now an entry like:

   ```json
   "Bash(PID=$(cat *)"
   ```

   It has two `(` but only one `)`. Claude Code's own settings loader rejects it with "Mismatched parentheses".

## What we believe is happening

The extractor appears to:

1. Take the raw command (`PID=$(cat .interlinked/harness.pid`).
2. Replace everything after a "token boundary" with `*` to produce a prefix match.
3. Wrap the result in `Bash(...)`.

The substitution at step 2 truncates the command inside the `$(...)` subshell, dropping the closing `)`. The outer `Bash(` then has no matching outer `)`. Result: `Bash(PID=$(cat *)` — 2 opens, 1 close.

## Same shape, multiple commands

Observed in the wild on a single user's machine, audit log entries from one day:

| Source command pattern | Resulting rule | Parens |
|---|---|---|
| `MARKER=$(date ...)` | `Bash(MARKER=$(date *)` | 2 open / 1 close |
| `SESSIONS=$(find ...)` | `Bash(SESSIONS=$(find *)` | 2 open / 1 close |
| `PID=$(cat ...)` | `Bash(PID=$(cat *)` | 2 open / 1 close |
| `node ...; if [...]; ...` | `Bash(node ' && !answered) *)` | unbalanced — extra `)` |

Any command containing `$(...)` will trigger it; the variable name is incidental.

## Suggested fix

When the extractor inserts the wildcard, either:

- Preserve all `)` that close `$(` / `$((` / `(` sequences already present in the prefix, **or**
- Validate the produced rule with the same paren-balance check that the settings loader uses before writing it, and fall back to a non-truncating form (e.g. don't auto-suggest "Always allow" for commands containing subshells).

A well-formed analog of the example above would be `Bash(PID=$(cat *))` — opens = closes = 2 — which the loader accepts.

## Local mitigation (already shipped)

We can't intercept the write because the UI writes settings.json from inside Claude Code's own process (no tool hook fires). Two layers in `interlinked-cli` work around it:

1. **PreToolUse write-content guard** (`src/harness/evaluator/write-content-guards.ts`) blocks any agent-issued `Write` / `Edit` / `MultiEdit` to `.claude/settings*.json` that would introduce a malformed rule. Does not affect the UI write path.
2. **Live filesystem watcher** (`src/harness/settings-watcher.ts`, this fix) polls the four default settings paths from inside the long-lived harness daemon and runs `autoStripAllScopes` whenever a change appears. Malformed rules live on disk for at most ~1.3 s before being removed and audit-logged at `.interlinked/permission-rule-strips.jsonl`.

Layer 2 closes the visible-error gap (the next session sees a clean file) but does not fix the underlying extractor bug — every time the user clicks "Always allow" on a `$(...)` command, the rule is still written briefly. Fixing the extractor at the source would let us remove layer 2 entirely.
