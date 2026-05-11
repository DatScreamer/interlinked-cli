// ===========================================
// Harness Server — Suggestion Check Registry
// ===========================================
// Runs the regex-heuristic suggestion checks (SQL injection, boolean
// trap, magic numbers, deletion hygiene, error-handling smells, C/C++
// patterns, ...) on an edited file's content and collects their
// findings for the suggestion scorer.
//
// These checks are deliberately not in the blocking quality-check
// pipeline — they are heuristic, so false positives are tolerable.
// The scorer filters noise by context before surfacing them.
//
// PARITY BOOKKEEPING — when adding a new entry below:
//   1. Mirror in `src/commands/verify/suggestions.ts` (offline `verify
//      --suggestions` runs its own parallel registry).
//   2. Add the check ID to `PARITY_REQUIRED` in
//      `src/__tests__/suggestion-registry-parity.test.ts`.
//   3. If the imported function name is new and *not* wired through
//      `quality-checks.ts`, add it to `VERIFY_ONLY_CHECKS` in
//      `src/harness/__tests__/check-pipeline-parity.test.ts` with a
//      one-line rationale.
// All three drift-detection tests already exist; they will fail loudly
// in CI if any of these steps is skipped.

import {
	checkAwaitInLoop,
	checkBareCatchBlock,
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkCatchReturnNull,
	checkCommentedOutCode,
	checkCStrcmpBooleanMisuse,
	checkCUncheckedMalloc,
	checkDeletionComments,
	checkDeprecationNotice,
	checkEmptyFunctionBody,
	checkErrorStringComparison,
	checkFlagArguments,
	checkFunctionArity,
	checkGodFile,
	checkInconsistentErrorStrategy,
	checkMagicNumbers,
	checkMixedErrorStrategy,
	checkNarrativeNaming,
	checkNegatedConditionWithElse,
	checkNestedTernary,
	checkNotImplementedStubs,
	checkOrphanedTestStub,
	checkQueryInLoop,
	checkRecursiveWalkerLstat,
	checkSilentCatch,
	checkSqlInjection,
	checkTestDescriptionQuality,
	checkThrowAsControlFlow,
	checkUnreachableCode,
	checkUntypedCatch,
} from "../generic-checks.js";
import type { Finding } from "../suggestion-scorer.js";

/** Registry entry bundling a check id, its source category, and the detector. */
interface SuggestionCheck {
	check: string;
	source: Finding["source"];
	fn: (content: string, filePath: string) => { line: number; text: string }[];
}

/**
 * Order matters only for the telemetry spool — severity/proximity is
 * computed by the scorer. New checks go at the end of the most
 * appropriate category block.
 */
const SUGGESTION_CHECKS: SuggestionCheck[] = [
	// --- Security + perf (real bugs, higher base severity) ---
	{ check: "sql-injection", source: "security", fn: checkSqlInjection },
	{ check: "perf-query-in-loop", source: "performance", fn: checkQueryInLoop },
	{ check: "perf-await-in-loop", source: "performance", fn: checkAwaitInLoop },
	{ check: "silent-catch", source: "quality", fn: checkSilentCatch },
	// `silent-promise-swallow` was promoted to the default-warning
	// CHECK_REGISTRY pipeline (entries-warnings.ts → silent_promise_catch). It
	// no longer runs through the scored suggestion path to avoid double-firing.
	{ check: "recursive-walker-lstat", source: "security", fn: checkRecursiveWalkerLstat },
	{ check: "unreachable-code", source: "quality", fn: checkUnreachableCode },

	// --- Taste: opinionated code quality ---
	{ check: "boolean-trap", source: "quality", fn: checkBooleanTrap },
	{ check: "function-arity", source: "quality", fn: checkFunctionArity },
	{ check: "narrative-naming", source: "quality", fn: checkNarrativeNaming },
	{ check: "test-description-quality", source: "quality", fn: checkTestDescriptionQuality },
	{ check: "catch-and-ignore", source: "quality", fn: checkCatchAndIgnore },
	{ check: "god-file", source: "quality", fn: checkGodFile },
	{ check: "magic-numbers", source: "quality", fn: checkMagicNumbers },
	{ check: "negated-condition-with-else", source: "quality", fn: checkNegatedConditionWithElse },
	{ check: "nested-ternary", source: "quality", fn: checkNestedTernary },
	{ check: "flag-arguments", source: "quality", fn: checkFlagArguments },
	{ check: "commented-out-code", source: "quality", fn: checkCommentedOutCode },

	// --- Deletion hygiene (Layer 1): zombie code detectors ---
	{ check: "not-implemented-stub", source: "quality", fn: checkNotImplementedStubs },
	{ check: "empty-function-body", source: "quality", fn: checkEmptyFunctionBody },
	{ check: "deprecation-notice", source: "quality", fn: checkDeprecationNotice },
	{ check: "orphaned-test-stub", source: "quality", fn: checkOrphanedTestStub },
	{ check: "deletion-comment", source: "quality", fn: checkDeletionComments },
	{ check: "mixed-error-strategy", source: "quality", fn: checkMixedErrorStrategy },

	// --- Error handling quality ---
	{ check: "bare-catch-block", source: "quality", fn: checkBareCatchBlock },
	{ check: "catch-return-null", source: "quality", fn: checkCatchReturnNull },
	{ check: "throw-as-control-flow", source: "quality", fn: checkThrowAsControlFlow },
	{ check: "untyped-catch", source: "quality", fn: checkUntypedCatch },
	{ check: "error-string-comparison", source: "quality", fn: checkErrorStringComparison },
	{ check: "inconsistent-error-strategy", source: "quality", fn: checkInconsistentErrorStrategy },

	// --- C/C++ heuristic checks ---
	{ check: "c-strcmp-boolean-misuse", source: "security", fn: checkCStrcmpBooleanMisuse },
	{ check: "c-unchecked-malloc", source: "security", fn: checkCUncheckedMalloc },
];

/** Above this elapsed-ms, a single suggestion check is treated as
 *  pathologically slow and logged to stderr so we can locate the
 *  regex with catastrophic backtracking. Tuned to be roughly an
 *  order of magnitude above the slowest healthy check on a typical
 *  300-line source file. */
const SLOW_CHECK_LOG_THRESHOLD_MS = 500;

/**
 * Public API — consumed by the PostToolUse pipeline in `server.ts` to
 * collect suggestion findings for the scorer. Runs each registered
 * regex check against the file content and aggregates `Finding[]`.
 *
 * Returns findings in registration order. Caller is responsible for
 * scoring/filtering via the suggestion scorer.
 *
 * Per-check timing is captured and any check exceeding
 * `SLOW_CHECK_LOG_THRESHOLD_MS` is logged to stderr — this is how we
 * isolate the regex responsible for the multi-second
 * `scored_suggestions` tax that shows up in `phase_breakdown`.
 */
export function collectSuggestionFindings(content: string, filePath: string): Finding[] {
	const allFindings: Finding[] = [];
	for (const { check, source, fn } of SUGGESTION_CHECKS) {
		const t0 = Date.now();
		const matches = fn(content, filePath);
		const elapsed = Date.now() - t0;
		if (elapsed >= SLOW_CHECK_LOG_THRESHOLD_MS) {
			process.stderr.write(
				`[interlinked-suggestion-perf] ${check} took ${elapsed}ms on ${filePath}\n`,
			);
		}
		for (const m of matches) {
			allFindings.push({ check, line: m.line, message: m.text, source });
		}
	}
	return allFindings;
}

/**
 * Public API — exposes the check registry for docs generation and
 * docs-freshness tests. Returns a shallow clone so callers cannot
 * mutate the shared registry.
 */
export function getSuggestionChecks(): ReadonlyArray<{ check: string; source: string }> {
	return SUGGESTION_CHECKS.map((c) => ({ check: c.check, source: c.source }));
}
