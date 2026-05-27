# Cross-language ports of harness check coverage

**Status:** Design / not yet implementation (2026-05-27). Companion to [`effect-ts-harness-additions.md`](effect-ts-harness-additions.md); ships *after* that doc converges. Captures the cross-language generalizations of the Effect-TS lessons that were deliberately deferred from the TS-first proposal.

**Audience:** The next engineer extending non-TS check coverage. The Effect intake produced four bug classes that generalize beyond TypeScript; this doc names the per-language regex set for each, plus a small list of further TS-only checks that should follow the same generalization treatment.

**References:**
- [`effect-ts-harness-additions.md`](effect-ts-harness-additions.md) — the TS-first version of these detectors; §2.1 / §2.2 / §2.5 / §2.6 are the ones ported here.
- `src/harness/checks/language-agnostic.ts` — single-regex universal patterns.
- `src/harness/checks/ubs-language-specific/cross-language-checks.ts` — alternation regex with per-language branches (the architectural precedent).
- `src/harness/checks/ubs-language-specific/{python,rust-go,java-c}-checks.ts` — per-language file convention.
- `src/harness/language-profiles.ts` — file-extension → `LanguageId` routing.

**Memory:** [[feedback_generalize_across_codebases]], [[feedback_harness_deterministic_only]], [[feedback_taste_enforcement]].

---

## 1. The gap

The harness has a TS center of gravity that the dogfooding feedback loop reinforces. Approximate current non-TS coverage:

| Language | Inline checks | Notes |
|---|---|---|
| TypeScript / JavaScript | ~80+ across agent-safety, agent-laziness, error-handling, sequential-awaits, performance, return-types, etc. | center of gravity |
| Python | ~12 in `python-checks.ts` (pickle / marshal / yaml / torch security, subprocess, mutable default, regex-in-loop, mktemp race, etc.) | second-deepest; security-focused |
| Rust / Go | 4 in `rust-go-checks.ts` (mutex lock unwrap, goroutine without waitgroup, defer in loop, go shell injection) | thin |
| Java / C | 2 visible in `java-c-checks.ts` (Optional.get, unsafe format string) + a separate `c-cpp.ts` | thin |
| Swift | 1 file | very thin |
| Ruby / PHP / C# / Kotlin | 0 | unaddressed |

The recent "agent-quality" check series (`floating_promises`, `non_null_assertion_ratchet`, `as any`, `promise_reject_non_error`, `unvalidated_json_boundary`, etc.) is entirely TS. The Effect-TS lessons in the companion doc continue that pattern. This doc is the deliberate counter-move: ship cross-language ports of the Effect bug classes that generalize, *after* the TS-first doc converges.

## 2. The mechanism insight

Regex checks operating on source content are **language-agnostic by construction** — no AST parser per language is needed. The harness already exploits this with two architectural patterns, both of which extend cleanly:

- `language-agnostic.ts` — single regex matching a pattern that has the same syntactic form across many languages (universal vocabulary like `localhost`, `MD5`, hash names, SQL keywords, debug-statement names like `console.log` / `print(` / `println!`).
- `ubs-language-specific/cross-language-checks.ts` — one check id with an alternation regex (or a small switch on file extension) that lists the syntactic form per language. `checkSqlStringConcat` is the existing precedent — same bug class, different regex per language.

The cost: one canonical-codebase read per language to lock down the syntactic form. The benefit: one harness check id, one severity, one metadata entry, one suppression directive — covering 4–5 languages.

**File-extension routing already exists.** `language-profiles.ts` maps `.py` → `python`, `.go` → `go`, etc. Per-language regex only runs on files whose `LanguageId` matches, so a Python pattern doesn't false-positive on a TS file that happens to mention `open(`. Verify at implementation time which routing path each check sits on.

## 3. Cross-language ports of the Effect lessons

Each Effect bug class becomes **one check id** with N per-language regexes inside.

### 3.1 `error_dispatch_by_class_widening`

(Effect doc §2.1: was `error_dispatch_by_instanceof`.)

**Bug class.** Dispatching errors by class identity instead of by tag / code. Across languages:

| Language | Pattern (regex sketch) | Notes |
|---|---|---|
| TS/JS | `\binstanceof\s+(Error\|TypeError\|RangeError\|SyntaxError\|EvalError\|URIError\|ReferenceError)\b` inside `catch` | Effect doc §2.1 |
| Python | `\bexcept\s+(Exception\|BaseException)\b(?:\s+as\s+\w+)?\s*:` — bare-Exception catch | broader form of widening |
| Java | `\bcatch\s*\(\s*(Exception\|Throwable\|RuntimeException)\s+\w+\s*\)` | widening catch |
| Go | (no analog) | `errors.Is` / `errors.As` are the right tools and explicit; the widening pattern doesn't manifest |
| Rust | (no analog at this layer) | `Result<T, E>` makes widening require explicit `Box<dyn Error>` coercion — rare and intentional |

Coverage: TS + Python + Java. Go and Rust have type-system enforcement that makes the bug class hard to express, so they get no entry in this check.

**Lands in:** new entry in `ubs-language-specific/cross-language-checks.ts` (or sibling) — three language branches.

**Severity:** advisory initially; ratchet to default after FP rate measured per language.

---

### 3.2 `error_chain_dropped`

(Effect doc §2.2: was `catch_rewrap_loses_cause`.) **The highest-payoff cross-language port — Go's `fmt.Errorf` without `%w` is a famous bug class with universal recognition.**

**Bug class.** Rewrapping an error without preserving the chain.

| Language | Pattern (regex sketch) | Detection difficulty |
|---|---|---|
| TS/JS | Inside `catch (<id>) { ... }`: `new\s+\w*Error\s*\(` whose args do not reference `<id>` and have no `cause:\s*<id>` option | scope-tracking |
| Go | `\bfmt\.Errorf\s*\([^)]*%[svdq]\b[^)]*\b(err\|e)\b` — `%v` / `%s` / `%d` / `%q` formatting an `err` (should be `%w` to preserve the chain) | language-anchored, easy |
| Python | Inside `except\s+\w+\s+as\s+<id>:`: `raise\s+\w+\([^)]*\)(?!\s+from\b)` — `raise NewError(...)` without `from <id>` | scope-tracking |
| Java | Inside `catch (... <id>)`: `throw\s+new\s+(\w+Exception\|RuntimeException\|Error)\s*\(\s*"[^"]*"\s*\)\s*;` — string-only constructor (vs. the `(msg, Throwable cause)` overload) | scope-tracking |
| Rust | `\.map_err\s*\(\s*\|\s*_\s*\|\s*\w+::\w+\b` — `map_err(|_| ...)` discards the source | lower priority; less common bug |

Coverage: 5 languages. Go is the headline — the `%w` rule is well-known, easy to motivate to a Go developer, and the regex is anchored on stable syntax.

**Lands in:** `ubs-language-specific/cross-language-checks.ts`.

**Severity:** default gate for Go (`%w` is established best practice); advisory for the other languages until measured.

---

### 3.3 `resource_handle_leak`

(Effect doc §2.5.)

**Bug class.** Acquired a handle, didn't pair the release on every exit path.

| Language | Pattern (regex sketch) | Native scope guard |
|---|---|---|
| TS/Node | `fs\.openSync\(\|fs\.createReadStream\(\|net\.connect\(\|child_process\.spawn\(` assigned to local, no matching `.close()` / `.destroy()` / `.kill()` before throw/return | none (manual try/finally) |
| Python | `\bopen\s*\(` not inside a `with` statement | `with open(...) as f:` |
| Java | `new\s+(FileInputStream\|FileOutputStream\|FileReader\|FileWriter\|Socket\|PreparedStatement)\s*\(` not inside try-with-resources `try\s*\(` | try-with-resources |
| Go | `\b(os\.Open\|os\.Create\|net\.Dial\|sql\.Open)\s*\(` assigned to local, no `defer\s+\w+\.Close\(\)` on that binding | `defer f.Close()` |
| Rust | (mostly N/A — `Drop` covers this by construction. The pathological case is `mem::forget(file)` which is rare and intentional.) | RAII / `Drop` |

Coverage: 4 languages. Python's `open()` without `with` is the most common real bug.

**Lands in:** extend `cleanup-early-exit.ts` for the TS branch; the per-language regexes land in `cross-language-checks.ts` or a new sibling.

**Severity:** advisory initially. Several FP exemptions needed (handle returned from function; handle passed to pipe-and-close target).

---

### 3.4 `sql_escape_hatch_non_literal`

(Effect doc §2.6: was `sql_unsafe_non_literal`.) Already drafted as cross-language in the Effect doc — the regex matches the **symbol vocabulary**, which itself is the cross-language anchor.

| Library | Escape-hatch symbol | Host language |
|---|---|---|
| Effect SQL | `sql.unsafe(` | TS |
| Drizzle | `sql.raw(` | TS |
| Kysely | `sql.lit(` | TS |
| node-postgres | (no named escape hatch — raw queries via `client.query(<non-literal>)` are themselves the smell) | TS/Node |
| psycopg | `cursor.execute(<non-literal>)` where the string contains `%s` formatting | Python |
| SQLAlchemy | `text(<non-literal>)` | Python |
| Django ORM | `.extra(where=[<non-literal>])` or `.raw(<non-literal>)` | Python |
| `database/sql` (Go) | `db.Query(<non-literal>)` with `fmt.Sprintf` formatting | Go |
| JDBC | `Statement.executeQuery(<non-literal>)` (vs. `PreparedStatement`) | Java |

Coverage: 4 languages × ~9 libraries.

**Lands in:** extend the existing SQL-injection family — `cross-language-checks.ts::checkSqlStringConcat` already has a per-language SQL pattern, so this is a sibling check.

**Severity:** pre_warn.

---

## 4. Beyond Effect — what else looks ripe?

Out of scope for this doc but worth flagging for a future intake pass — TS-only checks where the same logic applies elsewhere:

- **`floating_promises`** → Python `asyncio.create_task(...)` without `await` or storage; Rust `tokio::spawn(...)` whose `JoinHandle` is dropped; Go: no analog (goroutines are explicitly fire-and-forget by language design).
- **`non_null_assertion`** (TS `!`) → Java `.get()` on `Optional` without `isPresent` (covered narrowly as `checkJavaOptionalGet`); Rust `.unwrap()` on `Result`/`Option` in non-test code (covered narrowly as `checkMutexLockUnwrap` for mutexes only — broader generalization would be high-value).
- **`unvalidated_json_boundary`** → Python `json.loads(<network response>)` without subsequent schema validation (pydantic, marshmallow); Go `json.Unmarshal` without struct-tag `validate:`; Java Jackson `readValue` without `@Valid`.
- **`as any` / `as unknown as`** → Python `cast(Any, ...)`; Rust `unsafe` blocks (different bug class but adjacent); Java unchecked-cast `(T) obj`.
- **`boolean_trap`** — pure positional-argument shape, fully language-agnostic. Already advisory in TS; could apply universally with no per-language pattern change (the AST shape "call with literal `true`/`false`/`True`/`False` argument" is universal).

A full cross-language coverage-gap audit is a separate doc.

## 5. Shipping order

In priority order:

1. **`error_chain_dropped` — Go `%w` variant alone.** Ship this one first as proof-of-concept that the Effect intake produces non-TS detectors. Single regex, single language, well-known pattern, no scope-tracking needed.
2. **`resource_handle_leak` — Python `open()` w/o `with`.** Second most-recognized cross-language bug. The `with`-vs-bare-`open(` regex is unambiguous.
3. **`error_dispatch_by_class_widening` — TS + Python + Java in one check id.** Adds three languages to one entry.
4. **`error_chain_dropped` — complete the check id with TS + Python + Java variants** (Rust last, lower priority).
5. **`resource_handle_leak` — Java try-with-resources + Go `defer` variants** complete the check id.
6. **`sql_escape_hatch_non_literal`** — extension of existing SQL family with the cross-language symbol table.

Each detector lands in `ubs-language-specific/cross-language-checks.ts` (or a new sibling if that file approaches the line-cap policy) so the per-language alternation lives in one file per bug class.

## 6. Per-check shipping checklist (cross-language variant)

Per CLAUDE.md's check-rollout pattern, with one additional requirement specific to cross-language work:

1. Detector function(s) in `src/harness/checks/ubs-language-specific/cross-language-checks.ts` (or sibling). One exported function per check id; the function dispatches on `LanguageId` from `language-profiles.ts`.
2. Canonical registry entry in `src/harness/check-registry/entries-warnings.ts`.
3. Metadata entry in `src/harness/check-metadata.ts` — declare the languages the check supports.
4. Verify wiring touch — only the subfile under `src/commands/verify/` that the check surfaces in.
5. **Test coverage: ≥3 positive + ≥3 negative cases per language variant.** A check covering TS + Python + Java needs ≥18 test cases total. The per-language test cases live in one test file per check id, with `describe()` blocks per language.
6. If demoted to advisory: add to `DEFAULT_ADVISORY_SKIPS` with a one-line rationale and update the parity test.
7. Regen reference docs via `npm run docs`.

## 7. Open questions

- **File-extension routing vs. content scan.** Per-language regex should only run on files whose extension matches — verify each check uses `language-profiles.ts` for routing, not a global content scan. Single test: a Python regex shouldn't fire on a `.ts` file whose comment block quotes Python code.
- **Determinism tag.** Cross-language regex remains `[heuristic]` (regex, not compiler-verified). That's already correct under the existing classifier.
- **Test-case organization.** ≥3 positive + ≥3 negative *per language variant* is a lot of cases. Settle on whether tests group by check id (one file, multiple `describe`s) or by language (one file per language with cross-references). The existing `cross-language-checks.test.ts` is the precedent — match its style.
- **Generic Rust `.unwrap()` detection.** The existing `checkMutexLockUnwrap` is narrow. A broader "non-test `.unwrap()` on `Result`/`Option`" check is in the §4 backlog, not this doc.
- **Go `errors.Is` vs class-dispatch.** Should the harness positively *encourage* `errors.Is` / `errors.As` (via a "consider using errors.As" suggestion) the way the Effect doc encourages tag-dispatch? Probably not — recommending a stdlib idiom is policing style, not catching bugs.

## 8. Non-goals

- Full audit of cross-language coverage gaps beyond the Effect intake — that's a separate doc.
- Adding new languages to the harness (Ruby, PHP, C#, Kotlin) — out of scope here.
- Generic per-language AST parsing — the harness's regex-on-content stance is preserved; every check in this doc is regex-based.
- Moving the Effect-TS detectors out of their TS-only file structure — those ship first per the companion doc, and the cross-language entries live in `ubs-language-specific/` independently.
