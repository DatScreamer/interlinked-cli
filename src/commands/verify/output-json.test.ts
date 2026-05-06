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
		"lossyErrorRethrow",
		"silentPromiseSwallow",
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
		"childProcessExecUserInput",
		"mixedSyncAsyncFileApi",
		"cookieMissingSecurityFlags",
		"loggerFormatUserInput",
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

	it("emits empty registry_parity section when no drift findings are passed", () => {
		// Regression: --json must always include the registry_parity key so
		// CI consumers can rely on its presence. Empty findings → issues: 0,
		// details: [].
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
		expect(parsed.registry_parity).toBeDefined();
		expect(parsed.registry_parity.issues).toBe(0);
		expect(parsed.registry_parity.details).toEqual([]);
	});

	it("includes registry drift findings in the JSON output", () => {
		// Regression: pre-fix, registry parity was only wired into the
		// streaming path, so `interlinked verify --json` silently dropped
		// drift findings that the interactive run would have shown.
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
				registryDrift: [
					{
						pair: "suggestion-checks",
						kind: "missing-from-right",
						id: "ghost-check",
						source_file: "src/harness/server/suggestion-checks.ts",
						target_file: "src/commands/verify/suggestions.ts",
						message: '[suggestion-checks] "ghost-check" is in left but not right',
					},
				],
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.registry_parity.issues).toBe(1);
		expect(parsed.registry_parity.details).toHaveLength(1);
		expect(parsed.registry_parity.details[0]).toMatchObject({
			pair: "suggestion-checks",
			kind: "missing-from-right",
			id: "ghost-check",
		});
	});
});
