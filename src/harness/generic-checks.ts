// ===========================================
// Generic Checks — Language-agnostic and language-specific inline analysis
// ===========================================
// Pure functions that analyze file content (<1ms each for inline checks).
// Each check returns matches (line number + text) or a boolean verdict.
// Dependencies: Node.js stdlib only (fs, path, child_process for cross-file checks).
//
// As of 2026-04, implementation lives in the `./checks/` sub-package. This
// module is kept as a thin named-export barrel so existing importers, the
// harness impact-analyzer, and docs generators keep working. New code
// should import from `./checks/<family>.js` directly.

// ---- agent-safety ----
export {
	checkAsyncPromiseExecutor,
	checkBroadObjectTypes,
	checkConstantCondition,
	checkEvalUsage,
	checkExtraneousDependencies,
	checkFloatingPromises,
	checkInnerHtmlUsage,
	checkJsLooseEquality,
	checkMagicLiteralInConditional,
	checkMisusedPromises,
	checkNanComparison,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkPhantomDependencies,
	checkRecursiveWalkerLstat,
	checkSelfImport,
	checkSilentPromiseSwallow,
	checkTlsVerifyDisabled,
	checkUnsafeOptionalChaining,
	checkWeakHash,
} from "./checks/agent-safety.js";
// ---- agent-safety-advanced ----
export {
	checkAccumulatingSpread,
	checkCircularImports,
	checkDeadExports,
	checkDefaultExport,
	checkLifecycleCleanup,
	checkPromiseRejectNonError,
	checkRequireAwait,
	checkThrowLiteral,
	checkUnvalidatedJsonBoundary,
} from "./checks/agent-safety-advanced.js";
// ---- agent-laziness (Batch 1) ----
export {
	checkAgentThumbprintProse,
	checkDeadBranchLiteral,
	checkDoubleCastUnknown,
	checkFetchWithoutTimeout,
	checkFileLevelSuppression,
	checkNodeEnvBranchInProd,
	checkStubNotImplementedThrow,
	checkSyncIoOnHotPath,
	checkUnboundedPromiseAll,
	checkUnionWidenedWithString,
	checkUntestableTimeInSource,
} from "./checks/agent-laziness.js";
// ---- test-hygiene (Batch 2) ----
export {
	checkDuplicateTestNames,
	checkHardcodedTimeoutInTests,
	checkMockingTheSutSelf,
	checkRealIoInTests,
	checkTestMissingSutImport,
	checkTestNondeterminism,
} from "./checks/test-hygiene.js";
// ---- cross-file (Batch 5) ----
export {
	checkEmptyBodyHandler,
	checkListenerPairing,
	checkMigrationParity,
	checkSchemaTypeDrift,
} from "./checks/cross-file.js";
// ---- demo-data (Batch 8) ----
export {
	checkDemoDataUnmarked,
	checkDemoRuntimeMissingBanner,
	checkSilentDemoFallback,
} from "./checks/demo-data.js";
// ---- b-series ----
export {
	checkAssertionFreeTests,
	checkFloatEquality,
	checkHardcodedCredentials,
	checkInfiniteRecursion,
	checkParseIntRadix,
	checkSilentCatch,
	checkSuppressionDensity,
	checkSyncIoInAsync,
	checkTrivialAssertions,
	checkUnreachableCode,
} from "./checks/b-series.js";
// ---- c-cpp ----
export {
	checkCIncludeGuard,
	checkCSprintfUsage,
	checkCStrcmpBooleanMisuse,
	checkCUncheckedMalloc,
	checkCUnsafeFunctions,
} from "./checks/c-cpp.js";
// ---- compat-stubs ----
export {
	checkMigrationOrdering,
	checkSqlSchemaConsistency,
	checkVisibilityFilterMissing,
} from "./checks/compat-stubs.js";
// ---- complexity ----
export { checkFunctionComplexity } from "./checks/complexity.js";
// ---- comment-drift (Mythos Phase 2) ----
export {
	checkCommentClaimsIdempotentMutates,
	checkCommentClaimsLimitNoGuard,
	checkCommentClaimsNullThrowsInstead,
	checkCommentClaimsThrowsDoesnt,
	checkCommentClaimsValidationMissing,
} from "./checks/comment-drift.js";
// ---- cross-language ----
export { checkSqlInjection } from "./checks/cross-language.js";
// ---- deletion-hygiene ----
export {
	checkDeletionComments,
	checkDeprecationNotice,
	checkEmptyFunctionBody,
	checkNotImplementedStubs,
	checkOrphanedTestStub,
} from "./checks/deletion-hygiene.js";
// ---- error-handling ----
export {
	checkBareCatchBlock,
	checkCatchReturnNull,
	checkErrorStringComparison,
	checkInconsistentErrorStrategy,
	checkLossyErrorRethrow,
	checkThrowAsControlFlow,
	checkUntypedCatch,
} from "./checks/error-handling.js";
// ---- export-ripple ----
export {
	checkExportRipple,
	getGitSourceFiles,
} from "./checks/export-ripple.js";
// ---- focused-tests ----
export { checkFocusedTests } from "./checks/focused-tests.js";
// ---- index-as-key ----
export { checkIndexAsKey } from "./checks/index-as-key.js";
// ---- js-ts-general ----
export {
	checkCatchAndLog,
	checkDisabledTests,
	checkHardcodedTimeout,
	checkJsonParseUnsafe,
	checkNestedTernaries,
	checkTargetBlankNoRel,
} from "./checks/js-ts-general.js";
// ---- language-agnostic ----
export {
	checkBinaryContent,
	checkConsoleDebug,
	checkEmptyFile,
	checkLargeFile,
	LARGE_FILE_DEFAULT_MAX_LINES,
} from "./checks/language-agnostic.js";
// ---- missing-effect-cleanup ----
export { checkMissingEffectCleanup } from "./checks/missing-effect-cleanup.js";
// ---- over-mocking ----
export { checkOverMocking } from "./checks/over-mocking.js";
// ---- package-json ----
export {
	checkPackageJsonPublishInvariants,
	checkPackageJsonPublishInvariantsWithPublint,
	checkPackageJsonScriptPaths,
} from "./checks/package-json.js";
// ---- tsconfig-strictness ----
export { checkTsconfigStrictness } from "./checks/tsconfig-strictness.js";
// ---- performance ----
export {
	checkArrayFromMap,
	checkAwaitInLoop,
	checkCloneInLoop,
	checkCollectThenIterate,
	checkDoubleTypeCast,
	checkFilterLength,
	checkJsonClonePattern,
	checkJsonInLoop,
	checkLenListGenerator,
	checkMallocInLoop,
	checkMathSpread,
	checkQueryInLoop,
	checkRegexInLoop,
	checkSortInLoop,
	checkSpreadInReduce,
	checkSprintfInLoop,
	checkStringConcatInLoop,
	checkStrlenInLoopCondition,
} from "./checks/performance.js";
export type { PiiPattern } from "./checks/pii.js";
// ---- pii ----
export {
	checkMixedErrorStrategy,
	checkPiiInSource,
} from "./checks/pii.js";
// ---- placeholder-tests ----
export { checkPlaceholderTests } from "./checks/placeholder-tests.js";
export type { ProjectSetupIssue } from "./checks/project-setup.js";
// ---- project-setup ----
export { checkProjectSetup } from "./checks/project-setup.js";
// ---- react ----
export {
	checkAsyncEventHandler,
	checkDangerouslySetInnerHTML,
	checkDirectDomAccess,
	checkExcessiveUseState,
	checkInlineObjectProps,
} from "./checks/react.js";
// ---- return-types ----
export { checkMissingReturnTypes } from "./checks/return-types.js";
// ---- sequential-awaits ----
export { checkSequentialAwaits } from "./checks/sequential-awaits.js";
// ---- shared helpers ----
export type { InlineMatch } from "./checks/shared.js";
export {
	getExtension,
	isCliFile,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./checks/shared.js";
// ---- supply-chain ----
export {
	checkErrorMessageLeakage,
	checkHardcodedLocalhost,
	checkImportFromDist,
	checkInfiniteRetryLoop,
	checkPlaceholderValues,
	checkProcessExitInLibrary,
	checkTyposquatDependencies,
} from "./checks/supply-chain.js";
// ---- swift ----
export {
	checkSwiftAbbreviations,
	checkSwiftDelegateNotWeak,
	checkSwiftFileIdOverFilePath,
	checkSwiftFilterCount,
	checkSwiftForceCast,
	checkSwiftForceTry,
	checkSwiftForceUnwrap,
	checkSwiftGlobalVarNoIsolation,
	checkSwiftImplicitlyUnwrappedOptional,
	checkSwiftLegacyHashValue,
	checkSwiftLegacyRandom,
	checkSwiftSelfInEscapingClosure,
	checkSwiftTaskDetached,
	checkSwiftUnhandledTaskError,
	checkTestRegressions,
	extractEnvReferences,
	extractMockDefinitions,
	extractModuleExportNames,
	parseEnvDocumentation,
} from "./checks/swift.js";
// ---- taste ----
export {
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkFunctionArity,
	checkGodFile,
	checkNarrativeNaming,
	checkTestDescriptionQuality,
} from "./checks/taste.js";
// ---- taste-smell ----
export {
	checkCommentedOutCode,
	checkFlagArguments,
	checkMagicNumbers,
	checkNegatedConditionWithElse,
	checkNestedTernary,
	checkSameTypedPrimitiveParams,
} from "./checks/taste-smell.js";
// ---- iteration-safety ----
export {
	checkFreshCollectionKeyLookup,
	checkIteratorInvalidation,
} from "./checks/iteration-safety.js";
// ---- exhaustiveness ----
export { checkDiscriminatedUnionExhaustiveness } from "./checks/exhaustiveness.js";
// ---- index-bounds ----
export { checkIndexBoundsUnchecked } from "./checks/index-bounds.js";
// ---- cleanup-early-exit ----
export { checkCleanupSkippedOnEarlyExit } from "./checks/cleanup-early-exit.js";
// ---- tainted-sink ----
export { checkTaintedToPrivilegedSink } from "./checks/tainted-sink.js";
// ---- flow-safety ----
export {
	checkAwaitStateToctou,
	checkBoundaryCopyNoRevalidation,
	checkCleanupReentrancy,
} from "./checks/flow-safety.js";
// ---- test-file-exists ----
export { checkTestFileExists } from "./checks/test-file-exists.js";
// ---- testing ----
export {
	checkExcessiveUseEffect,
	checkSnapshotOveruse,
	checkTestImportingTest,
} from "./checks/testing.js";
// ---- ubs-language-specific (Plan 04 rows 22, 23, 25, 29, 30 + D.1 backlog) ----
export {
	checkDeeplyNestedCallback,
	checkDeferInLoop,
	checkDivisionByVariable,
	checkEvalInputTainted,
	checkGoroutineNoWaitgroup,
	checkJavaOptionalGet,
	checkLargeFunction,
	checkMagicNumberNoConst,
	checkMutexLockUnwrap,
	checkNumericComparisonChain,
	checkOsSystemTainted,
	checkPickleUntrustedLoad,
	checkPrintDebugLeak,
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkLoggerFormatUserInput,
	checkMixedSyncAsyncFileApi,
	checkPyMutableDefaultArg,
	checkPyNoneEquality,
	checkRegexInLoopNoCompile,
	checkSqlStringConcat,
	checkSubprocessShellTrue,
	checkTempfileMktempRace,
	checkTimeFormatLocaleDep,
	checkUbsHardcodedLocalhost,
	checkUbsStringConcatInLoop,
	checkUncheckedRedirect,
	checkUnsafeFormatString,
	checkXmlExternalEntity,
} from "./checks/ubs-language-specific.js";
