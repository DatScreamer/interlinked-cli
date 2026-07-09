# Test-oracle integrity — "0 tests skipped or deleted", made mechanical

**Status:** Plan, 2026-07-09. Not built. Sourced from `docs/external-pulse/bun-in-rust.md` §2.5.

**The invariant.** Bun's rewrite replaced 535,496 lines of Zig with Rust and changed the
test suite by exactly nothing: *"0 tests skipped or deleted."* The suite is written in
TypeScript **precisely so it is independent of the language under test** — an oracle the
rewrite cannot edit. Jarred then *manually verified the tests were in fact running and not
being skipped* before merging, because he did not trust the invariant to hold itself.

That manual verification is the part we can mechanize.

---

## 1. Why this matters more for us than for Bun

`harness-anti-workaround.md` class 4 ("Perverse incentives — the most dangerous") already
names the failure mode this plan closes:

> The gate rewards the bad workaround: coverage → introverted tests; **red-bar →
> `.skip`/delete**; CRAP/cap → awkward helpers or obfuscation.

Every ratchet we ship raises the payoff of weakening the oracle. We have seven water-line
ratchets guarded by `baseline_integrity_gate`, and the oracle they all ultimately depend on
— the test suite — is the one artifact with **no water-line at all**. An agent that cannot
lower `coverage-baseline.json` can still delete the test that produced the coverage.

## 2. What already exists (verified against source, not docs)

Better than expected. Two checks already hard-block a `git commit`:

| Check | File | Severity | Blocks? |
|---|---|---|---|
| `disabled_test_delta` | `behavioral-diff-checks.ts:31-65` | **error** | **yes**, when `test_first_mode === "enforce"` (the default) |
| `tdd_commit_gate` (red/regression branch) | `behavioral-checks-tdd.ts:154-209` | **error** | yes |
| `assertion_free_test` | `taste-checks.ts` → `entries-taste.ts:31` | error | **yes, pre_block** — stops the write |
| `tautological_assertion` | `taste-checks.ts` → `entries-taste.ts:45` | error | yes, pre_block |
| `mocking_the_sut` | `entries-taste.ts:59` | error | yes, pre_block |

And three warn only:

| Check | File | Severity | Gap |
|---|---|---|---|
| `test_block_count_regression` | `behavioral-diff-checks.ts:73-112` | warning | **never blocks**, even under `enforce` — `runTddCommitGate` only blocks on `severity === "error"` (`pre-tool-pipeline-stages.ts:98-109`) |
| `assertion_strength_weakening` | `behavioral-diff-checks.ts:121-155` | warning | requires a strong matcher *removed* AND a weak matcher *added* in the same file |
| `assertion_density` | `behavioral-checks-tdd-assertions.ts:123-162` | warning | in-memory session delta; resets every session; never persisted |

## 3. The five gaps, precisely

1. **Deletion warns; it never blocks.** `test_block_count_regression` is `severity: "warning"`.
2. **Value-swap is invisible.** `assertion_strength_weakening` matches a *matcher-kind*
   swap (`STRONG_MATCHER_RE` removed + `WEAK_MATCHER_RE` added). Changing `toBe(5)` →
   `toBe(6)` to match the new behavior trips nothing. Neither does deleting a lone
   `expect(...)` without adding a weak matcher.
3. **No committed skip water-line.** `disabled_test_delta` is a *diff* check — it catches
   a commit that adds skips. It cannot catch a repo that already has 400 skips, nor can it
   stop the count drifting up one commit at a time across sessions. Every other ratchet has
   a water-line; this one doesn't, so it isn't protected by `baseline_integrity_gate`.
4. **Skip detection is JS/TS + Swift only.** `checkDisabledTests` (`js-ts-general.ts:264`)
   early-returns unless `JS_TS_ALL_EXTS.includes(ext)`. `@pytest.mark.skip`, Rust
   `#[ignore]`, and `t.Skip()` are undetected. **Rust has no filename test predicate
   anywhere** — `isStrictTestFile` (`checks/shared.ts:209`) covers Python, Go, JS/TS, Java,
   Swift and not Rust; `isLikelyTestFile` catches `.rs` only via a `tests/` directory rule.
5. **Stub detection is JS/TS only.** `checkStubNotImplementedThrow` (`agent-laziness.ts:231`)
   gates on `JS_TS_EXTS`. Python `raise NotImplementedError` and Rust `unimplemented!()` slip
   through. (`todo!()` *is* covered — `rust_todo_macro` in `language-profiles-data.ts`.
   Verify `unimplemented!()` is in the same pattern before writing a duplicate.)

## 4. Design

### 4.1 Do not simply promote `test_block_count_regression` to `error`

This is the obvious move and it is wrong. It manufactures the artifact it exists to catch —
`harness-anti-workaround.md` class 2 and class 4, exactly. Three legitimate cases delete a
test block:

- The SUT was deleted. Its tests should go with it.
- The test moved to another file (split a suite, renamed a module).
- Two `it()` blocks were merged into one `it.each()` table.

A blunt block forces the agent to keep dead tests, or to game the counter by adding a filler
`it("placeholder", () => expect(true).toBe(true))` — which `assertion_free_test` and
`tautological_assertion` then block, leaving it stuck. That is the "gate whose pressure
manufactures the artifact" pathology.

**Instead: make the check commit-scoped rather than file-scoped, and condition on the SUT.**

```
block iff:
    Σ test blocks across ALL staged test files decreased
AND for each file with a net loss, its companion SUT still exists in the commit tree
AND the loss is not accounted for by an it.each/test.each table introduced in the same diff
```

A per-file loss offset by a gain in a sibling test file is a **move** → `info`, not a block.
A loss whose SUT was deleted in the same commit is a **cascade** → `info`. Everything else is
an agent deleting evidence. This is one extra `git` call (`git diff --cached --name-status`,
already available via the `getStagedDiff` neighbourhood in `behavioral-checks-tdd.ts:266`)
and it removes all three false positives.

Escape hatch: `// interlinked-tdd: exempt` already exists and is honored by
`hasTddExemptDirective`. Reuse it; do not invent a second directive.

### 4.2 The skip water-line

New baseline `.interlinked/skipped-tests-baseline.json`, shaped exactly like
`large-files-baseline.json` so the detector is a near-copy of `detectLargeFiles`:

```json
{
  "version": 1,
  "max_skipped": 0,
  "_comment": "Per-file skipped-test grandfather list. Goal end-state: empty `files`.",
  "files": {
    "src/legacy/foo.test.ts": 3
  }
}
```

**Directions** (mirroring `detectLargeFiles`, `baseline-integrity-gate.ts:169-193`):
- `max_skipped` may only **shrink**.
- Each grandfather count may only **shrink**.
- A **new** entry above `max_skipped` blocks.

This is git-tracked (carve it out of the `.interlinked/*` gitignore alongside the other
two), so it needs an entry in **both** gates.

### 4.3 Assertion-value integrity

`assertion_strength_weakening` should gain a sibling, not an extension — the two have
different determinism classes and different FP profiles.

`assertion_value_swap` (**advisory**, `heuristic`): in a staged test-file diff, a removed
`-` line and an added `+` line share the same matcher and the same subject expression, and
differ only in the *expected* literal. Report it; never block. Rationale: this is legitimate
about half the time (the spec genuinely changed), so it is a `verify --all-checks` finding
and a Tier-3 reviewer prompt, not a gate. Its value is that it is the single highest-signal
line for a human or a reviewer to look at in a "made the tests pass" diff.

`assertion_count_regression` (**default gate, warning**): net `expect(`/`assert` count across
staged test files decreased while non-test source changed. Uses `countAssertions`
(`behavioral-checks-tdd-assertions.ts:87`), which already handles `node:assert` named
imports via `importedAssertNames`. This catches gap 2's "deleted a lone `expect`" case that
`assertion_strength_weakening` structurally cannot.

### 4.4 Polyglot skip + stub markers

Rust is the awkward one: its unit tests live in-file behind `#[cfg(test)]`, so there is no
test-*file* to predicate on. Resolve by **not needing the predicate**:

| Language | Skip marker | Test-file predicate needed? |
|---|---|---|
| Python | `@pytest.mark.skip`, `@pytest.mark.skipif`, `@unittest.skip` | yes — `isStrictTestFile` already covers `test_*.py` / `*_test.py` |
| Go | `t.Skip(`, `t.SkipNow(` | yes — already covers `*_test.go` |
| Rust | `#[ignore]` | **no** — the attribute only appears on `#[test]` fns. Fire on any `.rs`. |

Same for stubs: Rust `unimplemented!()` and Python `raise NotImplementedError` are
unambiguous in non-test source; no predicate widening required. **Do not add Rust to
`isStrictTestFile`** — it would silently change the behavior of every check that consumes it
(`checkDisabledTests`, `checkFocusedTests`, `checkStubNotImplementedThrow`, the taste
checks, `assertion_density`), and the blast radius is not worth it.

`checkDisabledTests` currently early-returns on non-JS/TS. Replace the extension guard with
a `SKIP_MARKERS: Record<Language, RegExp>` table and dispatch on `getExtension`. This is an
**extension of an existing check id**, not a new one — no count-gate churn.

## 5. Edits, file by file

### New files
| Path | Contents |
|---|---|
| `src/harness/checks/test-skip-markers.ts` | `SKIP_MARKERS` table + `checkDisabledTestsPolyglot`; `checkDisabledTests` becomes a thin re-export for back-compat |
| `src/harness/skipped-tests-policy.ts` | `loadSkippedBaseline` / `maxSkippedFor` / `countSkipsInFile`, mirroring `large-file-policy.ts` |
| `src/harness/__tests__/test-oracle-integrity.test.ts` | ≥3 pos / ≥3 neg per new check, plus the three move/cascade/each-table negatives from §4.1 |
| `.interlinked/skipped-tests-baseline.json` | `{version:1, max_skipped:0, files:{}}` — dogfood: this repo has 0 skips today, so start the water-line at the floor |

### Modified
| Path | Edit |
|---|---|
| `src/harness/behavioral-diff-checks.ts` | rewrite `checkTestBlockCountRegression` per §4.1 (commit-scoped, SUT-conditioned, `severity: "error"` only on the unexplained-loss branch); add `checkAssertionCountRegression`; add `checkAssertionValueSwap` |
| `src/harness/server/pre-tool-pipeline-stages.ts` | add the two new checks to the `gateResults` array in `runTddCommitGate` (~L74-88) |
| `src/harness/evaluator/baseline-integrity-gate.ts` | 5 edits per the established contract: `BaselineKind` union (L35), `BASELINE_RE` alternation (L44), `KIND_MAP` (L47), new `detectSkippedTests` (copy `detectLargeFiles`), `switch` case (L288) |
| `src/harness/evaluator/commit-baseline-gate.ts` | add `".interlinked/skipped-tests-baseline.json"` to `TRACKED_BASELINES` (L25-31) |
| `.gitignore` | carve out the new baseline alongside `large-files-baseline.json` |
| `src/harness/checks/js-ts-general.ts` | `checkDisabledTests` → delegate to the polyglot table |
| `src/harness/checks/agent-laziness.ts` | `checkStubNotImplementedThrow`: add Python/Rust branches (do **not** widen `isTestFile`) |
| `src/harness/check-registry/entries-warnings/*.ts` | register `assertion_count_regression` (default) and `assertion_value_swap` (advisory) |
| `src/harness/check-metadata.ts` (or `check-metadata/`) | metadata for the two new ids |
| `src/commands/verify/advisory.ts` | add `assertion_value_swap` to `DEFAULT_ADVISORY_SKIPS` **with a one-line rationale**; update its regression test |
| `src/harness/__tests__/check-pipeline-parity.test.ts` | `AGGREGATED_IN_JSON` |
| `docs/design/baseline-integrity-gate.md` | §2 table: 7 → 8 files. (It already undercounts at 6; `mutation-manifest.json` is missing. Fix both.) |
| `CLAUDE.md` | the baseline-integrity paragraph lists six files; make it eight |

### Count-gate ordering (from `reference_docfreshness_count_gate_ordering`)

Two new registered checks move the inventory from **344 → 346**. `check-inventory.test.ts`
pins per-family counts derived live from the registries, and `docs-freshness.test.ts` asserts
the generated markdown matches. Adding is the easy direction: land the registry entries, then
`npm run docs`, then `npm run docs:check`. (The delicate ordering — edit the generated count
*first* — only bites on **removal**.)

## 6. Rollout

1. **Land the baseline at the floor.** This repo has 0 skipped tests today (`disabled_tests`
   is a default-gate check and the suite is green). `max_skipped: 0`, empty `files`. Any
   repo adopting later runs `interlinked adopt`, which snapshots current skips into `files`
   — and per commit `31b0a54` ("adopt no-loosen") `adopt` already refuses to *grow* an
   exemption list on re-run, so the grandfather list can only ratchet down. That machinery
   is already correct for this use; reuse it rather than writing a new snapshotter.
2. **Ship `assertion_value_swap` advisory-first.** One week of dogfood. Promote only if the
   FP rate is low, per the standing rule in CLAUDE.md ("prefer refining the check's detection
   logic over demoting it").
3. **Ship the `test_block_count_regression` promotion last**, after the move/cascade
   negatives are proven on this repo's own history. Concretely: replay the last 200 commits
   through the new detector and assert zero blocks. That is the acceptance test — a gate that
   would have blocked our own honest history is not ready.

## 7. What this does not do

It does not make the suite an *independent* oracle the way Bun's is. Bun's TypeScript suite
survives a language rewrite because it tests the binary's observable behavior, not its
internals. Ours tests TypeScript from TypeScript, and a sufficiently determined agent can
rewrite both sides coherently. The water-line raises the cost; it does not close the class.

The thing that actually closes it is **mutation testing** — a mutant that survives proves the
assertion was decorative regardless of how it was written. `harness-anti-workaround.md` says
this outright ("optimistic discharge is gameable (introverted tests); ground-truth coverage +
the mutation `kind` is the real defense"), and the per-edit mutation gate already exists
(default-off). This plan is the cheap 80%; `per_edit_mutation: true` is the real answer, and
its blocker is runner cost, not design.
