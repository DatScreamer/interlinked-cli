// ===========================================
// Per-file check battery — agent-safety group
// ===========================================
// Extracted from `file-checks.ts` to keep that orchestrator under the
// 1000-line file-size threshold. Covers the CRAP composite, the
// export/dead-export/cycle structural trio, and the first wave of
// "agent safety" detectors (comment-vs-behavior drift, TOCTOU, cleanup,
// promise hygiene, etc.).
//
// Behaviour-preserving: each helper runs the SAME checks in the SAME order
// as the inline block it replaced. Each `r.<bucket>` array is independent,
// so cross-helper ordering is invisible to output — only the per-bucket
// statement order matters, and that is preserved verbatim.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
	checkAccumulatingSpread,
	checkAsyncPromiseExecutor,
	checkAwaitStateToctou,
	checkBooleanTrap,
	checkBoundaryCopyNoRevalidation,
	checkBroadObjectTypes,
	checkCircularImports,
	checkCleanupReentrancy,
	checkCleanupSkippedOnEarlyExit,
	checkCodeClones,
	checkCommentClaimsIdempotentMutates,
	checkCommentClaimsLimitNoGuard,
	checkCommentClaimsNullThrowsInstead,
	checkCommentClaimsThrowsDoesnt,
	checkCommentClaimsValidationMissing,
	checkConstantCondition,
	checkDeadExports,
	checkDefaultExport,
	checkDiscriminatedUnionExhaustiveness,
	checkErrorDispatchByInstanceof,
	checkEvalUsage,
	checkExportRipple,
	checkExtraneousDependencies,
	checkFloatingPromises,
	checkFreshCollectionKeyLookup,
	checkImportFromOwnBarrel,
	checkIndexBoundsUnchecked,
	checkInnerHtmlUsage,
	checkIteratorInvalidation,
	checkLifecycleCleanup,
	checkLossyErrorRethrow,
	checkMagicLiteralInConditional,
	checkManualFieldCopy,
	checkManyOptionalParams,
	checkMisusedPromises,
	checkNanComparison,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkPositionalOptionalBoolean,
	checkPromiseRejectNonError,
	checkRequireAwait,
	checkSameTypedPrimitiveParams,
	checkSelfImport,
	checkSilentPromiseSwallow,
	checkTaintedToPrivilegedSink,
	checkThrowLiteral,
	checkUnsafeOptionalChaining,
} from "../../harness/generic-checks.js";
import { computeCrap } from "../../harness/checks/crap.js";
import { computeCyclomaticComplexity } from "../../harness/checks/cyclomatic.js";
import {
	coverageForFile,
	loadCoverageFinal,
} from "../../harness/coverage-final-reader.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { toIssues } from "./file-checks-shared.js";

/**
 * CRAP (Change Risk Anti-Patterns) — complexity × coverage composite.
 * Fail-open when coverage-final.json is absent: emits no findings.
 */
export function runCrapCheck(ctx: FileCheckContext): void {
	const { content, file, relPath, cwd, r } = ctx;
	const coveragePath = resolve(cwd, "coverage", "coverage-final.json");
	const covCache = loadCoverageFinal(coveragePath, cwd);
	const perFile = covCache ? coverageForFile(covCache, relPath) : undefined;
	if (perFile === undefined) return;
	const complexities = computeCyclomaticComplexity(content, file);
	const fileMtime = existsSync(file) ? statSync(file).mtimeMs : 0;
	const findings = computeCrap({
		complexities,
		coverage: perFile.functions,
		filePath: relPath,
		fileMtime,
		coverageMtime: perFile.mtime,
		threshold: 30,
		staleTolerance: "tag",
	});
	r.crap.push(
		...findings.map((f) => ({
			check: "crap",
			file: relPath,
			line: f.line,
			message: `${f.function}: CRAP=${f.crap_score.toFixed(0)} (cyc=${f.complexity}, cov=${f.coverage_pct.toFixed(0)}%)${f.stale ? " [stale coverage]" : ""}`,
		})),
	);
}

/**
 * Export-surface / dead-export / cycle structural trio plus the first wave of
 * agent-safety detectors. Mirrors the inline block at the head of the
 * `--- Agent safety checks ---` section.
 */
export function runAgentSafetyChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, cwd, r } = ctx;

	r.exportRipple.push(
		...toIssues("export_ripple", relPath, checkExportRipple(content, file, cwd)),
	);
	r.deadExports.push(...toIssues("dead_exports", relPath, checkDeadExports(content, file, cwd)));
	r.circularImports.push(
		...toIssues("circular_imports", relPath, checkCircularImports(content, file, cwd)),
	);
	r.lifecycleCleanup.push(
		...toIssues("lifecycle_cleanup", relPath, checkLifecycleCleanup(content, file)),
	);
	r.defaultExport.push(...toIssues("default_export", relPath, checkDefaultExport(content, file)));
	r.codeClones.push(...toIssues("code_clones", relPath, checkCodeClones(content, file)));

	// --- Agent safety checks ---
	r.misusedPromises.push(
		...toIssues("misused_promises", relPath, checkMisusedPromises(content, file)),
	);
	r.floatingPromises.push(
		...toIssues("floating_promises", relPath, checkFloatingPromises(content, file)),
	);
	r.broadObjectTypes.push(
		...toIssues("broad_object_types", relPath, checkBroadObjectTypes(content, file)),
	);
	r.booleanTrap.push(...toIssues("boolean_trap", relPath, checkBooleanTrap(content, file)));
	r.positionalOptionalBoolean.push(
		...toIssues(
			"positional_optional_boolean",
			relPath,
			checkPositionalOptionalBoolean(content, file),
		),
	);
	r.manyOptionalParams.push(
		...toIssues("many_optional_params", relPath, checkManyOptionalParams(content, file)),
	);
	r.sameTypedPrimitiveParams.push(
		...toIssues(
			"same_typed_primitive_params",
			relPath,
			checkSameTypedPrimitiveParams(content, file),
		),
	);
	// Comment-vs-behavior drift (Mythos Phase 2 verify-side wiring).
	r.commentClaimsLimitNoGuard.push(
		...toIssues(
			"comment_claims_limit_no_guard",
			relPath,
			checkCommentClaimsLimitNoGuard(content, file),
		),
	);
	r.commentClaimsNullThrowsInstead.push(
		...toIssues(
			"comment_claims_null_throws_instead",
			relPath,
			checkCommentClaimsNullThrowsInstead(content, file),
		),
	);
	r.commentClaimsValidationMissing.push(
		...toIssues(
			"comment_claims_validation_missing",
			relPath,
			checkCommentClaimsValidationMissing(content, file),
		),
	);
	r.commentClaimsIdempotentMutates.push(
		...toIssues(
			"comment_claims_idempotent_mutates",
			relPath,
			checkCommentClaimsIdempotentMutates(content, file),
		),
	);
	r.commentClaimsThrowsDoesnt.push(
		...toIssues(
			"comment_claims_throws_doesnt",
			relPath,
			checkCommentClaimsThrowsDoesnt(content, file),
		),
	);
	r.iteratorInvalidation.push(
		...toIssues("iterator_invalidation", relPath, checkIteratorInvalidation(content, file)),
	);
	r.freshCollectionKeyLookup.push(
		...toIssues(
			"fresh_collection_key_lookup",
			relPath,
			checkFreshCollectionKeyLookup(content, file),
		),
	);
	r.discriminatedUnionExhaustiveness.push(
		...toIssues(
			"discriminated_union_exhaustiveness",
			relPath,
			checkDiscriminatedUnionExhaustiveness(content, file),
		),
	);
	r.indexBoundsUnchecked.push(
		...toIssues(
			"index_bounds_unchecked",
			relPath,
			checkIndexBoundsUnchecked(content, file),
		),
	);
	r.cleanupSkippedOnEarlyExit.push(
		...toIssues(
			"cleanup_skipped_on_early_exit",
			relPath,
			checkCleanupSkippedOnEarlyExit(content, file),
		),
	);
	r.taintedToPrivilegedSink.push(
		...toIssues(
			"tainted_to_privileged_sink",
			relPath,
			checkTaintedToPrivilegedSink(content, file),
		),
	);
	r.awaitStateToctou.push(
		...toIssues("await_state_toctou", relPath, checkAwaitStateToctou(content, file)),
	);
	r.cleanupReentrancy.push(
		...toIssues("cleanup_reentrancy", relPath, checkCleanupReentrancy(content, file)),
	);
	r.boundaryCopyNoRevalidation.push(
		...toIssues(
			"boundary_copy_no_revalidation",
			relPath,
			checkBoundaryCopyNoRevalidation(content, file),
		),
	);
	r.magicLiteralInConditional.push(
		...toIssues(
			"magic_literal_in_conditional",
			relPath,
			checkMagicLiteralInConditional(content, file),
		),
	);
	r.asyncPromiseExecutor.push(
		...toIssues("async_promise_executor", relPath, checkAsyncPromiseExecutor(content, file)),
	);
	r.selfImports.push(...toIssues("self_import", relPath, checkSelfImport(content, file)));
	r.extraneousDeps.push(
		...toIssues("extraneous_deps", relPath, checkExtraneousDependencies(content, file)),
	);
	r.nonNullAssertions.push(
		...toIssues("non_null_assertion", relPath, checkNonNullAssertions(content, file)),
	);
	r.evalUsage.push(...toIssues("eval_usage", relPath, checkEvalUsage(content, file)));
	r.innerHtml.push(...toIssues("inner_html", relPath, checkInnerHtmlUsage(content, file)));
	r.nanComparison.push(...toIssues("nan_comparison", relPath, checkNanComparison(content, file)));
	r.constantCondition.push(
		...toIssues("constant_condition", relPath, checkConstantCondition(content, file)),
	);
	r.unsafeOptionalChaining.push(
		...toIssues(
			"unsafe_optional_chaining",
			relPath,
			checkUnsafeOptionalChaining(content, file),
		),
	);
	r.numberPrecisionLoss.push(
		...toIssues("number_precision_loss", relPath, checkNumberPrecisionLoss(content, file)),
	);
	r.throwLiteral.push(...toIssues("throw_literal", relPath, checkThrowLiteral(content, file)));
	r.promiseRejectNonError.push(
		...toIssues("promise_reject_non_error", relPath, checkPromiseRejectNonError(content, file)),
	);
	r.lossyErrorRethrow.push(
		...toIssues("lossy_error_rethrow", relPath, checkLossyErrorRethrow(content, file)),
	);
	r.importFromOwnBarrel.push(
		...toIssues("import_from_own_barrel", relPath, checkImportFromOwnBarrel(content, file)),
	);
	r.errorDispatchByInstanceof.push(
		...toIssues(
			"error_dispatch_by_instanceof",
			relPath,
			checkErrorDispatchByInstanceof(content, file),
		),
	);
	r.silentPromiseSwallow.push(
		...toIssues("silent_promise_catch", relPath, checkSilentPromiseSwallow(content, file)),
	);
	r.requireAwait.push(...toIssues("require_await", relPath, checkRequireAwait(content, file)));
	r.accumulatingSpread.push(
		...toIssues("accumulating_spread", relPath, checkAccumulatingSpread(content, file)),
	);
	r.manualFieldCopy.push(
		...toIssues("manual_field_copy", relPath, checkManualFieldCopy(content, file)),
	);
}
