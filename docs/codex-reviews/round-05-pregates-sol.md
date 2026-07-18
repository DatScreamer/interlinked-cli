1. [severity: high] [src/harness/evaluator/spec-pre-gates.ts:144] Relative `file_path` values are resolved against the daemon process rather than `ledger.repoRoot`, allowing valid in-repo writes to bypass all gates.
   Evidence: `const rel = relative(ledger.repoRoot, filePath)` and `readFileSync(filePath, "utf8")`; breaking input: `{ file_path: "docs/spec.md", ... }` when the daemon’s process cwd differs from the ledger root.
   Why: Other harness paths explicitly resolve relative targets against `ctx.cwd`; here the computed path can appear out-of-repo or read an unrelated file, producing false negatives or incorrect projections.

2. [severity: high] [src/harness/evaluator/spec-pre-gates.ts:52] Edit projection ignores the real Edit/MultiEdit uniqueness rule and projects only the first match when `old_string` occurs multiple times.
   Evidence: `if (!after.includes(e.old_string)) return null;` followed by `after.replace(e.old_string, e.new_string)`; the documented semantics require each non-`replace_all` `old_string` to be unique.
   Why: The real tool rejects an ambiguous edit, but the gate may return `ask` or warnings for content that cannot land, violating the zero-FP bar reserved for declared-marker drift.

3. [severity: high] [src/harness/server/spec-ledger-phase.ts:19] The module-global shared ledger is never keyed or cleared by repository, so one daemon/runtime can expose another repository’s ledger to PreToolUse.
   Evidence: `let sharedLedger: SpecLedger | null = null;` and `sharedLedger = ctx.specLedger;`.
   Why: A subsequent Pre event for a different cwd consults stale cross-repository facts; depending on paths, this either silently fails open or issues an incorrect declared-marker `ask`.

4. [severity: medium] [src/harness/server/spec-ledger-phase.ts:83] Post refresh reads `editedFilePath` directly even though callers permit repo-relative paths.
   Evidence: `ctx.specLedger.refreshFile(rel, readFileSync(editedFilePath, "utf8"));`; breaking input: `editedFilePath = "docs/spec.md"` with `ctx.cwd = "/repo"` and process cwd elsewhere.
   Why: The phase catches the read failure and leaves both the runtime ledger and shared Pre ledger stale, suppressing later drift detection.

5. [severity: medium] [src/harness/spec/ledger.ts:176] Previewing a formerly skipped file leaves it in `skippedPaths`, so links to it remain exempt from missing-target checks even after the hypothetical content replaces its ledger entry.
   Evidence: `preview.skippedPaths = new Set(this.skippedPaths); preview.refreshFile(relPath, content);`; `refreshFile` never deletes `relPath` from `skippedPaths`.
   Why: This state leak also survives live Post refreshes of size-skipped files and can mask later missing-file findings if that entry is subsequently removed.

6. [severity: medium] [src/harness/spec/ledger.ts:72] Link-target normalization handles only `/`, so Windows-style relative targets never match ledger keys or referrer queries.
   Evidence: `const parts = (sourceDir ? \`${sourceDir}/${raw}\` : raw).split("/")`; breaking link: `[plan](..\\plan.md#storage-model)`.
   Why: `externalReferrersTo` misses anchor-deletion warnings, while `xrefDrift` may incorrectly report a missing file containing literal backslashes.

7. [severity: medium] [src/harness/evaluator/spec-pre-gates.ts:67] Every ordinary Pre edit performs four full-ledger drift passes, not two, making the nominal 500-file bound a significant synchronous hot-path cost.
   Evidence: two `declaredFactNamesInDisagreement()` scans plus `ledger.computeDrift(rel)` and `preview.computeDrift(rel)`; each `computeDrift` rebuilds global censuses, bindings, declared sites, and xrefs across all files.
   Why: `previewWithFile` itself is cheap, but the repeated global recomputation scales with every fact/link in all 500 files and lacks caching or a performance regression test.

8. [severity: medium] [src/harness/server/spec-ledger-phase.ts:111] Resolved drift is removed from the Stop stash but its previously-created `pending_completions` entry is never cleared.
   Evidence: `session.spec_drift_outstanding = all...`, while `recordSiblingCompletions` only calls `session.pending_completions.set(...)`.
   Why: After a sibling is corrected, Stop/Pre obligation machinery can continue reporting a stale follow-up despite the ledger proving the finding is gone.

9. [severity: low] [src/harness/spec/ledger.ts:176] Preview cloning drops the diagnostic skipped counter.
   Evidence: `preview.truncated = this.truncated; preview.skippedPaths = new Set(this.skippedPaths);` but no `preview.skipped = this.skipped`.
   Why: `preview.skippedCount` falsely reports zero, violating the ledger’s “never silent” skipped-state contract and leaving the preview/live state-isolation test incomplete.

TOTAL: 9