# Harness prevention follow-ups

Catalog of new deterministic harness checks proposed during two rounds of
post-mortem on the 8 review-comment fixes landed in 2026-05-04. Two checks
shipped during the analysis (`silent_promise_swallow`, `recursive_walker_lstat`,
both in `src/harness/checks/agent-safety.ts`); the rest live here until
someone picks one up.

Each entry follows the same shape:

- **Bug it would have caught** — concrete file:line from the actual fixes.
- **Detection pattern** — regex/AST shape that an inline check could test.
- **FP risk** — how noisy the pattern is in normal code.
- **Ship-as** — `default` (gate every edit) vs `advisory` (only `verify
  --all-checks`). New checks ship advisory until a recurrence-log baseline
  shows the FP-rate is low enough to promote.

## Round 1 — original five-bug review

### 1. Reverse-ratchet on `harness_caught` recurrence log

**Bug it would have caught.** The `software-version-regression` check shipping
default-on with a `generic:version` anchor that fired on every nested
`version` field in `package-lock.json` —
`src/harness/quality-checks/software-version-regression.ts:333-336`.

**Detection pattern.** No new inline check. Aggregator over the existing
`.interlinked/recurrences.jsonl`: per check_id, compute fires-per-edit ratio
over the last N days. Auto-propose demotion when the ratio crosses a
threshold.

**Why this is the highest-value item.** We're already writing the events
(consolidation pass landed in this round) — we're just not using the
denominator. A check that fires on N% of edits is almost certainly an FP
machine, regardless of what its detector is doing.

**Ship-as.** New CLI subcommand: `interlinked recurrence list --fp-rate` and
`interlinked recurrence propose demote <check_id>`. No new harness check.

**Effort.** Small. Aggregator + CLI surface. The recurrence log already
records the numerator; the denominator is per-session edit count from the
session-state JSON.

### 3. `preferred_entry_point` registry

**Bug it would have caught.** Commit-cadence counter reading
`tool_input.file_path` instead of the existing `extractAllEditedFilePaths`
helper —
`src/harness/evaluator/post-tool.ts:485-487`.

**Detection pattern.** Hand-curated registry at
`.interlinked/preferred-entry-points.json`:

```json
[
  {
    "id": "tool-event-files",
    "canonical": "extractAllEditedFilePaths",
    "shadow_fields": ["tool_input.file_path", "tool_input.path", "tool_input.target_file"],
    "scope": "src/harness/**"
  }
]
```

For each entry, scan files under `scope` for direct reads of any
`shadow_fields` and warn unless the call site also references `canonical`.

**FP risk.** Low — the registry is hand-curated, so noise is bounded by
what's listed. The harness can ship with one or two well-known entries
seeded.

**Ship-as.** Default for the curated entries (the registry is the
allowlist).

**Effort.** Medium. Schema + loader + simple scanner.

### 4. Source-pin tests for normative CLAUDE.md claims

**Bug it would have caught.** Recurrence write nested under
`error_memory.enabled` despite docs saying recording is unconditional —
`src/harness/server.ts:1680-1687` (pre-fix).

**Detection pattern.** `enforce` skill extension. Walk CLAUDE.md +
`docs/design/*.md` for normative phrases (`/\b(every|always|regardless of|on
each|for every)\b/`). For each hit, surface a candidate
contract-pin test. The user accepts → skill writes a `*.contract.test.ts`
that grep-pins the source against the claim.

**FP risk.** High at extraction time, zero at gate time (only generated
tests run; the user vets each one).

**Ship-as.** On-demand only (matches existing `enforce` UX). Not gated.

**Effort.** Medium. Extension to the existing `enforce` skill rather than
new infrastructure.

### 6. `loop_accumulator_replay`

**Bug it would have caught.** Recurrence consolidation pass inside the
fan-out loop, replaying prior iterations' findings —
`src/harness/server.ts:2185` (the cursor-fix bug from this round).

**Detection pattern.** Inside a `for` / `while` body, find arrays that are
both `.push`-ed AND iterated by `for...of` / `.forEach` / `.map` /
`.filter`, where the iteration is NOT bounded by an index ≥ a cursor that
was captured before the push. AST-based; regex would over-fire.

**FP risk.** Medium-high. Many legit patterns push then iterate (e.g.,
collecting then de-duplicating). Needs careful predicate.

**Ship-as.** Advisory at first. Promote after FP-rate baseline.

**Effort.** Medium. Real AST work — won't fit cleanly as a regex check.

## Round 2 — second review pass corrections

### 7. `silent_catch_with_explicit_ack`

**Bug it would have caught.** `ServerBridge.reserveFile`'s
`catch (e) { void e; return; }` swallowing a 4xx server-denial as if it were
a transient network error —
`src/harness/server-bridge.ts:140-142` (pre-this-round-fix).

**Detection pattern.** `silent_catch` is too narrow — it only matches
literally empty `{}` bodies. Extend to also match catches whose body
contains nothing but `void <ident>` and/or `return;` / `return null;` /
`return undefined;`:

```typescript
/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*(?:void\s+\1\s*;)?\s*(?:return(?:\s+(?:null|undefined))?\s*;)?\s*\}/;
```

**FP risk.** Medium. `void e; return null` is sometimes deliberate
(converting "errored" to "no result"). Pair with a documentation-comment
escape, like `silent_catch` does today.

**Ship-as.** Advisory. The original `silent_catch` (empty body) stays
default; the explicit-ack variant is the new heuristic.

**Effort.** Small. One regex extension to `checkSilentCatch` in
`src/harness/checks/b-series.ts`, plus tests.

### 8. `jsdoc_swallow_drift`

**Bug it would have caught.** `recordHarnessCaught` JSDoc claiming
"Failures are swallowed inside `recordRecurrenceEvent`" while the
implementation propagated I/O errors —
`src/harness/recurrence.ts:248-269` (pre-this-round-fix).

**Detection pattern.** For every `export function NAME` (or `function
NAME`) with a leading JSDoc block, scan the JSDoc for tokens:
`/\b(swallow(s|ed)?|fire-and-forget|fail-open|best-effort|never throws?)\b/`.
If any match, scan the function body for unwrapped calls to known-throwing
APIs:

```
mkdirSync, writeFileSync, appendFileSync, readFileSync, unlinkSync,
spawnSync, execFileSync, JSON.parse, fetch
```

A call is "unwrapped" if it's not lexically inside a `try` block within the
same function. Flag the function declaration line.

**FP risk.** Low — the JSDoc tokens are specific. False positives mostly
land on functions whose JSDoc casually mentions "swallow" without it being
a contract.

**Ship-as.** Advisory. The JSDoc convention is well-established but the
tooling around it is new.

**Effort.** Medium. Needs JSDoc block extraction (line-anchored, not
arbitrary-position), plus per-function try-block scoping. Not pure
line-by-line regex.

## What's already shipped this round

- `silent_promise_swallow` —
  `src/harness/checks/agent-safety.ts::checkSilentPromiseSwallow`. Catches
  `.catch(() => {})` and friends. Registered as a suggestion check, source
  `quality`. Tests in `agent-safety.test.ts`.
- `recursive_walker_lstat` —
  `src/harness/checks/agent-safety.ts::checkRecursiveWalkerLstat`. Catches
  `function NAME(...) { readdirSync(...); ...; statSync(...); ...; NAME(...); }`
  without `lstatSync`. Registered as suggestion source `security`. Tests in
  `agent-safety.test.ts`.

## Round 3 — third incident: parity-test exception list drift

### 9. Configurable `registry_drift` detector — SHIPPED

**Status:** Implemented in `src/harness/registry-parity.ts`, tested in
`src/harness/__tests__/registry-parity.test.ts` (17 tests), wired into
`interlinked verify` via `streamRegistryParity` in
`src/commands/verify.ts`. Sample config for this repo at
`.interlinked/registry-parity.json` declaring the suggestion-checks ↔
verify-suggestions pair (24-entry asymmetric allowlist for harness-only
checks).

### Design notes from the original plan-doc entry (preserved for context)

**Bug it would have caught.** Adding `checkSilentPromiseSwallow` and
`checkRecursiveWalkerLstat` to both suggestion registries
(`src/harness/server/suggestion-checks.ts`,
`src/commands/verify/suggestions.ts`) without updating the
`VERIFY_ONLY_CHECKS` exception list in
`src/harness/__tests__/check-pipeline-parity.test.ts`. CI failed; root
cause was registry/exception-list bookkeeping drift.

**Why bumped.** Three incidents this session pointing at the same shape:
1. Two suggestion registries drifted (round 2).
2. `recordHarnessCaught` JSDoc claimed swallow-semantics drifted from
   implementation (a different but related "two-things-must-stay-in-sync"
   class).
3. The above — registry vs exception-list drift.

**Detection pattern (still as previously sketched).** Configurable harness
check reading `.interlinked/registry-parity.json`:

```json
{
  "pairs": [
    {
      "name": "suggestion-checks",
      "left":  { "file": "src/harness/server/suggestion-checks.ts",
                 "key_re": "check:\\s*\"([a-z0-9-]+)\"" },
      "right": { "file": "src/commands/verify/suggestions.ts",
                 "key_re": "check:\\s*\"([a-z0-9-]+)\"" },
      "left_only_allowed": ["sql-injection", "..."],
      "exception_list": "src/harness/__tests__/check-pipeline-parity.test.ts::VERIFY_ONLY_CHECKS"
    }
  ]
}
```

Detector:
- Parse the configured `key_re` from each file, get two ID sets.
- Symmetric drift (entries in left not in right and vice versa) — fail
  unless the entry is in `left_only_allowed` / `right_only_allowed`.
- If `exception_list` is configured, parse it and verify the exception
  set EQUALS the asymmetric difference (no stale entries, no missing
  entries).

**Where it would run.** `interlinked verify --check-registries` (new
flag) and as part of the standard `interlinked verify` if the config
exists. NOT on every PostToolUse — drift is a release-time concern, not
an edit-time one.

**FP rate.** Zero with correct config. The risk is the config itself
going stale, but that surfaces as test failures, not as silent drift.

**Effort.** Medium-large for the full general detector (~150-200 LoC):
config schema + loader + scanner + CLI integration + tests + sample
config for THIS repo. Sized as its own focused work cycle, not as a
single-fix-cycle add.

**Project-level mitigation shipped today (round 3).** Discoverability
comments at the top of both `suggestion-checks.ts` and
`verify/suggestions.ts` listing the three bookkeeping steps any future
contributor must perform. Cheap and immediate; reduces future incidents
of this exact class even before the generic detector ships.

## Round 4 — second-order corrections on the round-3 patch

### 10. HTTP-status-class-as-decision-class

**Bug it would have caught.** `isExplicitDenialError` treated every 4xx
(except 408/429) as a reservation denial; 401/403/404 are auth/config
errors that say nothing about whether another agent holds the file.

**Why deferred.** Specific to HTTP semantics for one endpoint; no clean
generic detector. Plan-doc only. The local fix narrows to 409 + 423 with
a documented rationale.

### 11. BASE_SEVERITY ↔ suggestion-checks drift

**Bug it would have caught.** New checks added to `SUGGESTION_CHECKS`
without entries in `BASE_SEVERITY`, falling through to the 0.5 default
× 0.75 proximity = 0.375 score, below the 0.5 threshold → silently
filtered.

**Why deferred.** Same drift class as `registry_drift` (#9), but
BASE_SEVERITY is sparse-by-design — most checks legitimately use the
default. A strict parity rule would false-positive. The local fix adds
explicit entries above threshold for both new checks.

### 12. `.gitignore` drift on tracked-by-convention configs

**Bug it would have caught.** `.interlinked/*` blanket-ignored;
contributors must add `!.interlinked/<file>` exceptions for tracked
configs. Adding `.interlinked/registry-parity.json` without an exception
silently broke fresh-clone CI.

**Why deferred.** Pattern detectable as "file path referenced from
source code AND gitignored without an exception", but FP-prone — many
files are correctly referenced from code AND correctly gitignored
(caches, logs, runtime state). Plan-doc only.

### 13. Streaming-vs-JSON output drift in `verify`

**Bug it would have caught.** New finding source wired into
`runVerify`'s streaming path but not `runVerifyBatchJson` /
`outputJson`'s JSON payload. CI consuming `--json` silently misses
findings interactive runs show.

**Why deferred.** Same shape as `registry_drift` (#9), but mapping
between ANSI streaming labels and snake_case JSON keys is fuzzy —
no clean `key_re` works for both. Could ship as a structural check
that "every section in `runVerify` has a corresponding key in
`outputJson`" via call-graph analysis, but that's its own focused
work cycle. Plan-doc only.

## What's deliberately NOT in scope

- **Per-bug-class agent rules** that target the exact failure of one
  incident. The 7 entries above are all generalizable; "no recurrence
  write under error_memory.enabled" is not a check — it's a fact about one
  function. Use the source-pin pattern (#4) for those.

- **LLM-as-judge verification.** Per `feedback_harness_deterministic_only.md`,
  the check pipeline must be deterministic. All proposals here are
  regex/AST.

- **Default-on heuristic checks.** Heuristics ship advisory until the
  recurrence log shows the FP rate is low enough to promote. This document
  doesn't propose new default-on checks unless explicitly noted.
