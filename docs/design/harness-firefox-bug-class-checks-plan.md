# Plan: Firefox-bug-class checks for Interlinked harness

## Context

Mozilla announced (2026-05-07, "Behind the Scenes Hardening Firefox with
Claude Mythos Preview") that they fixed 271 latent security bugs in
Firefox 150 with the help of a dynamic agentic harness. The disclosed
bug sample spans:

- Memory safety: UAFs, buffer over-read, integer overflow
- Trust-boundary verification gaps (parent process trusting sandbox input,
  RLBox copy verification gap)
- Iterator invalidation (hash rehash freeing backing store mid-iter)
- Race conditions / TOCTOU over IPC and async boundaries
- Re-entrancy during teardown (nested event loops, actor teardown UAF)
- Numeric edge cases (16-bit overflow at 65535, NaN-as-tagged-pointer)
- Protocol parser fallback paths

Most bugs are C++-specific, but the *patterns* port to TS/JS. This plan
maps each pattern class to a viable per-tool-use check the harness can
add.

## Budget envelope

- Per-check: 1-3s is plenty.
- Total PostToolUse: 15-30s shared timeout, parallelize aggressively.
- Existing soft ceiling in `server.ts:2255` is 15s — the negotiating range.
- PreToolUse stays tight: 500ms socket-connect ceiling, fail-open.
- Hook checks must be **deterministic**: no LLM in the main check pipeline
  (feedback memory `feedback_harness_deterministic_only`). LLM lives only
  in the narrow PreToolUse policy classifier.

## Existing coverage (verified against the registry)

Closest neighbors that don't overlap:

- `lifecycle_cleanup` (missing-cleanup detector, advisory)
- `missing_effect_cleanup` (React useEffect specific)
- `unvalidated_json_boundary` (partial trust-boundary, advisory)
- `nan_comparison` (`=== NaN`, error)
- `eval_usage`, `ubs_eval_input_tainted`, `child_process_exec_user_input`
  (sink-side checks)
- `ubs_tempfile_mktemp_race` (file-path TOCTOU only)
- `index_as_key` (React list keys — different bug class)
- `mutation-gate.ts` — full mutation testing as a *weekly* gate, deliberately
  not per-edit by design

Not yet covered: iterator invalidation, async TOCTOU, numeric-input-as-array-index,
cleanup reentrancy, NaN/non-stable Map keys, side-effect-after-throw,
boundary-value dynamic testing, regex/parser fuzz, roundtrip property tests.

## Tier 1 — Static AST patterns

Each <200ms, parallel, deterministic shape-match. No flow analysis.

Phase classification (per `check-registry/types.ts`): `pre_block` is reserved
for *fully-deterministic, zero-FP* errors only. Tier 1 here is partial-
deterministic with low FP, so default placement is **`post` warnings** that
run on every PostToolUse (not `--all-checks` only) — i.e. they're "default"
in that they fire by default, but they don't block writes. Promotion to
`pre_warn` after one week of clean dogfood signal.

| Check id (proposed) | Phase | Detection | Firefox bug | FP rate |
|---|---|---|---|---|
| `iterator_invalidation` | post | mutating array/`Map`/`Set` while iterating it (`splice`/`delete`/`clear`/key reassignment inside `for-of`/`forEach`/`for...in` on the same collection); also `Map.set`/`Set.add` to a *new* key inside iteration over the same collection | 2025977 (XSLT `key()` rehash freed backing store mid-iter) | low |
| `fresh_collection_key_lookup` | post | `NaN`, freshly-spread object literal, or `Symbol()` created mid-loop used as a `Map`/`Set` key | 2022034 loose analog (NaN crossing tagged-pointer boundary) | low |
| `index_bounds_unchecked` | post | `arr[Number(input)]`/`Buffer.subarray(parseInt(x))` where `x` traces to external input and no `Number.isFinite(n) && n < arr.length` guard exists between parse and use | 2026305 (16-bit overflow at 65535) | low-medium |
| `await_state_toctou` | post (advisory) | same expression (`x.y`/`state.foo`) appears as a truthiness check before an `await` and as a method receiver after | 2021894 / 2022733 (IPC race over async) | low (narrow form), medium (general) |
| `cleanup_skipped_on_early_exit` | post (advisory) | function acquires a resource (`AbortController`/`open`/`createConnection`/`addEventListener`/`subscribe`), throws or returns before the matching release, no `try/finally` around the acquisition | 2024653 / 2027298 reframed (cleanup race during teardown) | medium |

`side_effect_after_exit` was dropped — it's redundant with the existing
`unreachable_code` detector at `src/harness/checks/b-series.ts:18`. The
useful bug class from the Firefox teardown bugs is *cleanup-skipping early
exits*, captured by `cleanup_skipped_on_early_exit` above.

Implementation slot (verified against current code, May 2026):
- Detector lives in `src/harness/checks/<family>.ts` (e.g. a new
  `iteration-safety.ts`). The barrel `src/harness/generic-checks.ts`
  re-exports for back-compat — new code imports directly from
  `checks/<family>.js`.
- Registry entry in `src/harness/check-registry/entries-warnings.ts` (or
  `entries-errors.ts` for `pre_block` checks; not used here).
- Metadata in `src/harness/check-metadata.ts`.
- `src/harness/check-registry.ts` is now a compatibility shim that
  auto-re-exports from `check-registry/index.js`. **Do not edit it.**
- Verify wiring is split across `src/commands/verify/file-checks.ts`,
  `tool-results-types.ts`, `section-table.ts`, `output-json.ts`, and
  `advisory.ts` — touch the ones the new check actually surfaces in.
  The single-file `verify.ts` edit pattern in CLAUDE.md is stale.
- Pipeline-parity test entry in `__tests__/check-pipeline-parity.test.ts`.
- Each new check ships with at least three negative cases (legitimate
  patterns that must NOT fire) plus three positive cases.

## Tier 2 — Lightweight intra-file flow analysis

Each 1-3s, parallel. All start advisory (run only under `verify --all-checks`)
until dogfood signal supports promotion.

| Check id (proposed) | Detection | Firefox bug |
|---|---|---|
| `tainted_to_privileged_sink` | local intra-file flow: a value originating from a known untrusted source (`req.body`, `JSON.parse(stdin/argv/env)`, `child_process` stdout, `fetch().json()`, hook payload) that reaches `eval`/`Function`/`vm.run*`/`child_process.*`/`fs.write*` (computed path)/dynamic SQL without passing through a recognized validator (zod/io-ts/yup/`instanceof`/`typeof` chain) | 2023817 (parent process trusted sandbox-supplied input) |
| `boundary_copy_no_revalidation` | `Object.assign(typedSlot, untrustedRaw)` or spread-into-typed-target across a trust boundary, where the source has not been schema-validated since crossing the boundary | 2029813 (RLBox verification gap) |
| `cleanup_reentrancy` | disposers (`useEffect` cleanup returns, `dispose`/`close`/`destroy`, `removeEventListener` callbacks) that synchronously call methods capable of firing another lifecycle event on the same instance — distinct from the early-exit case in Tier 1 | 2024653 / 2027298 (UAF via re-entry during teardown) |

Implementation notes:
- `tainted_to_privileged_sink` does **NOT** ride existing
  `src/harness/taint-tracker.ts`. That tracker is session/file-level
  Bell-LaPadula sensitivity (label ratchets up when the *session* reads
  sensitive content), not intra-file variable taint. The new check needs
  a small local flow analyzer — narrower in scope than the existing
  `unvalidated_json_boundary` advisory, and it can sit alongside that
  check rather than extending its detector.
- `cleanup_reentrancy` and `boundary_copy_no_revalidation` need a tiny
  intra-file CFG (branch + assignment tracking, not full SSA).
- Promotion path: each starts advisory; promote to default-gate `post`
  warning after one week of clean dogfood signal.

## Tier 3 — Bounded dynamic checks (opt-in surface, NOT default PostToolUse)

This tier was originally pitched as default PostToolUse. It is too risky for
that surface as designed. Reasons:

- Importing a changed module to test it executes that module's top-level
  code. In a real codebase this can hit real services (DB connect on
  import, fetch on import, queue subscription on import), depend on env
  vars, mutate global state, or block on side-effectful initialization.
- "Pure exported function" is not statically inferable. Marking a function
  pure requires either an explicit annotation or a sandbox that prevents
  side effects from escaping — neither is free.
- Default PostToolUse runs on every edit. A flaky or slow Tier 3 check
  trains the agent to ignore it; a genuinely-failing one needs a clear
  reproduction path the agent can act on.

So Tier 3 is split out into a separate opt-in surface — `verify --dynamic`
or a CI-only gate — and gets its own design. Sketch of how it would work:

| Check id (proposed) | What it does | Firefox bug |
|---|---|---|
| `boundary_value_harness` | for each function annotated `/** @pure */` (or matching a strict purity heuristic — no imports of `node:fs`/`node:net`/`node:child_process`/`node:dns`, no top-level await, no module-scope side effects), generate ~50-200 inputs covering `0`, `-0`, `NaN`, `±Infinity`, `MAX_SAFE_INTEGER ± 1`, `2^16-1`, `2^16`, `2^31`, `2^32`, `""`, `"\0"`, very-long-string, empty/single/large/recursive arrays and objects; observe throws and return-type mismatches | 2026305 / 2022034 / 2023958 |
| `regex_parser_fuzz` | 1000 iterations from a malformed-input corpus + ReDoS catastrophic-backtrack detector, length-budgeted (not wall-clock) so it stays deterministic | 2023958 (DNS UDP→TCP fallback parser edge case) |
| `roundtrip_property_test` | for changed serializer/parser pairs (detected via export-name pattern: `parse`/`serialize`, `encode`/`decode`) with `/** @pure */` annotation, assert `parse(serialize(x)) === x` over the boundary corpus | 2023817 / 2029813 (trust-boundary copy verification) |

Architectural notes:
- Run inside `node:worker_threads` with a fresh module graph per worker so
  side effects don't leak across checks.
- Spawn workers only for files containing `/** @pure */` annotations — no
  speculative import of unannotated modules.
- All inputs deterministic (fixed seeds) so checks remain reproducible.
- Use `mutation-gate.ts` as the cadence reference: this tier is run on
  demand (`verify --dynamic`) or in CI, not on every edit.
- Open question: how to bootstrap the corpus — start with a small fixture
  set + boundary-value generator, expand from real-world failure modes.

Tier 3 is **not Phase 1**. The first dynamic-checks PR is the design doc
for `verify --dynamic` and its sandbox; implementation comes later, after
Tier 1 has shipped and dogfood signal exists.

## Build order (revised after wiring/risk review)

0. **Plan refresh** — this doc, plus an audit pass to confirm CLAUDE.md's
   "5-step agent-quality check" recipe matches current code (it doesn't —
   the legacy mirror step is now an auto-shim). CLAUDE.md update lands
   alongside the first detector PR.
1. **PR 1 — `iterator_invalidation` + `fresh_collection_key_lookup`**
   as `post` warnings, default-gate. Each ships with ≥3 negative cases
   (legitimate patterns that must NOT fire) and ≥3 positive cases.
2. **PR 2 — `index_bounds_unchecked`** as `post` warning, scoped to
   obvious external inputs (`Number(req.body.*)`, `parseInt(argv.*)`,
   `JSON.parse(stdin).*`) and obvious missing guards (no `Number.isFinite`
   or `< arr.length` between parse and index). Ships with the same
   negative/positive case discipline.
3. **PR 3 — `cleanup_skipped_on_early_exit`** as `post` advisory. Run
   under `verify --all-checks` until dogfood data shows signal.
4. **PR 4 — Tier 2 `tainted_to_privileged_sink`** as `post` advisory,
   alongside `unvalidated_json_boundary` (not extending it; both run
   independently). Local flow analyzer, no `taint-tracker.ts` dependency.
5. **PR 5 — `await_state_toctou` + `cleanup_reentrancy` +
   `boundary_copy_no_revalidation`** as `post` advisory. Promote individual
   checks once their FP rate is acceptable in dogfood.
6. **Separate design — `verify --dynamic`** surface for Tier 3. Different
   doc, different scope. Implementation only after Tier 1 has shipped and
   the sandbox/purity-annotation contract is settled.

## Out of scope at this budget size

- **LLM-driven test-case generation** (Mozilla's full inner loop) —
  `feedback_harness_deterministic_only` keeps LLM out of the check pipeline.
  Mozilla-style generation belongs on a separate async/queued surface
  (a CI job, not in-hook).
- **Symbolic execution / bounded model checking** — false sense of
  completeness for the cost.
- **Cross-process race fuzzing** — needs an instrumented runtime.
- **Pulling `mutation-gate.ts` to per-edit** — the weekly-gate decision is
  a deliberate cost-call already shipped.
- **Tier 3 on default PostToolUse** — see Tier 3 section above for the
  side-effect-on-import argument; opt-in surface only.

## Open questions

- Purity annotation form: JSDoc `/** @pure */`, an export wrapper
  (`export const fooPure = pure(foo)`), or both?
- `verify --dynamic` cadence: pre-merge CI gate, opt-in local command,
  or both?
- How to keep the boundary-value corpus and the malformed-input corpus
  versioned and updateable without touching detector code?
- Worker-thread sandbox: is a fresh module graph enough, or do we need
  to mock `node:fs`/`node:net` at the module-resolution layer to be
  honest about "no side effects"?
- Should `cleanup_skipped_on_early_exit` (Tier 1) and `cleanup_reentrancy`
  (Tier 2) merge into a single check family with sub-rules, given they
  cover adjacent ground in the same Firefox bug cluster?
