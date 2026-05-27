// UBS (Plan 04) warning entries: language-specific bug-class detectors for
// JS/TS, Python, Java, Go, and C/C++, plus the package.json-script-paths and
// tsconfig-strictness manifest checks. Several Plan 04 D.1 entries carry
// severity=error but run in the pre_warn / post phases. Extracted from
// entries-warnings.ts — re-exported there as part of WARNING_ENTRIES.

import {
	checkAesEcbMode,
	checkDeeplyNestedCallback,
	checkDeferInLoop,
	checkDivisionByVariable,
	checkDocumentWrite,
	checkEvalInputTainted,
	checkFloatEquality,
	checkGithubActionsInjection,
	checkGoroutineNoWaitgroup,
	checkGoShellInjection,
	checkInsertAdjacentHtml,
	checkJavaOptionalGet,
	checkJsLooseEquality,
	checkLargeFunction,
	checkMagicNumberNoConst,
	checkNodeCreateCipher,
	checkNumericComparisonChain,
	checkOsSystemTainted,
	checkOuterHtmlAssignment,
	checkPackageJsonScriptPaths,
	checkPickleUntrustedLoad,
	checkPickleWrapperLoad,
	checkPrintDebugLeak,
	checkPyMutableDefaultArg,
	checkRegexInLoopNoCompile,
	checkScriptWithoutSri,
	checkSqlEscapeHatchNonLiteral,
	checkSqlStringConcat,
	checkTempfileMktempRace,
	checkTimeFormatLocaleDep,
	checkTorchUnsafeLoad,
	checkTsconfigStrictness,
	checkUbsStringConcatInLoop,
	checkUncheckedRedirect,
	checkUnsafeFormatString,
	checkXmlExternalEntity,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const UBS_ENTRIES: CheckRegistration[] = [
	// === UBS Plan 04 — rows 27–30 (warning/post tier) ===
	{
		id: "ubs_js_loose_equality",
		phase: "pre_warn",
		name: "UBS JS Loose Equality",
		description:
			"Detects `==` / `!=` in JS/TS files. The triple-equality form (`===` / `!==`) avoids JS type coercion. The `x == null` / `x != null` idiom is allowed (Plan 04 §4.2 documented exception).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `===` / `!==` instead of `==` / `!=`. Loose equality triggers JavaScript type coercion (`'' == 0`, `null == undefined`, `'1' == 1` are all true) and is a documented bug source. The one allowed loose form is `x == null`, which checks both null AND undefined in one expression.",
		fn: checkJsLooseEquality,
		resultsPropName: "jsLooseEquality",
		content_keywords: ["==", "!="],
	},
	{
		id: "ubs_float_equality",
		phase: "pre_warn",
		name: "UBS Float Equality",
		description:
			"Detects `===` / `!==` against a non-IEEE-safe float literal — floating-point representation makes direct comparison unreliable.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Float equality is unreliable due to IEEE 754 representation: `0.1 + 0.2 === 0.3` is false. Compare with an epsilon: `Math.abs(a - b) < 1e-9`. Values exactly representable in binary (0.0, 0.5, 1.0, etc.) are skipped by the detector.",
		fn: checkFloatEquality,
		resultsPropName: "floatEquality",
		content_keywords: ["==", "!="],
	},
	{
		id: "ubs_java_optional_get",
		phase: "post",
		name: "UBS Java Optional.get()",
		description:
			"Detects Java `Optional<T>....get()` without an `isPresent()` / `orElse(...)` guard — NullPointerException risk.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`Optional.get()` throws `NoSuchElementException` when the optional is empty. Guard with `isPresent()` first, or replace with `orElse(default)` / `orElseGet(() -> ...)` / `orElseThrow(() -> new IllegalStateException(...))`. The whole point of `Optional` is to make absence explicit; `.get()` discards that signal.",
		fn: checkJavaOptionalGet,
		resultsPropName: "javaOptionalGet",
		content_keywords: ["Optional"],
	},
	{
		id: "ubs_division_by_variable",
		phase: "post",
		name: "UBS Division by Variable",
		description:
			"Detects `expr / identifier` — the divisor variable might be zero (advisory; high FP rate, ships in DEFAULT_ADVISORY_SKIPS).",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Division by a variable can throw `Division by zero` (Python) / produce `Infinity` / `NaN` (JS) at runtime. Add an explicit zero-check (`if (divisor === 0) ...`) or assert the precondition before the division. If the divisor is provably non-zero by construction, leave a comment so cold readers don't repeat the analysis.",
		fn: checkDivisionByVariable,
		resultsPropName: "divisionByVariable",
	},
	// ---- Plan 04 D.1 partial — three high-leverage backlog entries. ----
	// `eval_usage` (entries-errors.ts) and `cross-language.ts:checkSqlInjection`
	// already pre_block on broad eval / SQL cases; the two `error`-severity
	// pre_warn entries below specialize on the tainted-input subset (non-
	// literal first arg / template-literal interpolation) and add extra
	// pre-event signal without flipping decision semantics. The third entry
	// is a Python-specific post warning.
	{
		id: "ubs_eval_input_tainted",
		phase: "pre_warn",
		name: "Eval / Function / exec on tainted input",
		description:
			"Detects eval / Function / exec / compile invoked with a non-literal first argument (likely a parameter or external value).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Evaluating attacker-controllable input as code is the most direct RCE pattern. If you genuinely need dynamic dispatch, keep the input on a strict allowlist (lookup table → preset function); never pass it to eval / Function / exec / compile.",
		fn: checkEvalInputTainted,
		resultsPropName: "evalInputTainted",
		content_keywords: ["eval", "Function", "exec", "compile"],
	},
	{
		id: "ubs_sql_string_concat",
		phase: "pre_warn",
		name: "SQL string concatenation",
		description:
			"Detects SQL keywords inside a quoted string immediately followed by JS/Py concatenation or template-literal interpolation — the canonical SQL-injection shape.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Use parameterized queries / prepared statements: `db.query('SELECT * WHERE id = $1', [id])`. Concatenating input into the SQL string is a SQLi vector even on internal queries — values that look safe today get reached by external code paths tomorrow.",
		fn: checkSqlStringConcat,
		resultsPropName: "sqlStringConcat",
		content_keywords: ["SELECT", "INSERT", "UPDATE", "DELETE"],
	},
	{
		id: "sql_escape_hatch_non_literal",
		phase: "pre_warn",
		name: "SQL escape hatch with non-literal",
		description:
			"Detects SQL libraries' `sql.unsafe(...)` / `sql.raw(...)` / `sql.lit(...)` escape hatch invoked with a non-literal argument — runtime expressions reach the unparameterized path, restoring the SQL-injection vector the library otherwise prevents. Mirrors Effect's `Statement` discipline: `sql.unsafe` is reserved for compile-time constants like schema names. Effect-TS lessons port.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Wrap the value as a parameter, not via the escape hatch: `` sql`SELECT * FROM users WHERE id = ${userId}` `` (Effect/Drizzle) or `db.query('... WHERE id = $1', [userId])` (node-postgres). The escape hatch (`sql.unsafe` / `sql.raw` / `sql.lit`) is for compile-time constants only — schema names, version strings, hand-audited DDL fragments — never for runtime values. If you genuinely need to interpolate a column or table name from a closed allow-list, do the validation explicitly and then `sql.unsafe('<the_validated_constant>')` with the literal still hard-coded after the check.",
		fn: checkSqlEscapeHatchNonLiteral,
		resultsPropName: "sqlEscapeHatchNonLiteral",
		content_keywords: [".unsafe", ".raw", ".lit"],
	},
	{
		id: "ubs_python_mutable_default_arg",
		phase: "post",
		name: "Python mutable default argument",
		description:
			"Detects `def f(x=[])` / `def f(x={})` — Python evaluates default values once at def time, sharing them across calls.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Python evaluates default-argument values exactly once, at function-def time. Mutable defaults (`[]`, `{}`, `set()`) are shared across every invocation — appending to a default list mutates state visible to the next caller. Use `def f(x=None): if x is None: x = []` instead.",
		fn: checkPyMutableDefaultArg,
		resultsPropName: "pyMutableDefaultArg",
		content_keywords: ["def "],
	},
	// ---- Plan 04 D.1 backlog (17 of 20) ----
	{
		id: "ubs_tempfile_mktemp_race",
		phase: "pre_warn",
		name: "Tempfile mktemp Race",
		description:
			"Detects Python `tempfile.mktemp(...)` — TOCTOU race; an attacker can substitute a symlink between the name return and open.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"`tempfile.mktemp()` only generates a name — the caller has to open the file separately, leaving a window where an attacker can substitute a symlink. Use `tempfile.NamedTemporaryFile()` / `tempfile.mkstemp()` which atomically open the file with O_EXCL.",
		fn: checkTempfileMktempRace,
		resultsPropName: "tempfileMktempRace",
		content_keywords: ["mktemp", "tempfile.mktemp"],
	},
	{
		id: "ubs_pickle_untrusted_load",
		phase: "pre_warn",
		name: "Pickle Untrusted Load",
		description:
			"Detects Python `pickle.load(...)` / `pickle.loads(...)` / `cPickle` — unpickling attacker-controlled bytes executes arbitrary `__reduce__` code.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"`pickle.load`/`loads` is effectively `eval` for bytes — a crafted pickle can run any Python code via `__reduce__`. For data interchange use JSON / msgpack; if you must use pickle, sign the payload (HMAC) and verify before unpickling, and only ever unpickle bytes you produced yourself.",
		fn: checkPickleUntrustedLoad,
		resultsPropName: "pickleUntrustedLoad",
		content_keywords: ["pickle.load", "pickle.loads", "cPickle"],
	},
	{
		id: "ubs_xml_external_entity",
		phase: "pre_warn",
		name: "XML External Entity",
		description:
			"Detects `xml.etree` / `xml.dom` / `xml.sax` / `lxml` imports without `defusedxml` — XXE attacks read arbitrary files / cause DoS via billion-laughs.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Python's stdlib XML parsers do NOT disable external-entity resolution by default — XXE attacks can exfiltrate `/etc/passwd` or cause DoS via billion-laughs expansion. Use `defusedxml` (which mirrors the same APIs but with safe defaults) instead of `xml.etree` / `xml.dom` / `xml.sax` / `lxml`.",
		fn: checkXmlExternalEntity,
		resultsPropName: "xmlExternalEntity",
		content_keywords: ["etree", "xml.dom", "xml.sax"],
	},
	{
		id: "ubs_os_system_tainted",
		phase: "pre_warn",
		name: "os.system / os.popen with tainted input",
		description:
			"Detects Python `os.system(name)` / `os.popen(name)` invoked with a non-literal first argument — command-injection vector.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"`os.system` / `os.popen` always go through `/bin/sh`, so any non-literal argument is a command-injection vector. Use `subprocess.run([\"cmd\", \"arg\"])` (list form) so the shell is bypassed, or shell-quote with `shlex.quote(...)` if a shell really is needed.",
		fn: checkOsSystemTainted,
		resultsPropName: "osSystemTainted",
		content_keywords: ["os.system", "os.popen"],
	},
	{
		id: "ubs_unsafe_format_string",
		phase: "pre_warn",
		name: "Unsafe Format String",
		description:
			"Detects C/C++ `printf` / `sprintf` / `fprintf` with a non-literal format argument — `%n` writes arbitrary memory; `%x` leaks stack.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"A user-controlled format string can leak stack memory (`%x`) or write arbitrary bytes (`%n`). Always pass a literal format spec and route the variable into the value position: `printf(\"%s\", input)`, never `printf(input)`.",
		fn: checkUnsafeFormatString,
		resultsPropName: "unsafeFormatString",
		content_keywords: ["printf(", "sprintf(", "fprintf("],
	},
	{
		id: "ubs_unchecked_redirect",
		phase: "pre_warn",
		name: "Unchecked Redirect",
		description:
			"Detects JS/TS `redirect(url)` / `location.href = url` / `window.location = url` with a non-literal URL — open-redirect vector.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Open-redirect bugs let attackers craft links that go through your domain before bouncing to a phishing site. Validate the redirect target against an allowlist or ensure it's a relative path (`url.startsWith('/')`) before redirecting.",
		fn: checkUncheckedRedirect,
		resultsPropName: "uncheckedRedirect",
		// Mirror EVERY trigger surface in the regex: `redirect(`,
		// `location.href`, AND `window.location`. Omitting any one form
		// turns the gate into a silent false-negative — a JS/TS edit that
		// only adds `window.location = nextUrl` would bypass the
		// pre_warn check. Audit pass: keep this list 1:1 with `callRe` in
		// `checkUncheckedRedirect` (`src/harness/checks/ubs-language-specific.ts`).
		content_keywords: ["redirect(", "location.href", "window.location"],
	},
	{
		id: "ubs_goroutine_no_waitgroup",
		phase: "post",
		name: "Goroutine without WaitGroup",
		description:
			"Detects Go `go func()` started without an accompanying `wg.Add` / `wg.Done` / errgroup — fire-and-forget leak risk.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A bare `go func() { ... }()` leaks if the caller exits before the goroutine completes — work is silently dropped. Pair with `sync.WaitGroup` / `errgroup.Group`, or pass a context the goroutine respects so the lifetime is explicit.",
		fn: checkGoroutineNoWaitgroup,
		resultsPropName: "goroutineNoWaitgroup",
		content_keywords: ["go func", "goroutine"],
	},
	{
		id: "ubs_defer_in_loop",
		phase: "post",
		name: "Defer in Loop",
		description:
			"Detects Go `defer` inside a `for` loop — defers run at function return, accumulating resources across iterations.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Go `defer` runs at FUNCTION return, not loop iteration. `for { f, _ := os.Open(...); defer f.Close() }` accumulates open file handles across every iteration. Wrap the loop body in a closure or a helper function, or close the handle inline before the next iteration.",
		fn: checkDeferInLoop,
		resultsPropName: "deferInLoop",
		content_keywords: ["defer ", "for "],
	},
	{
		id: "ubs_string_concat_in_loop",
		phase: "post",
		name: "String Concat in Loop",
		description:
			"Detects `result += chunk` inside a loop in immutable-string languages (Python, Java, JS, Go) — O(n²).",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`s += chunk` in a loop is O(n²) in Python / Java / JS / Go because each `+=` allocates a new string. Use a `list.append` + `''.join` (Python), `StringBuilder` (Java), `[].push` + `.join('')` (JS), or `strings.Builder` (Go).",
		fn: checkUbsStringConcatInLoop,
		resultsPropName: "ubsStringConcatInLoop",
	},
	{
		id: "ubs_numeric_comparison_chain",
		phase: "post",
		name: "Numeric Comparison Chain",
		description:
			"Detects 3+ consecutive `instanceof` / `compareTo` lines in Java — typically missing polymorphism.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A chain of `if (x instanceof A)` / `if (x instanceof B)` is a sign of missing polymorphism. Move the per-type behavior onto the types themselves and call a virtual method, or use a `switch` on a sealed/enum discriminant.",
		fn: checkNumericComparisonChain,
		resultsPropName: "numericComparisonChain",
		content_keywords: ["instanceof", "compareTo"],
	},
	{
		id: "ubs_print_debug_leak",
		phase: "post",
		name: "Print Debug Leak",
		description:
			"Detects `console.log` / Python `print(...)` / Go `fmt.Println` left in non-test, non-CLI code — typically forgotten debug breadcrumbs.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`console.log` / `print` / `fmt.Println` left in library code is almost always a forgotten debug print. Use a structured logger (with a level) so the noise can be filtered, or remove the line if it was just a breadcrumb.",
		fn: checkPrintDebugLeak,
		resultsPropName: "printDebugLeak",
		content_keywords: ["console.log", "print(", "fmt.Println"],
	},
	// `ubs_hardcoded_localhost` was promoted to pre_block / error severity in
	// Phase 1 of the agent-quality rollout (see docs/plans/11-...md). After
	// the extension-gate tightening landed alongside the promotion, the
	// check's FP rate dropped to ~0 against the dogfood corpus. Entry now
	// lives in `entries-errors.ts`.
	{
		id: "ubs_magic_number_no_const",
		phase: "post",
		name: "Magic Number No Const",
		description:
			"Detects 3+ digit numeric literals in expression context (not initializer) — magic numbers without a named constant.",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`setTimeout(fn, 5000)` tells nobody what `5000` represents. Hoist into a named constant (`const RETRY_DELAY_MS = 5000`) so cold readers see intent without grepping for the value.",
		fn: checkMagicNumberNoConst,
		resultsPropName: "magicNumberNoConst",
	},
	{
		id: "ubs_large_function",
		phase: "post",
		name: "Large Function",
		description:
			"Detects a single function spanning 80+ body lines — review/refactor candidate.",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Functions over ~80 lines stretch the cold-reader's working memory. Extract internal stages (parse / validate / dispatch / serialize) into helpers with names that explain what each stage does.",
		fn: checkLargeFunction,
		resultsPropName: "largeFunction",
	},
	{
		id: "ubs_deeply_nested_callback",
		phase: "post",
		name: "Deeply Nested Callback",
		description:
			"Detects 4+ levels of nested function/arrow callbacks — callback-hell smell.",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Nesting 4+ callbacks deep is callback hell. Refactor with `async`/`await`, `Promise.all`, or extract each level into a named function so the structure is grep-able and the failure modes are isolatable.",
		fn: checkDeeplyNestedCallback,
		resultsPropName: "deeplyNestedCallback",
		content_keywords: ["function", "=>"],
	},
	{
		id: "ubs_time_format_locale_dep",
		phase: "post",
		name: "Time Format Locale Dependent",
		description:
			"Detects JS `toLocaleString()` / Java `DateTimeFormatter.ofLocalized*` without an explicit locale — formatting drifts by environment.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`date.toLocaleString()` (no args) or Java `DateTimeFormatter.ofLocalized*` (no `withLocale`) produces different strings depending on the JVM/Node locale. Pass an explicit locale (`'en-US'`) or use a fixed pattern (ISO-8601) when serializing for storage / wire formats.",
		fn: checkTimeFormatLocaleDep,
		resultsPropName: "timeFormatLocaleDep",
		content_keywords: ["toLocaleString", "DateTimeFormatter"],
	},
	{
		id: "ubs_regex_in_loop_no_compile",
		phase: "post",
		name: "Regex in Loop No Compile",
		description:
			"Detects Python `re.match` / `re.search` / `re.sub` inside a loop without `re.compile` — recompiles per iteration.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Calling `re.match(pattern, ...)` inside a loop recompiles `pattern` on every iteration. Hoist `re.compile(pattern)` outside the loop and call `pattern.match(...)` per iteration — Python caches compilations but the cache lookup itself is overhead.",
		fn: checkRegexInLoopNoCompile,
		resultsPropName: "regexInLoopNoCompile",
		content_keywords: ["re.match", "re.search", "re.compile"],
	},
	{
		id: "package_json_script_paths",
		phase: "post",
		name: "Package JSON Script Paths",
		description:
			"Detects package.json scripts that reference files which don't exist on disk (node ./X.mjs, tsc -p X.json, --config X). Catches the universal CI failure where a manifest declares a script path the file tree doesn't have.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A package.json script references a file that doesn't exist. Either create the file at the referenced path, fix the path to point at an existing file, or remove the script if it's no longer needed. The script will fail the moment anyone runs it.",
		fn: checkPackageJsonScriptPaths,
		resultsPropName: "packageJsonScriptPaths",
	},
	{
		id: "tsconfig_strictness",
		phase: "post",
		name: "tsconfig Strictness",
		description:
			"Detects tsconfig*.json files missing high-leverage strictness flags (noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noImplicitReturns, noFallthroughCasesInSwitch). None of these are implied by `strict: true`; each catches a documented bug class the type system would otherwise let through.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add the named strictness flag(s) to `compilerOptions` in your tsconfig and set them to `true`. Each finding includes the one-line rationale for the specific flag. `strict: true` does NOT cover any of the five flags this check enforces — they need to be set explicitly. If you genuinely cannot enable a flag yet, set it to `false` explicitly in the tsconfig with a comment explaining why (this check looks for absence, not the false value).",
		fn: checkTsconfigStrictness,
		resultsPropName: "tsconfigStrictness",
		// The detector itself short-circuits on basename and `compilerOptions`
		// presence; this keyword gate avoids opening the function on the
		// thousands of unrelated .json files an edit-stream can touch.
		content_keywords: ["compilerOptions", "extends"],
	},
	{
		id: "ubs_aes_ecb_mode",
		phase: "pre_warn",
		name: "AES in ECB mode",
		description:
			"Detects AES used in ECB mode (Python `AES.MODE_ECB`, `cryptography` `modes.ECB`, Node `\"aes-N-ecb\"`, Go `cipher.NewECBEncrypter`). ECB leaks plaintext structure: identical blocks encrypt to identical ciphertext.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Use AES-GCM (authenticated encryption — provides confidentiality AND integrity) or AES-CBC with a separately-derived HMAC. ECB is unsafe for any data larger than one block because identical plaintext blocks produce identical ciphertext, leaking the plaintext's structure to an attacker.",
		fn: checkAesEcbMode,
		resultsPropName: "aesEcbMode",
		content_keywords: ["ECB", "ecb"],
	},
	{
		id: "ubs_torch_unsafe_load",
		phase: "pre_warn",
		name: "PyTorch unsafe load",
		description:
			"Detects `torch.load(...)` without an explicit `weights_only=True` argument. Older torch defaults `weights_only=False`, which unpickles arbitrary Python objects — a documented supply-chain RCE vector against model checkpoints.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Pass `weights_only=True` to `torch.load(...)`. This limits deserialization to plain tensor data and rejects pickled Python objects. If you genuinely need to load a non-tensor object from a checkpoint, you must trust the source — document that decision in a comment next to the call.",
		fn: checkTorchUnsafeLoad,
		resultsPropName: "torchUnsafeLoad",
		content_keywords: ["torch.load"],
	},
	{
		id: "ubs_pickle_wrapper_load",
		phase: "pre_warn",
		name: "Pickle wrapper load (joblib / pandas / numpy)",
		description:
			"Detects libraries that unpickle data without the word `pickle` in the call site: `joblib.load(...)`, `pandas.read_pickle(...)`, `numpy.load(..., allow_pickle=True)`. All execute attacker-controlled `__reduce__` code on untrusted input.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Treat any input passed to these APIs as code, not data. If the file is trusted (your own pipeline writes it), document that trust boundary in a comment. If the file comes from outside your trust boundary, switch to a schema-validated format (JSON, msgspec, protobuf). For numpy specifically: drop `allow_pickle=True` — the safe `.npy` format works without it.",
		fn: checkPickleWrapperLoad,
		resultsPropName: "pickleWrapperLoad",
		content_keywords: ["joblib", "read_pickle", "allow_pickle"],
	},
	{
		id: "ubs_node_create_cipher",
		phase: "pre_warn",
		name: "Node deprecated createCipher (no IV)",
		description:
			"Detects Node `crypto.createCipher(...)` / `createDecipher(...)` — derives the key via an MD5-based KDF with no IV. Removed entirely in Node 22; pre-22 code using it has a predictable, attacker-recoverable key schedule.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace with `crypto.createCipheriv(algorithm, key, iv)` / `createDecipheriv(...)`. Generate a fresh random IV per encryption with `crypto.randomBytes(16)` and store the IV alongside the ciphertext (the IV does not need to be secret, just unique).",
		fn: checkNodeCreateCipher,
		resultsPropName: "nodeCreateCipher",
		content_keywords: ["createCipher", "createDecipher"],
	},
	{
		id: "ubs_script_without_sri",
		phase: "pre_warn",
		name: "External script without Subresource Integrity",
		description:
			"Detects `<script src=\"https://...\">` referencing an external URL without an `integrity=\"sha...\"` attribute. If the CDN is compromised or substituted, the loaded code runs with full page privileges.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add `integrity=\"sha384-...\" crossorigin=\"anonymous\"` to the script tag. SRI ties the script content to a known hash, so a swapped file at the CDN fails to load instead of executing silently. Most CDNs (cdnjs, unpkg, jsDelivr) publish SRI hashes alongside their URLs.",
		fn: checkScriptWithoutSri,
		resultsPropName: "scriptWithoutSri",
		content_keywords: ["<script", "src="],
	},
	{
		id: "ubs_go_shell_injection",
		phase: "pre_warn",
		name: "Go exec.Command shell invocation",
		description:
			"Detects Go `exec.Command(\"sh\", \"-c\", ...)` / `exec.Command(\"bash\", ...)` (and the `/bin/sh` / `/bin/bash` forms). Routing the remaining arguments through a shell interpreter exposes command-injection on any user-input concatenated into the command string.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Pass the program and its arguments directly: `exec.Command(\"ping\", \"-c\", \"1\", host)`. With no shell in the pipeline, shell metacharacters in arguments are not interpreted, so command injection is eliminated entirely. Validate user input separately (parse to int, normalize file path, ParseIP for hostnames) — type-checking is cheap.",
		fn: checkGoShellInjection,
		resultsPropName: "goShellInjection",
		content_keywords: ["exec.Command"],
	},
	{
		id: "ubs_github_actions_injection",
		phase: "pre_warn",
		name: "GitHub Actions workflow injection",
		description:
			"Detects interpolation of attacker-controllable GitHub-event fields (PR title, issue body, commit message, head ref, `client_payload.*`) directly into workflow expressions. Inside a `run:` block this is direct command injection at the workflow's privilege level.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use env-var indirection: declare `env: TITLE: ${{ github.event.pull_request.title }}` at the step, then reference `$TITLE` inside `run:`. The shell quotes the variable expansion, so attacker-controlled text becomes data, not code. The unsafe pattern is direct interpolation `run: echo \"${{ github.event.* }}\"` — that text is parsed by the shell.",
		fn: checkGithubActionsInjection,
		resultsPropName: "githubActionsInjection",
		content_keywords: ["github.event", "github.head_ref"],
	},
	{
		id: "ubs_document_write",
		phase: "pre_warn",
		name: "document.write XSS",
		description:
			"Detects `document.write(...)` / `document.writeln(...)`. Both are XSS sinks when any part of the written content is attacker-controlled, and both block rendering as a side effect.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Build DOM nodes with `document.createElement`/`appendChild` for structured content, or set `textContent` for plain text. If you need to inject HTML and the source is trusted, use a sanitizer like DOMPurify and assign to `innerHTML` of a newly-created container — never `document.write`, which has no safe form.",
		fn: checkDocumentWrite,
		resultsPropName: "documentWrite",
		content_keywords: ["document.write"],
	},
	{
		id: "ubs_outer_html_assignment",
		phase: "pre_warn",
		name: "outerHTML assignment XSS",
		description:
			"Detects `<expr>.outerHTML = <value>`. Equivalent XSS sink to `.innerHTML =`, but replaces the element itself rather than its children.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"For plain text replacement, build a text node with `document.createTextNode(value)` and call `element.replaceWith(textNode)`. For HTML replacement, sanitize first (DOMPurify) and only then assign — or build the replacement DOM tree explicitly with `createElement`.",
		fn: checkOuterHtmlAssignment,
		resultsPropName: "outerHtmlAssignment",
		content_keywords: ["outerHTML"],
	},
	{
		id: "ubs_insert_adjacent_html",
		phase: "pre_warn",
		name: "insertAdjacentHTML XSS",
		description:
			"Detects `.insertAdjacentHTML(position, htmlString)`. The second argument is parsed as HTML, so any attacker-controlled fragment in the string becomes a live DOM node with script-execution potential.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"For plain text, use `insertAdjacentText(position, text)` — the text is inserted as a text node, not parsed. For HTML, sanitize the string with DOMPurify before insertion, or build the DOM tree explicitly with `createElement` + `insertAdjacentElement`.",
		fn: checkInsertAdjacentHtml,
		resultsPropName: "insertAdjacentHtml",
		content_keywords: ["insertAdjacentHTML"],
	},
];
