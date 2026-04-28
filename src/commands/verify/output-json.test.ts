// ===========================================
// output-json unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { outputJson } from "./output-json.js";
import type { CodeQualityResults } from "./tool-results-types.js";

function emptyCq(): CodeQualityResults {
	const keys = [
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
		// Plan 04 D.1 partial — high-leverage backlog
		"evalInputTainted",
		"sqlStringConcat",
		"pyMutableDefaultArg",
		// Plan 04 D.1 backlog (17 of 20)
		"tempfileMktempRace",
		"pickleUntrustedLoad",
		"xmlExternalEntity",
		"osSystemTainted",
		"unsafeFormatString",
		"uncheckedRedirect",
		"goroutineNoWaitgroup",
		"deferInLoop",
		"ubsStringConcatInLoop",
		"numericComparisonChain",
		"printDebugLeak",
		"ubsHardcodedLocalhost",
		"magicNumberNoConst",
		"largeFunction",
		"deeplyNestedCallback",
		"timeFormatLocaleDep",
		"regexInLoopNoCompile",
	] as const;
	const out = {} as Record<string, []>;
	for (const k of keys) out[k] = [];
	return out as unknown as CodeQualityResults;
}

function captureStdout(fn: () => void): string {
	const chunks: string[] = [];
	const orig = process.stdout.write;
	process.stdout.write = ((c: string) => {
		chunks.push(c);
		return true;
	}) as typeof process.stdout.write;
	try {
		fn();
		return chunks.join("");
	} finally {
		process.stdout.write = orig;
	}
}

describe("outputJson", () => {
	it("emits valid JSON to stdout", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: null,
				totalFiles: 0,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.files_scanned).toBe(0);
		expect(parsed.tsc.issues).toBe(0);
		expect(parsed.biome.issues).toBe(0);
	});

	it("includes suggestions section when provided", () => {
		const out = captureStdout(() => {
			outputJson({
				tscResults: [],
				linterResults: [],
				linterName: "biome",
				semgrepResults: [],
				gitleaksResults: [],
				auditResult: null,
				cq: emptyCq(),
				suggestions: new Map([
					[
						"a.ts",
						[{ check: "sql", line: 1, message: "m", source: "security", score: 0.9 }],
					],
				]),
				totalFiles: 1,
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.suggestions).toBeDefined();
		expect(parsed.suggestions["a.ts"]).toHaveLength(1);
	});
});
