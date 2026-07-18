1. [severity: high] [src/harness/evaluator/pre-tool.ts:103] Continuing after a side-effecting TDD debt-mode allow can leave phantom coverage debt when a later gate blocks the write.
   Evidence: With `debt_mode=true`, the test at line 128 opens debt for a new 600-line untested file, then expects the later line-cap gate to block it.
   Why: No rollback occurs after the TDD gate persists the debt. Subsequent unrelated edits can therefore be blocked by debt for a file that never landed.

2. [severity: high] [src/harness/evaluator/pre-tool.ts:103] Returning immediately on `ask` allows approval of an early spec confirmation to bypass every later guard.
   Evidence: `if (decision.decision !== "allow" || decision.updated_input) return decision;`, while `evaluateSpecPreGates` runs before auto-reservation and `evaluateWriteContent`.
   Why: A markdown write containing both declared-marker drift and merge-conflict markers prompts only for the drift; approval proceeds without running the later conflict-marker block.

3. [severity: medium] [src/harness/server/post-tool-file-checks.ts:190] Cross-file spec evaluation is performed per file rather than transactionally per multi-file event, exposing transient drift during atomic corrections.
   Evidence: One `apply_patch` changes `A.md` and `B.md` from `<!-- fact:X -->1` to `2`; processing `A.md` first compares it with the still-cached `B.md=1`.
   Why: The warning is appended before the second file refreshes the ledger and is never retracted after the final state becomes consistent.

4. [severity: medium] [src/harness/rules/__tests__/merge-parity.test.ts:149] The new `warn_spec_drift` and `warn_review_findings` switches are unreachable through real configuration loading.
   Evidence: `verification_stop_checks: { why: "default-only today", probe: { __parity: true } }`, despite default-config.ts saying to flip per-kind values in `guard-rules.local.json`.
   Why: Both local and team merges discard this section; the off-switch test passes only because it constructs `ctx.rules` directly.

5. [severity: medium] [src/harness/evaluator/pre-tool.ts:193] The spec pre-gate is invoked without the effective `GuardRulesConfig`, so `spec_checks.enabled:false` cannot reliably disable its asks and warnings.
   Evidence: `() => evaluateSpecPreGates(event, toolName, warnings)`.
   Why: Neither `rules` nor the runtime ledger is passed, so hot-reloaded or caller-supplied disabling cannot govern this phase; the merge test only proves that the unused value was stored.

6. [severity: medium] [src/harness/evaluator/post-tool.ts:189] Disputed-ground read warnings are incorrectly disabled with the unrelated output-scanning subsystem.
   Evidence: `if (!rules.output_scanning?.enabled || !event.tool_response) return warnings;` executes before `scanDisputedGroundRead(event)`.
   Why: Disabling prompt-injection/secret scanning, or receiving an empty Read response, silently disables the memo’s anti-compounding warning for open findings.

7. [severity: medium] [src/harness/server/post-tool-file-checks.ts:114] In-repo classification uses a lexical prefix check and therefore disagrees with the realpath-safe containment policy added elsewhere.
   Evidence: With `CWD="/tmp/repo"` and `editedFilePath="/private/tmp/repo/docs/a.md"` on macOS, `resolved.startsWith(CWD + sep)` is false although both paths identify the same tree.
   Why: Spec-ledger and review-reconciliation phases are skipped for legitimate edits through symlink-normalized paths; an in-root symlink to an external tree produces the inverse misclassification.

8. [severity: medium] [src/harness/server/post-tool-file-checks.ts:348] Event-global `allCheckResults` are replayed against every subsequently processed file.
   Evidence: `warningEvidence` is built from all of `allCheckResults`, then passed to `recordWarningsIssued(session, editedFilePath, warningEvidence)`.
   Why: In a two-file patch, a finding from the first file is recorded and acknowledged under the second clean file, causing false escalation state and potentially suppressing a later genuine finding there.

9. [severity: medium] [src/harness/large-file-policy.ts:367] Recursive nearest-ancestor resolution permits an agent-controlled path to exhaust the JavaScript stack.
   Evidence: `isInsideRoot("/repo", "a/".repeat(20000) + "x.ts")` throws `RangeError: Maximum call stack size exceeded`.
   Why: Every nonexistent component adds another recursive `containmentPath` call, with no depth or input-length bound, on Pre/Post hot paths.

10. [severity: low] [src/harness/check-inventory.test.ts:19] The “authoritative” inventory has no family/source for ledger-only spec checks.
   Evidence: Its families are only `inline`, `sequence`, `structural`, `tool_quality`, `suggestion`, and `behavioral`, while `CheckResultEntry.source` now includes `"spec"` and the Post pipeline emits spec-ledger results.
   Why: Cross-file spec checks can run and enter recurrence without appearing in the advertised total; the union test merely mirrors the same incomplete source list.

11. [severity: low] [src/harness/evaluator/complexity-pulse.ts:178] Cyclomatic telemetry always reports and evaluates against the hard-coded default instead of the repository’s effective cap.
   Evidence: Both `(cap ${DEFAULT_MAX_CYCLOMATIC})` and the `overCap` filter use 25, while the write guard uses `maxCyclomaticFor(cwd)`.
   Why: A repository configured for cap 10 reports CC 20 as under cap, while a repository configured for cap 40 falsely labels CC 30 over cap.

12. [severity: low] [docs/generated/cli-reference.md:84] The generated top-level command reference is truncated mid-word.
   Evidence: `workspace                                  Registry wor`
   Why: The remainder of the workspace description and trailing commands/help are absent, so the checked-in generated reference is not a faithful CLI snapshot.

13. [severity: low] [src/harness/server/lifecycle-stop-warnings.test.ts:1025] The review-findings integration test cannot detect a stale long-lived daemon cache after external ingestion.
   Evidence: It calls `resetReviewReconcileCacheForTesting()` before writing and ingesting the report, then performs only the first read.
   Why: A permanently cached implementation passes; the production-critical sequence—warm cache, separate CLI process ingests findings, next Stop rereads—remains untested.

14. [severity: low] [src/harness/check-inventory.test.ts:20] The shipped-check count contradicts the governing design memo.
   Evidence: The inventory says `+8 spec family` including `stage-order`, while the memo says “seven registered checks total” and lists workstream DAG spike 13 as remaining.
   Why: Shipped scope and acceptance status are now ambiguous, undermining the memo’s count-pinning contract.

TOTAL: 14