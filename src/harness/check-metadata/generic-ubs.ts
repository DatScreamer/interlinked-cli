// Metadata fragment: UBS ("universal bug shapes") Plan 04 checks plus the
// Phase-1 pre_block security checks that ship alongside them, and the Plan 04
// D.2 pattern-parity expansion. Composed into GENERIC_CHECK_META in
// ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_UBS_META: Record<string, CheckMeta> = {
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
	sql_escape_hatch_non_literal: {
		name: "SQL Escape Hatch With Non-Literal",
		description:
			"Detects `sql.unsafe`/`sql.raw`/`sql.lit` invoked with a non-literal argument — restores the SQL-injection vector the library otherwise prevents. Effect-TS lessons port.",
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
	// === Plan 04 D.2 (2026-05) — pattern-parity expansion ===
	ubs_marshal_load: {
		name: "Python marshal.load(s)",
		description:
			"Detects `marshal.load(...)` / `marshal.loads(...)` — deserializing untrusted bytes through the `marshal` module executes arbitrary code.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_shelve_open: {
		name: "Python shelve.open",
		description:
			"Detects `shelve.open(...)`. `shelve` is a pickle-backed persistent dict; the same arbitrary-code-execution surface as `pickle.load`.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_yaml_unsafe_load: {
		name: "PyYAML unsafe load",
		description:
			"Detects PyYAML `yaml.load(...)` without a Safe-class Loader, plus the explicit `yaml.unsafe_load(...)` alias. Both construct arbitrary Python objects from `!!python/object` tags.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_torch_unsafe_load: {
		name: "PyTorch unsafe load",
		description:
			"Detects `torch.load(...)` without `weights_only=True`. Older torch defaults `weights_only=False`, which unpickles arbitrary Python objects from the checkpoint file.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_pickle_wrapper_load: {
		name: "Pickle wrapper load",
		description:
			"Detects libraries that unpickle without the word `pickle` in the call: `joblib.load`, `pandas.read_pickle`, `numpy.load(..., allow_pickle=True)`.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_aes_ecb_mode: {
		name: "AES in ECB mode",
		description:
			"Detects AES used in ECB mode across languages (Python `AES.MODE_ECB`, `modes.ECB`, Node `\"aes-N-ecb\"`, Go `cipher.NewECBEncrypter`). ECB leaks plaintext structure.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_node_create_cipher: {
		name: "Node deprecated createCipher",
		description:
			"Detects Node `crypto.createCipher(...)` / `createDecipher(...)` — derives the key via an MD5 KDF with no IV. Removed in Node 22.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_script_without_sri: {
		name: "External script without SRI",
		description:
			"Detects `<script src=\"https://...\">` external URLs without `integrity=\"sha...\"`. CDN compromise / substitution executes attacker code with full page privileges.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_go_shell_injection: {
		name: "Go exec.Command shell invocation",
		description:
			"Detects Go `exec.Command(\"sh\"|\"bash\"|/bin/sh|/bin/bash, ...)` — routing arguments through a shell interpreter enables command injection on concatenated user input.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_github_actions_injection: {
		name: "GitHub Actions workflow injection",
		description:
			"Detects interpolation of attacker-controllable GitHub-event fields (PR title, issue body, commit message, head ref, `client_payload.*`) into workflow expressions.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_document_write: {
		name: "document.write XSS",
		description:
			"Detects `document.write(...)` / `document.writeln(...)` — XSS sink and render-blocking anti-pattern.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_outer_html_assignment: {
		name: "outerHTML assignment XSS",
		description:
			"Detects `<expr>.outerHTML = <value>` — equivalent XSS sink to `.innerHTML =`, but replaces the element itself.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ubs_insert_adjacent_html: {
		name: "insertAdjacentHTML XSS",
		description:
			"Detects `.insertAdjacentHTML(position, htmlString)` — the second argument is parsed as HTML; attacker-controlled fragments become live DOM nodes.",
		tier: 1,
		determinism: "fully_deterministic",
	},
};
