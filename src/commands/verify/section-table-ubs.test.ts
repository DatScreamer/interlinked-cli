// ===========================================
// section-table-ubs fragment tests
// ===========================================

import { describe, expect, it } from "vitest";
import { ubsSections } from "./section-table-ubs.js";

describe("ubsSections", () => {
	it("is non-empty", () => {
		expect(ubsSections.length).toBeGreaterThan(0);
	});

	it("each entry has well-formed fields", () => {
		for (const spec of ubsSections) {
			expect(typeof spec.label).toBe("string");
			expect(typeof spec.key).toBe("string");
			expect(typeof spec.noun).toBe("string");
			expect(typeof spec.passLabel).toBe("string");
			expect(["31", "33"].includes(spec.color)).toBe(true);
		}
	});

	it("opens with the UBS Plan 04 rows 27–30", () => {
		expect(ubsSections[0]?.key).toBe("jsLooseEquality");
		expect(ubsSections.map((s) => s.key)).toContain("divisionByVariable");
	});

	it("carries the critical-tier security signatures", () => {
		const keys = ubsSections.map((s) => s.key);
		expect(keys).toContain("subprocessShellTrue");
		expect(keys).toContain("pickleUntrustedLoad");
		expect(keys).toContain("weakHash");
		expect(keys).toContain("weakRandom");
	});

	it("ends with the identical-conditional-branches universal bug shape", () => {
		expect(ubsSections.at(-1)?.key).toBe("identicalConditionalBranches");
		// the D.2 pattern-parity XSS sinks remain (now just before it)
		expect(ubsSections.map((s) => s.key)).toContain("insertAdjacentHtml");
	});

	// Exact-equality snapshot on every field of every row. Any single-field
	// string mutation (label/key/noun/passLabel/color emptied or altered)
	// fails this — the typeof/toContain checks above are blind to that class
	// of mutation because an emptied string is still a string and the other
	// rows still satisfy the toContain assertions.
	it("matches the full declarative table exactly, field for field", () => {
		expect(ubsSections).toEqual([
			{
				label: "ubs js loose equality",
				key: "jsLooseEquality",
				noun: "loose `==` / `!=` comparisons in JS/TS",
				passLabel: "no loose equality (allowed: `x == null` idiom)",
				color: "33",
			},
			{
				label: "ubs float equality",
				key: "floatEquality",
				noun: "exact-equality comparisons against a float literal",
				passLabel: "no unsafe float equality",
				color: "33",
			},
			{
				label: "ubs java optional.get()",
				key: "javaOptionalGet",
				noun: "Java Optional.get() without isPresent/orElse guard",
				passLabel: "no unguarded Optional.get() calls",
				color: "33",
			},
			{
				label: "ubs rust debug_assert side effect",
				key: "rustDebugAssertSideEffect",
				noun: "Rust debug_assert* arguments with release-erased side effects",
				passLabel: "no side effects hidden in debug_assert*",
				color: "33",
			},
			{
				label: "ubs c assert side effect",
				key: "cAssertSideEffect",
				noun: "C/C++ assert() arguments erased under -DNDEBUG (release)",
				passLabel: "no side effects hidden in assert()",
				color: "33",
			},
			{
				label: "ubs python assert side effect",
				key: "pythonAssertSideEffect",
				noun: "Python assert operands stripped under python -O",
				passLabel: "no side effects hidden in Python assert",
				color: "33",
			},
			{
				label: "ubs java assert side effect",
				key: "javaAssertSideEffect",
				noun: "Java assert side effects skipped without -ea (JVM default OFF)",
				passLabel: "no side effects hidden in Java assert",
				color: "33",
			},
			{
				label: "ubs rust unchecked cast_slice",
				key: "rustUncheckedCastSlice",
				noun: "Rust byte-buffer reinterprets with no length/alignment proof (cast_slice panics on odd length)",
				passLabel: "no unchecked cast_slice reinterprets",
				color: "33",
			},
			{
				label: "unaligned reinterpret",
				key: "unalignedReinterpret",
				noun: "typed-array views over an ArrayBuffer with no byteLength % element-size guard",
				passLabel: "no unguarded buffer reinterprets",
				color: "33",
			},
			{
				label: "ubs division by variable",
				key: "divisionByVariable",
				noun: "divisions by an identifier (advisory)",
				passLabel: "no unguarded division by variable",
				color: "33",
			},
			{
				label: "ubs mutex lock unwrap",
				key: "mutexLockUnwrap",
				noun: "Mutex<T>...lock().unwrap() calls (panic on poisoned mutex)",
				passLabel: "no Mutex::lock().unwrap()",
				color: "31",
			},
			{
				label: "ubs subprocess shell=True",
				key: "subprocessShellTrue",
				noun: "subprocess.<fn>(..., shell=True) calls (command-injection vector)",
				passLabel: "no subprocess(..., shell=True)",
				color: "31",
			},
			{
				label: "ubs tls verify disabled",
				key: "tlsVerifyDisabled",
				noun: "TLS verification disabled (verify=False / InsecureSkipVerify / rejectUnauthorized)",
				passLabel: "TLS verification enabled everywhere",
				color: "31",
			},
			{
				label: "ubs python none equality",
				key: "pyNoneEquality",
				noun: "`x == None` / `x != None` comparisons (PEP 8: use `is None` / `is not None`)",
				passLabel: "no `== None` / `!= None`",
				color: "31",
			},
			{
				label: "ubs weak hash",
				key: "weakHash",
				noun: "MD5 / SHA-1 calls (broken hashes for security-bearing use)",
				passLabel: "no weak hashes",
				color: "31",
			},
			{
				label: "ubs weak random for security",
				key: "weakRandom",
				noun: "predictable PRNG output used as a token / key / nonce / salt / password",
				passLabel: "no weak RNG for secrets",
				color: "31",
			},
			{
				label: "ubs eval input tainted",
				key: "evalInputTainted",
				noun: "eval / Function / exec / compile invoked with non-literal first arg",
				passLabel: "no tainted eval / Function / exec",
				color: "31",
			},
			{
				label: "ubs sql string concat",
				key: "sqlStringConcat",
				noun: "SQL keyword in a quoted string with `+` / template-literal interpolation",
				passLabel: "no SQL string concatenation",
				color: "31",
			},
			{
				label: "sql escape hatch non-literal",
				key: "sqlEscapeHatchNonLiteral",
				noun: "sql.unsafe / sql.raw / sql.lit called with non-literal argument",
				passLabel: "no sql.unsafe with runtime expression",
				color: "33",
			},
			{
				label: "ubs py mutable default arg",
				key: "pyMutableDefaultArg",
				noun: "Python `def f(x=[])` / `def f(x={})` (mutable default shared across calls)",
				passLabel: "no Python mutable defaults",
				color: "33",
			},
			{
				label: "ubs tempfile mktemp race",
				key: "tempfileMktempRace",
				noun: "tempfile.mktemp() calls (TOCTOU race vector)",
				passLabel: "no tempfile.mktemp",
				color: "31",
			},
			{
				label: "ubs pickle untrusted load",
				key: "pickleUntrustedLoad",
				noun: "pickle.load / pickle.loads / cPickle calls (RCE on attacker bytes)",
				passLabel: "no pickle load/loads",
				color: "31",
			},
			{
				label: "ubs xml external entity",
				key: "xmlExternalEntity",
				noun: "xml.etree / xml.dom / xml.sax / lxml without defusedxml (XXE)",
				passLabel: "all XML parsing uses defusedxml",
				color: "31",
			},
			{
				label: "ubs os.system / os.popen tainted",
				key: "osSystemTainted",
				noun: "os.system(name) / os.popen(name) with non-literal arg (cmd injection)",
				passLabel: "no os.system / os.popen on tainted input",
				color: "31",
			},
			{
				label: "ubs unsafe format string",
				key: "unsafeFormatString",
				noun: "C/C++ printf / sprintf / fprintf with non-literal format",
				passLabel: "no unsafe format strings",
				color: "31",
			},
			{
				label: "ubs unchecked redirect",
				key: "uncheckedRedirect",
				noun: "JS redirect(url) / location.href = url with non-literal URL",
				passLabel: "no unchecked redirects",
				color: "31",
			},
			{
				label: "ubs goroutine no waitgroup",
				key: "goroutineNoWaitgroup",
				noun: "Go `go func()` without WaitGroup / errgroup",
				passLabel: "all goroutines synchronized",
				color: "33",
			},
			{
				label: "ubs defer in loop",
				key: "deferInLoop",
				noun: "Go `defer` inside a `for` loop (defers run at function return)",
				passLabel: "no defers inside loops",
				color: "33",
			},
			{
				label: "ubs string concat in loop",
				key: "ubsStringConcatInLoop",
				noun: "`result += chunk` inside a loop in immutable-string langs (O(n²))",
				passLabel: "no string concat in loop",
				color: "33",
			},
			{
				label: "ubs numeric comparison chain",
				key: "numericComparisonChain",
				noun: "Java 3+ consecutive instanceof / compareTo lines (missing polymorphism)",
				passLabel: "no numeric comparison chains",
				color: "33",
			},
			{
				label: "ubs print debug leak",
				key: "printDebugLeak",
				noun: "console.log / print / fmt.Println in non-test, non-CLI code",
				passLabel: "no print debug leaks",
				color: "33",
			},
			{
				label: "ubs hardcoded localhost",
				key: "ubsHardcodedLocalhost",
				noun: "localhost / 127.0.0.1 baked into source outside test/config/example",
				passLabel: "no hardcoded localhost",
				color: "33",
			},
			{
				label: "child process exec user input",
				key: "childProcessExecUserInput",
				noun: "Node child_process.exec/execSync/spawn with non-literal first arg",
				passLabel: "no tainted child_process invocations",
				color: "31",
			},
			{
				label: "mixed sync/async file api",
				key: "mixedSyncAsyncFileApi",
				noun: "function bodies mixing fs.*Sync with await fs.*",
				passLabel: "no mixed sync/async file APIs",
				color: "31",
			},
			{
				label: "cookie missing security flags",
				key: "cookieMissingSecurityFlags",
				noun: "Set-Cookie / cookies.set / res.cookie without httpOnly+secure",
				passLabel: "no insecure cookies",
				color: "31",
			},
			{
				label: "logger format user input",
				key: "loggerFormatUserInput",
				noun: "logger.<level>(req|ctx|input|user|...) — log-injection vector",
				passLabel: "no logger format-string injections",
				color: "31",
			},
			{
				label: "ubs magic number no const",
				key: "magicNumberNoConst",
				noun: "3+ digit numeric literals in expression context without named constant",
				passLabel: "no magic numbers without constants",
				color: "33",
			},
			{
				label: "ubs large function",
				key: "largeFunction",
				noun: "function spanning 80+ body lines",
				passLabel: "no large functions",
				color: "33",
			},
			{
				label: "ubs deeply nested callback",
				key: "deeplyNestedCallback",
				noun: "4+ levels of nested function/arrow callbacks",
				passLabel: "no deeply nested callbacks",
				color: "33",
			},
			{
				label: "ubs time format locale dep",
				key: "timeFormatLocaleDep",
				noun: "JS toLocaleString / Java DateTimeFormatter.ofLocalized* without explicit locale",
				passLabel: "all locale-dependent formatting is explicit",
				color: "33",
			},
			{
				label: "ubs regex in loop no compile",
				key: "regexInLoopNoCompile",
				noun: "Python re.match / re.search / re.sub inside loop without re.compile",
				passLabel: "no recompiled regex in loop",
				color: "33",
			},
			{
				label: "ubs marshal load",
				key: "marshalLoad",
				noun: "Python marshal.load(s) — pickle-equivalent RCE surface",
				passLabel: "no marshal.load(s) calls",
				color: "31",
			},
			{
				label: "ubs shelve open",
				key: "shelveOpen",
				noun: "Python shelve.open — pickle-backed persistent dict",
				passLabel: "no shelve.open calls",
				color: "31",
			},
			{
				label: "ubs yaml unsafe load",
				key: "yamlUnsafeLoad",
				noun: "PyYAML yaml.load without Safe loader or yaml.unsafe_load",
				passLabel: "no unsafe yaml.load calls",
				color: "31",
			},
			{
				label: "ubs torch unsafe load",
				key: "torchUnsafeLoad",
				noun: "PyTorch torch.load without weights_only=True",
				passLabel: "no unsafe torch.load calls",
				color: "33",
			},
			{
				label: "ubs pickle wrapper load",
				key: "pickleWrapperLoad",
				noun: "joblib.load / pandas.read_pickle / np.load(allow_pickle=True)",
				passLabel: "no pickle-wrapper loads",
				color: "33",
			},
			{
				label: "ubs aes ecb mode",
				key: "aesEcbMode",
				noun: "AES in ECB mode (leaks plaintext block structure)",
				passLabel: "no AES-ECB usage",
				color: "33",
			},
			{
				label: "ubs node create cipher",
				key: "nodeCreateCipher",
				noun: "Node deprecated createCipher / createDecipher (no IV)",
				passLabel: "no deprecated createCipher calls",
				color: "33",
			},
			{
				label: "ubs script without sri",
				key: "scriptWithoutSri",
				noun: "external <script src> without integrity= (SRI)",
				passLabel: "all external scripts have SRI",
				color: "33",
			},
			{
				label: "ubs go shell injection",
				key: "goShellInjection",
				noun: 'Go exec.Command("sh"|"bash"|...) shell-interpreter invocation',
				passLabel: "no go shell-interpreter execs",
				color: "33",
			},
			{
				label: "ubs github actions injection",
				key: "githubActionsInjection",
				noun: "GitHub Actions workflow interpolating attacker-controllable event fields",
				passLabel: "no workflow injection patterns",
				color: "33",
			},
			{
				label: "ubs document write",
				key: "documentWrite",
				noun: "document.write / document.writeln (XSS sink, render-blocking)",
				passLabel: "no document.write calls",
				color: "33",
			},
			{
				label: "ubs outer html assignment",
				key: "outerHtmlAssignment",
				noun: ".outerHTML = assignments (XSS sink)",
				passLabel: "no outerHTML assignments",
				color: "33",
			},
			{
				label: "ubs insert adjacent html",
				key: "insertAdjacentHtml",
				noun: ".insertAdjacentHTML(...) calls (XSS sink)",
				passLabel: "no insertAdjacentHTML calls",
				color: "33",
			},
			{
				label: "identical conditional branches",
				key: "identicalConditionalBranches",
				noun: "if/else or ternary with identical branches (condition has no effect)",
				passLabel: "no identical-branch conditionals",
				color: "33",
			},
		]);
	});
});
