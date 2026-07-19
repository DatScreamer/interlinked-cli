---
name: interlinked-harness
description: Understand and respond to the Interlinked PreToolUse guard — the local daemon that BLOCKS dangerous tool calls before they run. Load this when a Bash command or file edit was refused with "BLOCKED: … Suggestion: …", when you see an `[interlinked:<check>]` warning tagged `[proven]` or `[heuristic]`, when a destructive command / force-push / protected-file / secret / repo-confinement rule fired, when a grep was answered by the index, or when you need to know how to legitimately suppress a false positive or disable a guard rule. Covers what blocks, how to read the reason, suppression grammar, determinism tags, and the fail-closed cold fallback.
---

# interlinked-harness — the guard: what blocks you & how to respond

Interlinked runs a **local daemon** that evaluates every agent tool call **before it runs**
(PreToolUse). It is **default-permit with targeted forbid**: it allows everything except
known-dangerous shapes, which it refuses with an actionable reason and a safer alternative.
It is a fast deterministic guardrail, **not** a security trust boundary (it's local and
bypassable) — so the right instinct when blocked is to take the suggested safe path, not to
defeat the pattern.

## Load this when
- A tool call was refused: `BLOCKED: <reason>` / `Suggestion: <safer alternative>`.
- You see an `[interlinked:<check>]` warning (tagged `[proven]` or `[heuristic]`).
- A destructive command, `git push --force`, protected-file, secret, repo-confinement, or
  bash-redirect-bypass rule fired.
- You need to legitimately suppress a check false-positive, or disable a wrong guard rule.

## Mental model
- A hook ships each tool call to the daemon over a Unix socket. The daemon runs ~33 ordered
  phases; **the first phase that returns a terminal decision wins**.
- Decisions: `block` (tool refused, you see the reason), `ask` (human confirmation — on
  runners without an ask primitive, like Codex/Copilot/Gemini, **ask downgrades to deny**),
  or `allow` (may still carry non-blocking `warnings`, or an `updated_input` rewrite).
- Built-in rules (~119 across ~25 categories) are regex patterns on the command/tool-input.
  **OR over positive patterns; `negate:true` patterns are exceptions.** `executed_only` masks
  quoted/heredoc/comment text, so *mentioning* `rm -rf /` in an `echo` is allowed while the
  bare command blocks. Compound commands (`&&`, `||`, `;`, `|`, newline) are decomposed and
  each part checked.

> **Two unrelated things are called "guard".** This skill is the **PreToolUse guard** (the
> daemon, operated via `interlinked harness …`). `interlinked guard` is a separate **git
> pre-commit/pre-push hook** that checks staged files against file reservations — see
> **interlinked-coordination**.

## What gets blocked (with concrete examples)

| Category | Blocks (examples) | Allows (examples) |
|---|---|---|
| **Destructive fs** | `rm -rf /`, `rm -rf *`, `rm node_modules`, `sudo rm …`, `dd`, `mkfs`, `shred`, `chmod 777` | `rm -rf /tmp/x`, `rm -rf dist/`, `rm -rf .wrangler/cache` |
| **Process killing** | `pkill node`, `killall wrangler`, `kill -9 1234`, `kill $(pgrep …)`, `… \| xargs kill` | `pkill -f 'wrangler dev'`, `grep -rn "kill -9" src/` |
| **Git** | `git push --force`/`-f`, `git reset --hard`, `git clean -fd`, `git checkout -- .`, `git branch -D`, `git stash drop`/`clear` | `git push --force-with-lease` |
| **DB / cloud / IaC / containers** | `DROP DATABASE`/`TRUNCATE`/`DELETE`-without-WHERE, `docker … prune`/`rm -f`, `kubectl delete`, `terraform destroy`, `pulumi destroy` | — |
| **Info-flow / persistence** | env exfil (`env \| curl …`, `printenv \| nc …`), `.npmrc`/`.yarnrc` writes, `nohup curl … &`, `crontab -e`, `systemctl enable`, writes to `/etc/cron.d/`, `*.service` | — |
| **Protected files** | Read/Write of `*.pem`/`*.key`; Write of `*.env*` **only if secrets detected**; **Delete** of CI configs, `migrations/**`, `.gitignore`, lockfiles, `Dockerfile` | `.env.example` / `.sample` |
| **Sensitive-file read** | `Read` of `.env`, `credentials.json`, `service-account*.json`, `*.pem`/`*.key` | `.env.example` |
| **Repo confinement** | any Write/Edit whose real (symlink-resolved) target is outside the repo root | paths under the allowlist / session scratchpad |
| **Package installs** | any un-allowlisted `npm/pip/cargo/go/…` install; URL/git/tarball specs — see **interlinked-supply-chain** | allowlisted + exact-pinned |
| **Bash-routed write bypass** | a `>` / `tee` redirect writing a tracked source file (dodges the content gate) | routed to Write/Edit or `interlinked write` |
| **Content pre_block** (introduced-only) | edit that *introduces* merge-conflict markers, `eval()`, and other zero-FP checks | pre-existing instances (warn, not block) |

## When you're BLOCKED: what to do
1. **Read the `reason` and `Suggestion:`.** The suggestion is the intended path (force-push →
   `--force-with-lease`; `rm node_modules` → `npm cache clean --force && npm install`;
   `pkill node` → target the PID or `pkill -f 'wrangler dev'`). Take it — but the safe *flag* is
   not always the whole answer. For a destructive or history-rewriting op on a **shared** target
   (force-push to `main`, dropping data), the block is also a prompt to check *intent*: confirm
   the action is warranted and that you have explicit user authorization before proceeding.
2. **Don't rewrite to dodge the regex.** The pattern encodes a real hazard; evading it is the
   wrong move (and trajectory detectors watch for evasion).
3. **Content-check blocks are introduced-only.** A `pre_block` finding (`[check_id]` in the
   reason) blocks **only when your content has more instances of that finding's line text than
   the file already had** (multiset over whitespace-normalized text — moving a pre-existing
   finding doesn't count; a brand-new file counts everything). Fix the line(s) you *added*,
   then retry.
4. **Legitimate suppression** — only when a flagged line is genuinely deliberate:
   - Inline, on the line **above** the finding: `// interlinked-ignore: <check-id> — <why>`
     (reason separator ` — `, ` -- `, or `–`; comma-separate multiple check ids).
   - File/glob-level: an entry in `.interlinked/verify-suppressions.json`
     (`{ "<file-or-glob>": { "<check>": {"reason","by","at"} } }`).
   - Both are honored identically at pre_block, PostToolUse, and `interlinked verify`, and are
     **ratcheted/audited** (visible exceptions, not silent bypasses).
   - Distinct: `// interlinked: defer <check> -- reason` *acknowledges* a finding without
     suppressing it (still logged) — for pre-existing findings you're choosing not to fix now.
5. **When NOT to suppress:** `[proven]` findings (tsc/biome/gitleaks/semgrep actually ran) and
   any destructive/security **guard-rule** block. Suppression directives affect **checks**, not
   **rules** — you cannot `// interlinked-ignore` a `git push --force` block. If a *rule* is
   wrong for your repo, the fix is config (below), not a comment. Don't add
   `@ts-ignore`/`biome-ignore` to silence a `[proven]` check — that trips `suppressions-unjustified`.

## Warnings: `[proven]` vs `[heuristic]`
Every warning is tagged. `[proven]` = a real compiler/linter/scanner/parser/test-runner
produced it — authoritative, fix it. `[heuristic]` = regex/AST-shape match that could be a
false positive — evaluate it. No tag = unknown check id (never guessed).

**Visibility (Claude Code):** a **block reason is always surfaced.** PreToolUse allow-warnings
are routed through `additionalContext` (you see them next turn); PostToolUse warnings go to
stderr. Allow-warnings are easy to overlook — read them.

## Grep acceleration
The guard intercepts `Grep` tool calls and Bash `rg`/`grep`, queries a trigram index for
candidate files, and can answer the search directly (block-and-answer) faster than a full
scan. It is **strictly never-worse-than-native**: on small/medium repos it declines and native
`rg` runs unaccelerated. It's a large-monorepo optimization; you don't manage it. Inspect what
it would match with `interlinked index query <pattern>`. Your own just-written edits are
immediately searchable (in-memory dirty layer).

## Configuring the guard (when a rule is genuinely wrong for the repo)
Config lives in `.interlinked/guard-rules.json` (team) + `.interlinked/guard-rules.local.json`
(personal, gitignored). Merge priority: local > team > built-in.
- `disabled_rules: ["builtin-git-force-push", …]` — turn a built-in rule off (built-ins can be
  disabled, never edited).
- `extra_exceptions: { "<rule-id>": ["substring", …] }` — the rule won't fire if the command
  contains a listed substring.
- Team/local/distilled files hot-reload within ~2s (`watchFile`); `interlinked harness restart`
  forces a full reload.

## The cold fallback (dead daemon fails closed)
If a daemon **was** started for this project but the socket is now unreachable (crashed/hung),
the hook **BLOCKS** tool calls rather than run unguarded, and tries to self-heal. A subset of
checks still runs inline even when the daemon is down: merge-conflict markers, **destructive
commands**, **package installs**, and the **per-file line cap**. Fix: `interlinked harness
start` / `restart`, then retry. (If no daemon ever ran here, calls are allowed instead.)

## Gotchas
- **The "`sleep` is blocked" claim in old docs is stale** — there is no standalone `sleep`
  block in the current rule set. Don't rely on it.
- **`interlinked harness test "<cmd>"`** fires a synthetic event at the daemon to see if it
  would block — and is itself exempt from destructive rules so you can test them safely. A
  chained destructive tail still blocks; "test allowed it" ≠ "the real command is allowed".
- **`harness restart` clears per-session trajectory state** — soft_block "retry allowed" memory
  and trajectory detectors reset. A restart mid-task can change guard behavior.
- **`[interlinked:trajectory] …(shadow — would block)`** warnings are advisory only (shadow
  mode) — they preview a future gate; treat as signal, not a block.
- **All five runners get PreToolUse blocking** (Claude Code, Codex, Copilot CLI, Gemini,
  Cursor). Runners without an `ask` primitive (Codex/Copilot/Gemini) collapse `ask` → deny.
- **PII content scanner** is separate and opt-in: `interlinked scanner on|off|toggle|status|review`.
- Env bypasses (logged, documented-flows only): `INTERLINKED_DISABLE_PACKAGE_GUARD=1`,
  `INTERLINKED_DISABLE_BASELINE_GUARD=1`, `INTERLINKED_DISABLE_SCRATCH_GUARD=1`.

## Quick reference
```bash
interlinked harness test "git push --force"   # would this block? (safe to run)
interlinked harness checks                     # authoritative check inventory
interlinked harness status --json              # is the daemon up?
interlinked index query "<pattern>"            # what the grep accelerator would match
interlinked harness restart                    # reload everything (clears trajectory)
```

## Related skills
- **interlinked-verify** — the check catalog behind the warnings, `interlinked verify`, and how to land edits through the gates.
- **interlinked-quality-gates** — the metric ratchets (line-cap / coverage / complexity) that also block edits.
- **interlinked-supply-chain** — the package-install gate in detail.
- **interlinked-setup** — starting/restarting the daemon, `doctor`, config.
