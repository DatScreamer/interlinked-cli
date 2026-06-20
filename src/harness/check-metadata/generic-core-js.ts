// Metadata fragment: core JS/TS correctness — async/promise hygiene, error
// handling, type safety, module-import shape, eval/XSS sinks, package.json /
// tsconfig invariants, and base test / web hygiene. Composed into
// GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_CORE_JS_META: Record<string, CheckMeta> = {
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
	duplicated_policy_constant: {
		name: "Duplicated Policy Constant",
		description:
			"Detects a file declaring a named policy constant (DEFAULT_*/MAX_*/MIN_*/*_CAP/*_THRESHOLD/*_LIMIT) that also hard-codes the same bare numeric literal elsewhere instead of referencing the constant",
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
	promise_reject_non_error: {
		name: "Promise.reject with non-Error",
		description:
			"Detects Promise.reject() called with a string/number/boolean/null/undefined literal instead of an Error instance",
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
		description: "Detects skipped tests (it.skip, xit, xdescribe)",
		tier: 2,
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
};
