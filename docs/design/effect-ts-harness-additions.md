# Effect-TS lessons — harness check additions

**Status:** Design / not yet implementation (2026-05-27). Concrete near-term proposal for six new or refined detectors in the harness check pipeline, plus three deferred and a documented skip list.

**Audience:** The next engineer (likely future-me) sitting down to extend the check families under `src/harness/checks/`. Companion to [`harness-system-diagrams.md`](harness-system-diagrams.md) (where this lands in the pipeline) and the broader detection-vs-decision split in [`trajectories-as-primitive.md`](trajectories-as-primitive.md).

**References:**
- Effect-TS repository — cloned to `reference-repos/effect/` for inspection (2026-05-27). Source for every file:line citation below.
- `@effect/eslint-plugin` (v0.3.2) — Effect's only published lint plugin. Two rules total: `dprint` (formatting) and `no-import-from-barrel-package`.
- [`cross-language-check-coverage.md`](cross-language-check-coverage.md) — companion doc; ships **after** this one. Captures the per-language regex sets for the four §2 detectors that have analogs in Python / Go / Java / Rust (§2.1 / §2.2 / §2.5 / §2.6). §2.3 and §2.4 are genuinely TS-only and stay here.
- `src/harness/check-registry/entries-warnings.ts` + `entries-errors.ts` — where new entries register.
- `src/harness/check-metadata.ts` — where new entries declare their family / phase / determinism.
- `src/commands/verify/advisory.ts` — `DEFAULT_ADVISORY_SKIPS` list for heuristic checks.

**Memory:** [[feedback_generalize_across_codebases]], [[feedback_harness_deterministic_only]], [[feedback_taste_enforcement]], [[feedback_safety_continuity]].

---

## 1. The gap

A walk through Effect's 33 packages identified 30+ enforced conventions. The interlinked harness already covers the bulk: floating promises, untagged throws, eval, SQL string-concat, setTimeout/setInterval cleanup, unvalidated `JSON.parse`, `process.env.NODE_ENV` branching, `console.*` in production, non-null assertions, double-cast `as unknown as`, `Math.random` in source, default exports, boolean traps, `.push(...arr)` spread, circular imports, misused promises. 16 patterns confirmed.

What is **not** covered, and where vanilla TypeScript cannot replicate Effect's type-level enforcement:

1. **Catch-block error rewrap** — `instanceof Error` dispatch, and `new Error(msg)` inside `catch(e)` that drops the original. Effect's `Cause` model never loses information; raw JS loses it constantly.
2. **Barrel re-import within own package** — module init-order hazard. Effect's single published lint rule.
3. **`circular_imports` type-only refinement** — runtime cycles only, not `import type` cycles. Effect's `.madgerc:1-7`.
4. **File-handle / connection leaks** — `fs.openSync` / `net.connect` without paired close on an early-exit path. Effect's `Scope`/`Finalizer` makes this a non-issue by construction.
5. **`sql.unsafe(...)` with non-literal arg** — the one intentional SQL escape hatch Effect provides, reserved for compile-time constants.
6. **(Plus three Tier-B opt-ins; see §3.)**

These are real bug classes where the type system genuinely can't help, so an AST/regex detector is the only remaining lever. That filter is the basis for the shortlist below.

## 2. Proposed detectors (Tier A — default candidates)

Each proposal names: the Effect convention being mirrored (with file:line), the detector signature, false-positive estimate, the harness file it lands in, and the registration metadata.

### 2.1 `error_dispatch_by_instanceof`

**Effect convention.** Errors are dispatched by tag, never by class identity. `Effect.catchTag("NetworkError", ...)` and `Effect.catchTags({...})` are the only sanctioned forms. Evidence:
- `packages/platform/src/internal/httpRouter.ts:654, 700` — `Effect.catchTag(k, f)`, `Effect.catchTags(cases)`.
- `packages/platform/src/internal/fileSystem.ts:47` — `Effect.catchTag("SystemError", e => e.reason === "NotFound" ? ... : ...)`.

**Why portable.** `instanceof Error` (and subclass variants) in a catch block almost always indicates the author wanted tag-discrimination but reached for nominal typing instead. JS error subclassing across realms is famously fragile (`instanceof` returns false across iframe/worker boundaries); the pattern is a latent bug independent of Effect.

**Detector signature.**
- Phase: `post` (PostToolUse — file on disk, full context).
- Pattern: inside a `catch (<id>) { ... }` block, match `\b(?:<id>\s+)?instanceof\s+(Error|TypeError|RangeError|SyntaxError|EvalError|URIError|ReferenceError)\b`.
- Suggested fix surfaced to the agent: "Dispatch on a `_tag` field or `code`/`name` property instead — `instanceof` fails across realm boundaries."

**False-positive estimate:** <2%. The legitimate cases (e.g., `instanceof TypeError` to distinguish a Node-thrown TypeError from a user error) are rare and surface as a one-line ignore.

**Lands in:** `src/harness/checks/error-handling.ts` (existing family).

**Registry entry:** `entries-warnings.ts`, severity `warning`, gate `--all-checks` initially (advisory in `DEFAULT_ADVISORY_SKIPS`). Promote to default gate after two weeks of usage data showing the FP rate holds.

---

### 2.2 `catch_rewrap_loses_cause`

**Effect convention.** `Cause<E>` is lossless — fail, die, interrupt, and aggregate causes all preserve the original. The ES2022 equivalent is `new Error(msg, { cause: e })`. Effect's wrapped errors carry the original through structured constructors (e.g., `RequestError` in `packages/platform/src/HttpClientError.ts:32-76` carries the underlying `cause` as a readonly field).

**Why portable.** A new `Error` constructed inside `catch (e) { ... }` without referencing `e` silently strips the stack and breaks any debugging chain downstream. The fix is mechanical: add `{ cause: e }` (Node 16.9+, TS 4.6+) or include `e` in the message. This is one of the highest-payoff debugging-hygiene rules I can imagine adding.

**Detector signature.**
- Phase: `post`.
- Pattern: inside a `catch (<id>) { ... }` block:
  - Match `throw\s+new\s+\w+Error\s*\(` or `new\s+\w+Error\s*\(`.
  - Walk the argument list — if `<id>` does not appear in any argument *and* there is no `cause:\s*<id>` property in an options object, flag.
- Skip when the rethrow is a custom tagged-error class constructor that already wraps `e` (heuristic: constructor name ends with `Error` and `<id>` appears in a constructor argument).

**False-positive estimate:** ~5%. Hand-rolled rewrap patterns where the caller doesn't want the inner stack are real but rare; they show up as one-line ignores when justified.

**Lands in:** `src/harness/checks/error-handling.ts`.

**Registry entry:** `entries-warnings.ts`, severity `warning`, default gate (not in `DEFAULT_ADVISORY_SKIPS`). This is the one I'd actually ship loud — the bug class is real, the fix is mechanical, and a developer who sees the warning will recognize it immediately.

---

### 2.3 `import_from_own_barrel`

**Effect convention.** Effect's only correctness-focused published lint rule. From `reference-repos/effect/eslint.config.mjs:154-159`:
```js
"@effect/no-import-from-barrel-package": [
  "error",
  { packageNames: ["effect", "@effect/platform", "@effect/sql"] }
]
```
Rationale: barrel re-imports from inside the same package create module-init-order hazards, defeat tree-shaking, and grow latent cycles. Effect's library is structured so every file imports from deep paths (`"effect/Option"`), never from the published top-level barrel.

**Why portable.** Even for non-published packages, importing `./index.js` from a file that `./index.js` re-exports is a latent circular-init bug. The order in which the runtime resolves the cycle depends on file-load order, which is fragile.

**Detector signature.**
- Phase: `pre_warn` (PreToolUse — pure lexical check, no project graph needed).
- Pattern: in a file at `<dir>/<name>.ts`, flag `import\s+.*\s+from\s+["'](?:\.\/index|\.\/)["']` *and* (for published-package contexts) flag `from\s+"<own-package-name>"` where `<own-package-name>` is read from the nearest enclosing `package.json`.
- Suggested fix: import from the deep submodule path directly.

**False-positive estimate:** <1%. The pattern is unambiguous.

**Lands in:** New file `src/harness/checks/imports.ts`, or extend `cross-file.ts`. (Check first whether an import-policy family already exists; I haven't audited every checks/ file.)

**Registry entry:** `entries-warnings.ts`, severity `warning`, default gate.

---

### 2.4 `circular_imports` — refine to skip type-only imports

**Effect convention.** Effect runs `madge` for cycle detection with `skipTypeImports: true`. From `reference-repos/effect/.madgerc:1-7`:
```json
{
  "detectiveOptions": {
    "ts": { "skipTypeImports": true }
  }
}
```
Rationale: `import type { X } from "..."` and `import { type X } from "..."` are erased at runtime and cannot form a runtime cycle. Including them inflates the cycle graph with false positives.

**Why portable.** This is a pure FP-reduction on an existing harness check, not a new rule. CLAUDE.md lists `circular_imports` as one of the agent-quality checks (post, advisory). I haven't verified whether our implementation already distinguishes type-only specifiers from runtime ones — that's the action item.

**Action.**
1. Audit `circular_imports` (likely lives in `src/harness/checks/iteration-safety.ts` or a structural-checks file — find via grep).
2. If it does not already filter `import type` / `import { type ... }`, add the filter.
3. Add a test case: two files with mutually-recursive `import type` should *not* trigger; same files with runtime imports should.

**False-positive estimate (after fix):** measurable reduction — this is exactly the kind of stable-FP class that [[project_escalation_amplifies_stable_fp]] warns about, so the priority should reflect that.

**Lands in:** existing detector file. No new registry entry; no new check id.

---

### 2.5 `resource_handle_leak`

**Effect convention.** Resources are managed via `Scope` and finalizers — `addFinalizer(effect)` guarantees cleanup on scope close, regardless of success / failure / interruption. Source: `packages/effect/src/Scope.ts:51-130`.

**Why portable.** The vanilla-JS failure mode is `const fd = fs.openSync(...)` followed by an early `return` or `throw` with no `fs.closeSync(fd)`. Same for `net.connect`, `fs.createReadStream`, `dgram.createSocket`, `child_process.spawn` (without `subprocess.kill()` on error). Each is a process-lifetime leak.

**Detector signature.**
- Phase: `post`.
- Pattern:
  1. Find local bindings assigned the result of any of: `fs.openSync`, `fs.open(...).then(...)`, `fs.createReadStream`, `fs.createWriteStream`, `net.connect`, `net.createConnection`, `dgram.createSocket`, `child_process.spawn`, `child_process.fork`.
  2. Walk the enclosing function for paired close calls (`.close()`, `.destroy()`, `.end()`, `.kill()`, or assignment to the cleanup register of a `try/finally`).
  3. If any `return` or `throw` statement reachable from the assignment lacks a paired close before it, flag.
- Skip when the binding is returned from the function (callee is responsible).
- Skip when the binding is `.pipe()`d into a target that closes it (rough heuristic — accept some FP here).

**False-positive estimate:** ~10–15%. The "returned from function" and "piped" exemptions are necessary; even with them, there are legitimate "handle owned by an outer scope" patterns. Start advisory.

**Lands in:** Extend `src/harness/checks/cleanup-early-exit.ts` (already covers `setInterval`/`setTimeout`/`addEventListener` non-cleanup on throw/return — same shape).

**Registry entry:** `entries-warnings.ts`, severity `warning`, advisory (in `DEFAULT_ADVISORY_SKIPS`) for the first iteration. Ratchet to default after tuning.

---

### 2.6 `sql_unsafe_non_literal`

**Effect convention.** The `sql` tagged template literal **requires** parameters to flow through `Parameter` segments — string interpolation is impossible because the tag function walks the AST. The single sanctioned escape hatch is `sql.unsafe(...)`, reserved for compile-time constants like schema names. Source: `packages/sql/src/Statement.ts:277-376`, `packages/sql/src/internal/statement.ts:411-414`.

**Why portable.** Every modern SQL library exposes an `unsafe` / `raw` / `lit` escape hatch (`Drizzle: sql.raw`, `Kysely: sql.lit`, `node-postgres: client.query` with a plain string, etc.). The pattern is universal: the escape hatch is for *literals only*. Passing a variable into it is almost always a SQL-injection vector.

**Detector signature.**
- Phase: `pre_warn` (PreToolUse — lexical pattern, fast).
- Pattern: match `\b(?:sql\.unsafe|sql\.raw|sql\.lit)\s*\(\s*(?!['"`])` — `sql.unsafe(` not followed by a string-literal opening quote or backtick.
- Generalize: read the symbol list from `.interlinked/sql-unsafe-aliases.json` so a project can declare its own `db.raw`, etc.

**False-positive estimate:** ~3%. The API surface is deliberately rare; non-literal usage is almost always a smell.

**Lands in:** Extend the SQL-injection family. CLAUDE.md mentions `ubs_sql_string_concat` and a `sql` family — find via grep at registration time.

**Registry entry:** `entries-warnings.ts`, severity `warning`, default gate.

---

## 3. Deferred (Tier B — opt-in, config-gated)

Three patterns that are real but only apply to specific project shapes. Each ships behind a config flag in `.interlinked/policy.json` and is off by default.

### 3.1 `@since X.Y.Z` JSDoc on public exports

Effect requires `@since` on every public symbol; `pnpm docgen` enforces it. Source: `packages/effect/src/Effect.ts:2`, every public export in `packages/effect/src/Option.ts`, `Cause.ts`, etc. (consistent across the library).

**Why opt-in.** Only valuable for packages that publish to npm with semver promises. The interlinked CLI is an end-app — would be all noise. But projects that *do* publish should turn this on. Activates when `package.json` has `"private": false` and the project declares `policy.require_since_jsdoc: true`.

**Detector signature.** For each exported binding in `src/**/*.ts` (excluding `**/internal/**`), require a preceding JSDoc with `@since \d+\.\d+\.\d+`.

**Lands in:** `src/harness/checks/comment-drift.ts` extension (existing JSDoc-policing family) or new `src/harness/checks/jsdoc-policy.ts`.

---

### 3.2 `process_env_outside_config_module`

Effect funnels every env read through `Config.string("DB_URL")`, never scattered `process.env.DB_URL`. Source: `packages/effect/src/Config.ts:17, 67-68, 103-146`.

**Why opt-in.** Coverage today (`checkNodeEnvBranchInProd`) only catches the `NODE_ENV` variant. The general rule — "no `process.env.<anything>` outside `<configured-paths>`" — is a real centralization win but the path allowlist must be declared per project. Default-on would produce 30%+ FP rate; config-gated drops it to ~5%.

**Detector signature.** Allowlist module paths in `.interlinked/config-modules.json` (default suggestion: `src/config/**`, `src/env.ts`, `src/lib/config.ts`). Flag `process\.env\.\w+` reads anywhere else.

**Lands in:** Extend `src/harness/checks/agent-laziness.ts` (where `checkNodeEnvBranchInProd` lives).

---

### 3.3 `secret_field_not_wrapped`

Effect wraps secrets in `Redacted<T>` so they cannot accidentally serialize. Source: `packages/effect/src/Redacted.ts:1-145`, `packages/effect/src/Inspectable.ts:33-47` (auto-redaction in `toJSON`).

**Detector signature.** Flag class fields, function parameters, or return types whose **name** matches `/password|secret|api[_-]?key|apiKey|token|auth|credential|private[_-]?key/i` and whose **declared type** is `string`. Accept any non-`string`/`number`/`boolean` opaque wrapper type as a pass (the project picks its own wrapper name — `Redacted`, `Secret`, `Sensitive`, etc.).

**False-positive estimate:** ~15%. Field-name heuristics are noisy; the existing `pii.ts` already accepts this tradeoff.

**Lands in:** Extend `src/harness/checks/secrets.ts` (or `pii.ts` if that's the closest match).

---

## 4. Explicitly out of scope (Tier C — documented skips)

Patterns I considered and decided not to port, with one-line rationale each:

| Pattern | Skip rationale |
|---|---|
| `Pipeable` interface enforcement | Effect-specific runtime convention; doesn't generalize. |
| `_tag` field on discriminated unions | TS gives this for free via union narrowing; requiring the literal name `_tag` is presumptuous. |
| `Data.tagged` structural equality | Effect-specific; no general TS equivalent that doesn't drag in a runtime. |
| `Refinement<A, B>` (`x is B` type guards) | TS already encourages this; near-zero finding rate in real codebases. |
| `dual(arity, ...)` data-first/last APIs | A library-design choice, not a bug class. |
| `TypeId` symbols on data types | Effect-specific. |
| Banning raw `Promise.all/race/resolve/reject` | Effect bans these in favor of `Effect.tryPromise` — Effect-specific. We already catch the dangerous cases (`async_promise_executor`, `unbounded_promise_all`). |
| Banning raw `setTimeout`/`setInterval` | Same — legitimate in non-Effect code; we already enforce cleanup via `lifecycle_cleanup`. |
| `@example` blocks fenced with ` ```ts ` | Too narrow; only matters if a docgen step exists in the project. |
| Changeset-per-PR | Process convention, not a per-edit check. Could become a Stop-event prompt; not part of this proposal. |
| Codegen-barrel-files freshness | Project-structure-specific; only matters for monorepos that use the pattern. |

The meta-reason most of Tier C is out of scope: these are patterns that enforce Effect's *type-design discipline*, which gets its enforcement from the type system, not from lint or AST. Trying to re-implement them as AST checks is the wrong shape — see §5.

## 5. Why this list is short

`@effect/eslint-plugin` ships **two** rules: `dprint` (formatting) and `no-import-from-barrel-package` (bundler-graph correctness). Their `eslint.config.mjs` turns off the most common @typescript-eslint policing rules (`no-explicit-any`, `no-non-null-assertion`, `ban-ts-comment`, `ban-types`). The library author deliberately rejected lint-as-policy: types are global and carry relationship information across function boundaries; lint is local and can only see syntax in a single AST node. Effect put correctness where it can actually be checked — at the type level.

That's a different trust model than ours. Effect's contributors are senior FP engineers who internalize conventions over years; lint nags would create friction without value. The interlinked harness operates on **agents** — actors that haven't internalized the codebase and treat convention violations as low-probability events to risk. Lint-shape behavioral checks are exactly the right tool for that trust model. We're not lint-policing humans; we're behavioral-gating agents.

So the patterns worth porting are exactly those where (a) vanilla TS can't replicate Effect's type-level enforcement, and (b) the bug class persists regardless of whether the code uses Effect. §2 is what survives that filter. §3 is the same filter relaxed for project-specific shapes. §4 is what fails it.

## 6. Shipping order

In priority order, with rough effort estimate (one detector + tests + verify wiring per CLAUDE.md):

1. **`import_from_own_barrel`** (§2.3) — single regex, near-zero FP, real init-order bug. Easiest win.
2. **`circular_imports` type-only refinement** (§2.4) — pure FP reduction on existing detector. Stable-FP class hit, no new check id.
3. **`catch_rewrap_loses_cause`** (§2.2) — meaningful debugging-hygiene win, mechanical fix; default-gate confident.
4. **`error_dispatch_by_instanceof`** (§2.1) — start advisory, watch FP rate, promote after data.
5. **`resource_handle_leak`** (§2.5) — extend `cleanup-early-exit.ts`, advisory initially.
6. **`sql_unsafe_non_literal`** (§2.6) — extension of existing SQL family.

Tier B (§3) deferred until either (a) a project on the harness asks for them, or (b) the supply-chain / library-publishing work needs them.

## 7. Per-check shipping checklist

Per CLAUDE.md's "Agent-quality checks" rollout pattern, each new detector ships with:

1. Detector function in `src/harness/checks/<family>.ts` (or new family file).
2. Canonical registry entry in `src/harness/check-registry/entries-warnings.ts` (or `entries-errors.ts` for `pre_block` errors — none of the §2 detectors are `pre_block`).
3. Metadata entry in `src/harness/check-metadata.ts` (family, determinism, tier).
4. Verify wiring touch — only the subfile under `src/commands/verify/` that the check surfaces in (per CLAUDE.md, don't touch the orchestrator unless necessary).
5. Test coverage: **≥3 positive cases + ≥3 negative cases** per detector. Negative cases are the FP-management lever; pick patterns that would naively trigger but legitimately shouldn't.
6. If demoted to advisory: add to `DEFAULT_ADVISORY_SKIPS` in `src/commands/verify/advisory.ts` with a one-line rationale, and update the parity test in `__tests__/check-pipeline-parity.test.ts`.
7. Regen reference docs via `npm run docs`.

## 8. Open questions

- **§2.4 type-only refinement** — is it already implemented? Quick grep at implementation time. If yes, this entry collapses to "verified, no change."
- **§2.3 barrel-import detector — own-package-name detection** — for a multi-file checkout where `package.json` declares a name, do we reliably read it at PreToolUse time? Check whether `project-graph.ts` already caches this.
- **§2.5 resource leak — passed-out handles** — the "returned from function" exemption is straightforward; the "piped into a closing target" exemption is harder. Worth measuring whether the simpler form (no piped exemption) already has acceptable FP rate before adding complexity.
- **§2.2 catch rewrap — TS-version aware?** The `cause` option requires Node 16.9+ / TS 4.6+. Should the detector check `tsconfig.json` target and silently skip on older targets? Probably yes — the suggestion to add `{ cause: e }` is wrong advice on older targets.
- **Tier B activation** — does `.interlinked/policy.json` already exist as a config surface, or do these get rolled into the existing config-gating mechanism? Verify at implementation time.

## 9. Non-goals

This doc is not proposing:
- Adopting Effect itself as a dependency. The CLI ships one runtime dependency (`commander`) and that stance is defended per the external-pulse dependency filter.
- Reimplementing Effect's runtime patterns (`Scope`, `Fiber`, `Layer`) in TS without Effect.
- Stop-event additions or trajectory-detector additions. Those live in their own design docs ([`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md), `verification-stop-checks.ts`).
- Cloud-tier policy work. Each §2 detector is local-deterministic and lives in Tier 1 of the three-tier enforcement model.
