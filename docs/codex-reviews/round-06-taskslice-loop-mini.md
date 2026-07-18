1. [severity: high] [src/harness/server/review-reconcile-phase.ts:83] Any write anywhere in a finding’s file marks the finding touched, violating the required span-overlap reconciliation contract.
   Evidence: `if (f.file !== rel) continue;` followed immediately by `appendReconciliationTxn(... action: "touched" ...)`; breaking input: a finding at `docs/plan.md:500` and an edit affecting only line 1.
   Why: The design requires PostToolUse span-matching against `recent_line_edits`; file-only matching produces false closure and can make Stop report the finding addressed when its cited region was never touched.

2. [severity: high] [src/harness/evaluator/spec-pre-gates.ts:68] Declared-marker gating compares only whether a fact name was previously disputed, so a write can introduce a new conflicting value for an already-disputed marker without an `ask`.
   Evidence: `filter((n) => !beforeNames.has(n))`; breaking input: `a.md cap=500`, `b.md cap=800`, then change `a.md` to `cap=900`.
   Why: The edit introduces additional declared-marker drift but the name was already in the disagreement set, so the sole zero-FP pre-block class is bypassed.

3. [severity: high] [src/harness/spec/ledger.ts:449] Range drift is suppressed whenever a local registry’s maximum differs from the claim, even when the global census introduces a different cross-file contradiction.
   Evidence: `if (local && hasDefSites(local) && local.max !== claim.to) continue;`; breaking input: `a.md` defines `X-01..X-20` and claims “X-01 through X-10”, while `b.md` defines `X-21..X-30`.
   Why: The local single-file check can expose 10-vs-20, but only the ledger can expose the cross-file maximum of 30; the unconditional skip loses that distinct finding.

4. [severity: medium] [src/harness/evaluator/spec-pre-gates.ts:150] Every eligible PreToolUse write clones the entire ledger and computes full repo-wide drift twice, making the decision hot path scale with all files and findings rather than the edited file.
   Evidence: `const preview = ledger.previewWithFile(rel, after);`, then `preview.computeDrift(rel)` at line 73 and both `ledger.computeDrift(rel)` and `preview.computeDrift(rel)` at lines 118–120.
   Why: `computeDrift(scope)` still constructs every count/range, declared-fact, and xref finding before filtering, including repeated global censuses and heading-set allocation; near the 500-file/2-MiB caps this violates the design’s millisecond Pre hot-path requirement.

5. [severity: medium] [src/harness/server/review-reconcile-phase.ts:117] Read and write disputed-ground warnings share one session-file dedup key, so an earlier read suppresses the specified write-on-disputed warning.
   Evidence: `const key = \`${sessionId}\u0000${rel}\`;`; breaking sequence: Read `docs/plan.md`, then write that same disputed file in the same session.
   Why: The design defines derivation and dependency crossing as separate anti-compounding channels; collapsing their dedup state creates a false negative at the later, more consequential write.

6. [severity: medium] [src/harness/server/review-reconcile-phase.ts:154] Read reconciliation ignores the Read tool’s line range and warns for findings anywhere in the file, contrary to the documented overlap requirement.
   Evidence: `disputedGroundWarning(... filePath, "read")` receives no offset/limit or finding-span information; breaking input: read lines 1–20 of a 1,000-line file whose sole finding cites line 900.
   Why: This creates persistent false-positive “disputed ground” warnings and consumes the once-per-file dedup slot before a later read that actually overlaps the finding.

7. [severity: medium] [src/harness/spec/ledger.ts:178] `previewWithFile` drops the skipped-count metadata, making previews disagree with the live ledger’s documented bounded-walk state.
   Evidence: the preview copies `truncated` and `skippedPaths` but never assigns `preview.skipped = this.skipped`.
   Why: Any consumer inspecting preview completeness sees `skippedCount === 0` despite unreadable or oversized files, violating the “nothing here is silent” ledger contract and leaving the existing preview test unable to detect the loss.

TOTAL: 7