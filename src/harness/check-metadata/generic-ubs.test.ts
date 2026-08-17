// Mutation-hardening companion for generic-ubs.ts.
//
// generic-fragments.test.ts and index.test.ts already pin the CheckMeta SHAPE
// (typeof name === "string") and the exact KEY SET, but neither pins the
// exact string CONTENTS of name/description — so a StringLiteral mutant
// replacing any name or description with "" survives both (still a string,
// key set unchanged). This file closes that gap: one exact-value assertion
// per field, per entry, sourced from the real module at authoring time.

import { describe, expect, it } from "vitest";
import { GENERIC_UBS_META } from "./generic-ubs.js";

// Exact expected name/description per check id, transcribed from the real
// (unmutated) module. A StringLiteral mutation on any name/description in
// generic-ubs.ts makes the corresponding assertion below fail.
const EXPECTED: Record<string, { name: string; description: string }> = {
	ubs_js_loose_equality: {
		name: "UBS JS Loose Equality",
		description: "Detects `==` / `!=` in JS/TS files (allows the documented `x == null` idiom).",
	},
	ubs_float_equality: {
		name: "UBS Float Equality",
		description: "Detects `===` / `!==` against a non-IEEE-safe float literal — comparison is unreliable.",
	},
	ubs_java_optional_get: {
		name: "UBS Java Optional.get()",
		description: "Detects Java `Optional<T>....get()` without an `isPresent()` / `orElse(...)` guard.",
	},
	ubs_rust_debug_assert_side_effect: {
		name: "Rust debug_assert side effect",
		description: "Detects Rust debug_assert* arguments with a try operator, assignment, or mutating-looking call — release builds erase debug_assert evaluation.",
	},
	ubs_c_assert_side_effect: {
		name: "C assert side effect",
		description: "Detects C/C++ assert(...) arguments with an assignment, ++/--, or mutating-looking call — -DNDEBUG (the standard release configuration) erases the argument.",
	},
	ubs_python_assert_side_effect: {
		name: "Python assert side effect",
		description: "Detects Python assert operands with a walrus binding or mutating-looking call — python -O strips assert statements, erasing the operand.",
	},
	ubs_java_assert_side_effect: {
		name: "Java assert side effect",
		description: "Detects Java assert conditions with an assignment, ++/--, or mutating-looking call — JVM assertions are OFF by default (no -ea), so the condition never evaluates.",
	},
	ubs_rust_unchecked_cast_slice: {
		name: "Rust unchecked cast_slice",
		description: "Detects bytemuck::cast_slice / from_raw_parts / transmute reinterpreting a byte buffer as a wider type with no length/alignment proof — cast_slice panics on odd byteLength (Bun #31188).",
	},
	unaligned_reinterpret: {
		name: "Unaligned buffer reinterpret",
		description: "Detects JS/TS typed-array views over an existing ArrayBuffer with no byteLength % BYTES_PER_ELEMENT guard — the constructor throws on odd-length input (the Bun #31188 class in JS clothing).",
	},
	ubs_division_by_variable: {
		name: "UBS Division by Variable",
		description: "Detects `expr / identifier` — divisor might be zero (advisory; ships in DEFAULT_ADVISORY_SKIPS).",
	},
	ubs_mutex_lock_unwrap: {
		name: "UBS Mutex Lock Unwrap",
		description: "Detects Mutex<T>...lock().unwrap() in Rust source — panics on poisoned mutex.",
	},
	ubs_subprocess_shell_true: {
		name: "UBS Subprocess shell=True",
		description: "Detects subprocess.<fn>(..., shell=True) in Python — command-injection vector.",
	},
	ubs_tls_verify_disabled: {
		name: "UBS TLS Verify Disabled",
		description: "Detects TLS peer-cert verification turned off (verify=False / InsecureSkipVerify: true / rejectUnauthorized: false).",
	},
	ubs_py_none_equality: {
		name: "UBS Python None Equality",
		description: "Detects `x == None` / `x != None` in Python — should be `is None` / `is not None` per PEP 8.",
	},
	ubs_weak_hash: {
		name: "UBS Weak Hash",
		description: "Detects MD5 / SHA-1 calls — broken hashes for security-bearing use.",
	},
	ubs_eval_input_tainted: {
		name: "UBS Eval Input Tainted",
		description: "Detects eval / Function / exec / compile invoked with a non-literal first argument.",
	},
	ubs_sql_string_concat: {
		name: "UBS SQL String Concat",
		description: "Detects SQL keyword inside a quoted string with `+` / template-literal interpolation — canonical SQL-injection shape.",
	},
	sql_escape_hatch_non_literal: {
		name: "SQL Escape Hatch With Non-Literal",
		description: "Detects `sql.unsafe`/`sql.raw`/`sql.lit` invoked with a non-literal argument — restores the SQL-injection vector the library otherwise prevents. Effect-TS lessons port.",
	},
	ubs_python_mutable_default_arg: {
		name: "UBS Python Mutable Default Arg",
		description: "Detects `def f(x=[])` / `def f(x={})` — Python evaluates default values once at def time, sharing them across calls.",
	},
	ubs_tempfile_mktemp_race: {
		name: "UBS Tempfile mktemp Race",
		description: "Detects Python tempfile.mktemp(...) — TOCTOU race; an attacker can swap a symlink between name return and open.",
	},
	ubs_pickle_untrusted_load: {
		name: "UBS Pickle Untrusted Load",
		description: "Detects pickle.load / pickle.loads / cPickle — unpickling executes arbitrary __reduce__ code.",
	},
	ubs_xml_external_entity: {
		name: "UBS XML External Entity",
		description: "Detects xml.etree / xml.dom / xml.sax / lxml without defusedxml — XXE attacks read files / DoS.",
	},
	ubs_os_system_tainted: {
		name: "UBS os.system / os.popen tainted input",
		description: "Detects Python os.system(name) / os.popen(name) with non-literal arg — command-injection vector.",
	},
	ubs_unsafe_format_string: {
		name: "UBS Unsafe Format String",
		description: "Detects C/C++ printf / sprintf / fprintf with non-literal format — %n writes memory; %x leaks stack.",
	},
	ubs_unchecked_redirect: {
		name: "UBS Unchecked Redirect",
		description: "Detects JS/TS redirect(url) / location.href = url with non-literal URL — open-redirect vector.",
	},
	ubs_goroutine_no_waitgroup: {
		name: "UBS Goroutine No WaitGroup",
		description: "Detects Go `go func()` without accompanying wg.Add / wg.Done / errgroup — fire-and-forget leak.",
	},
	ubs_defer_in_loop: {
		name: "UBS Defer in Loop",
		description: "Detects Go `defer` inside a `for` loop — defers run at function return, not loop iteration.",
	},
	ubs_string_concat_in_loop: {
		name: "UBS String Concat in Loop",
		description: "Detects `result += chunk` inside a loop in immutable-string languages (Py/Java/JS/Go) — O(n²).",
	},
	ubs_numeric_comparison_chain: {
		name: "UBS Numeric Comparison Chain",
		description: "Detects 3+ consecutive instanceof / compareTo lines in Java — typically missing polymorphism.",
	},
	ubs_print_debug_leak: {
		name: "UBS Print Debug Leak",
		description: "Detects console.log / Python print / Go fmt.Println left in non-test, non-CLI code.",
	},
	ubs_hardcoded_localhost: {
		name: "UBS Hardcoded Localhost",
		description: "Detects localhost / 127.0.0.1 baked into source outside test/config/example/dev paths and outside non-source extensions. Promoted to pre_block / fully_deterministic in Phase 1 of agent-quality rollout.",
	},
	child_process_exec_user_input: {
		name: "Child Process Exec with User Input",
		description: "Detects Node child_process.exec/execSync/spawn shapes with non-literal first argument. Command-injection vector. Phase 1 pre_block error.",
	},
	mixed_sync_async_file_api: {
		name: "Mixed Sync/Async File API",
		description: "Detects function bodies mixing fs.*Sync with await fs.* — partial migration bug. Phase 1 pre_block error.",
	},
	cookie_missing_security_flags: {
		name: "Cookie Missing Security Flags",
		description: "Detects res.cookie / cookies.set / Set-Cookie setHeader without httpOnly+secure flags. Phase 1 pre_block error.",
	},
	logger_format_user_input: {
		name: "Logger Format String with User Input",
		description: "Detects logger.<level> calls with request-bound first argument — log-injection vector. Phase 1 pre_block error.",
	},
	ubs_magic_number_no_const: {
		name: "UBS Magic Number No Const",
		description: "Detects 3+ digit numeric literals in expression context without being assigned to a named constant.",
	},
	ubs_large_function: {
		name: "UBS Large Function",
		description: "Detects a single function spanning 80+ body lines — review/refactor candidate.",
	},
	ubs_deeply_nested_callback: {
		name: "UBS Deeply Nested Callback",
		description: "Detects 4+ levels of nested function / arrow callbacks — callback-hell smell.",
	},
	ubs_time_format_locale_dep: {
		name: "UBS Time Format Locale Dependent",
		description: "Detects JS toLocaleString / Java DateTimeFormatter.ofLocalized* without an explicit locale.",
	},
	ubs_regex_in_loop_no_compile: {
		name: "UBS Regex in Loop No Compile",
		description: "Detects Python re.match / re.search / re.sub inside a loop without re.compile.",
	},
	ubs_marshal_load: {
		name: "Python marshal.load(s)",
		description: "Detects `marshal.load(...)` / `marshal.loads(...)` — deserializing untrusted bytes through the `marshal` module executes arbitrary code.",
	},
	ubs_shelve_open: {
		name: "Python shelve.open",
		description: "Detects `shelve.open(...)`. `shelve` is a pickle-backed persistent dict; the same arbitrary-code-execution surface as `pickle.load`.",
	},
	ubs_yaml_unsafe_load: {
		name: "PyYAML unsafe load",
		description: "Detects PyYAML `yaml.load(...)` without a Safe-class Loader, plus the explicit `yaml.unsafe_load(...)` alias. Both construct arbitrary Python objects from `!!python/object` tags.",
	},
	ubs_torch_unsafe_load: {
		name: "PyTorch unsafe load",
		description: "Detects `torch.load(...)` without `weights_only=True`. Older torch defaults `weights_only=False`, which unpickles arbitrary Python objects from the checkpoint file.",
	},
	ubs_pickle_wrapper_load: {
		name: "Pickle wrapper load",
		description: "Detects libraries that unpickle without the word `pickle` in the call: `joblib.load`, `pandas.read_pickle`, `numpy.load(..., allow_pickle=True)`.",
	},
	ubs_aes_ecb_mode: {
		name: "AES in ECB mode",
		description: "Detects AES used in ECB mode across languages (Python `AES.MODE_ECB`, `modes.ECB`, Node `\"aes-N-ecb\"`, Go `cipher.NewECBEncrypter`). ECB leaks plaintext structure.",
	},
	ubs_weak_random_security: {
		name: "Weak Random for Security",
		description: "Detects Python's `random.<fn>()` PRNG generating a security value (token / key / nonce / salt / password / OTP / IV) — predictable, unsafe for secrets. (JS Math.random is covered by the A3 content-quality write-guard.)",
	},
	ubs_archive_extract_traversal: {
		name: "Unsanitized archive extraction (zip-slip)",
		description: "Detects an archive extracted without member-path validation (Python `extractall` with no `filter=`, Node `tar.x`/`tar.extract`/adm-zip `extractAllTo`) — a crafted `../` entry escapes the target dir (CVE-2007-4559).",
	},
	ubs_python_assert_tautology: {
		name: "Python assert tautology",
		description: "Detects `assert (cond, \"msg\")` — the parentheses make an always-truthy 2-tuple, so the assertion never fails (the author meant `assert cond, \"msg\"`).",
	},
	ubs_node_create_cipher: {
		name: "Node deprecated createCipher",
		description: "Detects Node `crypto.createCipher(...)` / `createDecipher(...)` — derives the key via an MD5 KDF with no IV. Removed in Node 22.",
	},
	ubs_script_without_sri: {
		name: "External script without SRI",
		description: "Detects `<script src=\"https://...\">` external URLs without `integrity=\"sha...\"`. CDN compromise / substitution executes attacker code with full page privileges.",
	},
	ubs_go_shell_injection: {
		name: "Go exec.Command shell invocation",
		description: "Detects Go `exec.Command(\"sh\"|\"bash\"|/bin/sh|/bin/bash, ...)` — routing arguments through a shell interpreter enables command injection on concatenated user input.",
	},
	ubs_github_actions_injection: {
		name: "GitHub Actions workflow injection",
		description: "Detects interpolation of attacker-controllable GitHub-event fields (PR title, issue body, commit message, head ref, `client_payload.*`) into workflow expressions.",
	},
	ubs_document_write: {
		name: "document.write XSS",
		description: "Detects `document.write(...)` / `document.writeln(...)` — XSS sink and render-blocking anti-pattern.",
	},
	ubs_outer_html_assignment: {
		name: "outerHTML assignment XSS",
		description: "Detects `<expr>.outerHTML = <value>` — equivalent XSS sink to `.innerHTML =`, but replaces the element itself.",
	},
	ubs_insert_adjacent_html: {
		name: "insertAdjacentHTML XSS",
		description: "Detects `.insertAdjacentHTML(position, htmlString)` — the second argument is parsed as HTML; attacker-controlled fragments become live DOM nodes.",
	},
	identical_conditional_branches: {
		name: "Identical Conditional Branches",
		description: "Detects an if/else or ternary whose branches are identical after comment/whitespace normalization — the condition has no effect. Brace-delimited languages; string literals preserved so differing literals stay distinct. Mirrors SonarQube S3923 / Clippy if_same_then_else.",
	},
};

describe("GENERIC_UBS_META exact string values", () => {
	for (const [key, expected] of Object.entries(EXPECTED)) {
		it(`${key} has the exact name and description`, () => {
			expect(GENERIC_UBS_META[key]?.name, `${key}.name`).toBe(expected.name);
			expect(GENERIC_UBS_META[key]?.description, `${key}.description`).toBe(expected.description);
		});
	}

	it("covers every key in GENERIC_UBS_META (no entry silently unassorted)", () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(GENERIC_UBS_META).sort());
	});
});
