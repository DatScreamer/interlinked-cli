// Metadata for generic/inline agent safety checks (PostToolUse, regex-based).
// Keys must match the `name` fields in quality-checks.ts agentSafetyChecks array.

import type { CheckMeta } from "./types.js";

/** Public API — consumed by doc generation and re-exported from check-metadata.ts. */
export const GENERIC_CHECK_META: Record<string, CheckMeta> = {
	// Heuristic — regex-based analysis, not tool-backed
	complexity: {
		name: "Function Complexity",
		description: "Flags functions with high branch count, deep nesting, or many parameters",
		tier: 2,
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
	boolean_trap: {
		name: "Boolean Trap",
		description:
			"Detects call sites with 2+ boolean literal arguments — intent is opaque to a reader without jumping to the definition",
		tier: 2,
		determinism: "heuristic",
	},
	magic_literal_in_conditional: {
		name: "Magic Literal in Conditional",
		description:
			"Detects if/switch branches comparing against a bare numeric or string literal instead of a named constant or enum",
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
	},
	inner_html: {
		name: "innerHTML Usage",
		description: "Detects direct innerHTML assignment (XSS risk)",
		tier: 1,
		determinism: "fully_deterministic",
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
	},
	package_json_publish_invariants: {
		name: "Package JSON Publish Invariants",
		description:
			"Detects edits to a publishable package.json that silently drop publish-critical fields (name, version, license, repository, main, types, exports, bin, files, publishConfig, scripts.prepublishOnly, etc.)",
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

	// Warning severity — partially deterministic
	extraneous_deps: {
		name: "Extraneous Dependencies",
		description: "Detects imported packages not in package.json",
		tier: 2,
		determinism: "partially_deterministic",
	},
	non_null_assertion: {
		name: "Non-Null Assertion",
		description: "Detects TypeScript non-null assertions (!)",
		tier: 2,
		determinism: "partially_deterministic",
	},
	constant_condition: {
		name: "Constant Condition",
		description: "Detects always-true/false conditions",
		tier: 2,
		determinism: "partially_deterministic",
	},
	number_precision_loss: {
		name: "Number Precision Loss",
		description: "Detects integer literals beyond safe precision",
		tier: 2,
		determinism: "fully_deterministic",
	},
	require_await: {
		name: "Require Await",
		description: "Detects async functions without await",
		tier: 2,
		determinism: "partially_deterministic",
	},
	json_parse_unsafe: {
		name: "JSON Parse Unsafe",
		description: "Detects JSON.parse without try/catch",
		tier: 2,
		determinism: "partially_deterministic",
	},

	// Warning severity — heuristic
	accumulating_spread: {
		name: "Accumulating Spread",
		description: "Detects spread operator in reduce (O(n^2))",
		tier: 2,
		determinism: "heuristic",
	},
	excessive_use_state: {
		name: "Excessive useState",
		description: "Detects components with too many useState hooks",
		tier: 3,
		determinism: "heuristic",
	},
	direct_dom_access: {
		name: "Direct DOM Access",
		description: "Detects direct DOM manipulation in React components",
		tier: 3,
		determinism: "heuristic",
	},
	inline_object_props: {
		name: "Inline Object Props",
		description: "Detects inline object/array creation in JSX props",
		tier: 3,
		determinism: "heuristic",
	},
	async_event_handler: {
		name: "Async Event Handler",
		description: "Detects async event handlers that may cause unmounted-component issues",
		tier: 3,
		determinism: "heuristic",
	},
	nested_ternaries: {
		name: "Nested Ternaries",
		description: "Detects nested ternary expressions",
		tier: 2,
		determinism: "heuristic",
	},
	catch_and_log: {
		name: "Catch and Log",
		description: "Detects catch blocks that only log and rethrow",
		tier: 3,
		determinism: "heuristic",
	},
	hardcoded_timeout: {
		name: "Hardcoded Timeout",
		description: "Detects magic number timeouts (setTimeout/setInterval)",
		tier: 3,
		determinism: "heuristic",
	},
	sequential_awaits: {
		name: "Sequential Awaits",
		description: "Detects sequential await calls that could be parallelized",
		tier: 3,
		determinism: "heuristic",
	},
	index_as_key: {
		name: "Index as Key",
		description: "Detects array index used as React key prop",
		tier: 3,
		determinism: "heuristic",
	},
	missing_effect_cleanup: {
		name: "Missing Effect Cleanup",
		description: "Detects useEffect with subscriptions but no cleanup",
		tier: 3,
		determinism: "heuristic",
	},
	over_mocking: {
		name: "Over-Mocking",
		description: "Detects excessive mocking in test files",
		tier: 3,
		determinism: "heuristic",
	},
	excessive_use_effect: {
		name: "Excessive useEffect",
		description: "Detects components with too many useEffect hooks",
		tier: 3,
		determinism: "heuristic",
	},
	// C/C++ checks
	c_unsafe_functions: {
		name: "C Unsafe Functions",
		description: "Detects unsafe C functions: strcpy, strcat, gets, sprintf",
		tier: 1,
		determinism: "fully_deterministic",
	},
	c_include_guard: {
		name: "C Include Guard",
		description: "Detects header files missing #pragma once or #ifndef guard",
		tier: 1,
		determinism: "fully_deterministic",
	},
	c_strcmp_boolean_misuse: {
		name: "C strcmp Boolean Misuse",
		description: "Detects strcmp return value used as boolean without comparison",
		tier: 1,
		determinism: "partially_deterministic",
	},
	c_unchecked_malloc: {
		name: "C Unchecked Malloc",
		description: "Detects malloc/calloc/realloc without null check",
		tier: 2,
		determinism: "partially_deterministic",
	},
	c_sprintf_usage: {
		name: "C sprintf Usage",
		description: "Detects sprintf — use snprintf for bounds safety",
		tier: 1,
		determinism: "fully_deterministic",
	},
	// === UBS Plan 04 — rows 27–30 (warning/post tier) ===
	ubs_js_loose_equality: {
		name: "UBS JS Loose Equality",
		description:
			"Detects `==` / `!=` in JS/TS files (allows the documented `x == null` idiom).",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_float_equality: {
		name: "UBS Float Equality",
		description:
			"Detects `===` / `!==` against a non-IEEE-safe float literal — comparison is unreliable.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_java_optional_get: {
		name: "UBS Java Optional.get()",
		description:
			"Detects Java `Optional<T>....get()` without an `isPresent()` / `orElse(...)` guard.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_division_by_variable: {
		name: "UBS Division by Variable",
		description:
			"Detects `expr / identifier` — divisor might be zero (advisory; ships in DEFAULT_ADVISORY_SKIPS).",
		tier: 2,
		determinism: "heuristic",
	},
	// === UBS Plan 04 — rows 22–26 (critical-tier) ===
	ubs_mutex_lock_unwrap: {
		name: "UBS Mutex Lock Unwrap",
		description:
			"Detects Mutex<T>...lock().unwrap() in Rust source — panics on poisoned mutex.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_subprocess_shell_true: {
		name: "UBS Subprocess shell=True",
		description:
			"Detects subprocess.<fn>(..., shell=True) in Python — command-injection vector.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_tls_verify_disabled: {
		name: "UBS TLS Verify Disabled",
		description:
			"Detects TLS peer-cert verification turned off (verify=False / InsecureSkipVerify: true / rejectUnauthorized: false).",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_py_none_equality: {
		name: "UBS Python None Equality",
		description:
			"Detects `x == None` / `x != None` in Python — should be `is None` / `is not None` per PEP 8.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_weak_hash: {
		name: "UBS Weak Hash",
		description: "Detects MD5 / SHA-1 calls — broken hashes for security-bearing use.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	// === Plan 04 D.1 partial — high-leverage backlog (security + Py) ===
	ubs_eval_input_tainted: {
		name: "UBS Eval Input Tainted",
		description:
			"Detects eval / Function / exec / compile invoked with a non-literal first argument.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_sql_string_concat: {
		name: "UBS SQL String Concat",
		description:
			"Detects SQL keyword inside a quoted string with `+` / template-literal interpolation — canonical SQL-injection shape.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_python_mutable_default_arg: {
		name: "UBS Python Mutable Default Arg",
		description:
			"Detects `def f(x=[])` / `def f(x={})` — Python evaluates default values once at def time, sharing them across calls.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	// === Plan 04 D.1 backlog (17 of 20) ===
	ubs_tempfile_mktemp_race: {
		name: "UBS Tempfile mktemp Race",
		description:
			"Detects Python tempfile.mktemp(...) — TOCTOU race; an attacker can swap a symlink between name return and open.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_pickle_untrusted_load: {
		name: "UBS Pickle Untrusted Load",
		description:
			"Detects pickle.load / pickle.loads / cPickle — unpickling executes arbitrary __reduce__ code.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_xml_external_entity: {
		name: "UBS XML External Entity",
		description:
			"Detects xml.etree / xml.dom / xml.sax / lxml without defusedxml — XXE attacks read files / DoS.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_os_system_tainted: {
		name: "UBS os.system / os.popen tainted input",
		description:
			"Detects Python os.system(name) / os.popen(name) with non-literal arg — command-injection vector.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_unsafe_format_string: {
		name: "UBS Unsafe Format String",
		description:
			"Detects C/C++ printf / sprintf / fprintf with non-literal format — %n writes memory; %x leaks stack.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_unchecked_redirect: {
		name: "UBS Unchecked Redirect",
		description:
			"Detects JS/TS redirect(url) / location.href = url with non-literal URL — open-redirect vector.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_goroutine_no_waitgroup: {
		name: "UBS Goroutine No WaitGroup",
		description:
			"Detects Go `go func()` without accompanying wg.Add / wg.Done / errgroup — fire-and-forget leak.",
		tier: 2,
		determinism: "heuristic",
	},
	ubs_defer_in_loop: {
		name: "UBS Defer in Loop",
		description:
			"Detects Go `defer` inside a `for` loop — defers run at function return, not loop iteration.",
		tier: 2,
		determinism: "heuristic",
	},
	ubs_string_concat_in_loop: {
		name: "UBS String Concat in Loop",
		description:
			"Detects `result += chunk` inside a loop in immutable-string languages (Py/Java/JS/Go) — O(n²).",
		tier: 2,
		determinism: "heuristic",
	},
	ubs_numeric_comparison_chain: {
		name: "UBS Numeric Comparison Chain",
		description:
			"Detects 3+ consecutive instanceof / compareTo lines in Java — typically missing polymorphism.",
		tier: 2,
		determinism: "heuristic",
	},
	ubs_print_debug_leak: {
		name: "UBS Print Debug Leak",
		description:
			"Detects console.log / Python print / Go fmt.Println left in non-test, non-CLI code.",
		tier: 2,
		determinism: "heuristic",
	},
	ubs_hardcoded_localhost: {
		name: "UBS Hardcoded Localhost",
		description:
			"Detects localhost / 127.0.0.1 baked into source outside test/config/example/dev paths and outside non-source extensions. Promoted to pre_block / fully_deterministic in Phase 1 of agent-quality rollout.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	child_process_exec_user_input: {
		name: "Child Process Exec with User Input",
		description:
			"Detects Node child_process.exec/execSync/spawn shapes with non-literal first argument. Command-injection vector. Phase 1 pre_block error.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	mixed_sync_async_file_api: {
		name: "Mixed Sync/Async File API",
		description:
			"Detects function bodies mixing fs.*Sync with await fs.* — partial migration bug. Phase 1 pre_block error.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	cookie_missing_security_flags: {
		name: "Cookie Missing Security Flags",
		description:
			"Detects res.cookie / cookies.set / Set-Cookie setHeader without httpOnly+secure flags. Phase 1 pre_block error.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	logger_format_user_input: {
		name: "Logger Format String with User Input",
		description:
			"Detects logger.<level> calls with request-bound first argument — log-injection vector. Phase 1 pre_block error.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_magic_number_no_const: {
		name: "UBS Magic Number No Const",
		description:
			"Detects 3+ digit numeric literals in expression context without being assigned to a named constant.",
		tier: 3,
		determinism: "heuristic",
	},
	ubs_large_function: {
		name: "UBS Large Function",
		description:
			"Detects a single function spanning 80+ body lines — review/refactor candidate.",
		tier: 3,
		determinism: "heuristic",
	},
	ubs_deeply_nested_callback: {
		name: "UBS Deeply Nested Callback",
		description:
			"Detects 4+ levels of nested function / arrow callbacks — callback-hell smell.",
		tier: 3,
		determinism: "heuristic",
	},
	ubs_time_format_locale_dep: {
		name: "UBS Time Format Locale Dependent",
		description:
			"Detects JS toLocaleString / Java DateTimeFormatter.ofLocalized* without an explicit locale.",
		tier: 2,
		determinism: "heuristic",
	},
	ubs_regex_in_loop_no_compile: {
		name: "UBS Regex in Loop No Compile",
		description:
			"Detects Python re.match / re.search / re.sub inside a loop without re.compile.",
		tier: 2,
		determinism: "heuristic",
	},
};
