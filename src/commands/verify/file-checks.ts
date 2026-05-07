// ===========================================
// Per-file check battery
// ===========================================
// Applies every generic + taste check to a single file's content and
// appends findings to the shared `CodeQualityResults`. This is the bulk of
// `runCodeQualityChecks` — extracted into its own module so `tool-results.ts`
// stays under the 800-line file-size threshold.

import { existsSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";

import {
	checkAccumulatingSpread,
	checkAgentThumbprintProse,
	checkAsyncEventHandler,
	checkAsyncPromiseExecutor,
	checkBooleanTrap,
	checkBroadObjectTypes,
	checkCatchAndLog,
	checkCircularImports,
	checkConsoleDebug,
	checkConstantCondition,
	checkDangerouslySetInnerHTML,
	checkDeadBranchLiteral,
	checkDeadExports,
	checkDeeplyNestedCallback,
	checkDemoDataUnmarked,
	checkDemoRuntimeMissingBanner,
	checkDuplicateTestNames,
	checkEmptyBodyHandler,
	checkDefaultExport,
	checkDeferInLoop,
	checkDirectDomAccess,
	checkDisabledTests,
	checkDivisionByVariable,
	checkDoubleCastUnknown,
	checkEvalUsage,
	checkExcessiveUseEffect,
	checkExcessiveUseState,
	checkExportRipple,
	checkExtraneousDependencies,
	checkFetchWithoutTimeout,
	checkFileLevelSuppression,
	checkFloatEquality,
	checkFloatingPromises,
	checkFocusedTests,
	checkFunctionComplexity,
	checkGoroutineNoWaitgroup,
	checkHardcodedTimeout,
	checkHardcodedTimeoutInTests,
	checkIndexAsKey,
	checkInlineObjectProps,
	checkInnerHtmlUsage,
	checkJavaOptionalGet,
	checkJsLooseEquality,
	checkJsonParseUnsafe,
	checkLargeFile,
	checkLargeFunction,
	checkListenerPairing,
	checkMigrationParity,
	checkLifecycleCleanup,
	checkLossyErrorRethrow,
	checkMagicLiteralInConditional,
	checkMagicNumberNoConst,
	checkMigrationOrdering,
	checkMissingEffectCleanup,
	checkMissingReturnTypes,
	checkMisusedPromises,
	checkMockingTheSutSelf,
	checkMutexLockUnwrap,
	checkNanComparison,
	checkNestedTernaries,
	checkNodeEnvBranchInProd,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkNumericComparisonChain,
	checkOsSystemTainted,
	checkOverMocking,
	checkPickleUntrustedLoad,
	checkPiiInSource,
	checkPlaceholderTests,
	checkPrintDebugLeak,
	checkPromiseRejectNonError,
	checkEvalInputTainted,
	checkPyMutableDefaultArg,
	checkPyNoneEquality,
	checkRealIoInTests,
	checkRegexInLoopNoCompile,
	checkRequireAwait,
	checkSchemaTypeDrift,
	checkSelfImport,
	checkSequentialAwaits,
	checkSilentCatch,
	checkSilentDemoFallback,
	checkSilentPromiseSwallow,
	checkSnapshotOveruse,
	checkSqlSchemaConsistency,
	checkSqlStringConcat,
	checkStubNotImplementedThrow,
	checkSubprocessShellTrue,
	checkSyncIoOnHotPath,
	checkTargetBlankNoRel,
	checkTempfileMktempRace,
	checkTestFileExists,
	checkTestImportingTest,
	checkTestMissingSutImport,
	checkTestNondeterminism,
	checkTestRegressions,
	checkThrowLiteral,
	checkTimeFormatLocaleDep,
	checkTlsVerifyDisabled,
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkLoggerFormatUserInput,
	checkMixedSyncAsyncFileApi,
	checkUbsHardcodedLocalhost,
	checkUbsStringConcatInLoop,
	checkUnboundedPromiseAll,
	checkUncheckedRedirect,
	checkUnionWidenedWithString,
	checkUnsafeFormatString,
	checkUnsafeOptionalChaining,
	checkUntestableTimeInSource,
	checkUnvalidatedJsonBoundary,
	checkVisibilityFilterMissing,
	checkWeakHash,
	checkXmlExternalEntity,
	extractEnvReferences,
	extractMockDefinitions,
} from "../../harness/generic-checks.js";
import { parseImports, resolveImportPath } from "../../harness/project-graph.js";
import { findAnyTypes } from "../../harness/quality-checks.js";
import {
	checkAssertionFreeTest,
	checkAssertionRoulette,
	checkCommentedOutCode,
	checkConditionalInTest,
	checkDataClump,
	checkDuplicateDescribe,
	checkDuplicateSwitchDiscriminant,
	checkElseIfChain,
	checkEmptyCatch,
	checkFlagArgument,
	checkFunctionArgCount,
	checkFuzzyResponsibilityName,
	checkHybridClass,
	checkLawOfDemeter,
	checkLoopNestingDepth,
	checkMagicNumber,
	checkMockingTheSUT,
	checkNonDeterministicTest,
	checkPrivateMemberTestAccess,
	checkTautologicalAssertion,
	checkTestWithoutDescription,
} from "../../harness/taste-checks.js";
import { computeCrap } from "../../harness/checks/crap.js";
import { computeCyclomaticComplexity } from "../../harness/checks/cyclomatic.js";
import {
	coverageForFile,
	loadCoverageFinal,
} from "../../harness/coverage-final-reader.js";
import { JS_TS_EXTS, LARGE_FILE_THRESHOLD } from "./advisory.js";
import { collectSuppressionFindings } from "./suppressions.js";
import type { CodeQualityIssue, CodeQualityResults } from "./tool-results-types.js";

const JSON_EXT = ".json";
const TS_EXT = ".ts";
const TSX_EXT = ".tsx";
const DTS_SUFFIX = ".d.ts";
const ANY_KIND = "any";
const JSON_PARSE_ERR_SLICE = 150;

/** Helper: convert InlineMatch[] from generic-checks into CodeQualityIssue[] */
function toIssues(
	check: string,
	file: string,
	matches: Array<{ line: number; text: string }>,
): CodeQualityIssue[] {
	return matches.map((m) => ({ check, file, line: m.line, message: m.text }));
}

interface MockDriftArgs {
	mocks: ReturnType<typeof extractMockDefinitions>;
	moduleExportsCache: Map<string, string[]>;
	file: string;
	relPath: string;
	cwd: string;
	out: CodeQualityIssue[];
}

/**
 * Compare mock definitions in a test file against the real module exports we
 * cached earlier, and emit a finding when a mock references a name that is
 * NOT exported.
 */
function collectMockDriftFindings(args: MockDriftArgs): void {
	const { mocks, moduleExportsCache, file, relPath, cwd, out } = args;
	for (const mock of mocks) {
		const resolved = resolveImportPath(file, mock.modulePath);
		if (!resolved) continue;
		const cachedExports = moduleExportsCache.get(resolved);
		if (!cachedExports) continue;
		const exportSet = new Set(cachedExports);
		const missing = mock.mockedNames.filter((name) => !exportSet.has(name));
		if (missing.length === 0) continue;
		for (const name of missing) {
			out.push({
				check: "mock_drift",
				file: relPath,
				line: mock.line,
				message: `mock references "${name}" which is not exported by "${relative(cwd, resolved)}"`,
			});
		}
	}
}

type PiiOpts = Parameters<typeof checkPiiInSource>[2];

interface RunFileChecksArgs {
	file: string;
	content: string;
	cwd: string;
	r: CodeQualityResults;
	moduleExportsCache: Map<string, string[]>;
	allEnvRefs: Map<string, Array<{ file: string; line: number }>>;
	piiOpts: PiiOpts;
}

/**
 * Public API — consumed by `tool-results.ts`.
 *
 * Run every per-file check against a single file. Mutates `r` in place.
 * Returns early for `.d.ts` files and for JSON files (after validating them).
 */
export function runPerFileChecks(args: RunFileChecksArgs): void {
	const { file, content, cwd, r, moduleExportsCache, allEnvRefs, piiOpts } = args;

	const ext = extname(file).toLowerCase();
	const relPath = relative(cwd, file);
	const isDts = file.endsWith(DTS_SUFFIX);

	// Large files
	if (!isDts) {
		const sizeCheck = checkLargeFile(content, LARGE_FILE_THRESHOLD);
		if (sizeCheck.exceeded) {
			r.largeFiles.push({
				check: "large_files",
				file: relPath,
				line: 0,
				message: `${sizeCheck.lines} lines — consider splitting into smaller, focused modules`,
			});
		}
	}

	// JSON validity
	if (ext === JSON_EXT) {
		try {
			JSON.parse(content);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			r.jsonValidity.push({
				check: "json_validity",
				file: relPath,
				line: 0,
				message: msg.slice(0, JSON_PARSE_ERR_SLICE),
			});
		}
		return;
	}

	if (isDts) return;

	// Strong typing — shared findAnyTypes (non-test only)
	const base = basename(file, ext);
	const isTest = base.endsWith(".test") || base.endsWith(".spec") || file.includes("__tests__");
	if (!isTest && (ext === TS_EXT || ext === TSX_EXT)) {
		for (const m of findAnyTypes(content)) {
			if (m.kind === ANY_KIND) {
				r.strongTyping.push({
					check: "strong_typing",
					file: relPath,
					line: m.line,
					message: m.text,
				});
			}
		}
	}

	r.consoleStatements.push(
		...toIssues("console_statements", relPath, checkConsoleDebug(content, file)),
	);
	r.silentCatches.push(...toIssues("silent_catches", relPath, checkSilentCatch(content, file)));

	if (JS_TS_EXTS.has(ext)) {
		collectSuppressionFindings(content, relPath, r.suppressions);
	}

	// Phantom imports
	if (JS_TS_EXTS.has(ext)) {
		for (const imp of parseImports(content, file)) {
			if (!imp.specifier.startsWith(".") && !imp.specifier.startsWith("/")) continue;
			if (imp.specifier.endsWith(JSON_EXT)) continue;
			if (!resolveImportPath(file, imp.specifier)) {
				r.phantomImports.push({
					check: "phantom_imports",
					file: relPath,
					line: 0,
					message: `imports "${imp.specifier}" which does not resolve to any file`,
				});
			}
		}
	}

	const testResult = checkTestRegressions(content, file);
	if (testResult.skipped.length > 0) {
		r.testRegressions.push(...toIssues("test_regressions", relPath, testResult.skipped));
	}

	for (const ref of extractEnvReferences(content, file)) {
		const entry = allEnvRefs.get(ref.name) || [];
		entry.push({ file: relPath, line: ref.line });
		allEnvRefs.set(ref.name, entry);
	}

	if (JS_TS_EXTS.has(ext)) {
		const mocks = extractMockDefinitions(content, file);
		collectMockDriftFindings({
			mocks,
			moduleExportsCache,
			file,
			relPath,
			cwd,
			out: r.mockDrift,
		});
	}

	r.missingReturnTypes.push(
		...toIssues("missing_return_types", relPath, checkMissingReturnTypes(content, file)),
	);
	r.noTestFile.push(...toIssues("no_test_file", relPath, checkTestFileExists(file)));
	r.complexity.push(...toIssues("complexity", relPath, checkFunctionComplexity(content, file)));

	// CRAP (Change Risk Anti-Patterns) — complexity × coverage composite.
	// Fail-open when coverage-final.json is absent: emits no findings.
	{
		const coveragePath = resolve(cwd, "coverage", "coverage-final.json");
		const covCache = loadCoverageFinal(coveragePath, cwd);
		const perFile = covCache ? coverageForFile(covCache, relPath) : undefined;
		if (perFile !== undefined) {
			const complexities = computeCyclomaticComplexity(content, file);
			const fileMtime = existsSync(file) ? statSync(file).mtimeMs : 0;
			const findings = computeCrap({
				complexities,
				coverage: perFile.functions,
				filePath: relPath,
				fileMtime,
				coverageMtime: perFile.mtime,
				threshold: 30,
				staleTolerance: "tag",
			});
			r.crap.push(
				...findings.map((f) => ({
					check: "crap",
					file: relPath,
					line: f.line,
					message: `${f.function}: CRAP=${f.crap_score.toFixed(0)} (cyc=${f.complexity}, cov=${f.coverage_pct.toFixed(0)}%)${f.stale ? " [stale coverage]" : ""}`,
				})),
			);
		}
	}

	r.exportRipple.push(
		...toIssues("export_ripple", relPath, checkExportRipple(content, file, cwd)),
	);
	r.deadExports.push(...toIssues("dead_exports", relPath, checkDeadExports(content, file, cwd)));
	r.circularImports.push(
		...toIssues("circular_imports", relPath, checkCircularImports(content, file, cwd)),
	);
	r.lifecycleCleanup.push(
		...toIssues("lifecycle_cleanup", relPath, checkLifecycleCleanup(content, file)),
	);
	r.defaultExport.push(...toIssues("default_export", relPath, checkDefaultExport(content, file)));

	// --- Agent safety checks ---
	r.misusedPromises.push(
		...toIssues("misused_promises", relPath, checkMisusedPromises(content, file)),
	);
	r.floatingPromises.push(
		...toIssues("floating_promises", relPath, checkFloatingPromises(content, file)),
	);
	r.broadObjectTypes.push(
		...toIssues("broad_object_types", relPath, checkBroadObjectTypes(content, file)),
	);
	r.booleanTrap.push(...toIssues("boolean_trap", relPath, checkBooleanTrap(content, file)));
	r.magicLiteralInConditional.push(
		...toIssues(
			"magic_literal_in_conditional",
			relPath,
			checkMagicLiteralInConditional(content, file),
		),
	);
	r.asyncPromiseExecutor.push(
		...toIssues("async_promise_executor", relPath, checkAsyncPromiseExecutor(content, file)),
	);
	r.selfImports.push(...toIssues("self_import", relPath, checkSelfImport(content, file)));
	r.extraneousDeps.push(
		...toIssues("extraneous_deps", relPath, checkExtraneousDependencies(content, file)),
	);
	r.nonNullAssertions.push(
		...toIssues("non_null_assertion", relPath, checkNonNullAssertions(content, file)),
	);
	r.evalUsage.push(...toIssues("eval_usage", relPath, checkEvalUsage(content, file)));
	r.innerHtml.push(...toIssues("inner_html", relPath, checkInnerHtmlUsage(content, file)));
	r.nanComparison.push(...toIssues("nan_comparison", relPath, checkNanComparison(content, file)));
	r.constantCondition.push(
		...toIssues("constant_condition", relPath, checkConstantCondition(content, file)),
	);
	r.unsafeOptionalChaining.push(
		...toIssues(
			"unsafe_optional_chaining",
			relPath,
			checkUnsafeOptionalChaining(content, file),
		),
	);
	r.numberPrecisionLoss.push(
		...toIssues("number_precision_loss", relPath, checkNumberPrecisionLoss(content, file)),
	);
	r.throwLiteral.push(...toIssues("throw_literal", relPath, checkThrowLiteral(content, file)));
	r.promiseRejectNonError.push(
		...toIssues("promise_reject_non_error", relPath, checkPromiseRejectNonError(content, file)),
	);
	r.lossyErrorRethrow.push(
		...toIssues("lossy_error_rethrow", relPath, checkLossyErrorRethrow(content, file)),
	);
	r.silentPromiseSwallow.push(
		...toIssues("silent_promise_catch", relPath, checkSilentPromiseSwallow(content, file)),
	);
	r.requireAwait.push(...toIssues("require_await", relPath, checkRequireAwait(content, file)));
	r.accumulatingSpread.push(
		...toIssues("accumulating_spread", relPath, checkAccumulatingSpread(content, file)),
	);

	// --- 13 additional agent safety checks ---
	r.excessiveUseState.push(
		...toIssues("excessive_use_state", relPath, checkExcessiveUseState(content, file)),
	);
	r.dangerouslySetInnerHtml.push(
		...toIssues(
			"dangerously_set_inner_html",
			relPath,
			checkDangerouslySetInnerHTML(content, file),
		),
	);
	r.directDomAccess.push(
		...toIssues("direct_dom_access", relPath, checkDirectDomAccess(content, file)),
	);
	r.inlineObjectProps.push(
		...toIssues("inline_object_props", relPath, checkInlineObjectProps(content, file)),
	);
	r.asyncEventHandler.push(
		...toIssues("async_event_handler", relPath, checkAsyncEventHandler(content, file)),
	);
	r.nestedTernaries.push(
		...toIssues("nested_ternaries", relPath, checkNestedTernaries(content, file)),
	);
	r.catchAndLog.push(...toIssues("catch_and_log", relPath, checkCatchAndLog(content, file)));
	r.jsonParseUnsafe.push(
		...toIssues("json_parse_unsafe", relPath, checkJsonParseUnsafe(content, file)),
	);
	r.unvalidatedJsonBoundary.push(
		...toIssues(
			"unvalidated_json_boundary",
			relPath,
			checkUnvalidatedJsonBoundary(content, file),
		),
	);
	r.hardcodedTimeout.push(
		...toIssues("hardcoded_timeout", relPath, checkHardcodedTimeout(content, file)),
	);
	r.disabledTests.push(...toIssues("disabled_tests", relPath, checkDisabledTests(content, file)));
	r.placeholderTest.push(
		...toIssues("placeholder_test", relPath, checkPlaceholderTests(content, file)),
	);
	r.targetBlankNoRel.push(
		...toIssues("target_blank_no_rel", relPath, checkTargetBlankNoRel(content, file)),
	);
	r.snapshotOveruse.push(
		...toIssues("snapshot_overuse", relPath, checkSnapshotOveruse(content, file)),
	);
	r.testImportingTest.push(
		...toIssues("test_importing_test", relPath, checkTestImportingTest(content, file)),
	);

	// --- 5 additional agent safety checks ---
	r.excessiveUseEffect.push(
		...toIssues("excessive_use_effect", relPath, checkExcessiveUseEffect(content, file)),
	);
	r.sequentialAwaits.push(
		...toIssues("sequential_awaits", relPath, checkSequentialAwaits(content, file)),
	);
	r.indexAsKey.push(...toIssues("index_as_key", relPath, checkIndexAsKey(content, file)));
	r.missingEffectCleanup.push(
		...toIssues("missing_effect_cleanup", relPath, checkMissingEffectCleanup(content, file)),
	);
	r.overMocking.push(...toIssues("over_mocking", relPath, checkOverMocking(content, file)));

	// --- Coding-agent feedback checks ---
	r.focusedTests.push(...toIssues("focused_tests", relPath, checkFocusedTests(content, file)));
	r.migrationOrdering.push(
		...toIssues("migration_ordering", relPath, checkMigrationOrdering(content, file)),
	);
	r.sqlSchemaConsistency.push(
		...toIssues("sql_schema_consistency", relPath, checkSqlSchemaConsistency(content, file)),
	);
	r.visibilityFilterMissing.push(
		...toIssues(
			"visibility_filter_missing",
			relPath,
			checkVisibilityFilterMissing(content, file),
		),
	);

	// PII detection
	r.piiDetection.push(
		...toIssues("pii_detection", relPath, checkPiiInSource(content, file, piiOpts)),
	);

	// --- Taste checks ---
	r.assertionFreeTest.push(
		...toIssues("assertion_free_test", relPath, checkAssertionFreeTest(content, file)),
	);
	r.tautologicalAssertion.push(
		...toIssues("tautological_assertion", relPath, checkTautologicalAssertion(content, file)),
	);
	r.mockingTheSut.push(
		...toIssues("mocking_the_sut", relPath, checkMockingTheSUT(content, file)),
	);
	r.privateMemberTestAccess.push(
		...toIssues(
			"private_member_test_access",
			relPath,
			checkPrivateMemberTestAccess(content, file),
		),
	);
	r.loopNestingDepth.push(
		...toIssues("loop_nesting_depth", relPath, checkLoopNestingDepth(content, file)),
	);
	r.elseIfChain.push(...toIssues("else_if_chain", relPath, checkElseIfChain(content, file)));
	r.duplicateSwitchDiscriminant.push(
		...toIssues(
			"duplicate_switch_discriminant",
			relPath,
			checkDuplicateSwitchDiscriminant(content, file),
		),
	);
	r.hybridClass.push(...toIssues("hybrid_class", relPath, checkHybridClass(content, file)));
	r.fuzzyResponsibilityName.push(
		...toIssues(
			"fuzzy_responsibility_name",
			relPath,
			checkFuzzyResponsibilityName(content, file),
		),
	);
	r.lawOfDemeter.push(...toIssues("law_of_demeter", relPath, checkLawOfDemeter(content, file)));
	r.flagArgument.push(...toIssues("flag_argument", relPath, checkFlagArgument(content, file)));
	r.commentedOutCode.push(
		...toIssues("commented_out_code", relPath, checkCommentedOutCode(content, file)),
	);
	r.conditionalInTest.push(
		...toIssues("conditional_in_test", relPath, checkConditionalInTest(content, file)),
	);
	r.nonDeterministicTest.push(
		...toIssues("non_deterministic_test", relPath, checkNonDeterministicTest(content, file)),
	);
	r.emptyCatch.push(...toIssues("empty_catch", relPath, checkEmptyCatch(content, file)));
	r.testWithoutDescription.push(
		...toIssues(
			"test_without_description",
			relPath,
			checkTestWithoutDescription(content, file),
		),
	);
	r.assertionRoulette.push(
		...toIssues("assertion_roulette", relPath, checkAssertionRoulette(content, file)),
	);
	r.magicNumber.push(...toIssues("magic_number", relPath, checkMagicNumber(content, file)));
	r.functionArgCount.push(
		...toIssues("function_arg_count", relPath, checkFunctionArgCount(content, file)),
	);
	r.dataClump.push(...toIssues("data_clump", relPath, checkDataClump(content, file)));
	r.duplicateDescribe.push(
		...toIssues("duplicate_describe", relPath, checkDuplicateDescribe(content, file)),
	);

	// === UBS Plan 04 — rows 27–30 ===
	r.jsLooseEquality.push(
		...toIssues("ubs_js_loose_equality", relPath, checkJsLooseEquality(content, file)),
	);
	r.floatEquality.push(
		...toIssues("ubs_float_equality", relPath, checkFloatEquality(content, file)),
	);
	r.javaOptionalGet.push(
		...toIssues("ubs_java_optional_get", relPath, checkJavaOptionalGet(content, file)),
	);
	r.divisionByVariable.push(
		...toIssues(
			"ubs_division_by_variable",
			relPath,
			checkDivisionByVariable(content, file),
		),
	);

	// === UBS Plan 04 — rows 22–26 (critical-tier) ===
	r.mutexLockUnwrap.push(
		...toIssues("ubs_mutex_lock_unwrap", relPath, checkMutexLockUnwrap(content, file)),
	);
	r.subprocessShellTrue.push(
		...toIssues(
			"ubs_subprocess_shell_true",
			relPath,
			checkSubprocessShellTrue(content, file),
		),
	);
	r.tlsVerifyDisabled.push(
		...toIssues("ubs_tls_verify_disabled", relPath, checkTlsVerifyDisabled(content, file)),
	);
	r.pyNoneEquality.push(
		...toIssues("ubs_py_none_equality", relPath, checkPyNoneEquality(content, file)),
	);
	r.weakHash.push(...toIssues("ubs_weak_hash", relPath, checkWeakHash(content, file)));
	// Plan 04 D.1 partial — high-leverage backlog
	r.evalInputTainted.push(
		...toIssues(
			"ubs_eval_input_tainted",
			relPath,
			checkEvalInputTainted(content, file),
		),
	);
	r.sqlStringConcat.push(
		...toIssues("ubs_sql_string_concat", relPath, checkSqlStringConcat(content, file)),
	);
	r.pyMutableDefaultArg.push(
		...toIssues(
			"ubs_python_mutable_default_arg",
			relPath,
			checkPyMutableDefaultArg(content, file),
		),
	);
	// Plan 04 D.1 backlog (17 of 20)
	r.tempfileMktempRace.push(
		...toIssues(
			"ubs_tempfile_mktemp_race",
			relPath,
			checkTempfileMktempRace(content, file),
		),
	);
	r.pickleUntrustedLoad.push(
		...toIssues(
			"ubs_pickle_untrusted_load",
			relPath,
			checkPickleUntrustedLoad(content, file),
		),
	);
	r.xmlExternalEntity.push(
		...toIssues(
			"ubs_xml_external_entity",
			relPath,
			checkXmlExternalEntity(content, file),
		),
	);
	r.osSystemTainted.push(
		...toIssues("ubs_os_system_tainted", relPath, checkOsSystemTainted(content, file)),
	);
	r.unsafeFormatString.push(
		...toIssues(
			"ubs_unsafe_format_string",
			relPath,
			checkUnsafeFormatString(content, file),
		),
	);
	r.uncheckedRedirect.push(
		...toIssues(
			"ubs_unchecked_redirect",
			relPath,
			checkUncheckedRedirect(content, file),
		),
	);
	r.goroutineNoWaitgroup.push(
		...toIssues(
			"ubs_goroutine_no_waitgroup",
			relPath,
			checkGoroutineNoWaitgroup(content, file),
		),
	);
	r.deferInLoop.push(
		...toIssues("ubs_defer_in_loop", relPath, checkDeferInLoop(content, file)),
	);
	r.ubsStringConcatInLoop.push(
		...toIssues(
			"ubs_string_concat_in_loop",
			relPath,
			checkUbsStringConcatInLoop(content, file),
		),
	);
	r.numericComparisonChain.push(
		...toIssues(
			"ubs_numeric_comparison_chain",
			relPath,
			checkNumericComparisonChain(content, file),
		),
	);
	r.printDebugLeak.push(
		...toIssues("ubs_print_debug_leak", relPath, checkPrintDebugLeak(content, file)),
	);
	r.ubsHardcodedLocalhost.push(
		...toIssues(
			"ubs_hardcoded_localhost",
			relPath,
			checkUbsHardcodedLocalhost(content, file),
		),
	);
	r.childProcessExecUserInput.push(
		...toIssues(
			"child_process_exec_user_input",
			relPath,
			checkChildProcessExecUserInput(content, file),
		),
	);
	r.mixedSyncAsyncFileApi.push(
		...toIssues(
			"mixed_sync_async_file_api",
			relPath,
			checkMixedSyncAsyncFileApi(content, file),
		),
	);
	r.cookieMissingSecurityFlags.push(
		...toIssues(
			"cookie_missing_security_flags",
			relPath,
			checkCookieMissingSecurityFlags(content, file),
		),
	);
	r.loggerFormatUserInput.push(
		...toIssues(
			"logger_format_user_input",
			relPath,
			checkLoggerFormatUserInput(content, file),
		),
	);
	r.magicNumberNoConst.push(
		...toIssues(
			"ubs_magic_number_no_const",
			relPath,
			checkMagicNumberNoConst(content, file),
		),
	);
	r.largeFunction.push(
		...toIssues("ubs_large_function", relPath, checkLargeFunction(content, file)),
	);
	r.deeplyNestedCallback.push(
		...toIssues(
			"ubs_deeply_nested_callback",
			relPath,
			checkDeeplyNestedCallback(content, file),
		),
	);
	r.timeFormatLocaleDep.push(
		...toIssues(
			"ubs_time_format_locale_dep",
			relPath,
			checkTimeFormatLocaleDep(content, file),
		),
	);
	r.regexInLoopNoCompile.push(
		...toIssues(
			"ubs_regex_in_loop_no_compile",
			relPath,
			checkRegexInLoopNoCompile(content, file),
		),
	);

	// === Batch 1: agent-laziness checks ===
	r.agentThumbprintProse.push(
		...toIssues("agent_thumbprint_prose", relPath, checkAgentThumbprintProse(content, file)),
	);
	r.stubNotImplementedThrow.push(
		...toIssues(
			"stub_not_implemented_throw",
			relPath,
			checkStubNotImplementedThrow(content, file),
		),
	);
	r.deadBranchLiteral.push(
		...toIssues("dead_branch_literal", relPath, checkDeadBranchLiteral(content, file)),
	);
	r.fileLevelSuppression.push(
		...toIssues("file_level_suppression", relPath, checkFileLevelSuppression(content, file)),
	);
	r.untestableTimeInSource.push(
		...toIssues(
			"untestable_time_in_source",
			relPath,
			checkUntestableTimeInSource(content, file),
		),
	);
	r.doubleCastUnknown.push(
		...toIssues("double_cast_unknown", relPath, checkDoubleCastUnknown(content, file)),
	);
	r.unionWidenedWithString.push(
		...toIssues(
			"union_widened_with_string",
			relPath,
			checkUnionWidenedWithString(content, file),
		),
	);
	r.nodeenvBranchInProd.push(
		...toIssues("nodeenv_branch_in_prod", relPath, checkNodeEnvBranchInProd(content, file)),
	);
	r.fetchWithoutTimeout.push(
		...toIssues("fetch_without_timeout", relPath, checkFetchWithoutTimeout(content, file)),
	);
	r.unboundedPromiseAll.push(
		...toIssues("unbounded_promise_all", relPath, checkUnboundedPromiseAll(content, file)),
	);
	r.syncIoOnHotPath.push(
		...toIssues("sync_io_on_hot_path", relPath, checkSyncIoOnHotPath(content, file)),
	);

	// === Batch 2: test-hygiene checks ===
	r.duplicateTestNames.push(
		...toIssues("duplicate_test_names", relPath, checkDuplicateTestNames(content, file)),
	);
	r.realIoInTests.push(
		...toIssues("real_io_in_tests", relPath, checkRealIoInTests(content, file)),
	);
	r.testNondeterminism.push(
		...toIssues("test_nondeterminism", relPath, checkTestNondeterminism(content, file)),
	);
	r.hardcodedTimeoutInTests.push(
		...toIssues(
			"hardcoded_timeout_in_tests",
			relPath,
			checkHardcodedTimeoutInTests(content, file),
		),
	);
	r.testMissingSutImport.push(
		...toIssues(
			"test_missing_sut_import",
			relPath,
			checkTestMissingSutImport(content, file),
		),
	);
	r.mockingTheSutSelf.push(
		...toIssues("mocking_the_sut_self", relPath, checkMockingTheSutSelf(content, file)),
	);

	// === Batch 5: cross-file checks ===
	r.emptyBodyHandler.push(
		...toIssues("empty_body_handler", relPath, checkEmptyBodyHandler(content, file)),
	);
	r.listenerPairing.push(
		...toIssues("listener_pairing", relPath, checkListenerPairing(content, file)),
	);
	r.schemaTypeDrift.push(
		...toIssues("schema_type_drift", relPath, checkSchemaTypeDrift(content, file)),
	);
	r.migrationParity.push(
		...toIssues("migration_parity", relPath, checkMigrationParity(content, file)),
	);

	// === Batch 8: demo-data checks ===
	r.demoDataUnmarked.push(
		...toIssues("demo_data_unmarked", relPath, checkDemoDataUnmarked(content, file)),
	);
	r.silentDemoFallback.push(
		...toIssues("silent_demo_fallback", relPath, checkSilentDemoFallback(content, file)),
	);
	r.demoRuntimeMissingBanner.push(
		...toIssues(
			"demo_runtime_missing_banner",
			relPath,
			checkDemoRuntimeMissingBanner(content, file),
		),
	);
}
