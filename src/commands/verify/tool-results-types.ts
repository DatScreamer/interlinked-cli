// ===========================================
// Verify tool-result types
// ===========================================
// Type-only module so other verify modules can depend on `CodeQualityIssue`
// and `CodeQualityResults` without pulling the full check implementation.

import type { CheckResult } from "../../harness/check-engine/index.js";

/** Public API — consumed by verify submodules. Re-alias for backward compatibility. */
export type DiagnosticResult = CheckResult;

/** Public API — consumed by verify submodules. */
export type AuditResult = import("../../harness/check-engine/types.js").AuditResult;

/** Public API — consumed by verify submodules. */
export interface CodeQualityIssue {
	check: string;
	file: string;
	line: number;
	message: string;
}

/**
 * Public API — consumed by verify submodules.
 *
 * One bucket per check. `runCodeQualityChecks` populates these, `outputJson`
 * formats them, and `streamCqSection` walks them for the human-readable
 * streaming output.
 */
export interface CodeQualityResults {
	strongTyping: CodeQualityIssue[];
	suppressions: CodeQualityIssue[];
	largeFiles: CodeQualityIssue[];
	jsonValidity: CodeQualityIssue[];
	phantomImports: CodeQualityIssue[];
	consoleStatements: CodeQualityIssue[];
	silentCatches: CodeQualityIssue[];
	testRegressions: CodeQualityIssue[];
	undocumentedEnvVars: CodeQualityIssue[];
	mockDrift: CodeQualityIssue[];
	incompleteRenames: CodeQualityIssue[];
	missingReturnTypes: CodeQualityIssue[];
	noTestFile: CodeQualityIssue[];
	complexity: CodeQualityIssue[];
	exportRipple: CodeQualityIssue[];
	deadExports: CodeQualityIssue[];
	circularImports: CodeQualityIssue[];
	lifecycleCleanup: CodeQualityIssue[];
	defaultExport: CodeQualityIssue[];
	// Agent safety checks
	misusedPromises: CodeQualityIssue[];
	floatingPromises: CodeQualityIssue[];
	broadObjectTypes: CodeQualityIssue[];
	booleanTrap: CodeQualityIssue[];
	magicLiteralInConditional: CodeQualityIssue[];
	asyncPromiseExecutor: CodeQualityIssue[];
	selfImports: CodeQualityIssue[];
	extraneousDeps: CodeQualityIssue[];
	nonNullAssertions: CodeQualityIssue[];
	evalUsage: CodeQualityIssue[];
	innerHtml: CodeQualityIssue[];
	nanComparison: CodeQualityIssue[];
	constantCondition: CodeQualityIssue[];
	unsafeOptionalChaining: CodeQualityIssue[];
	numberPrecisionLoss: CodeQualityIssue[];
	throwLiteral: CodeQualityIssue[];
	promiseRejectNonError: CodeQualityIssue[];
	requireAwait: CodeQualityIssue[];
	accumulatingSpread: CodeQualityIssue[];
	// 13 additional agent safety checks
	excessiveUseState: CodeQualityIssue[];
	dangerouslySetInnerHtml: CodeQualityIssue[];
	directDomAccess: CodeQualityIssue[];
	inlineObjectProps: CodeQualityIssue[];
	asyncEventHandler: CodeQualityIssue[];
	nestedTernaries: CodeQualityIssue[];
	catchAndLog: CodeQualityIssue[];
	jsonParseUnsafe: CodeQualityIssue[];
	unvalidatedJsonBoundary: CodeQualityIssue[];
	hardcodedTimeout: CodeQualityIssue[];
	disabledTests: CodeQualityIssue[];
	placeholderTest: CodeQualityIssue[];
	suppressionHygiene: CodeQualityIssue[];
	targetBlankNoRel: CodeQualityIssue[];
	snapshotOveruse: CodeQualityIssue[];
	testImportingTest: CodeQualityIssue[];
	// 5 additional agent safety checks
	excessiveUseEffect: CodeQualityIssue[];
	sequentialAwaits: CodeQualityIssue[];
	indexAsKey: CodeQualityIssue[];
	missingEffectCleanup: CodeQualityIssue[];
	overMocking: CodeQualityIssue[];
	// Coding-agent feedback checks
	focusedTests: CodeQualityIssue[];
	migrationOrdering: CodeQualityIssue[];
	sqlSchemaConsistency: CodeQualityIssue[];
	visibilityFilterMissing: CodeQualityIssue[];
	// PII detection
	piiDetection: CodeQualityIssue[];
	// Taste checks (sourced from Robert C. Martin's essays)
	assertionFreeTest: CodeQualityIssue[];
	tautologicalAssertion: CodeQualityIssue[];
	mockingTheSut: CodeQualityIssue[];
	privateMemberTestAccess: CodeQualityIssue[];
	loopNestingDepth: CodeQualityIssue[];
	elseIfChain: CodeQualityIssue[];
	duplicateSwitchDiscriminant: CodeQualityIssue[];
	hybridClass: CodeQualityIssue[];
	fuzzyResponsibilityName: CodeQualityIssue[];
	lawOfDemeter: CodeQualityIssue[];
	flagArgument: CodeQualityIssue[];
	commentedOutCode: CodeQualityIssue[];
	// AI test-smell checks
	conditionalInTest: CodeQualityIssue[];
	nonDeterministicTest: CodeQualityIssue[];
	emptyCatch: CodeQualityIssue[];
	testWithoutDescription: CodeQualityIssue[];
	assertionRoulette: CodeQualityIssue[];
	magicNumber: CodeQualityIssue[];
	// Structural checks
	functionArgCount: CodeQualityIssue[];
	dataClump: CodeQualityIssue[];
	duplicateDescribe: CodeQualityIssue[];
	// Verify-parity: project-wide scans (static equivalents of PostToolUse checks)
	crossFileSwitchDiscriminant: CodeQualityIssue[];
	singleImplementationInterface: CodeQualityIssue[];
	filesWithoutTest: CodeQualityIssue[];
	projectLocRatio: CodeQualityIssue[];
	/** CRAP (Change Risk Anti-Patterns) — comp² · (1 − cov)³ + comp. Advisory. */
	crap: CodeQualityIssue[];
}

/** Public API — consumed by verify submodules. Every top-level key. */
export const CQ_RESULT_KEYS: ReadonlyArray<keyof CodeQualityResults> = [
	"strongTyping",
	"suppressions",
	"largeFiles",
	"jsonValidity",
	"phantomImports",
	"consoleStatements",
	"silentCatches",
	"testRegressions",
	"undocumentedEnvVars",
	"mockDrift",
	"incompleteRenames",
	"missingReturnTypes",
	"noTestFile",
	"complexity",
	"exportRipple",
	"deadExports",
	"circularImports",
	"lifecycleCleanup",
	"defaultExport",
	"misusedPromises",
	"floatingPromises",
	"broadObjectTypes",
	"booleanTrap",
	"magicLiteralInConditional",
	"asyncPromiseExecutor",
	"selfImports",
	"extraneousDeps",
	"nonNullAssertions",
	"evalUsage",
	"innerHtml",
	"nanComparison",
	"constantCondition",
	"unsafeOptionalChaining",
	"numberPrecisionLoss",
	"throwLiteral",
	"promiseRejectNonError",
	"requireAwait",
	"accumulatingSpread",
	"excessiveUseState",
	"dangerouslySetInnerHtml",
	"directDomAccess",
	"inlineObjectProps",
	"asyncEventHandler",
	"nestedTernaries",
	"catchAndLog",
	"jsonParseUnsafe",
	"unvalidatedJsonBoundary",
	"hardcodedTimeout",
	"disabledTests",
	"placeholderTest",
	"suppressionHygiene",
	"targetBlankNoRel",
	"snapshotOveruse",
	"testImportingTest",
	"excessiveUseEffect",
	"sequentialAwaits",
	"indexAsKey",
	"missingEffectCleanup",
	"overMocking",
	"focusedTests",
	"migrationOrdering",
	"sqlSchemaConsistency",
	"visibilityFilterMissing",
	"piiDetection",
	"assertionFreeTest",
	"tautologicalAssertion",
	"mockingTheSut",
	"privateMemberTestAccess",
	"loopNestingDepth",
	"elseIfChain",
	"duplicateSwitchDiscriminant",
	"hybridClass",
	"fuzzyResponsibilityName",
	"lawOfDemeter",
	"flagArgument",
	"commentedOutCode",
	"conditionalInTest",
	"nonDeterministicTest",
	"emptyCatch",
	"testWithoutDescription",
	"assertionRoulette",
	"magicNumber",
	"functionArgCount",
	"dataClump",
	"duplicateDescribe",
	"crossFileSwitchDiscriminant",
	"singleImplementationInterface",
	"filesWithoutTest",
	"projectLocRatio",
	"crap",
];

/** Public API — consumed by verify submodules. Build an empty result set. */
export function emptyResults(): CodeQualityResults {
	const r = {} as CodeQualityResults;
	for (const key of CQ_RESULT_KEYS) {
		r[key] = [];
	}
	return r;
}
