// ===========================================
// JSON output formatter
// ===========================================
// Single entry point `outputJson` writes a consolidated JSON object to stdout.
// Structure is load-bearing — downstream tooling (CI, parity tests, test
// fixtures) reads the top-level keys. When adding a new check, append a new
// key here AND in `streaming-output.ts`.

import type { ProjectSetupIssue } from "../../harness/generic-checks.js";
import type { Finding } from "../../harness/suggestion-scorer.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { AuditResult, CodeQualityResults, DiagnosticResult } from "./tool-results-types.js";

/** Row shape we care about for section summarization. */
interface FileKeyedRow {
	file: string;
}

/** Compact a list into the summary shape (issues count + sorted unique files). */
function summarize(list: readonly FileKeyedRow[]): JsonObject {
	return {
		issues: list.length,
		files: [...new Set(list.map((r) => r.file))].sort(),
	};
}

/** Same as summarize, but includes the raw details array. */
function summarizeWithDetails(list: readonly FileKeyedRow[]): JsonObject {
	return {
		...summarize(list),
		details: list,
	};
}

interface OutputJsonArgs {
	tscResults: DiagnosticResult[];
	linterResults: DiagnosticResult[];
	linterName: string;
	semgrepResults: DiagnosticResult[];
	gitleaksResults: DiagnosticResult[];
	auditResult: AuditResult | null;
	cq: CodeQualityResults;
	suggestions: Map<string, Finding[]> | null;
	totalFiles: number;
	setupIssues?: ProjectSetupIssue[];
	structureSection?: JsonObject;
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Serialize a verify run to stdout as a single JSON object. Exit-code side
 * effects live in the caller.
 */
export function outputJson(args: OutputJsonArgs): void {
	const {
		tscResults,
		linterResults,
		linterName,
		semgrepResults,
		gitleaksResults,
		auditResult,
		cq,
		suggestions,
		totalFiles,
		setupIssues,
		structureSection,
	} = args;

	const result: JsonObject = {
		files_scanned: totalFiles,
		project_setup: {
			issues: setupIssues?.length ?? 0,
			details:
				setupIssues?.map((i) => ({ file: i.file, message: i.message, fix: i.fix })) ?? [],
		},
		tsc: summarizeWithDetails(tscResults),
		[linterName]: summarizeWithDetails(linterResults),
		semgrep: {
			findings: semgrepResults.length,
			files: [...new Set(semgrepResults.map((r) => r.file))].sort(),
			details: semgrepResults,
		},
		gitleaks: {
			secrets: gitleaksResults.length,
			files: [...new Set(gitleaksResults.map((r) => r.file))].sort(),
			details: gitleaksResults,
		},
		dependency_audit: auditResult
			? {
					vulnerabilities: auditResult.total,
					critical: auditResult.critical,
					high: auditResult.high,
					moderate: auditResult.moderate,
					low: auditResult.low,
					tool: auditResult.tool,
				}
			: { vulnerabilities: 0 },
		strong_typing: summarizeWithDetails(cq.strongTyping),
		suppressions: summarizeWithDetails(cq.suppressions),
		large_files: summarizeWithDetails(cq.largeFiles),
		json_validity: summarizeWithDetails(cq.jsonValidity),
		phantom_imports: summarizeWithDetails(cq.phantomImports),
		console_statements: summarize(cq.consoleStatements),
		silent_catches: summarize(cq.silentCatches),
		test_regressions: summarize(cq.testRegressions),
		undocumented_env_vars: summarize(cq.undocumentedEnvVars),
		mock_drift: summarize(cq.mockDrift),
		incomplete_renames: summarize(cq.incompleteRenames),
		missing_return_types: summarize(cq.missingReturnTypes),
		no_test_file: summarize(cq.noTestFile),
		complexity: summarize(cq.complexity),
		crap: summarizeWithDetails(cq.crap),
		export_ripple: summarize(cq.exportRipple),
		excessive_use_state: summarize(cq.excessiveUseState),
		dangerously_set_inner_html: summarize(cq.dangerouslySetInnerHtml),
		direct_dom_access: summarize(cq.directDomAccess),
		inline_object_props: summarize(cq.inlineObjectProps),
		async_event_handler: summarize(cq.asyncEventHandler),
		nested_ternaries: summarize(cq.nestedTernaries),
		catch_and_log: summarize(cq.catchAndLog),
		json_parse_unsafe: summarize(cq.jsonParseUnsafe),
		hardcoded_timeout: summarize(cq.hardcodedTimeout),
		disabled_tests: summarize(cq.disabledTests),
		placeholder_test: summarizeWithDetails(cq.placeholderTest),
		suppression_hygiene: summarizeWithDetails(cq.suppressionHygiene),
		target_blank_no_rel: summarize(cq.targetBlankNoRel),
		snapshot_overuse: summarize(cq.snapshotOveruse),
		test_importing_test: summarize(cq.testImportingTest),
		excessive_use_effect: summarize(cq.excessiveUseEffect),
		sequential_awaits: summarize(cq.sequentialAwaits),
		index_as_key: summarize(cq.indexAsKey),
		missing_effect_cleanup: summarize(cq.missingEffectCleanup),
		over_mocking: summarize(cq.overMocking),
		focused_tests: summarizeWithDetails(cq.focusedTests),
		migration_ordering: summarizeWithDetails(cq.migrationOrdering),
		sql_schema_consistency: summarizeWithDetails(cq.sqlSchemaConsistency),
		visibility_filter_missing: summarizeWithDetails(cq.visibilityFilterMissing),
		pii_detection: summarizeWithDetails(cq.piiDetection),
		assertion_free_test: summarizeWithDetails(cq.assertionFreeTest),
		tautological_assertion: summarizeWithDetails(cq.tautologicalAssertion),
		mocking_the_sut: summarizeWithDetails(cq.mockingTheSut),
		private_member_test_access: summarizeWithDetails(cq.privateMemberTestAccess),
		loop_nesting_depth: summarizeWithDetails(cq.loopNestingDepth),
		else_if_chain: summarizeWithDetails(cq.elseIfChain),
		duplicate_switch_discriminant: summarizeWithDetails(cq.duplicateSwitchDiscriminant),
		hybrid_class: summarizeWithDetails(cq.hybridClass),
		fuzzy_responsibility_name: summarizeWithDetails(cq.fuzzyResponsibilityName),
		law_of_demeter: summarizeWithDetails(cq.lawOfDemeter),
		flag_argument: summarizeWithDetails(cq.flagArgument),
		commented_out_code: summarizeWithDetails(cq.commentedOutCode),
		conditional_in_test: summarizeWithDetails(cq.conditionalInTest),
		non_deterministic_test: summarizeWithDetails(cq.nonDeterministicTest),
		empty_catch: summarizeWithDetails(cq.emptyCatch),
		test_without_description: summarizeWithDetails(cq.testWithoutDescription),
		assertion_roulette: summarizeWithDetails(cq.assertionRoulette),
		magic_number: summarizeWithDetails(cq.magicNumber),
		function_arg_count: summarizeWithDetails(cq.functionArgCount),
		data_clump: summarizeWithDetails(cq.dataClump),
		duplicate_describe: summarizeWithDetails(cq.duplicateDescribe),
		cross_file_switch_discriminant: summarizeWithDetails(cq.crossFileSwitchDiscriminant),
		single_implementation_interface: summarizeWithDetails(cq.singleImplementationInterface),
		files_without_test: summarizeWithDetails(cq.filesWithoutTest),
		project_loc_ratio: {
			issues: cq.projectLocRatio.length,
			files: [],
			details: cq.projectLocRatio,
		},
	};

	if (suggestions) {
		const suggObj: Record<string, unknown[]> = {};
		for (const [file, findings] of suggestions.entries()) {
			suggObj[file] = findings;
		}
		result.suggestions = suggObj;
	}
	if (structureSection) {
		result.structure = structureSection;
	}
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
