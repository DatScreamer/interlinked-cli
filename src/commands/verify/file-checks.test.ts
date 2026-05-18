// ===========================================
// file-checks unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { runPerFileChecks } from "./file-checks.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

function makeEmptyResults(): CodeQualityResults {
	const r = {} as CodeQualityResults;
	const keys: (keyof CodeQualityResults)[] = [
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
		"sameTypedPrimitiveParams",
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
		"lossyErrorRethrow",
		"silentPromiseSwallow",
		"requireAwait",

		"accumulatingSpread",
		"manualFieldCopy",
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
		// Plan 04 Phase-1 UBS critical-tier (rows 22–26)
		"mutexLockUnwrap",
		"subprocessShellTrue",
		"tlsVerifyDisabled",
		"pyNoneEquality",
		"weakHash",
		// Plan 04 Phase-1 UBS warning/post tier (rows 27–30)
		"jsLooseEquality",
		"floatEquality",
		"javaOptionalGet",
		"divisionByVariable",
		// tsconfig strictness — runs on .json files inside the JSON branch
		"tsconfigStrictness",
	];
	for (const k of keys) r[k] = [];
	return r;
}

describe("runPerFileChecks", () => {
	it("reports JSON parse errors for invalid JSON files", () => {
		const r = makeEmptyResults();
		runPerFileChecks({
			file: "/tmp/foo.json",
			content: "{not json",
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.jsonValidity.length).toBeGreaterThan(0);
	});

	it("does not report on valid JSON files", () => {
		const r = makeEmptyResults();
		runPerFileChecks({
			file: "/tmp/foo.json",
			content: '{"x": 1}',
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.jsonValidity.length).toBe(0);
	});

	it("skips .d.ts files without running other checks", () => {
		const r = makeEmptyResults();
		runPerFileChecks({
			file: "/tmp/foo.d.ts",
			content: "export const x: any;",
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.strongTyping.length).toBe(0);
	});

	it("dispatches silent_promise_catch through the default-warning pipeline (post-promotion regression guard)", () => {
		// Use the canonical emptyResults() — the JS/TS dispatch touches every
		// CodeQualityResults bucket, so the partial makeEmptyResults() above
		// would crash with "Cannot read properties of undefined" on missing
		// Plan 04 D.1 buckets. The makeEmptyResults() fixture stays as-is to
		// keep guarding the historical surface; smoke tests use the source.
		const r = emptyResults();
		runPerFileChecks({
			file: "/tmp/swallow.ts",
			content: 'fetch("/api").catch(() => {});\n',
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.silentPromiseSwallow.length).toBeGreaterThan(0);
	});

	it("dispatches lossy_error_rethrow through the default-warning pipeline", () => {
		const r = emptyResults();
		runPerFileChecks({
			file: "/tmp/lossy.ts",
			content: 'try { foo(); } catch (e) { throw new Error("wrapped"); }\n',
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.lossyErrorRethrow.length).toBeGreaterThan(0);
	});
});
