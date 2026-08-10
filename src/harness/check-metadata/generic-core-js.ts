// Metadata fragment: core JS/TS correctness — async/promise hygiene, error
// handling, type safety, module-import shape, eval/XSS sinks, package.json /
// tsconfig invariants, and base test / web hygiene. Composed into
// GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_CORE_JS_META: Record<string, CheckMeta> = {
	cjs_in_esm_module: {
		name: "CommonJS in ES Module",
		description:
			"Detects require()/module.exports/__dirname/__filename in an ES module (import/export present or .mjs) - undefined under ESM, throws at runtime",
		tier: 1,
		determinism: "heuristic",
	},
	// Error severity — pattern-exact checks
	misused_promises: {
		name: "Misused Promises",
		description: "Detects floating promises and missing await",
		tier: 1,
		determinism: "fully_deterministic",
	},
	floating_promises: {
		name: "Floating Promises",
		description:
			"Detects async calls at statement position without await, return, void, assignment, or .catch()/.finally() handling",
		tier: 1,
		determinism: "partially_deterministic",
	},
	broad_object_types: {
		name: "Broad Object Types",
		description:
			"Detects Record<K, any>, { [k: string]: any } index signatures, and bare Function / object type annotations",
		tier: 1,
		determinism: "partially_deterministic",
	},
	magic_literal_in_conditional: {
		name: "Magic Literal in Conditional",
		description:
			"Detects if/switch branches comparing against a bare numeric or string literal instead of a named constant or enum",
		tier: 2,
		determinism: "heuristic",
	},
	nan_coercion_guard: {
		name: "NaN Coercion Guard",
		description:
			"Detects Date.parse/Number/parseInt/parseFloat results used in a relational comparison without a Number.isFinite/isNaN guard — NaN makes the comparison silently false (fail-open)",
		tier: 1,
		determinism: "heuristic",
	},
	array_push_return_used: {
		name: "Array push/unshift return value used",
		description:
			"Detects Array#push()/unshift() return values returned, bound, or used as an arrow implicit-return body — they return the new length, not the element or array (fail-quiet on stream-style this.push() and chained .push().length)",
		tier: 1,
		determinism: "heuristic",
	},
	array_iteratee_variadic_builtin: {
		name: "Variadic builtin as array iteratee",
		description:
			"Detects parseInt/Number.parseInt passed bare to .map()/.flatMap()/Array.from(x, fn) — the element index becomes parseInt's radix (the ['1','2','3'].map(parseInt) -> [1, NaN, NaN] bug)",
		tier: 1,
		determinism: "heuristic",
	},
	write_without_mkdir: {
		name: "Write Without mkdir",
		description:
			"Detects writeFileSync/appendFileSync/writeFile/createWriteStream on a nested path with no prior mkdir(..., { recursive: true }) / existsSync guard in the same function scope — throws ENOENT when the parent directory is absent",
		tier: 1,
		determinism: "heuristic",
	},
	homedir_write_escape: {
		name: "Homedir Write Escape",
		description:
			"Detects write-family calls whose path derives from the user's real home (homedir() / process.env.HOME/USERPROFILE, directly or via up to two local bindings) — writes that escape the repo into real user data; the test runner must sandbox HOME because per-test env redirects break under mutation",
		tier: 2,
		determinism: "heuristic",
	},
	duplicated_policy_constant: {
		name: "Duplicated Policy Constant",
		description:
			"Detects a file declaring a named policy constant (DEFAULT_*/MAX_*/MIN_*/*_CAP/*_THRESHOLD/*_LIMIT) that also hard-codes the same bare numeric literal elsewhere instead of referencing the constant",
		tier: 2,
		determinism: "heuristic",
	},
	type_predicate_drift: {
		name: "Type Predicate Drift",
		description:
			"Detects a `value is T` type predicate that validates only some of T's required properties — the annotation is an unchecked assertion, so the unvalidated fields stay unvalidated when T grows",
		tier: 2,
		determinism: "heuristic",
	},
	snapshot_hygiene: {
		name: "Snapshot Hygiene",
		description:
			"Detects a write whose target path is a snapshot-review artifact (jest/vitest `*.snap.new` or cargo-insta `*.pending-snap`) that must never be committed — the runner ignores it at test time, so committing it leaves a dangling artifact without satisfying the assertion",
		tier: 1,
		determinism: "heuristic",
	},
	design_slop: {
		name: "Design Slop",
		description:
			"Detects AI-generated frontend tells in design-surface files (overused fonts, side-tab accent borders, gradient text, purple/violet palettes, bounce easing, gray-on-color, broken images, em-dash/buzzword copy tells); ported from Impeccable (Apache-2.0)",
		tier: 1,
		determinism: "heuristic",
	},
	// Bun-regression detector pack (2026-07-20): escape-hatch SPAN pair.
	rust_unsafe_span: {
		name: "Wide Rust unsafe block",
		description:
			"Detects a Rust unsafe { ... } block spanning more than 5 nonblank interior lines — safe code riding inside the hatch (78% of Bun's post-port unsafe blocks are one line).",
		tier: 1,
		determinism: "fully_deterministic",
	},
	suppression_block_span: {
		name: "Wide eslint-disable region",
		description:
			"Detects a block-form /* eslint-disable */ … /* eslint-enable */ region spanning more than 10 lines — the suppression covers code that never needed it. Disable-with-no-enable is owned by file_level_suppression.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	anonymous_registration: {
		name: "Anonymous Registration",
		description:
			"Detects a registry entry pairing a greppable string id/name key with an ANONYMOUS function implementation — the key is what other files reference, but the implementation is not reachable from it in one hop by grep, index, embedding search, or the harness's own name-based resolvers (the gap that left four checks unsatisfiable in 2026-08)",
		tier: 2,
		determinism: "heuristic",
	},
	payload_field_casing: {
		name: "Payload Field Casing",
		description:
			"Detects a raw hook-payload contract field (transcript_path/session_id/tool_use_id/…) read in one casing off a raw-payload variable with no other-casing fallback — cross-runner payloads deliver the same field as snake_case or camelCase, so a single-casing read silently goes undefined under the other (the thinking-capture regression class)",
		tier: 2,
		determinism: "heuristic",
	},
	gitignored_written_config: {
		name: "Gitignored Written Config",
		description:
			"Detects file-write calls whose statically-resolved path is excluded by .gitignore (no `!` negation carve-out) — a config/policy file intended to be committed can never land in a PR. Verify-only (needs git context).",
		tier: 2,
		determinism: "heuristic",
	},
	spec_path_ref: {
		name: "Spec Path Ref",
		description:
			"Detects a present-tense claim that a path exists in-repo (\"the full `invariants.toml` exists in-repo\") when the working tree lacks it (Sol D-3). Future-tense and unknown-tense mentions never fire. Verify-only (needs a filesystem resolver).",
		tier: 2,
		determinism: "heuristic",
	},
	promise_reject_non_error: {
		name: "Promise.reject with non-Error",
		description:
			"Detects Promise.reject() called with a string/number/boolean/null/undefined literal instead of an Error instance",
		tier: 1,
		determinism: "fully_deterministic",
	},
	raw_control_bytes: {
		name: "Raw Control Bytes in Source",
		description:
			"Detects a literal control character (NUL, ESC, DEL, ...) written into text source instead of its escape sequence — a raw byte makes grep classify the whole file as binary and skip it, so the file becomes invisible to code search while the diff looks identical. Covers JS/TS, Python, JSON, C-family, Java, C#, and markup/config text; Go, Rust, Ruby, and shell are excluded because each has a string form that cannot carry an escape",
		tier: 1,
		determinism: "fully_deterministic",
	},
	lossy_error_rethrow: {
		name: "Lossy Error Rethrow",
		description:
			"Detects catch (e) { throw new Error('...') } without { cause: e } — the new Error drops the original stack trace and breaks error.cause-chain inspection",
		tier: 1,
		determinism: "fully_deterministic",
	},
	import_from_own_barrel: {
		name: "Import From Own Barrel",
		description:
			"Detects a non-barrel source file importing from its own-directory barrel ('./index', './', or the file's own published package name) — forms latent module-init cycles and defeats tree-shaking. Effect-TS lessons port.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	error_dispatch_by_instanceof: {
		name: "Error Dispatch by instanceof",
		description:
			"Detects `e instanceof <BuiltinError>` inside a catch block — fragile across realm boundaries (iframes, workers, vm contexts). Prefer tag/code/name dispatch. Effect-TS lessons port.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	silent_promise_catch: {
		name: "Silent Promise Catch",
		description:
			"Detects .catch(() => {}), .catch(() => undefined / null / void 0), and .catch(function () {}) — swallowed rejections silently mask bugs (e.g. the optimistic-grant rollback bug class in src/harness/reservations.ts).",
		tier: 1,
		determinism: "fully_deterministic",
	},
	unvalidated_json_boundary: {
		name: "Unvalidated JSON Boundary",
		description:
			"Detects JSON.parse/.json() results reaching property access without passing through a schema parser (zod, valibot, ajv, yup, io-ts)",
		tier: 2,
		determinism: "heuristic",
	},
	dead_exports: {
		name: "Dead Exports",
		description:
			"Detects named exports that no other file in the project imports — inflates the apparent public surface",
		tier: 3,
		determinism: "partially_deterministic",
	},
	circular_imports: {
		name: "Circular Imports",
		description:
			"Detects import cycles involving the edited file (A → B → C → A) — unclear module boundaries and runtime undefined-at-import-time bugs",
		tier: 3,
		determinism: "partially_deterministic",
	},
	untested_inverse_pair: {
		name: "Untested Inverse Pair",
		description:
			"Detects exported inverse pairs (encode/decode, to<X>/from<X>, etc.) with no round-trip property test across project tests",
		tier: 3,
		determinism: "heuristic",
	},
	untested_idempotent: {
		name: "Untested Idempotent",
		description:
			"Detects exported idempotent-shaped functions (normalize/sanitize/dedupe/etc.) with no property test across project tests",
		tier: 3,
		determinism: "heuristic",
	},
	lifecycle_cleanup: {
		name: "Lifecycle Cleanup",
		description:
			"Detects classes with dispose/destroy/close methods that register setInterval/setTimeout/addEventListener without the paired cleanup",
		tier: 2,
		determinism: "heuristic",
	},
	default_export: {
		name: "Default Export Hygiene",
		description:
			"Flags anonymous default exports or default exports whose symbol name does not match the filename",
		tier: 3,
		determinism: "heuristic",
	},
	code_clones: {
		name: "Code Clones (DRY)",
		description:
			"Jaccard-similarity clone detector (modeled on Uncle Bob's dry4* tools) — flags functions >=82% token-shingle-similar to another function in the same file or a sibling file",
		tier: 3,
		determinism: "heuristic",
	},
	async_promise_executor: {
		name: "Async Promise Executor",
		description: "Detects async functions passed to Promise constructor",
		tier: 1,
		determinism: "fully_deterministic",
	},
	self_import: {
		name: "Self Import",
		description: "Detects a module importing itself",
		tier: 1,
		determinism: "fully_deterministic",
	},
	eval_usage: {
		name: "Eval Usage",
		description: "Detects use of eval() and Function()",
		tier: 1,
		determinism: "fully_deterministic",
		asi: "ASI05",
	},
	inner_html: {
		name: "innerHTML Usage",
		description: "Detects direct innerHTML assignment (XSS risk)",
		tier: 1,
		determinism: "fully_deterministic",
		asi: "ASI05",
	},
	nan_comparison: {
		name: "NaN Comparison",
		description: "Detects direct comparison with NaN",
		tier: 1,
		determinism: "fully_deterministic",
	},
	unsafe_optional_chaining: {
		name: "Unsafe Optional Chaining",
		description: "Detects unsafe optional chaining patterns",
		tier: 1,
		determinism: "fully_deterministic",
	},
	throw_literal: {
		name: "Throw Literal",
		description: "Detects throwing string literals instead of Error objects",
		tier: 1,
		determinism: "fully_deterministic",
	},
	dangerously_set_inner_html: {
		name: "dangerouslySetInnerHTML",
		description: "Detects React dangerouslySetInnerHTML usage",
		tier: 1,
		determinism: "fully_deterministic",
		asi: "ASI05",
	},
	package_json_publish_invariants: {
		name: "Package JSON Publish Invariants",
		description:
			"Detects edits to a publishable package.json that silently drop publish-critical fields (name, version, license, repository, main, types, exports, bin, files, publishConfig, scripts.prepublishOnly, etc.)",
		tier: 1,
		determinism: "fully_deterministic",
	},
	package_json_script_paths: {
		name: "Package JSON Script Paths",
		description:
			"Detects package.json scripts that reference files which don't exist on disk (node ./X.mjs, tsc -p X.json, --config X). Catches the CI failure where a manifest declares a script path the file tree doesn't have.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	tsconfig_strictness: {
		name: "tsconfig Strictness",
		description:
			"Detects tsconfig*.json files missing high-leverage strictness flags not covered by `strict: true` (noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noImplicitReturns, noFallthroughCasesInSwitch). Walks the `extends` chain so a flag set in a base tsconfig counts as present.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	disabled_tests: {
		name: "Disabled Tests",
		description:
			"Detects newly-introduced unconditional test skips (it.skip/xit/xdescribe, @pytest.mark.skip, #[ignore], t.Skip)",
		tier: 1,
		determinism: "fully_deterministic",
	},
	snapshot_overuse: {
		name: "Snapshot Overuse",
		description: "Detects excessive snapshot testing",
		tier: 2,
		determinism: "fully_deterministic",
	},
	test_importing_test: {
		name: "Test Importing Test",
		description: "Detects test files importing from other test files",
		tier: 2,
		determinism: "fully_deterministic",
	},
	target_blank_no_rel: {
		name: "Target Blank No Rel",
		description: 'Detects target="_blank" without rel="noopener"',
		tier: 2,
		determinism: "fully_deterministic",
	},
	unjustified_cast: {
		name: "Unjustified Cast",
		description:
			"Detects type-assertion casts (as X) lacking a // SAFETY: justification — heuristic over comment/string-stripped content",
		tier: 2,
		determinism: "heuristic",
	},
	process_env_outside_config: {
		name: "process.env Outside Config",
		description:
			"Detects process.env reads outside the config boundary — heuristic over comment-stripped content",
		tier: 2,
		determinism: "heuristic",
	},
	top_level_side_effect: {
		name: "Top-Level Side Effect",
		description:
			"Detects I/O / side-effecting calls at module load (column-0 heuristic for top level)",
		tier: 2,
		determinism: "heuristic",
	},
	// ---- quality-frontier wave (2026-07-06) — see docs/design/quality-frontier-2026-07.md ----
	unawaited_async_assertion: {
		name: "Unawaited Async Assertion",
		description:
			"Detects a statement-position expect(...).rejects/.resolves chain in a test with no leading await/return/void — the matcher promise floats and the test silently passes",
		tier: 1,
		determinism: "fully_deterministic",
	},
	timeout_unit_mismatch: {
		name: "Timeout Unit Mismatch",
		description:
			"Detects a seconds-named identifier passed directly as the setTimeout/setInterval delay (ms expected, fires ~1000x early), or an ms-named identifier multiplied by 1000 at the call site",
		tier: 1,
		determinism: "heuristic",
	},
	numeric_sort_without_comparator: {
		name: "Numeric Sort Without Comparator",
		description:
			"Detects .sort() with no comparator on a provably-numeric receiver (numeric array literal or number[] annotation) — default sort is lexicographic, [10, 9, 1] → [1, 10, 9]",
		tier: 1,
		determinism: "heuristic",
	},
	implicit_switch_fallthrough: {
		name: "Implicit Switch Fallthrough",
		description:
			"Detects a non-empty switch case not ending in break/return/throw/continue while a following clause exists, with no falls-through comment (TS AST; skips when typescript is absent)",
		tier: 1,
		determinism: "heuristic",
	},
	contradictory_nullness_chain: {
		name: "Contradictory Nullness Chain",
		description:
			"Detects an optional chain immediately non-null asserted on the same chain (a?.b!.c) — the ! contradicts the ?.; typically churn from appeasing tsc",
		tier: 1,
		determinism: "heuristic",
	},
	json_stringify_error: {
		name: "JSON.stringify of Caught Error",
		description:
			"Detects JSON.stringify(<catch binding>) passed bare — Error own-props are non-enumerable so the output is {} and the log loses message/name/stack",
		tier: 1,
		determinism: "heuristic",
	},
	catch_rewrap_loses_cause: {
		name: "Catch Rewrap Loses Cause",
		description:
			"Detects new Error(...) in a catch that references the caught binding only via string coercion, with no { cause } and no bare-argument pass — stack and cause chain destroyed",
		tier: 1,
		determinism: "heuristic",
	},
	resource_handle_leak: {
		name: "Resource Handle Leak",
		description:
			"Detects an fs.openSync fd / fs.createWriteStream binding never closed/ended/destroyed and never handed off — leaks on every path (narrow zero-noise slice)",
		tier: 1,
		determinism: "heuristic",
	},
	jsdoc_param_drift: {
		name: "JSDoc Param Drift",
		description:
			"Detects a JSDoc @param tag naming a parameter that does not exist on the documented function (TS AST; destructured/rest/dotted params and overloads exempt)",
		tier: 1,
		determinism: "fully_deterministic",
	},
};
