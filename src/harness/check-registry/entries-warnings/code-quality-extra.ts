// interlinked-tdd: exempt
// Second half of CODE_QUALITY_ENTRIES (React hooks hygiene, test hygiene, and SQL
// schema/visibility checks). Split out of code-quality.ts to stay under the per-file
// line cap; spread back into CODE_QUALITY_ENTRIES there. Moving code, no logic change.

import {
	detectArrayIterateeVariadicBuiltin,
	detectReturnArrayPush,
} from "../../checks/array-method-misuse.js";
import { detectPayloadFieldCasing } from "../../checks/payload-casing.js";
import {
	checkExcessiveUseEffect,
	checkFocusedTests,
	checkIndexAsKey,
	checkMigrationOrdering,
	checkMissingEffectCleanup,
	checkOverMocking,
	checkPlatformConditionalAssertion,
	checkSequentialAwaits,
	checkSilentDependencySkip,
	checkSqlSchemaConsistency,
	checkVisibilityFilterMissing,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const CODE_QUALITY_ENTRIES_EXTRA: CheckRegistration[] = [
	{
		id: "excessive_use_effect",
		phase: "post",
		name: "Excessive useEffect",
		description: "Detects components with too many useEffect hooks",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Too many useEffect hooks. Combine related effects or extract into custom hooks.",
		fn: checkExcessiveUseEffect,
		resultsPropName: "excessiveUseEffect",
	},
	{
		id: "sequential_awaits",
		phase: "post",
		name: "Sequential Awaits",
		description: "Detects sequential await calls that could be parallelized",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"These awaits can run in parallel. Use Promise.all([...]) for independent async operations.",
		fn: checkSequentialAwaits,
		resultsPropName: "sequentialAwaits",
	},
	{
		id: "index_as_key",
		phase: "post",
		name: "Index as Key",
		description: "Detects array index used as React key prop",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use a stable, unique identifier as key instead of array index. Index keys cause incorrect rendering when items are reordered.",
		fn: checkIndexAsKey,
		resultsPropName: "indexAsKey",
	},
	{
		id: "missing_effect_cleanup",
		phase: "post",
		name: "Missing Effect Cleanup",
		description: "Detects useEffect with subscriptions but no cleanup",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This useEffect adds a subscription but returns no cleanup function. Return a cleanup to prevent memory leaks.",
		fn: checkMissingEffectCleanup,
		resultsPropName: "missingEffectCleanup",
	},
	{
		id: "over_mocking",
		phase: "post",
		name: "Over-Mocking",
		description: "Detects excessive mocking in test files",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This test file has extensive mocking. Consider testing with real implementations where possible, or restructure to reduce mock surface.",
		fn: checkOverMocking,
		resultsPropName: "overMocking",
	},
	{
		id: "focused_tests",
		phase: "pre_block",
		name: "Focused Tests",
		description: "Detects shipped focus markers (.only, fit, fdescribe)",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Remove .only / fit / fdescribe markers — focused tests cause CI to silently skip the rest of the suite.",
		fn: checkFocusedTests,
		resultsPropName: "focusedTests",
	},
	{
		id: "test_platform_conditional",
		phase: "post",
		name: "Platform-Conditional Test Assertion",
		description:
			"A test comment narrates platform-variant behavior ('on platforms where…', 'macOS-only') while the NARRATED test never gates on it — evidence must be a PLATFORM-conditioned skipIf/runIf (process.platform, a platform-derived constant, or a platform-named flag) on that test or an enclosing suite, a platform branch in its body, or an unconditional .skip/.todo; a dependency gate like skipIf(!dockerAvailable), a gate on an unrelated sibling, or a mention in a comment/string is not evidence",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Construct the platform condition explicitly in the fixture (e.g. create your own symlink instead of relying on macOS's /tmp symlink), or gate the test with it.skipIf(process.platform !== …) so it only asserts where the narrated condition holds.",
		fn: checkPlatformConditionalAssertion,
		resultsPropName: "testPlatformConditional",
	},
	{
		id: "test_silent_dependency_skip",
		phase: "post",
		name: "Silent Dependency Skip",
		description:
			"`if (!X_AVAILABLE) return;` inside a test callback — bare, braced (`{ return; }`), or multi-line — records a PASS wherever the external dependency is missing; CI reports green while running nothing, hiding the gap until an unguarded sibling fails. Consequents that skip/throw/assert are recognized as handled; guards in module-level helpers and lifecycle hooks are exempt (not test skips)",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace the early return with it.skipIf(!X_AVAILABLE)(…) / describe.skipIf(…) so the skip is REPORTED in the run summary, and consider installing the dependency on CI so the path actually executes somewhere.",
		fn: checkSilentDependencySkip,
		resultsPropName: "testSilentDependencySkip",
	},
	{
		id: "migration_ordering",
		phase: "pre_block",
		name: "Migration Ordering",
		description: "Detects CREATE INDEX on a column not in the same-block CREATE TABLE",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Add the column via addColumnIfNotExists() FIRST, then run CREATE INDEX in a SEPARATE sql.exec() call. CREATE TABLE IF NOT EXISTS is a no-op for existing tables, so any column added later won't be present when CREATE INDEX runs in the same block.",
		fn: checkMigrationOrdering,
		resultsPropName: "migrationOrdering",
	},
	{
		id: "sql_schema_consistency",
		phase: "pre_warn",
		name: "SQL Schema Consistency",
		description: "Detects SQL queries referencing columns not declared in same-file schema",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This SQL query references a column not declared in any CREATE TABLE or addColumnIfNotExists() call in the same file. Either add it to the schema, or move the query to a file that has access to the correct schema.",
		fn: checkSqlSchemaConsistency,
		resultsPropName: "sqlSchemaConsistency",
	},
	{
		id: "visibility_filter_missing",
		phase: "pre_warn",
		name: "Visibility Filter Missing",
		description: "Detects soft-delete table queries without an archived_at/deleted_at filter",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This query targets a table with a soft-delete column (archived_at / deleted_at / is_archived / is_deleted) but does not filter on it. Add the filter — list/count queries diverging from this contract is a known regression source. If you intentionally want all rows including archived ones, add a WHERE/AND clause that explicitly references the soft-delete column.",
		fn: checkVisibilityFilterMissing,
		resultsPropName: "visibilityFilterMissing",
	},
	{
		id: "array_push_return_used",
		phase: "post",
		name: "Array push/unshift return value used",
		description:
			"Detects the return value of Array#push() / Array#unshift() being returned, bound to a fresh variable, or used as an arrow implicit-return body — push/unshift return the new array LENGTH, not the element or the array, so the value is almost always a mistake. Skips stream-style this.push() (Readable#push returns a meaningful boolean) and chained .push(x).length.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Array#push()/unshift() return the new length, not what you added. Mutate on its own line, then return or use the array: `items.push(item); return items;`. If you genuinely want the count, read `items.length` after the push so the intent is explicit.",
		fn: detectReturnArrayPush,
		resultsPropName: "arrayPushReturnUsed",
		content_keywords: [".push(", ".unshift("],
	},
	{
		id: "array_iteratee_variadic_builtin",
		phase: "post",
		name: "Variadic builtin as array iteratee",
		description:
			"Detects parseInt (or Number.parseInt) passed directly as the callback to .map() / .flatMap() / Array.from(x, fn). Array iterators pass the element index as a second argument, which parseInt reads as the radix — the classic ['1','2','3'].map(parseInt) -> [1, NaN, NaN] bug. Narrowed to parseInt, whose extra argument is load-bearing (Number/Boolean/String ignore it).",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Wrap the callback so the index can't leak into parseInt's radix: `.map((s) => parseInt(s, 10))`. (`.map(Number)` is fine — Number ignores the extra argument.)",
		fn: detectArrayIterateeVariadicBuiltin,
		resultsPropName: "arrayIterateeVariadicBuiltin",
		content_keywords: ["parseInt"],
	},
	{
		id: "payload_field_casing",
		phase: "post",
		name: "Payload Field Casing",
		description:
			"Detects reading a cross-runner hook-payload contract field (transcript_path, session_id, tool_use_id, …) off a raw-payload variable (rawInput/nativeJson/hookInput/payload/input) in ONE casing with no other-casing fallback on the same line. Hook payloads cross a runner boundary (Claude Code/Codex/Gemini/Copilot) where the same field arrives in both snake_case and camelCase; a single-casing read silently returns undefined when the other casing is delivered — the failure mode behind the thinking-capture regression.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This reads a raw hook-payload field in one casing only. Different runners (and versions) deliver the same field as snake_case OR camelCase, so a single-casing read goes silently undefined under the other. Add the other-casing fallback on the same expression, e.g. `rawInput.transcript_path ?? rawInput.transcriptPath`.",
		fn: detectPayloadFieldCasing,
		resultsPropName: "payloadFieldCasing",
		content_keywords: ["rawInput", "nativeJson", "hookInput", "payload", "input"],
	},
];
