// ===========================================
// Parity Test: verify command vs PostToolUse check pipeline
// ===========================================
// Ensures that every inline check wired into one pipeline is also wired
// into the other. Prevents drift where a new check is added to PostToolUse
// but forgotten in `interlinked verify` (or vice versa).
//
// This test reads source files as text and extracts check function names
// via regex — no imports needed, pure static analysis.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLI_ROOT = resolve(import.meta.dirname, "../..");

// Paths relative to cli/src/
const QUALITY_CHECKS_PATH = resolve(CLI_ROOT, "harness/quality-checks.ts");
const CHECK_REGISTRY_DIR = resolve(CLI_ROOT, "harness/check-registry");
const VERIFY_PATH = resolve(CLI_ROOT, "commands/verify.ts");
// `verify.ts` was split across `commands/verify/` during the 2026-04 refactor.
// The parity test needs to see the concatenated source so the regex
// extraction covers the full wiring even after the split.
const VERIFY_SUBMODULE_DIR = resolve(CLI_ROOT, "commands/verify");
const VERIFY_SUBMODULES = [
	"file-checks.ts",
	"tool-results.ts",
	"tool-results-types.ts",
	"section-table.ts",
	"output-json.ts",
	"streaming-output.ts",
	"suggestions.ts",
	"suppressions.ts",
];

function readFullVerifySource(): string {
	const top = readFileSync(VERIFY_PATH, "utf-8");
	const subs = VERIFY_SUBMODULES.map((f) =>
		readFileSync(resolve(VERIFY_SUBMODULE_DIR, f), "utf-8"),
	);
	return [top, ...subs].join("\n");
}

/**
 * Read the concatenation of all check-registry source files. The registry
 * was split across entries-errors/entries-warnings/entries-taste/entries-c-cpp
 * to keep individual files under the file-size threshold; the test still
 * needs a single string to run regex extraction over.
 */
function readRegistrySources(): string {
	return [
		"entries-errors.ts",
		"entries-warnings.ts",
		"entries-taste.ts",
		"entries-c-cpp.ts",
		"builders.ts",
	]
		.map((f) => readFileSync(resolve(CHECK_REGISTRY_DIR, f), "utf-8"))
		.join("\n");
}

// ===========================================
// Helpers: Extract check names from source
// ===========================================

/** Extract `check*` function names imported from generic-checks in a file.
 *  If the file imports from check-registry.ts (which re-exports generic-checks),
 *  also include those transitive imports. */
function extractGenericCheckImports(source: string, transitiveSource?: string): Set<string> {
	const names = new Set<string>();
	const importRegex = /import\s*\{([^}]+)\}\s*from\s*["'][^"']*generic-checks[^"']*["']/gs;
	for (const m of source.matchAll(importRegex)) {
		for (const name of m[1].split(",")) {
			const trimmed = name.trim().replace(/^type\s+/, "");
			if (trimmed.startsWith("check")) {
				names.add(trimmed);
			}
		}
	}
	// If the source imports from check-registry, include the registry's generic-checks imports
	if (/from\s*["'][^"']*check-registry[^"']*["']/.test(source) && transitiveSource) {
		for (const m of transitiveSource.matchAll(importRegex)) {
			for (const name of m[1].split(",")) {
				const trimmed = name.trim().replace(/^type\s+/, "");
				if (trimmed.startsWith("check")) {
					names.add(trimmed);
				}
			}
		}
	}
	return names;
}

/** Extract check names used in the agentSafetyChecks array in quality-checks.ts.
 *  If agentSafetyChecks is built via buildAgentSafetyChecks() from check-registry,
 *  extract IDs from the registry source instead. */
function extractAgentSafetyCheckNames(source: string, registrySource?: string): Set<string> {
	const names = new Set<string>();

	// Strategy 1: inline array literal (legacy) — only matches when the assignment
	// contains an array literal `= [` (not a function call like buildAgentSafetyChecks)
	const arrayMatch = source.match(/const\s+agentSafetyChecks[^=]*=\s*\[[\s\S]*?\];/);
	if (arrayMatch) {
		for (const m of arrayMatch[0].matchAll(/name:\s*["'](\w+)["']/g)) {
			names.add(m[1]);
		}
		return names;
	}

	// Strategy 2: registry-based (buildAgentSafetyChecks call detected)
	// The registry is split across multiple entries-*.ts files, each exporting
	// an ENTRIES array (ERROR_ENTRIES, WARNING_ENTRIES, TASTE_ENTRIES,
	// C_CPP_ENTRIES). Concatenate them and extract id/pipeline pairs by
	// scanning entry blocks.
	if (/buildAgentSafetyChecks/.test(source) && registrySource) {
		const entries = registrySource.split(/\{\s*\n/);
		for (const entry of entries) {
			const idMatch = entry.match(/id:\s*["'](\w+)["']/);
			const pipelineMatch = entry.match(/pipeline:\s*["'](\w+)["']/);
			if (idMatch && pipelineMatch && pipelineMatch[1] === "agent_safety") {
				names.add(idMatch[1]);
			}
		}
	}
	return names;
}

/** Extract check names used in toIssues() calls in verify.ts */
function extractVerifyCheckNames(source: string): Set<string> {
	const names = new Set<string>();
	for (const m of source.matchAll(/toIssues\(\s*["'](\w+)["']/g)) {
		names.add(m[1]);
	}
	return names;
}

/** Extract check names from streamCqSection calls and the declarative
 *  section table (`key: "propertyName"`) in the verify streaming pipeline. */
function extractStreamSectionNames(source: string): Set<string> {
	const names = new Set<string>();
	// Legacy inline call form
	for (const m of source.matchAll(
		/streamCqSection\(\s*\n?\s*["'][^"']+["'],\s*\n?\s*cq\.(\w+)/g,
	)) {
		names.add(m[1]);
	}
	// Declarative table form (post-refactor): `key: "nameOfBucket"` inside a
	// SectionSpec whose sibling `label` marks the entry as a streaming section.
	for (const m of source.matchAll(/key:\s*["'](\w+)["']/g)) {
		names.add(m[1]);
	}
	return names;
}

/** Extract property names from CodeQualityResults interface */
function extractResultsInterfaceProps(source: string): Set<string> {
	const names = new Set<string>();
	const interfaceMatch = source.match(/interface\s+CodeQualityResults\s*\{([\s\S]*?)\n\}/);
	if (!interfaceMatch) return names;
	for (const m of interfaceMatch[1].matchAll(/^\s*(\w+)\s*:/gm)) {
		names.add(m[1]);
	}
	return names;
}

/** Extract property names consumed by outputJson — either via destructuring
 *  (legacy `const { ... } = cq;`) or via direct property access (post-refactor
 *  `cq.foo`, `summarize(cq.bar)`, etc.). */
function extractJsonOutputProps(source: string): Set<string> {
	const names = new Set<string>();
	const destructMatch = source.match(
		/function\s+outputJson[\s\S]*?const\s*\{([\s\S]*?)\}\s*=\s*cq;/,
	);
	if (destructMatch) {
		for (const m of destructMatch[1].matchAll(/(\w+)/g)) {
			names.add(m[1]);
		}
	}
	// Post-refactor: outputJson reads `cq.X` directly across the build object.
	for (const m of source.matchAll(/\bcq\.(\w+)/g)) {
		names.add(m[1]);
	}
	return names;
}

// ===========================================
// Intentional exceptions
// ===========================================

// Checks that only exist in verify (not PostToolUse) with documented reasons
const VERIFY_ONLY_CHECKS = new Set([
	// Cross-file checks that need full project scan
	"checkExportRipple",
	"checkProjectSetup",
	"checkTestRegressions",
	// Placeholder-test check: currently only wired into verify via its own
	// module (`harness/checks/placeholder-tests.ts`); quality-checks.ts is the
	// legacy single-file pipeline. Remove from this list once the check is
	// surfaced through the agentSafetyChecks registry.
	"checkPlaceholderTests",
	// Heuristics moved to scored suggestion pipeline (server.ts), not quality-checks.ts
	"checkSqlInjection",
	"checkQueryInLoop",
	"checkAwaitInLoop",
	"checkUnreachableCode",
	"checkSilentCatch",
	"checkRecursiveWalkerLstat",
	"checkConsoleDebug",
	// Codebase-wide analysis checks (too broad/slow for single-file PostToolUse)
	"checkPiiInSource",
	"checkMixedErrorStrategy",
	// Extraction helpers (not checks)
	"extractEnvReferences",
	"extractMockDefinitions",
	"parseEnvDocumentation",
]);

// Checks in PostToolUse only (not verify) with documented reasons
const POSTTOOLUSE_ONLY_CHECKS = new Set([
	// Binary/empty file checks — only relevant when agent writes a file
	"checkBinaryContent",
	"checkEmptyFile",
	// C/C++ checks — PostToolUse only, pending registry refactor (Improvement #2)
	// Function names (for import parity) and snake_case names (for toIssues parity)
	"checkCUnsafeFunctions",
	"checkCIncludeGuard",
	"checkCSprintfUsage",
	"c_unsafe_functions",
	"c_include_guard",
	"c_sprintf_usage",
	// Package publish invariants — needs pre-edit disk content to diff against
	// post-edit proposed content, so the check only makes sense at PreToolUse
	// where those two states differ. Running it during `interlinked verify`
	// would produce zero findings (pre == post on a committed file), and
	// wiring a verify-side entry would just add dead code.
	"checkPackageJsonPublishInvariants",
	"checkPackageJsonPublishInvariantsWithPublint",
	"package_json_publish_invariants",
	// Package JSON script paths — stateless check, would work in verify too,
	// but the verify-side wiring (interface + init + push + streamCqSection)
	// is deferred to a follow-up. Hook-time coverage is the load-bearing path.
	"checkPackageJsonScriptPaths",
	"package_json_script_paths",
]);

// ===========================================
// Tests
// ===========================================

describe("check pipeline parity: verify ↔ PostToolUse", () => {
	const qualitySource = readFileSync(QUALITY_CHECKS_PATH, "utf-8");
	const registrySource = readRegistrySources();
	const verifySource = readFullVerifySource();

	const qcImports = extractGenericCheckImports(qualitySource, registrySource);
	const verifyImports = extractGenericCheckImports(verifySource);
	const safetyCheckNames = extractAgentSafetyCheckNames(qualitySource, registrySource);
	const verifyCheckNames = extractVerifyCheckNames(verifySource);

	it("every check imported in quality-checks.ts is also imported in verify.ts (or documented as exception)", () => {
		const missing: string[] = [];
		for (const name of qcImports) {
			if (!verifyImports.has(name) && !POSTTOOLUSE_ONLY_CHECKS.has(name)) {
				missing.push(name);
			}
		}
		expect(
			missing,
			`These checks are imported in quality-checks.ts but NOT in verify.ts:\n${missing.join("\n")}\n\nEither add them to verify.ts or add to POSTTOOLUSE_ONLY_CHECKS with a reason.`,
		).toEqual([]);
	});

	it("every check imported in verify.ts is also imported in quality-checks.ts (or documented as exception)", () => {
		const missing: string[] = [];
		for (const name of verifyImports) {
			if (!qcImports.has(name) && !VERIFY_ONLY_CHECKS.has(name)) {
				missing.push(name);
			}
		}
		expect(
			missing,
			`These checks are imported in verify.ts but NOT in quality-checks.ts:\n${missing.join("\n")}\n\nEither add them to quality-checks.ts or add to VERIFY_ONLY_CHECKS with a reason.`,
		).toEqual([]);
	});

	it("every agentSafetyCheck has a corresponding toIssues call in verify.ts (or documented as exception)", () => {
		const missing: string[] = [];
		for (const name of safetyCheckNames) {
			// Convert snake_case safety check name to the verify toIssues name
			const verifyName = name; // toIssues uses the same snake_case name
			if (!verifyCheckNames.has(verifyName) && !POSTTOOLUSE_ONLY_CHECKS.has(name)) {
				missing.push(name);
			}
		}
		expect(
			missing,
			`These agentSafetyChecks have no matching toIssues() call in verify.ts:\n${missing.join("\n")}\n\nAdd the check to verify.ts's runCodeQualityChecks() function.`,
		).toEqual([]);
	});

	it("every toIssues call in verify.ts has a corresponding agentSafetyCheck (or documented as exception)", () => {
		// Build set of verify check names that correspond to agentSafetyChecks
		// (excluding checks that are wired differently, like complexity, large_file, etc.)
		const safetyCheckSet = new Set(safetyCheckNames);
		const verifyOnlyToIssueNames = new Set([
			// These are wired separately in quality-checks.ts (not via agentSafetyChecks array)
			"complexity",
			"no_test_file",
			"missing_return_types",
			"strong_typing",
			"console_statements",
			"silent_catches",
			"test_regressions",
			"phantom_imports",
			"unreachable_code",
			"sql_injection",
			"query_in_loop",
			"await_in_loop",
			"export_ripple",
			"large_files",
			"json_validity",
			"suppressions",
			"undocumented_env_vars",
			"mock_drift",
			"incomplete_renames",
			"css_syntax",
			"sql_syntax",
			"package_json_consistency",
			"schema_drift",
			"pii_detection",
			// Placeholder-test detector: see note in VERIFY_ONLY_CHECKS above.
			"placeholder_test",
		]);

		const missing: string[] = [];
		for (const name of verifyCheckNames) {
			if (
				!safetyCheckSet.has(name) &&
				!verifyOnlyToIssueNames.has(name) &&
				!VERIFY_ONLY_CHECKS.has(name)
			) {
				missing.push(name);
			}
		}
		expect(
			missing,
			`These verify toIssues() checks have no matching agentSafetyCheck:\n${missing.join("\n")}\n\nAdd to quality-checks.ts agentSafetyChecks array or document as exception.`,
		).toEqual([]);
	});

	it("verify.ts CodeQualityResults interface has a property for every toIssues check name", () => {
		const interfaceProps = extractResultsInterfaceProps(verifySource);
		const missing: string[] = [];
		const toIssuesNames = extractVerifyCheckNames(verifySource);

		// Some toIssues names map to non-standard camelCase property names
		const TOISSUES_TO_PROP: Record<string, string> = {
			self_import: "selfImports",
			non_null_assertion: "nonNullAssertions",
			extraneous_deps: "extraneousDeps",
			no_test_file: "noTestFile",
			// `silent_promise_catch` (registry id) maps to `silentPromiseSwallow`
			// (property name) — the property tracks the underlying detector
			// `checkSilentPromiseSwallow` rather than the registry id.
			silent_promise_catch: "silentPromiseSwallow",
			// UBS Plan 04 ids carry the `ubs_` prefix in registry/toIssues, but
			// per Plan 04 §"Phase matrix" the resultsPropName is the bare camel
			// form (e.g. `floatEquality` not `ubsFloatEquality`).
			ubs_js_loose_equality: "jsLooseEquality",
			ubs_float_equality: "floatEquality",
			ubs_java_optional_get: "javaOptionalGet",
			ubs_division_by_variable: "divisionByVariable",
			ubs_mutex_lock_unwrap: "mutexLockUnwrap",
			ubs_subprocess_shell_true: "subprocessShellTrue",
			ubs_tls_verify_disabled: "tlsVerifyDisabled",
			ubs_py_none_equality: "pyNoneEquality",
			ubs_weak_hash: "weakHash",
			// Plan 04 D.1 partial
			ubs_eval_input_tainted: "evalInputTainted",
			ubs_sql_string_concat: "sqlStringConcat",
			ubs_python_mutable_default_arg: "pyMutableDefaultArg",
			// Plan 04 D.1 backlog (17 of 20)
			ubs_tempfile_mktemp_race: "tempfileMktempRace",
			ubs_pickle_untrusted_load: "pickleUntrustedLoad",
			ubs_xml_external_entity: "xmlExternalEntity",
			ubs_os_system_tainted: "osSystemTainted",
			ubs_unsafe_format_string: "unsafeFormatString",
			ubs_unchecked_redirect: "uncheckedRedirect",
			ubs_goroutine_no_waitgroup: "goroutineNoWaitgroup",
			ubs_defer_in_loop: "deferInLoop",
			ubs_string_concat_in_loop: "ubsStringConcatInLoop",
			ubs_numeric_comparison_chain: "numericComparisonChain",
			ubs_print_debug_leak: "printDebugLeak",
			ubs_hardcoded_localhost: "ubsHardcodedLocalhost",
			ubs_magic_number_no_const: "magicNumberNoConst",
			ubs_large_function: "largeFunction",
			ubs_deeply_nested_callback: "deeplyNestedCallback",
			ubs_time_format_locale_dep: "timeFormatLocaleDep",
			ubs_regex_in_loop_no_compile: "regexInLoopNoCompile",
		};

		for (const name of toIssuesNames) {
			const override = TOISSUES_TO_PROP[name];
			const camelCase = override ?? name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
			if (!interfaceProps.has(camelCase) && !interfaceProps.has(name)) {
				missing.push(`${name} (expected property: ${camelCase})`);
			}
		}
		expect(
			missing,
			`These toIssues checks have no matching CodeQualityResults property:\n${missing.join("\n")}`,
		).toEqual([]);
	});

	it("verify.ts streamCqSection covers every CodeQualityResults property", () => {
		const interfaceProps = extractResultsInterfaceProps(verifySource);
		const streamProps = extractStreamSectionNames(verifySource);

		// Some properties are rendered via custom logic, not streamCqSection
		const CUSTOM_RENDERED = new Set([
			"undocumentedEnvVars", // Rendered with special env-var grouping
			"suppressions", // Rendered in suppression summary section
		]);

		const missing: string[] = [];
		for (const prop of interfaceProps) {
			if (!streamProps.has(prop) && !CUSTOM_RENDERED.has(prop)) {
				missing.push(prop);
			}
		}
		expect(
			missing,
			`These CodeQualityResults properties have no streamCqSection() call:\n${missing.join("\n")}`,
		).toEqual([]);
	});

	it("verify.ts outputJson destructures every CodeQualityResults property", () => {
		const interfaceProps = extractResultsInterfaceProps(verifySource);
		const jsonProps = extractJsonOutputProps(verifySource);

		// Agent safety checks are currently aggregated under a single "agent_checks"
		// key in JSON output rather than destructured individually.
		// TODO: These should be individually included in JSON output for tooling.
		const AGGREGATED_IN_JSON = new Set([
			"misusedPromises",
			"floatingPromises",
			"broadObjectTypes",
			"booleanTrap",
			"sameTypedPrimitiveParams",
			"commentClaimsLimitNoGuard",
			"commentClaimsNullThrowsInstead",
			"commentClaimsValidationMissing",
			"commentClaimsIdempotentMutates",
			"commentClaimsThrowsDoesnt",
			"iteratorInvalidation",
			"freshCollectionKeyLookup",
			"discriminatedUnionExhaustiveness",
			"indexBoundsUnchecked",
			"cleanupSkippedOnEarlyExit",
			"taintedToPrivilegedSink",
			"awaitStateToctou",
			"cleanupReentrancy",
			"boundaryCopyNoRevalidation",
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
			"unvalidatedJsonBoundary",
			"deadExports",
			"circularImports",
			"lifecycleCleanup",
			"defaultExport",
			"codeClones",
			"requireAwait",
			"accumulatingSpread",
			"excessiveUseState",
			// C/C++ checks (PostToolUse only, pending registry refactor)
			"cUnsafeFunctions",
			"cIncludeGuard",
			"cSprintfUsage",
			// UBS Plan 04 — rows 22–30. Each is destructured into its own
			// summary key in outputJson (`ubs_*`), so the parity test does
			// not strictly require them in this set, but listing them keeps
			// the bookkeeping explicit when downstream tooling adds them as
			// individual JSON-output fields.
			"jsLooseEquality",
			"floatEquality",
			"javaOptionalGet",
			"divisionByVariable",
			"mutexLockUnwrap",
			"subprocessShellTrue",
			"tlsVerifyDisabled",
			"pyNoneEquality",
			"weakHash",
			"evalInputTainted",
			"sqlStringConcat",
			"pyMutableDefaultArg",
			// D.1 backlog
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
			// Batches 1, 2, 5, 8: now individually destructured in
			// outputJson; no longer aggregated. Kept here as a comment for
			// the bookkeeping trail.
		]);

		const missing: string[] = [];
		for (const prop of interfaceProps) {
			if (!jsonProps.has(prop) && !AGGREGATED_IN_JSON.has(prop)) {
				missing.push(prop);
			}
		}
		expect(
			missing,
			`These CodeQualityResults properties are not destructured in outputJson():\n${missing.join("\n")}\n\nAdd them to the outputJson destructuring and JSON output object.`,
		).toEqual([]);
	});

	it("no check functions are imported but unused in quality-checks.ts", () => {
		// Every imported check function should either:
		// 1. Appear in the agentSafetyChecks array (fn: () => checkXxx(...))
		// 2. Be called elsewhere in the file (e.g., checkFunctionComplexity, checkLargeFile)
		// 3. Be used transitively via check-registry.ts (imported there and wired into CHECK_REGISTRY)
		const unused: string[] = [];
		// Combined source: quality-checks.ts + check-registry.ts (for transitive usage)
		const combinedSource = `${qualitySource}\n${registrySource}`;
		for (const name of qcImports) {
			// Count occurrences beyond the import statement
			const importPattern = new RegExp(`\\b${name}\\b`, "g");
			const matches = combinedSource.match(importPattern);
			// Should appear at least twice: once in import, once in usage
			if (!matches || matches.length < 2) {
				unused.push(name);
			}
		}
		expect(
			unused,
			`These check functions are imported in quality-checks.ts but never used:\n${unused.join("\n")}\n\nRemove the unused import or wire the check into the pipeline.`,
		).toEqual([]);
	});

	it("no check functions are imported but unused in verify.ts", () => {
		const unused: string[] = [];
		for (const name of verifyImports) {
			const importPattern = new RegExp(`\\b${name}\\b`, "g");
			const matches = verifySource.match(importPattern);
			if (!matches || matches.length < 2) {
				unused.push(name);
			}
		}
		expect(
			unused,
			`These check functions are imported in verify.ts but never used:\n${unused.join("\n")}\n\nRemove the unused import or wire the check into the pipeline.`,
		).toEqual([]);
	});
});
