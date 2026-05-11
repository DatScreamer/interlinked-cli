# Generalized Ratchet & Quota System

**Status:** Design / not yet implementation. Sequenced third in the no-SOTA-assumed harness extensions (C in the A/B/C/D series).

**Origin.** Three ratchets exist today as one-off implementations: `non_null_assertion_ratchet`, the `as any` ratchet, and the suppressions ratchet. Each is wired separately; each carries its own baseline, its own enforcement, its own reporting. The pattern is general — **for any check, baseline the count and refuse to let it grow** — but the implementation is bespoke. This document specifies a single ratchet engine that any check id can opt into, plus a quota concept ("every X has a Y") that complements ratchets for existence claims.

**Audience.** Engineers extending `src/harness/check-registry/` and `src/commands/verify/`.

**Constraint.** Deterministic enforcement only. Ratchets and quotas are pure functions of (baseline, current state, edit). No LLM, no learning, no dynamic policy.

---

## TL;DR

Two new mechanisms, one engine:

- **Ratchet** — for any check id, baseline the count and require monotone behavior on edits. Three modes: `monotone_decrease` (default), `monotone_zero` (once at zero, stays at zero), `bounded` (explicit cap).
- **Quota** — a predicate over project state that asserts an existence relation ("every exported symbol has a test"). Quota violations behave like check warnings; quotas can themselves be ratcheted.

Config in `.interlinked/ratchets.json` (team) and `.local.json` (personal). Baseline state in `.interlinked/ratchet-baselines.json` (committed). Enforcement runs as part of `interlinked verify` and during PostToolUse.

The three existing ratchets (`non_null_assertion_ratchet`, `as_any`, `suppressions`) migrate into this engine as configuration, not code. After migration, adding a new ratchet is a one-line config change.

---

## 1. Why generalize

The existing three ratchets demonstrate the value: they meaningfully suppress regression of well-named patterns over time. But each was built bespoke, and the next ten patterns that deserve ratcheting (broad object types, magic literals, dead exports, default exports, untyped JSON parses, lifecycle leaks) would each require parallel implementation work. Three ratchets is the threshold — the fourth should land via config.

Two secondary benefits:

- **Audibility.** Today a reviewer asking "what does this codebase ratchet?" reads three different files. Centralized config produces one answer.
- **Scope correctness.** Ad-hoc ratchets each made independent decisions about scope (whole repo? per file? per package?). The general engine standardizes scope semantics, which is where ratchets get FP-noisy if done wrong.

Tertiary: the quota concept (existence predicates) is a different shape from ratchets but shares the baseline-and-enforce machinery. Ship them together because the enforcement-and-reporting code is the same.

---

## 2. Ratchet types

### 2.1 `monotone_decrease`

Count must not grow from baseline. Edits that increase the count fail (`verify`-blocking) or warn (in PostToolUse).

```jsonc
{ "check": "broad_object_types", "scope": "per_file", "mode": "monotone_decrease" }
```

This is the default mode. Most checks newly added to the ratchet system start here. The model: "we're not enforcing zero, but we're insisting we don't get worse."

### 2.2 `monotone_zero`

Once the count reaches zero, it stays at zero. Re-adding the pattern fails. Equivalent to flipping a check from advisory to blocking, but conditional on having reached zero first (so adoption is gradual, not a flag-day).

```jsonc
{ "check": "magic_literal_in_conditional", "scope": "per_file", "mode": "monotone_zero" }
```

`monotone_zero` activates per-scope when that scope's baseline first hits zero. The state file records which scopes have crossed the threshold.

### 2.3 `bounded`

Explicit cap, not derived from baseline. Use for "this metric should be ≤ N forever":

```jsonc
{ "check": "files_per_directory", "scope": "per_directory", "mode": "bounded", "cap": 30 }
```

Less common than the other two. Useful for hard architectural constraints (max files in a directory, max exports per module, etc.).

---

## 3. Scopes

Scope is the unit over which counts are aggregated. Same scope semantics across all ratchet modes:

| Scope | Counts aggregated over | When to use |
|---|---|---|
| `per_file` | The single file being edited | Default; most FP-safe; the count change is unambiguously caused by the edit |
| `per_directory` | All files under a directory (configurable depth) | Layer/package-level metrics |
| `per_package` | All files under a package root (declared in `.interlinked/packages.json`) | Cross-cutting code-quality metrics |
| `repo` | Whole working tree | Architectural metrics; noisy under multi-developer churn |

### 3.1 Scope and the FP problem

The biggest FP source for ratchets is **scope mismatch with the unit of edit**. If a ratchet's scope is `repo` and the metric counts `as any` across the whole repo, then a developer who edits `foo.ts` (which has zero `as any`) can fail the ratchet because someone else's commit on `bar.ts` raised the count above baseline. That's a noisy false positive — the developer can't fix what they didn't change.

The defense is: **ratchet scope must be a subset of edit scope**. `per_file` is FP-safe by construction (the edit *is* the file). `per_directory` is FP-safe if the edit touches that directory. `repo` is only FP-safe in CI, not at edit time — the engine enforces this by **only running `repo`-scoped ratchets in `interlinked verify`, never in PostToolUse**.

### 3.2 Diff-aware enforcement (per_file)

For `per_file` scope, count the change in the *touched region* of the file, not the whole file. This is the same diff-aware filtering pattern the existing harness applies — pre-existing findings outside the diff don't count.

```
for each per_file ratchet:
  pre_count_in_diff  = count(check, file_state_before, diff_region)
  post_count_in_diff = count(check, file_state_after, diff_region)
  if post_count_in_diff > pre_count_in_diff: violation
```

This matters because a 500-line file with 3 baselined `broad_object_types` shouldn't fail when the developer adds a 10-line function (zero new instances) — the existing 3 are not "introduced by this edit."

---

## 4. Quota predicates

Quotas are a parallel concept: not "how many of X exists" but "does every X have a Y." They're existence relations, evaluated as predicates over the project graph.

```jsonc
{
  "rule": "every_exported_symbol_has_test",
  "scope": "per_package",
  "grace_edits": 0
}
```

### 4.1 Quota vocabulary

Like contracts in Doc B, quotas compose from a vetted vocabulary — no inline scripts:

| Quota predicate | Meaning |
|---|---|
| `every_exported_symbol_has_test` | For every exported symbol in scope, ≥1 test references it |
| `every_new_export_has_consumer` | Newly added exports must be referenced from ≥1 file (with optional grace period in edits) |
| `every_route_has_authz` | Every route handler reads from the auth context |
| `every_db_write_inside_txn` | Every db write call appears inside a transaction scope |
| `every_pii_field_has_marker` | Every field matching PII patterns has a `@pii`/`@sensitive` marker |
| `every_handler_returns_typed_error` | Every handler's error path returns a typed error, not a `throw new Error("...")` |

The vocabulary lives in `src/harness/ratchets/quotas/predicates.ts`. New predicates require both implementation and a tricky-case corpus (same pattern as refactor verbs, Doc B §9).

### 4.2 `grace_edits`

For "every new export has a consumer" — the consumer doesn't exist *at the moment* the export is added, by definition. Grace period is "this quota tolerates violation for N subsequent edits before blocking."

Storage: `.interlinked/ratchet-state.local.json` carries `pending_quotas: [{ rule, key, edits_remaining }]` with decrement on each edit. Past zero, violation surfaces.

### 4.3 Quotas can be ratcheted

A quota can itself be a check id and thus a ratchet target:

```jsonc
{ "check": "quota.every_exported_symbol_has_test", "scope": "per_package", "mode": "monotone_decrease" }
```

Reads as: "we're not enforcing every export has a test today, but we're requiring the gap not grow." Useful for adopting a quota gradually.

---

## 5. Storage and config

### 5.1 Config layering

| File | Git | Purpose |
|---|---|---|
| `src/harness/ratchets/builtin.ts` | committed | Default ratchets + quotas (currently the 3 existing ones, post-migration) |
| `.interlinked/ratchets.json` | committed | Team-shared additions / disabled list |
| `.interlinked/ratchets.local.json` | gitignored | Personal overrides |

Same pattern as guard rules and escalation rules — auditable, layered, no surprises.

### 5.2 Baseline storage

| File | Git | Purpose |
|---|---|---|
| `.interlinked/ratchet-baselines.json` | committed | Per-scope baseline counts |
| `.interlinked/ratchet-state.local.json` | gitignored | Pending quotas, last-evaluated timestamps, monotone_zero crossings |

Baselines are committed because they're a team contract — "the count was N when we adopted this ratchet, and we agreed not to grow it." Personal state (pending quotas) is local because it tracks per-developer edit history.

### 5.3 Baseline file shape

```jsonc
{
  "version": 1,
  "established_at": "2026-05-10T00:00:00Z",
  "established_by": "interlinked@1.4.2",
  "ratchets": {
    "broad_object_types::per_file::src/harness/checks/iteration-safety.ts": 3,
    "broad_object_types::per_file::src/harness/checks/b-series.ts": 7,
    "as_any::repo": 142,
    "magic_literal_in_conditional::per_package::cli": 28,
    "_zero_crossings": ["non_null_assertion::per_file::src/harness/types.ts"]
  }
}
```

Key format: `<check>::<scope>::<scope_key>` — sortable, diffable in git, human-readable.

### 5.4 Re-baselining

```bash
interlinked ratchet baseline                    # Establish baseline for any unbaselined ratchets
interlinked ratchet baseline --check broad_object_types --scope per_file
interlinked ratchet baseline --reset            # Wipe and re-establish all (requires --force)
```

Re-baselining requires `--force` to prevent accidental drift erasure. The intended workflow: a maintainer adds a new ratchet to config, runs `baseline` (records current state), commits both. Re-baselining the same ratchet later requires explicit intent.

---

## 6. Engine architecture

### 6.1 New files

| File | Purpose |
|---|---|
| `src/harness/ratchets/types.ts` | `Ratchet`, `Quota`, `Scope`, `Mode`, `BaselineEntry`, `RatchetViolation` |
| `src/harness/ratchets/engine.ts` | Evaluator entry point; loads config + baseline, evaluates against context |
| `src/harness/ratchets/baseline.ts` | Baseline establishment, re-baseline, version migration |
| `src/harness/ratchets/scopes.ts` | Scope iteration (per_file, per_directory, per_package, repo) |
| `src/harness/ratchets/diff.ts` | Diff-aware counting (per_file mode) |
| `src/harness/ratchets/quotas/predicates.ts` | Quota predicate implementations |
| `src/harness/ratchets/__tests__/` | Tests |

### 6.2 Integration points

- **`interlinked verify`** — engine runs as a verify section after quality checks. `repo`-scope ratchets only fire here.
- **PostToolUse** — engine runs after structural checks; only `per_file`/`per_directory` ratchets and quotas with grace=0 evaluate.
- **`interlinked harness status`** — show current vs baseline for all active ratchets.

### 6.3 Migration of the existing three

The three existing ratchets each have a different surface today:

| Existing | Migration target |
|---|---|
| `non_null_assertion_ratchet` (in `check-registry/entries-warnings.ts`) | New config entry: `{ check: "non_null_assertion", scope: "per_file", mode: "monotone_decrease" }` |
| `as_any` ratchet (in `quality-checks.ts`) | `{ check: "as_any", scope: "per_file", mode: "monotone_decrease" }` |
| Suppressions ratchet (in `quality-checks.ts`) | `{ check: "suppressions_unjustified", scope: "per_file", mode: "monotone_decrease" }` plus `quota.suppressions_have_reason` |

Migration is mechanical:

1. Implement engine + builtin config (Phase 1)
2. Add the three as builtin entries with their current baseline values
3. Remove the bespoke implementations (Phase 2)
4. Run regression tests — counts and behavior identical

The migration is a no-op for users; the architectural simplification is internal.

---

## 7. CLI surface

```bash
interlinked ratchet list                            # All active ratchets + quotas + status
interlinked ratchet show <id>                       # Detail: baseline, current, violations
interlinked ratchet status                          # Compact summary: green/yellow/red per ratchet
interlinked ratchet baseline [--check X] [--scope] # Establish or re-establish baseline
interlinked ratchet promote <check>                 # When at zero, lock as monotone_zero
interlinked ratchet demote <check>                  # Lower mode (zero → decrease, decrease → off)
interlinked ratchet violations [--since <commit>]   # List ratchet violations introduced since commit
```

`promote` is the ratchet lifecycle: most ratchets start `monotone_decrease`, then once a scope reaches zero, the maintainer promotes that scope to `monotone_zero`. The `_zero_crossings` field in the baseline file records which scopes have crossed.

`violations --since` is the CI/PR-review entry point: "what ratchets did this PR violate?"

---

## 8. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Baseline file missing | engine startup | refuse to enforce; print "run `interlinked ratchet baseline`" |
| Baseline file out of sync (a ratchet has no baseline entry) | engine startup | print warning; don't enforce *that* ratchet; suggest baseline command |
| Baseline file ahead of code (entry references nonexistent check) | engine startup | warn; ignore the entry; suggest cleanup |
| `repo`-scope ratchet fires in PostToolUse | engine pre-check | refuse to evaluate (engine bug); log to harness log |
| Diff-aware counting flake (parser disagrees with previous run) | re-run mismatch | conservative — count the higher of the two |
| Quota predicate is expensive (project graph traversal) | wall-clock check | cache result for 30s per scope; mark stale on file edit in scope |
| `grace_edits` lost across CLI restarts | engine startup | reload from `ratchet-state.local.json`; if missing, start fresh (lose grace, fail-closed) |

The expensive-quota issue (project graph traversal can be ~100ms+ for big quotas like `every_exported_symbol_has_test`) is the perf-critical one. Cache aggressively; fall back to *not running* the quota in PostToolUse if it overruns the per-event budget. Verify-mode runs are uncapped.

---

## 9. Testing

- `__tests__/engine.test.ts` — each mode (`monotone_decrease`, `monotone_zero`, `bounded`) with synthetic counts
- `__tests__/scopes.test.ts` — each scope's counting and FP-safety properties
- `__tests__/diff-aware.test.ts` — per_file diff-aware counting (the FP-defense workhorse)
- `__tests__/baseline.test.ts` — establish, reset, re-establish, version migration
- `__tests__/quota-predicates.test.ts` — each predicate, ≥3 positive and ≥3 negative cases
- `__tests__/migration.test.ts` — the three existing ratchets produce identical violations before and after migration (regression)
- `__tests__/integration.test.ts` — full verify pass with engine enabled

The migration regression test is the migration's gate. If it fails, the migration cannot land.

---

## 10. Phased rollout

| Phase | Deliverable | Gate to next |
|---|---|---|
| 1 | Engine + types + `monotone_decrease` + `per_file` scope + diff-aware counting | All unit tests pass |
| 2 | Migrate the 3 existing ratchets into builtin config; remove bespoke code | Migration regression: identical violations on a 30-day commit replay |
| 3 | `monotone_zero` + `bounded` modes; `per_directory` scope | Pos/neg tests + manual verification on this repo |
| 4 | Quota engine + 3 initial quota predicates (`every_exported_symbol_has_test`, `every_new_export_has_consumer`, `every_handler_returns_typed_error`) | Each ≥3/3 pos/neg + tricky corpus |
| 5 | `per_package` scope + `repo` scope (verify-only) + CLI surfaces | Used in CI for ≥1 week |
| 6 | `promote`/`demote` lifecycle + `_zero_crossings` tracking | Phase 5 stable |

The migration in Phase 2 is the proof of value. If migrating the three existing ratchets into the engine produces zero behavioral diff, the engine is safe to extend in Phase 3+. If it produces diffs, those diffs are bugs to fix before the engine ships.

---

## 11. Open questions

1. **Per-author scope.** Some teams want "this developer's commits don't grow this ratchet" rather than "any commit doesn't." Out of scope for Phase 1; can layer on later via `git blame` integration.
2. **Cross-baseline merging.** When two long-lived branches both ratchet a count down, the merge should pick the lower of the two baselines. Today: not handled — baseline file just merges with conflict, requiring manual resolution. Acceptable for Phase 1; revisit if it becomes painful.
3. **Ratchet expiry.** Should ratchets that have stayed at the same count for 90 days auto-promote to `monotone_zero` (no progress = lock the ceiling)? Tempting but risks accidental enforcement. Defer to Phase 6 as opt-in.
4. **Quota FP rate.** Quota predicates are higher-FP than ratchets (existence claims are easy to mis-spec). Phase 4 ships with shadow mode (same pattern as escalation rules, Doc A §6.3) to calibrate before enforcing.
5. **Performance budget.** Quotas in PostToolUse have to fit the harness budget. Hard ceiling? Phase 4 instruments and decides; provisional answer is "≤50ms per quota in the hot path, fall back to verify-only above that."
6. **What stops the config from growing without bound?** Same answer as refactor verbs: informal cap (~25 ratchets total before architectural review), explicit RFC discipline for new entries.

---

## 12. Composition with the larger system

| Doc | Relationship |
|---|---|
| A (escalation rules) | Repeated ratchet violations across a session can fire an escalation. Quotas can be the substrate for escalation triggers (`quota.X violated ≥3 times in session`). |
| B (refactor verbs) | Verb contracts can reference ratchet predicates ("after this rename, `as_any` count not increased"). Ratchets give verbs a vocabulary for anti-shortcut clauses. |
| D (BoN executor) | Verifier composition includes `--verify "ratchet:all"` (no ratchet violation introduced) and `--verify "quota:X"` (specific quota satisfied). Ratchets are first-class verifiers. |
| Existing `interlinked recurrence` | Ratchet violations are recorded in the recurrence log. Patterns that recur become candidates for promoting from `monotone_decrease` to `monotone_zero`. |

The system-level effect: today's per-edit warnings → escalation syntheses (A) → ratchet enforcement (this doc) → recurrence-driven promotion. That's the feedback cadence — warn, synthesize, ratchet, lock.
