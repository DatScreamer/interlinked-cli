// UBS (Ultimate Bug Scanner) language-specific detectors — Phase 1 rows 22,
// 23, 25, 29, 30 + the Plan 04 D.1 backlog. Each detector returns
// InlineMatch[] and is ext-gated where relevant.
//
// This file is a barrel. The detectors were decomposed into the
// `ubs-language-specific/` subdirectory during the 1500-line-per-file
// rollout; this module re-exports every public symbol so existing
// importers (`generic-checks.ts`, `check-registry/entries-warnings.ts`,
// the `__tests__/ubs-*.test.ts` suites) keep resolving from this path
// unchanged. New detectors should be added to the appropriate
// subdirectory module — split by programming language or check family —
// and re-exported here.
//
// Module map:
//   ubs-language-specific/_shared.ts             — shared internal helpers
//   ubs-language-specific/python-checks.ts        — Python-language checks
//   ubs-language-specific/js-security-checks.ts   — JS/TS injection & security
//   ubs-language-specific/division-by-variable.ts — `ubs_division_by_variable`
//   ubs-language-specific/quality-smell-checks.ts — generic quality / smell
//   ubs-language-specific/rust-go-checks.ts       — Rust / Go checks
//   ubs-language-specific/java-c-checks.ts        — Java / C-family checks
//   ubs-language-specific/cross-language-checks.ts — SQL concat, hardcoded host


// ---- Cross-language checks ----
export {
	checkSqlEscapeHatchNonLiteral,
	checkSqlStringConcat,
	checkUbsHardcodedLocalhost,
} from "./ubs-language-specific/cross-language-checks.js";
// ---- `ubs_division_by_variable` (Row 30) ----
export { checkDivisionByVariable } from "./ubs-language-specific/division-by-variable.js";
// ---- Java / C-family checks ----
export {
	checkJavaOptionalGet,
	checkUnsafeFormatString,
} from "./ubs-language-specific/java-c-checks.js";
// ---- JS/TS injection & security checks ----
export {
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkDocumentWrite,
	checkEvalInputTainted,
	checkInsertAdjacentHtml,
	checkLoggerFormatUserInput,
	checkMixedSyncAsyncFileApi,
	checkNodeCreateCipher,
	checkOuterHtmlAssignment,
	checkScriptWithoutSri,
	checkUncheckedRedirect,
} from "./ubs-language-specific/js-security-checks.js";
// ---- Python-language checks ----
export {
	checkMarshalLoad,
	checkOsSystemTainted,
	checkPickleUntrustedLoad,
	checkPickleWrapperLoad,
	checkPyMutableDefaultArg,
	checkPyNoneEquality,
	checkRegexInLoopNoCompile,
	checkShelveOpen,
	checkSubprocessShellTrue,
	checkTempfileMktempRace,
	checkTorchUnsafeLoad,
	checkXmlExternalEntity,
	checkYamlUnsafeLoad,
} from "./ubs-language-specific/python-checks.js";
// ---- Python temporal-correctness checks ----
export { checkNaiveDatetime } from "./ubs-language-specific/python-datetime-checks.js";
// ---- Generic quality / code-smell checks ----
export {
	checkDeeplyNestedCallback,
	checkLargeFunction,
	checkMagicNumberNoConst,
	checkNumericComparisonChain,
	checkPrintDebugLeak,
	checkTimeFormatLocaleDep,
	checkUbsStringConcatInLoop,
} from "./ubs-language-specific/quality-smell-checks.js";
// ---- Rust / Go checks ----
export {
	checkDeferInLoop,
	checkGoroutineNoWaitgroup,
	checkGoShellInjection,
	checkMutexLockUnwrap,
	checkRustDebugAssertSideEffects,
} from "./ubs-language-specific/rust-go-checks.js";
