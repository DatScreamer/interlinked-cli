# PreToolUse Guard Catalog -- Blocks and Warnings

> **POINT-IN-TIME SNAPSHOT, not the catalog (noted 2026-08-07).** The authoritative,
> generated list is **`docs/generated/guard-rules.md`** (`npm run docs` regenerates it,
> and CI fails if it drifts). This file froze at 66 rules; the current built-in count is
> tracked by a gen marker in CLAUDE.md and is substantially higher. It also cites
> `cli/src/harness/evaluator.ts`, a path that no longer exists. Read it for the
> *reasoning* behind rule categories; never for the *inventory*.

## Overview

The Interlinked Harness evaluates every agent tool call at two hook points: PreToolUse (before execution) and PostToolUse (after execution). This document catalogs all block and warning categories in the PreToolUse evaluator (`cli/src/harness/evaluator.ts`), along with the PostToolUse quality checks that produce blocking feedback.

## Hard Blocks

These categories cause `{ decision: "block" }` -- the agent sees the reason and cannot proceed with the tool call.

| # | Category | What's Blocked | Why |
|---|----------|---------------|-----|
| 1 | **Sleep detection** | `bash sleep`, `bash -c sleep` | Agents should use `wait_for_work` (server-side long-poll) instead of burning CPU with sleep loops |
| 2 | **66 Guard Rules** | rm -rf, git push --force, DROP TABLE, chmod 777, curl\|bash, git reset --hard, terraform destroy, docker rm -f, kubectl delete namespace, kill/pkill, AWS destructive ops, sudo rm, shred, wipefs, dd of=/dev, fdisk/mkfs, git filter-branch, helm uninstall, docker volume rm, etc. | Destructive operations that cause irreversible data loss, infrastructure destruction, or cross-project interference |
| 3 | **Protected files** | Writes to `*.pem`, `*.key`, and glob-matched patterns from `guard-rules.json` | Prevents overwriting certificates, private keys, and team-designated protected files |
| 4 | **Secrets in writes** | File writes containing AWS keys (`AKIA...`), GitHub tokens (`ghp_...`), Stripe keys (`sk_live_...`), Slack tokens (`xox...`), npm tokens, JWTs, PEM private keys, SendGrid keys | Prevents committing secrets to source files; 9 inline regex patterns |
| 5 | **File reservations (remote)** | Writing to a file reserved by a remote agent (different cohort) | Prevents file conflicts in multi-agent collaboration; local cohort gets a warning instead |
| 6 | **Env exfiltration** | `env \| curl`, `printenv \| wget`, `set \| nc` | Piping environment variables to network tools is a data exfiltration vector |
| 7 | **Edit will fail** | Edit tool where `old_string` is not found in the file | Pre-validates that the edit is possible; prevents wasted tool calls and stale-file errors |
| 8 | **Path traversal** | Writes to `../`, `/etc/`, `/usr/` | Agents should only write within the project directory |
| 9 | **Binary writes** | Text tools writing to `.png`, `.exe`, `.wasm`, `.pdf`, `.zip`, `.dll`, `.so`, `.pyc`, `.class`, `.jar`, etc. | Text editing tools corrupt binary files; use appropriate binary-safe methods |
| 10 | **Merge conflict markers** | `<<<<<<<`, `=======`, `>>>>>>>` in write content | Guaranteed parse errors; resolve conflicts before writing |
| 11 | **file:// fetch** | `WebFetch` with `file://` protocol | Local file access via fetch is a security boundary violation |
| 12 | **Sensitive file reads** | Reading `.env`, `credentials.json`, `service-account*.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks` (except `.env.example/.sample/.template`) | Agents should not read credential files; use environment variables or ask the user for specific values |
| 13 | **Network while tainted (IFC)** | Bash network commands (curl, wget, nc, ssh, scp, etc.) when session sensitivity is at or above the blocking threshold | Bell-LaPadula model: after reading sensitive files, outbound network is blocked to prevent data exfiltration |
| 14 | **Step limit exceeded** | Any tool call when step count exceeds limit for the current sensitivity level | High-sensitivity sessions have lower operation budgets to limit blast radius |
| 15 | **Lock file tampering** | Direct Write/Edit to `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, etc. | Lock files must only be modified by package managers; direct edits enable supply chain attacks |

## Warnings

These categories produce `warnings[]` in the response -- the agent sees them in stderr on its next turn but is not blocked.

| # | Category | What's Warned | Why |
|---|----------|--------------|-----|
| 1 | **AskUserQuestion** | Using the `AskUserQuestion` tool | Agent should send MCP messages instead; the human monitors the MCP dashboard, not the terminal |
| 2 | **`as any` assertions** | N `as any` casts in file content | Prefer proper typing (interfaces, generics, branded types) |
| 3 | **console.log in production** | >2 console.log/debug/info statements in non-test files | Remove debug logging before committing |
| 4 | **TODO/FIXME/HACK markers** | Unresolved task markers in new code | Resolve before committing or create a tracking issue |
| 5 | **Empty catch blocks** | `catch (e) {}` with no body | Silent error swallowing hides bugs |
| 6 | **eval() / new Function()** | Dynamic code execution | Enables code injection; use safer alternatives |
| 7 | **Math.random() in crypto context** | `Math.random()` in files containing security-related terms (token, secret, password, key, nonce, salt, hash, crypto, auth) | Use `crypto.randomUUID()` or `crypto.getRandomValues()` |
| 8 | **Floating promises** | Async function calls without `await`, `void`, `return`, `.then()`, or `.catch()` | Unhandled promise rejections crash Node.js processes |
| 9 | **JSON.parse without try-catch** | `JSON.parse()` not wrapped in try block within 5 preceding lines | Throws on malformed input; wrap to handle gracefully |
| 10 | **Import/require mixing** | Both `import` and `require()` in same non-.cjs file | Use one module system consistently (prefer ES imports) |
| 11 | **Hardcoded URLs (3+)** | >3 non-localhost URLs in non-test/config files | Use configuration or environment variables |
| 12 | **SQL injection** | Template literal interpolation in `.exec()`, `.query()`, or `sql` tagged templates | Use parameterized queries |
| 13 | **Wildcard CORS** | `Access-Control-Allow-Origin: *` | Restrict to specific origins in production |
| 14 | **ReDoS patterns** | Nested quantifiers `(x+)+` | Causes catastrophic backtracking |
| 15 | **curl\|bash** | Piping remote content to shell | Security risk; download first, inspect, then execute |
| 16 | **--no-verify** | Git hooks bypass flag | Safety hooks exist to prevent broken commits |
| 17 | **Data POST to external** | `curl -d ... https://external-url` | Verify this is intentional and not exfiltrating sensitive data |
| 18 | **Custom registry installs** | `pip install -i` or `npm install --registry` | Dependency confusion risk; verify trusted source |
| 19 | **Existing diagnostics** | tsc/biome errors already present in the file before editing | Tells agent to fix existing issues while editing the file |
| 20 | **Structural context** | Blast radius (>N dependents), import graph, git blame, route map, sibling files, export surface changes | Gives agent awareness of impact before making changes |
| 21 | **Taint escalation** | Reading a file that raises session sensitivity level | Informs agent that outbound network will be blocked/monitored |
| 22 | **Stale file reads** | Reading a file that was recently modified by another agent | Prevents working with outdated file content |
| 23 | **Error history** | File has recurring errors across sessions, pattern detection (edit pair errors, temporal clustering, sequences) | Cross-session learning from past mistakes |
| 24 | **Permission auto-add** | 3 consecutive similar tool calls triggering the same permission prompt | Automatically adds permission to `.claude/settings.json` to reduce friction |
| 25 | **curl-to-MCP detection** | Repeated curl calls to localhost MCP ports | MCP server may be disconnected; consider reconnecting. **Changed this session from block to warning** -- blocking curl-to-localhost was too aggressive since agents legitimately curl local dev servers |
| 26 | **curl to /mcp routes** | curl/wget/fetch targeting `/mcp` endpoints | MCP servers should be accessed via MCP tools, not HTTP |
| 27 | **Invalid JSON** | Malformed JSON in `.json` file writes | Pre-validates before the write hits disk |
| 28 | **Large file reads** | Reading files >10MB | Warns about context consumption; suggest reading specific line ranges |

## Notable Change This Session: curl-to-MCP

The `curl_mcp_detection` check was previously configured to escalate to a **block** after a threshold number of curl calls to localhost ports. This was changed to **warning only** because:

- Agents legitimately curl local dev servers (e.g., `curl localhost:8787/api/...`)
- The MCP port detection was too broad, catching development/testing workflows
- The warning still alerts the agent that MCP may be disconnected, without preventing legitimate work

The change is in `evaluator.ts` -- the escalation path now only adds warnings, never returns `{ decision: "block" }` for curl-to-localhost patterns.

## PostToolUse Quality Checks (Blocking)

These run after file writes and return `{ decision: "block" }` to ensure agents see the feedback:

| Check | Tool | Trigger | Severity |
|-------|------|---------|----------|
| TypeScript | tsc --noEmit | `.ts`, `.tsx`, `.js`, `.jsx` edits | error |
| Biome lint | biome check | `.ts`, `.tsx`, `.js`, `.jsx` edits | warning |
| ESLint | eslint | `.ts`, `.tsx`, `.js`, `.jsx` edits | warning |
| Semgrep (SAST) | semgrep scan | `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.rb`, `.php` edits | warning |
| Dependency audit (SCA) | npm audit / pip-audit / cargo-audit / govulncheck | Lock/manifest file edits | warning |
| Gitleaks (secrets) | gitleaks detect | All code + config file edits | error |
| Secrets (inline) | 9 regex patterns | Write/Edit content | error |
| Strong typing | `any` type scanner | `.ts`, `.tsx` edits (non-test) | warning |
| Affected tests | vitest --related / convention lookup | Source file edits | warning |
| Structural checks | Export surface, import resolution, duplicate symbols, interface changes, dead imports, hallucinated imports | All code file edits | error/warning |
| Binary content | NUL byte detection | All file writes | error |
| Empty file | Whitespace-only content | All file writes | warning |
| Large file | >2000 lines | All file writes | warning |

## Scored Suggestions (Non-Blocking)

These are regex heuristics that run in the PostToolUse suggestion pipeline. They are scored by proximity to the edit region, frequency, and suppression state, and only the top 1-3 above a threshold are shown:

- SQL injection (template literals in .exec/.query)
- Query in loop (N+1 query patterns)
- Await in loop (sequential async instead of Promise.all)
- Silent catch (empty catch blocks)
- Unreachable code (code after return/throw/break/continue)
