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
		// Batch 1: agent-laziness
		"agentThumbprintProse",
		"stubNotImplementedThrow",
		"deadBranchLiteral",
		"fileLevelSuppression",
		"untestableTimeInSource",
		"doubleCastUnknown",
		"typeSmuggling",
		"unionWidenedWithString",
		"nodeenvBranchInProd",
		"fetchWithoutTimeout",
		"unboundedPromiseAll",
		"syncIoOnHotPath",
		// Batch 2: test-hygiene
		"duplicateTestNames",
		"realIoInTests",
		"testNondeterminism",
		"hardcodedTimeoutInTests",
		"testMissingSutImport",
		"mockingTheSutSelf",
		// Batch 5: cross-file
		"emptyBodyHandler",
		"listenerPairing",
		"schemaTypeDrift",
		"migrationParity",
		// Batch 8: demo-data
		"demoDataUnmarked",
		"silentDemoFallback",
		"demoRuntimeMissingBanner",
		// tsconfig strictness
		"tsconfigStrictness",
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

	it("emits empty decision_surface + multiple_lockfiles sections when not passed", () => {
		// Regression: --json must always include these keys so CI consumers
		// can rely on the schema. Absent args → empty by_category map +
		// total_surface 0, issues 0, details [].
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
		expect(parsed.decision_surface).toBeDefined();
		expect(parsed.decision_surface.total_surface).toBe(0);
		expect(parsed.decision_surface.by_category).toEqual({});
		expect(parsed.multiple_lockfiles).toBeDefined();
		expect(parsed.multiple_lockfiles.issues).toBe(0);
		expect(parsed.multiple_lockfiles.details).toEqual([]);
	});

	it("emits the decision_surface metric when passed", () => {
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
				decisionSurface: {
					projectRoot: "/repo",
					byCategory: {
						package_manager: ["npm"],
						test_framework: ["vitest"],
						linter: ["biome"],
						formatter: ["biome"],
						bundler: ["tsup"],
						http_client: [],
						date_lib: [],
					},
					totalSurface: 5,
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.decision_surface.total_surface).toBe(5);
		expect(parsed.decision_surface.by_category.test_framework).toEqual(["vitest"]);
		expect(parsed.decision_surface.by_category.linter).toEqual(["biome"]);
	});

	it("emits multiple_lockfiles details when multiplicity is true", () => {
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
				lockfileMultiplicity: {
					lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
					managers: ["npm", "pnpm"],
					multiplicity: true,
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.multiple_lockfiles.issues).toBe(1);
		expect(parsed.multiple_lockfiles.details).toHaveLength(1);
		expect(parsed.multiple_lockfiles.details[0].managers).toEqual(["npm", "pnpm"]);
		expect(parsed.multiple_lockfiles.details[0].message).toContain("Multiple lockfiles");
	});

	it("emits no multiple_lockfiles issue when multiplicity is false", () => {
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
				lockfileMultiplicity: {
					lockfiles: ["package-lock.json"],
					managers: ["npm"],
					multiplicity: false,
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.multiple_lockfiles.issues).toBe(0);
		expect(parsed.multiple_lockfiles.details).toEqual([]);
	});

	it("emits empty decision_surface_growth when not passed", () => {
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
		expect(parsed.decision_surface_growth).toBeDefined();
		expect(parsed.decision_surface_growth.skipped).toBe("not-computed");
		expect(parsed.decision_surface_growth.total_growth).toBe(0);
		expect(parsed.decision_surface_growth.warnings).toEqual([]);
	});

	it("emits decision_surface_growth when the ratchet ran with growth", () => {
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
				decisionSurfaceRatchet: {
					baselineRef: "origin/main",
					skipped: null,
					growthByCategory: {
						package_manager: [],
						test_framework: ["jest"],
						linter: [],
						formatter: [],
						bundler: [],
						http_client: [],
						date_lib: [],
					},
					totalGrowth: 1,
					warnings: [
						"[heuristic] decision_surface_growth — test_framework expanded since origin/main: added jest.",
					],
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.decision_surface_growth.baseline_ref).toBe("origin/main");
		expect(parsed.decision_surface_growth.skipped).toBeNull();
		expect(parsed.decision_surface_growth.total_growth).toBe(1);
		expect(parsed.decision_surface_growth.growth_by_category.test_framework).toEqual(["jest"]);
		expect(parsed.decision_surface_growth.warnings).toHaveLength(1);
	});

	it("emits decision_surface_growth with skip reason when the ratchet skipped", () => {
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
				decisionSurfaceRatchet: {
					baselineRef: null,
					skipped: "not-a-repo",
					growthByCategory: {
						package_manager: [],
						test_framework: [],
						linter: [],
						formatter: [],
						bundler: [],
						http_client: [],
						date_lib: [],
					},
					totalGrowth: 0,
					warnings: [],
				},
			});
		});
		const parsed = JSON.parse(out);
		expect(parsed.decision_surface_growth.skipped).toBe("not-a-repo");
		expect(parsed.decision_surface_growth.baseline_ref).toBeNull();
		expect(parsed.decision_surface_growth.warnings).toEqual([]);
	});
});
