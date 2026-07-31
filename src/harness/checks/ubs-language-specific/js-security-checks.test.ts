// Smoke tests for the JS/TS-security UBS detectors. The exhaustive red/green
// suites live in src/harness/__tests__/ubs-*.test.ts and exercise these via
// the ubs-language-specific.ts barrel; this colocated file covers the module
// surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkDocumentWrite,
	checkEvalInputTainted,
	checkInsertAdjacentHtml,
	checkLoggerFormatUserInput,
	checkMixedSyncAsyncFileApi,
	checkNodeCreateCipher,
	checkOuterHtmlAssignment,
	checkScriptWithoutSri,
	checkUncheckedRedirect,
} from "./js-security-checks.js";

describe("ubs-language-specific/js-security-checks", () => {
	it("checkEvalInputTainted flags eval with an identifier arg", () => {
		expect(checkEvalInputTainted("eval(userCode)", "a.js").length).toBeGreaterThan(0);
		expect(checkEvalInputTainted('eval("1+1")', "a.js")).toEqual([]);
	});

	it("checkEvalInputTainted does NOT flag eval/exec inside a Python docstring or comment (FP fix)", () => {
		// Multi-line triple-quoted docstring — the JS string-masker can't span it,
		// so the body used to read as code and FP on the quoted `eval(...)`.
		const docstring = `"""
Port of eval_from_even.py — it historically called eval(user_input).
"""
def even(x):
    return x % 2 == 0
`;
		expect(checkEvalInputTainted(docstring, "even.py")).toEqual([]);
		// Triple-single-quoted docstring + a # comment mentioning eval.
		expect(
			checkEvalInputTainted("def f():\n    '''avoid eval(x) — see eval_from_even.py'''\n    return 1\n", "even.py"),
		).toEqual([]);
		expect(checkEvalInputTainted("# previously used eval(s)\ndef even(x):\n    return x\n", "even.py")).toEqual([]);
		// Real eval/exec calls are still caught.
		expect(checkEvalInputTainted("def r(s):\n    return eval(s)\n", "even.py").length).toBeGreaterThan(0);
		expect(checkEvalInputTainted("def r(c):\n    exec(c)\n", "even.py").length).toBeGreaterThan(0);
	});

	it("checkChildProcessExecUserInput flags namespaced exec with a var arg", () => {
		const code = "child_process.exec(userInput)";
		expect(checkChildProcessExecUserInput(code, "a.js").length).toBeGreaterThan(0);
	});

	it("checkMixedSyncAsyncFileApi flags a function mixing sync and async fs", () => {
		const code =
			"async function f() {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n}";
		expect(checkMixedSyncAsyncFileApi(code, "a.js").length).toBeGreaterThan(0);
	});

	it("checkCookieMissingSecurityFlags flags res.cookie without flags", () => {
		expect(
			checkCookieMissingSecurityFlags('res.cookie("s", v)', "a.js").length,
		).toBeGreaterThan(0);
	});

	it("checkLoggerFormatUserInput flags logger.info with a request-bound arg", () => {
		expect(
			checkLoggerFormatUserInput("logger.info(req)", "a.js").length,
		).toBeGreaterThan(0);
	});

	it("checkUncheckedRedirect flags redirect with an identifier arg", () => {
		expect(checkUncheckedRedirect("redirect(url)", "a.js").length).toBeGreaterThan(0);
	});

	it("checkDocumentWrite flags document.write", () => {
		expect(checkDocumentWrite("document.write(html)", "a.ts").length).toBeGreaterThan(0);
		expect(checkDocumentWrite("document.body.appendChild(n)", "a.ts")).toEqual([]);
	});

	it("checkOuterHtmlAssignment flags `.outerHTML =`", () => {
		expect(checkOuterHtmlAssignment("el.outerHTML = h", "a.ts").length).toBeGreaterThan(0);
		expect(checkOuterHtmlAssignment("const x = el.outerHTML", "a.ts")).toEqual([]);
	});

	it("checkInsertAdjacentHtml flags `.insertAdjacentHTML(`", () => {
		expect(checkInsertAdjacentHtml("el.insertAdjacentHTML(p, h)", "a.ts").length).toBeGreaterThan(
			0,
		);
		expect(checkInsertAdjacentHtml("el.insertAdjacentText(p, t)", "a.ts")).toEqual([]);
	});

	it("checkNodeCreateCipher flags `createCipher(`", () => {
		expect(checkNodeCreateCipher("crypto.createCipher(k)", "a.ts").length).toBeGreaterThan(0);
		expect(checkNodeCreateCipher("crypto.createCipheriv(a, k, iv)", "a.ts")).toEqual([]);
	});

	it("checkScriptWithoutSri flags external script without integrity", () => {
		const yes = `<script src="https://cdn/lib.js"></script>`;
		expect(checkScriptWithoutSri(yes, "page.html").length).toBeGreaterThan(0);
		const no = `<script src="https://cdn/lib.js" integrity="sha384-x"></script>`;
		expect(checkScriptWithoutSri(no, "page.html")).toEqual([]);
	});

	it("all checks return empty for non-JS/TS files", () => {
		expect(checkEvalInputTainted("eval(x)", "a.go")).toEqual([]);
		expect(checkUncheckedRedirect("redirect(x)", "a.go")).toEqual([]);
	});
});

// ===========================================================================
// Branch-level red/green suites. Each detector gets MUST-FIRE cases (one per
// distinguishable branch) and MUST-NOT-FIRE cases (the legitimate shapes it
// must leave alone). These are security detectors on the pre_block/error tier,
// so a wrong MUST-NOT-FIRE silently disarms a gate — every negative below is
// a shape that is genuinely safe, not merely one the detector happens to miss.
// ===========================================================================

/** JS/TS extensions every detector in this module must accept. */
const JS_TS_EXTS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"] as const;
/** Extensions every detector in this module must ignore. */
const NON_JS_EXTS = [".go", ".rb", ".java"] as const;

const MIXED_FS_FN = "async function f() {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n}";

describe("checkEvalInputTainted — positive (must fire)", () => {
	for (const ext of JS_TS_EXTS) {
		it(`P: flags eval with an identifier arg in ${ext}`, () => {
			expect(checkEvalInputTainted("eval(userCode)", `src/app${ext}`)).toEqual([
				{ line: 1, text: "eval(userCode)" },
			]);
		});
	}

	it("P: flags Python eval/exec/compile in .py and .pyi", () => {
		for (const kw of ["eval", "exec", "compile"]) {
			expect(checkEvalInputTainted(`${kw}(user_input)`, "m.py")).toEqual([
				{ line: 1, text: `${kw}(user_input)` },
			]);
		}
	});

	it("P: flags an indented eval (the lookbehind excludes `.`/word chars, not whitespace)", () => {
		expect(checkEvalInputTainted("function f() {\n  eval(userCode);\n}", "src/app.js")).toEqual([
			{ line: 2, text: "eval(userCode);" },
		]);
	});

	it("P: flags eval with whitespace around the open paren", () => {
		expect(checkEvalInputTainted("eval (userCode)", "src/app.js")).toEqual([
			{ line: 1, text: "eval (userCode)" },
		]);
		expect(checkEvalInputTainted("eval( userCode)", "src/app.js")).toEqual([
			{ line: 1, text: "eval( userCode)" },
		]);
		// The Python pattern is a separate literal and needs the same tolerance.
		expect(checkEvalInputTainted("eval (user_input)", "m.py")).toEqual([
			{ line: 1, text: "eval (user_input)" },
		]);
		expect(checkEvalInputTainted("eval( user_input)", "m.py")).toEqual([
			{ line: 1, text: "eval( user_input)" },
		]);
	});

	it("P: flags a single-character identifier argument", () => {
		expect(checkEvalInputTainted("eval(x)", "src/app.js")).toEqual([{ line: 1, text: "eval(x)" }]);
	});

	it("P: flags `Function(body)` in JS but not in Python", () => {
		expect(checkEvalInputTainted("Function(body)", "src/app.js")).toEqual([
			{ line: 1, text: "Function(body)" },
		]);
		expect(checkEvalInputTainted("Function(body)", "m.py")).toEqual([]);
	});

	it("P: a `#` inside a JS string is not a comment (JS content skips the Python pre-pass)", () => {
		const src = 'const id = "#main"; eval(userCode);';
		expect(checkEvalInputTainted(src, "src/app.js")).toEqual([{ line: 1, text: src }]);
	});

	it("P: reports the post-docstring line number (docstring blanking preserves newlines)", () => {
		expect(checkEvalInputTainted('"""\nd1\nd2\nd3\n"""\nr = eval(s)\n', "m.py")).toEqual([
			{ line: 6, text: "r = eval(s)" },
		]);
	});

	it("P: docstring blanking preserves LENGTH, so a following call keeps its lookbehind context", () => {
		// `abc"""x"""eval(y)`: with length-preserving blanking the char before
		// `eval` is a space, so the `(?<![.\w])` lookbehind passes. If blanking
		// collapsed the docstring instead, `abc` would abut `eval` and the call
		// would be missed.
		expect(checkEvalInputTainted('abc"""x"""eval(y)\n', "m.py")).toEqual([
			{ line: 1, text: 'abc"""x"""eval(y)' },
		]);
	});

	it("P: a `# noqa` code that maps to a different check does NOT suppress", () => {
		expect(checkEvalInputTainted("r = eval(s)  # noqa: S608\n", "m.py")).toEqual([
			{ line: 1, text: "r = eval(s)  # noqa: S608" },
		]);
	});

	it("P: caps findings at 10 and trims/truncates the reported text", () => {
		const many = Array.from({ length: 12 }, () => "eval(userCode);").join("\n");
		expect(checkEvalInputTainted(many, "src/app.js")).toHaveLength(10);
		const long = `   eval(${"z".repeat(200)});`;
		expect(checkEvalInputTainted(long, "src/app.js")).toEqual([
			{ line: 1, text: long.trim().slice(0, 150) },
		]);
	});
});

describe("checkEvalInputTainted — negative (must not fire)", () => {
	for (const ext of NON_JS_EXTS) {
		it(`N: ignores ${ext}`, () => {
			expect(checkEvalInputTainted("eval(userCode)", `src/app${ext}`)).toEqual([]);
		});
	}

	it("N: ignores test files and vendored/fixture trees", () => {
		expect(checkEvalInputTainted("eval(userCode)", "src/app.test.js")).toEqual([]);
		expect(checkEvalInputTainted("eval(userCode)", "node_modules/p/a.js")).toEqual([]);
	});

	it("N: ignores string-literal arguments in every quote style", () => {
		expect(checkEvalInputTainted('eval("1+1")', "src/app.js")).toEqual([]);
		expect(checkEvalInputTainted("eval('1+1')", "src/app.js")).toEqual([]);
		expect(checkEvalInputTainted("eval(`1+1`)", "src/app.js")).toEqual([]);
		expect(checkEvalInputTainted("eval(1 + 1)", "src/app.js")).toEqual([]);
	});

	it("N: ignores member-call and identifier-prefix forms", () => {
		expect(checkEvalInputTainted("re.exec(input)", "m.py")).toEqual([]);
		expect(checkEvalInputTainted("re.compile(input)", "m.py")).toEqual([]);
		expect(checkEvalInputTainted("fooeval(x)", "src/app.js")).toEqual([]);
	});

	it("N: JS `exec`/`compile` are not the eval class (child_process / no such global)", () => {
		expect(checkEvalInputTainted("exec(cmd)", "src/app.js")).toEqual([]);
		expect(checkEvalInputTainted("compile(src)", "src/app.js")).toEqual([]);
	});

	it("N: a multi-line ''' docstring mentioning eval is prose, not code", () => {
		expect(
			checkEvalInputTainted("'''\neval(user_input) is unsafe.\n'''\ndef f(x):\n    return x\n", "m.py"),
		).toEqual([]);
	});

	it("N: a docstring containing a lone quote is still fully blanked", () => {
		// Blanking every character (not just newlines) keeps the stray `"` from
		// re-pairing with the closing triple quote and exposing the prose call.
		expect(
			checkEvalInputTainted('"""\na lone " quote, then eval(user_input).\n"""\ndef f(x):\n    return x\n', "m.py"),
		).toEqual([]);
	});

	it("N: a Python string containing `eval(...)` is data, not a call", () => {
		expect(checkEvalInputTainted('msg = "eval(userInput) is bad"\n', "m.py")).toEqual([]);
	});

	it("N: honours a bare `# noqa` and the mapped `S307` code", () => {
		expect(checkEvalInputTainted("r = eval(s)  # noqa\n", "m.py")).toEqual([]);
		expect(checkEvalInputTainted("r = eval(s)  # noqa: S307\n", "m.py")).toEqual([]);
	});
});

describe("checkChildProcessExecUserInput — positive (must fire)", () => {
	for (const ext of JS_TS_EXTS) {
		it(`P: flags namespaced exec in ${ext}`, () => {
			expect(checkChildProcessExecUserInput("child_process.exec(userInput)", `src/app${ext}`)).toEqual([
				{ line: 1, text: "child_process.exec(userInput)" },
			]);
		});
	}

	it("P: flags every namespace × function pair", () => {
		for (const ns of ["child_process", "childProcess", "cp"]) {
			for (const fn of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]) {
				expect(checkChildProcessExecUserInput(`${ns}.${fn}(userInput)`, "src/app.js")).toEqual([
					{ line: 1, text: `${ns}.${fn}(userInput)` },
				]);
			}
		}
	});

	it("P: tolerates whitespace around the open paren", () => {
		expect(checkChildProcessExecUserInput("cp.exec (userInput)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec (userInput)" },
		]);
		expect(checkChildProcessExecUserInput("cp.exec( userInput)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec( userInput)" },
		]);
	});

	it("P: flags a single-character identifier argument", () => {
		expect(checkChildProcessExecUserInput("cp.exec(x)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec(x)" },
		]);
	});

	it("P: flags an interpolated template literal (shell string built from a variable)", () => {
		expect(checkChildProcessExecUserInput("cp.exec(`ls ${dir}`)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec(`ls ${dir}`)" },
		]);
	});

	it("P: the template pass tolerates whitespace around the open paren too", () => {
		expect(checkChildProcessExecUserInput("cp.exec (`ls ${dir}`)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec (`ls ${dir}`)" },
		]);
		expect(checkChildProcessExecUserInput("cp.exec( `ls ${dir}`)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec( `ls ${dir}`)" },
		]);
	});

	it("P: flags an interpolated template containing escaped backticks", () => {
		const before = "cp.exec(`echo \\`date\\` ${x}`)";
		expect(checkChildProcessExecUserInput(before, "src/app.js")).toEqual([
			{ line: 1, text: before },
		]);
		const after = "cp.exec(`${x} \\`done\\``)";
		expect(checkChildProcessExecUserInput(after, "src/app.js")).toEqual([
			{ line: 1, text: after },
		]);
	});

	it("P: flags an interpolated template spanning a backslash line continuation", () => {
		expect(checkChildProcessExecUserInput("cp.exec(`ls \\\n${dir}`)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec(`ls \\" },
		]);
		// …and a continuation on the far side of the interpolation.
		expect(checkChildProcessExecUserInput("cp.exec(`${dir} \\\n ls`)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec(`${dir} \\" },
		]);
	});

	it("P: reports the real line number for both the identifier and template forms", () => {
		expect(
			checkChildProcessExecUserInput("const a = 1;\nconst b = 2;\ncp.exec(userInput);", "src/app.js"),
		).toEqual([{ line: 3, text: "cp.exec(userInput);" }]);
		expect(
			checkChildProcessExecUserInput("const a = 1;\nconst b = 2;\ncp.exec(`ls ${dir}`);", "src/app.js"),
		).toEqual([{ line: 3, text: "cp.exec(`ls ${dir}`);" }]);
	});

	it("P: reports one finding per line when both forms hit the same line", () => {
		expect(checkChildProcessExecUserInput("cp.exec(cmd); cp.exec(`ls ${d}`);", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec(cmd); cp.exec(`ls ${d}`);" },
		]);
	});

	it("P: caps findings at 10 on both scan passes and trims/truncates the text", () => {
		expect(
			checkChildProcessExecUserInput(
				Array.from({ length: 12 }, () => "cp.exec(userInput);").join("\n"),
				"src/app.js",
			),
		).toHaveLength(10);
		expect(
			checkChildProcessExecUserInput(
				Array.from({ length: 12 }, () => "cp.exec(`ls ${d}`);").join("\n"),
				"src/app.js",
			),
		).toHaveLength(10);
		const long = `   cp.exec(${"w".repeat(200)});`;
		expect(checkChildProcessExecUserInput(long, "src/app.js")).toEqual([
			{ line: 1, text: long.trim().slice(0, 150) },
		]);
		// The template pass renders its own text and needs the same treatment.
		const longTpl = `   cp.exec(\`ls \${${"w".repeat(200)}}\`);`;
		expect(checkChildProcessExecUserInput(longTpl, "src/app.js")).toEqual([
			{ line: 1, text: longTpl.trim().slice(0, 150) },
		]);
	});
});

describe("checkChildProcessExecUserInput — negative (must not fire)", () => {
	for (const ext of [...NON_JS_EXTS, ".py"]) {
		it(`N: ignores ${ext}`, () => {
			expect(checkChildProcessExecUserInput("child_process.exec(userInput)", `src/app${ext}`)).toEqual([]);
		});
	}

	it("N: ignores test files", () => {
		expect(checkChildProcessExecUserInput("child_process.exec(userInput)", "src/app.test.js")).toEqual([]);
	});

	it("N: a hardcoded command string is not the user-input form", () => {
		expect(checkChildProcessExecUserInput('cp.exec("ls -la")', "src/app.js")).toEqual([]);
		expect(checkChildProcessExecUserInput("cp.exec('ls -la')", "src/app.js")).toEqual([]);
		expect(checkChildProcessExecUserInput("cp.exec(`ls -la`)", "src/app.js")).toEqual([]);
	});

	it("N: requires a word boundary before the namespace", () => {
		expect(checkChildProcessExecUserInput("mycp.exec(userInput)", "src/app.js")).toEqual([]);
	});

	it("N: a commented-out call is not code", () => {
		expect(checkChildProcessExecUserInput("// cp.exec(`ls ${d}`)\nconst a = 1;", "src/app.js")).toEqual([]);
		expect(checkChildProcessExecUserInput("// cp.exec(userInput)\nconst a = 1;", "src/app.js")).toEqual([]);
	});
});

describe("checkMixedSyncAsyncFileApi — positive (must fire)", () => {
	for (const ext of JS_TS_EXTS) {
		it(`P: flags a mixed function in ${ext}`, () => {
			expect(checkMixedSyncAsyncFileApi(MIXED_FS_FN, `src/app${ext}`)).toEqual([
				{ line: 3, text: "await fs.readFile(q);" },
			]);
		});
	}

	it("P: flags every fs API name in the mixed set", () => {
		const apis = [
			"readFile", "writeFile", "readdir", "stat", "lstat", "open",
			"close", "unlink", "mkdir", "rmdir", "rm", "rename", "copyFile",
			"chmod", "chown", "appendFile", "access", "readlink", "symlink",
		];
		for (const api of apis) {
			expect(
				checkMixedSyncAsyncFileApi(
					`async function f() {\n  fs.${api}Sync(p);\n  await fs.${api}(q);\n}`,
					"src/app.js",
				),
			).toEqual([{ line: 3, text: `await fs.${api}(q);` }]);
		}
	});

	it("P: flags the `fsp` alias as well as `fs`", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"async function f() {\n  fsp.readFileSync(p);\n  await fsp.readFile(q);\n}",
				"src/app.js",
			),
		).toEqual([{ line: 3, text: "await fsp.readFile(q);" }]);
	});

	it("P: finds a body that opens immediately after `)` with no whitespace", () => {
		const src = "async function f(){fs.readFileSync(p); await fs.readFile(q);}";
		expect(checkMixedSyncAsyncFileApi(src, "src/app.js")).toEqual([{ line: 1, text: src }]);
	});

	it("P: finds a body behind a TypeScript return-type annotation", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"async function f(): Promise<void> {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n}",
				"src/app.ts",
			),
		).toEqual([{ line: 3, text: "await fs.readFile(q);" }]);
	});

	it("P: a nested `{ … }` block does not truncate the enclosing body", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"async function f() {\n  fs.readFileSync(p);\n  if (x) {\n    g();\n  }\n  await fs.readFile(q);\n}",
				"src/app.js",
			),
		).toEqual([{ line: 6, text: "await fs.readFile(q);" }]);
	});

	it("P: a class method body is scoped correctly and does not swallow the class brace", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"class A {\n  async m() {\n    fs.readFileSync(p);\n    await fs.readFile(q);\n  }\n}",
				"src/app.js",
			),
		).toEqual([{ line: 4, text: "await fs.readFile(q);" }]);
	});

	it("P: detection does not depend on the file's trailing token", () => {
		// Body discovery must look at the text around each candidate brace, not
		// at the end of the whole file — a trailing `.do` property access is not
		// a control-flow keyword.
		expect(
			checkMixedSyncAsyncFileApi(
				"async function f() {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n}\nexport const mode = flags.do\n",
				"src/app.js",
			),
		).toEqual([{ line: 3, text: "await fs.readFile(q);" }]);
	});

	it("P: masking a nested helper keeps the parent's line numbers intact", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"async function f() {\n  fs.readFileSync(p);\n  const g = () => {\n    h();\n  };\n  await fs.readFile(q);\n}",
				"src/app.js",
			),
		).toEqual([{ line: 6, text: "await fs.readFile(q);" }]);
	});

	it("P: reports one finding per line and caps at 10, trimming/truncating the text", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"async function a(){ fs.readFileSync(p); await fs.readFile(q); } async function b(){ fs.readFileSync(p); await fs.readFile(q); }",
				"src/app.js",
			),
		).toHaveLength(1);
		expect(
			checkMixedSyncAsyncFileApi(
				Array.from(
					{ length: 12 },
					(_, i) => `async function f${i}() { fs.readFileSync(p); await fs.readFile(q); }`,
				).join("\n"),
				"src/app.js",
			),
		).toHaveLength(10);
		const long = `async function f() {\n  fs.readFileSync(p);\n\t  await fs.readFile(${"v".repeat(200)});\n}`;
		expect(checkMixedSyncAsyncFileApi(long, "src/app.js")).toEqual([
			{ line: 3, text: long.split("\n")[2]?.trim().slice(0, 150) },
		]);
	});

	// --- control-keyword guard, all four axes -------------------------------
	// `findFunctionBodies` skips a `) {` whose preceding text ENDS in a
	// control-flow keyword, so that `if (…) {` is not mistaken for a function
	// body. Each case below is a genuinely mixed function that MUST be flagged;
	// together they pin the guard's regex shape, its `)`-only application, its
	// 32-character lookback window, and its `continue`.

	it("P: an await inside an `if (obj.do) {` block is still attributed to the enclosing function", () => {
		// `obj.do` ends the if-condition, so the `$`-anchored keyword guard
		// fires and the if-block is (correctly) NOT treated as a function body.
		// The mix therefore belongs to `f`, and dropping/loosening the guard
		// would mask the await into a phantom body and lose the finding.
		expect(
			checkMixedSyncAsyncFileApi(
				"async function f() {\n  fs.readFileSync(p);\n  if (obj.do) {\n    await fs.readFile(q);\n  }\n}",
				"src/app.js",
			),
		).toEqual([{ line: 4, text: "await fs.readFile(q);" }]);
	});

	it("P: a default parameter reading through a keyword-named property is a function, not control flow", () => {
		// `obj.do.x` contains `do` but does NOT end in it. The guard is anchored
		// (`\s*$`) precisely so that a keyword merely APPEARING in the lookback
		// window cannot suppress a real function body.
		expect(
			checkMixedSyncAsyncFileApi(
				"async function f(a = obj.do.x) {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n}",
				"src/app.js",
			),
		).toEqual([{ line: 3, text: "await fs.readFile(q);" }]);
	});

	it("P: an arrow body is never suppressed by the control-keyword guard", () => {
		// `$do` is a legal identifier and `$` is not a `\w`, so `\bdo\s*$`
		// matches the text before `=>`. The guard is deliberately applied ONLY
		// to `)` matches, so the arrow body must still be scanned.
		expect(
			checkMixedSyncAsyncFileApi(
				"const g = async $do => {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n};",
				"src/app.js",
			),
		).toEqual([{ line: 3, text: "await fs.readFile(q);" }]);
	});

	it("P: a keyword-named property beyond the 32-character lookback does not suppress the body", () => {
		// 30 spaces push `obj.switch` out of the bounded window, so the guard
		// cannot see it. Widening the window to the whole prefix would suppress
		// this real finding.
		const src = `async function f(a = obj.switch${" ".repeat(30)}) {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n}`;
		expect(checkMixedSyncAsyncFileApi(src, "src/app.js")).toEqual([
			{ line: 3, text: "await fs.readFile(q);" },
		]);
	});

	it("P: masking a nested block must not consume the character AFTER its closing brace", () => {
		// Compact formatting puts `fs.readFileSync(` immediately after the
		// nested block's `}`. The mask covers the block INTERIOR only; eating
		// one character past `}` would blank the leading `f` and lose the mix.
		const src = "async function f(){if(x){g();}fs.readFileSync(p);await fs.readFile(q);}";
		expect(checkMixedSyncAsyncFileApi(src, "src/app.js")).toEqual([{ line: 1, text: src }]);
	});
});

describe("checkMixedSyncAsyncFileApi — negative (must not fire)", () => {
	for (const ext of [...NON_JS_EXTS, ".py"]) {
		it(`N: ignores ${ext}`, () => {
			expect(checkMixedSyncAsyncFileApi(MIXED_FS_FN, `src/app${ext}`)).toEqual([]);
		});
	}

	it("N: ignores test files", () => {
		expect(checkMixedSyncAsyncFileApi(MIXED_FS_FN, "src/app.test.js")).toEqual([]);
	});

	it("N: sync-only and async-only functions are not mixed", () => {
		expect(checkMixedSyncAsyncFileApi("function f() {\n  fs.readFileSync(p);\n}", "src/app.js")).toEqual([]);
		expect(
			checkMixedSyncAsyncFileApi("async function f() {\n  await fs.readFile(q);\n}", "src/app.js"),
		).toEqual([]);
	});

	it("N: sibling helpers each using one style are not cross-flagged", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"function a() {\n  fs.readFileSync(p);\n}\nasync function b() {\n  await fs.readFile(q);\n}",
				"src/app.js",
			),
		).toEqual([]);
	});

	it("N: a nested helper's await does not taint its parent", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"function outer() {\n  fs.readFileSync(p);\n  const g = async () => { await fs.readFile(q); };\n}",
				"src/app.js",
			),
		).toEqual([]);
	});

	it("N: module-level sync work plus an async function is not one mixed function", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"fs.readFileSync(p);\nasync function f() {\n  await fs.readFile(q);\n}",
				"src/app.js",
			),
		).toEqual([]);
	});

	it("N: a callback-style async call is not the `await` form", () => {
		expect(
			checkMixedSyncAsyncFileApi("function f() {\n  fs.readFileSync(p);\n  fs.readFile(q, cb);\n}", "src/app.js"),
		).toEqual([]);
	});

	it("N: a non-fs module with the same method names is not flagged", () => {
		expect(
			checkMixedSyncAsyncFileApi(
				"async function f() {\n  cache.readFileSync(p);\n  await cache.readFile(q);\n}",
				"src/app.js",
			),
		).toEqual([]);
	});

	it("N: an unbalanced/truncated body yields no function range at all", () => {
		expect(
			checkMixedSyncAsyncFileApi("async function f() {\n  fs.readFileSync(p);\n  await fs.readFile(q);", "src/app.js"),
		).toEqual([]);
	});
});

describe("checkCookieMissingSecurityFlags — positive (must fire)", () => {
	for (const ext of JS_TS_EXTS) {
		it(`P: flags a flagless res.cookie in ${ext}`, () => {
			expect(checkCookieMissingSecurityFlags('res.cookie("s", v);', `src/app${ext}`)).toEqual([
				{ line: 1, text: 'res.cookie("s", v);' },
			]);
		});
	}

	it("P: flags `cookies.set` as well as `res.cookie`, with or without a space", () => {
		expect(checkCookieMissingSecurityFlags('cookies.set("s", v);', "src/app.js")).toEqual([
			{ line: 1, text: 'cookies.set("s", v);' },
		]);
		expect(checkCookieMissingSecurityFlags('res.cookie ("s", v);', "src/app.js")).toEqual([
			{ line: 1, text: 'res.cookie ("s", v);' },
		]);
	});

	it("P: one missing flag is still a finding", () => {
		expect(checkCookieMissingSecurityFlags('res.cookie("s", v, { httpOnly: true });', "src/app.js")).toEqual([
			{ line: 1, text: 'res.cookie("s", v, { httpOnly: true });' },
		]);
		expect(checkCookieMissingSecurityFlags('res.cookie("s", v, { secure: true });', "src/app.js")).toEqual([
			{ line: 1, text: 'res.cookie("s", v, { secure: true });' },
		]);
	});

	it("P: flags are read from the options OBJECT, not from a neighbouring one", () => {
		// The call itself has no options object; the secure-looking object on the
		// next line belongs to something else and must not clear the finding.
		expect(
			checkCookieMissingSecurityFlags(
				'res.cookie("s", v);\nconst opts = { httpOnly: true, secure: true };\n',
				"src/app.js",
			),
		).toEqual([{ line: 1, text: 'res.cookie("s", v);' }]);
	});

	it("P: flag-looking text inside a string VALUE does not count as an option", () => {
		const src = 'res.cookie("s", "httpOnly: true; secure: true");';
		expect(checkCookieMissingSecurityFlags(src, "src/app.js")).toEqual([{ line: 1, text: src }]);
		// Same, but with a real (flagless) options object present: only the
		// object's own contents may clear the finding.
		const withOpts = 'res.cookie("s", "httpOnly: true; secure: true", { path: "/" });';
		expect(checkCookieMissingSecurityFlags(withOpts, "src/app.js")).toEqual([
			{ line: 1, text: withOpts },
		]);
		// …and when the options object is unterminated, the fallback still reads
		// only from the brace onward, never the whole argument list.
		const unterminated = 'res.cookie("s", "httpOnly: true; secure: true", { path: "/");';
		expect(checkCookieMissingSecurityFlags(unterminated, "src/app.js")).toEqual([
			{ line: 1, text: unterminated },
		]);
	});

	it("P: reports the real line number", () => {
		expect(
			checkCookieMissingSecurityFlags('const a = 1;\nconst b = 2;\nres.cookie("s", v);\n', "src/app.js"),
		).toEqual([{ line: 3, text: 'res.cookie("s", v);' }]);
	});

	it("P: flags a Set-Cookie header written through setHeader, however spaced", () => {
		for (const src of [
			'res.setHeader("Set-Cookie", "a=b; Path=/");',
			'res.setHeader("Set-Cookie","a=b; Path=/");',
			"res.setHeader ( 'Set-Cookie' , 'a=b; Path=/' );",
			"res.setHeader(`Set-Cookie`, `a=b; Path=/`);",
			'setHeader("Set-Cookie", "a=b; Path=/");',
		]) {
			expect(checkCookieMissingSecurityFlags(src, "src/app.js")).toEqual([{ line: 1, text: src }]);
		}
	});

	it("P: header flags must match on a word boundary", () => {
		for (const src of [
			'res.setHeader("Set-Cookie", "a=b; NotHttpOnly; Secure");',
			'res.setHeader("Set-Cookie", "a=b; HttpOnly; Securely");',
		]) {
			expect(checkCookieMissingSecurityFlags(src, "src/app.js")).toEqual([{ line: 1, text: src }]);
		}
	});

	it("P: reports the real line number for the setHeader pass too", () => {
		expect(
			checkCookieMissingSecurityFlags(
				'const a = 1;\nconst b = 2;\nres.setHeader("Set-Cookie", "a=b; Path=/");',
				"src/app.js",
			),
		).toEqual([{ line: 3, text: 'res.setHeader("Set-Cookie", "a=b; Path=/");' }]);
	});

	it("P: both passes share one finding per line and cap at 10, trimming/truncating text", () => {
		expect(
			checkCookieMissingSecurityFlags(
				'res.cookie("s", v); res.setHeader("Set-Cookie", "a=b; Path=/");',
				"src/app.js",
			),
		).toHaveLength(1);
		expect(
			checkCookieMissingSecurityFlags(
				Array.from({ length: 12 }, (_, i) => `res.cookie("c${i}", v);`).join("\n"),
				"src/app.js",
			),
		).toHaveLength(10);
		expect(
			checkCookieMissingSecurityFlags(
				Array.from({ length: 12 }, (_, i) => `res.setHeader("Set-Cookie", "c${i}=v; Path=/");`).join("\n"),
				"src/app.js",
			),
		).toHaveLength(10);
		const long = `\t  res.cookie("s", ${"x".repeat(200)});`;
		expect(checkCookieMissingSecurityFlags(long, "src/app.js")).toEqual([
			{ line: 1, text: long.trim().slice(0, 150) },
		]);
		// The setHeader pass renders its own text and needs the same treatment.
		const longHdr = `\t  res.setHeader("Set-Cookie", "a=b; ${"q".repeat(200)}");`;
		expect(checkCookieMissingSecurityFlags(longHdr, "src/app.js")).toEqual([
			{ line: 1, text: longHdr.trim().slice(0, 150) },
		]);
	});

	it("P: a long (400-character) header value is still inspected", () => {
		const value = `a=b; Path=/; ${"x".repeat(400 - "a=b; Path=/; ".length)}`;
		expect(value).toHaveLength(400);
		const src = `res.setHeader("Set-Cookie", ${value});`;
		expect(checkCookieMissingSecurityFlags(src, "src/app.js")).toEqual([
			{ line: 1, text: src.trim().slice(0, 150) },
		]);
	});

	it("P: flag text in a TRAILING argument does not clear a flagless options object", () => {
		// Mirror of the "flag text inside a string VALUE" case above, on the far
		// side of the object: only the first top-level `{…}`'s own balanced
		// interior may clear the finding. Any scan that gives up on balancing
		// and returns the tail from `{` to the end of the argument list would
		// swallow this string and silently disarm the gate.
		const src = 'res.cookie("s", v, { path: "/" }, "httpOnly: true; secure: true");';
		expect(checkCookieMissingSecurityFlags(src, "src/app.js")).toEqual([{ line: 1, text: src }]);
	});

	it("P: a chained setHeader is reported on the line the call is written on", () => {
		// Multi-line method chains: the finding must anchor on `setHeader`, not
		// on the receiver it is chained from. The optional receiver prefix in the
		// pattern is same-line by construction; letting it span the newline moves
		// the finding onto the wrong line and quotes the wrong source text.
		expect(
			checkCookieMissingSecurityFlags('res\n.setHeader("Set-Cookie", "a=b; Path=/");', "src/app.js"),
		).toEqual([{ line: 2, text: '.setHeader("Set-Cookie", "a=b; Path=/");' }]);
		// Same, with an indented dot and a single-character receiver.
		expect(
			checkCookieMissingSecurityFlags('r\n  .setHeader("Set-Cookie", "a=b; Path=/");', "src/app.js"),
		).toEqual([{ line: 2, text: '.setHeader("Set-Cookie", "a=b; Path=/");' }]);
	});
});

describe("checkCookieMissingSecurityFlags — negative (must not fire)", () => {
	for (const ext of [...NON_JS_EXTS, ".py"]) {
		it(`N: ignores ${ext}`, () => {
			expect(checkCookieMissingSecurityFlags('res.cookie("s", v);', `src/app${ext}`)).toEqual([]);
		});
	}

	it("N: ignores test files and content with no cookie mention", () => {
		expect(checkCookieMissingSecurityFlags('res.cookie("s", v);', "src/app.test.js")).toEqual([]);
		expect(checkCookieMissingSecurityFlags("res.send(v);", "src/app.js")).toEqual([]);
	});

	it("N: both flags present clears the finding at every spacing", () => {
		for (const opts of [
			"{httpOnly:true,secure:true}",
			"{ httpOnly: true, secure: true }",
			"{ httpOnly : true , secure : true }",
			"{ HttpOnly: true, Secure: true }",
		]) {
			expect(checkCookieMissingSecurityFlags(`res.cookie("s", v, ${opts});`, "src/app.js")).toEqual([]);
		}
	});

	it("N: a nested call inside the options object does not truncate the scan", () => {
		expect(
			checkCookieMissingSecurityFlags(
				'res.cookie("s", v, { expires: new Date(Date.now() + 1), httpOnly: true, secure: true });',
				"src/app.js",
			),
		).toEqual([]);
	});

	it("N: a nested object inside the options does not close it early", () => {
		expect(
			checkCookieMissingSecurityFlags(
				'res.cookie("s", v, { meta: { x: 1 }, httpOnly: true, secure: true });',
				"src/app.js",
			),
		).toEqual([]);
	});

	it("N: an unterminated options object still has its flags counted", () => {
		// PreToolUse sees half-typed buffers; a truncated options object must
		// fail open (report nothing) rather than fire on the partial text.
		expect(
			checkCookieMissingSecurityFlags('res.cookie("s", v, { httpOnly: true, secure: true);', "src/app.js"),
		).toEqual([]);
	});

	it("N: an options object passed as the FIRST argument is still inspected", () => {
		expect(
			checkCookieMissingSecurityFlags(
				'cookies.set({ name: "s", value: v, httpOnly: true, secure: true });',
				"src/app.js",
			),
		).toEqual([]);
	});

	it("N: a call whose parens do not close within the scan bound is skipped, not guessed", () => {
		// The balanced-paren walk gives up after BALANCED_PARENS_MAX_SCAN chars
		// rather than reporting on a partially-read argument list.
		expect(checkCookieMissingSecurityFlags(`res.cookie(${"a".repeat(1999)})`, "src/app.js")).toEqual([]);
		expect(checkCookieMissingSecurityFlags(`res.cookie(${"a".repeat(2500)})`, "src/app.js")).toEqual([]);
	});

	it("N: a Set-Cookie header carrying both attributes is fine, case-insensitively", () => {
		expect(
			checkCookieMissingSecurityFlags('res.setHeader("Set-Cookie", "a=b; HttpOnly; Secure");', "src/app.js"),
		).toEqual([]);
		expect(
			checkCookieMissingSecurityFlags('res.setHeader("Set-Cookie", "a=b; httponly; secure");', "src/app.js"),
		).toEqual([]);
	});

	it("N: mismatched quote delimiters around the header name do not match", () => {
		expect(checkCookieMissingSecurityFlags(`res.setHeader('Set-Cookie", "a=b");`, "src/app.js")).toEqual([]);
	});

	it("N: an unterminated options object in FIRST position still has its flags counted", () => {
		// The half-typed-buffer case from above, with the object at index 0 of
		// the argument list. The fallback must read from just past the `{`
		// forward; reading backward from it (or wrapping to the end of the
		// string) drops the flags and fires on a cookie that carries both.
		expect(
			checkCookieMissingSecurityFlags("cookies.set({ httpOnly: true, secure: true);", "src/app.js"),
		).toEqual([]);
	});
});

describe("checkLoggerFormatUserInput — positive (must fire)", () => {
	for (const ext of JS_TS_EXTS) {
		it(`P: flags logger.info(req) in ${ext}`, () => {
			expect(checkLoggerFormatUserInput("logger.info(req)", `src/app${ext}`)).toEqual([
				{ line: 1, text: "logger.info(req)" },
			]);
		});
	}

	it("P: flags every logger object × level pair", () => {
		for (const obj of ["logger", "log", "console"]) {
			for (const lvl of ["info", "warn", "error", "debug", "trace", "fatal"]) {
				expect(checkLoggerFormatUserInput(`${obj}.${lvl}(req)`, "src/app.js")).toEqual([
					{ line: 1, text: `${obj}.${lvl}(req)` },
				]);
			}
		}
	});

	it("P: flags every request-bound source identifier", () => {
		for (const id of ["req", "ctx", "input", "user", "params", "body", "query", "userInput", "userMsg"]) {
			expect(checkLoggerFormatUserInput(`logger.info(${id})`, "src/app.js")).toEqual([
				{ line: 1, text: `logger.info(${id})` },
			]);
		}
	});

	it("P: tolerates whitespace around the open paren", () => {
		expect(checkLoggerFormatUserInput("logger.info (req)", "src/app.js")).toEqual([
			{ line: 1, text: "logger.info (req)" },
		]);
		expect(checkLoggerFormatUserInput("logger.info( req)", "src/app.js")).toEqual([
			{ line: 1, text: "logger.info( req)" },
		]);
	});

	it("P: reports the real line number, caps at 10, and trims/truncates the text", () => {
		expect(
			checkLoggerFormatUserInput("const a = 1;\nconst b = 2;\nlogger.info(req);", "src/app.js"),
		).toEqual([{ line: 3, text: "logger.info(req);" }]);
		expect(
			checkLoggerFormatUserInput(
				Array.from({ length: 12 }, () => "logger.info(req);").join("\n"),
				"src/app.js",
			),
		).toHaveLength(10);
		const long = `   logger.info(req, ${"y".repeat(200)});`;
		expect(checkLoggerFormatUserInput(long, "src/app.js")).toEqual([
			{ line: 1, text: long.trim().slice(0, 150) },
		]);
	});
});

describe("checkLoggerFormatUserInput — negative (must not fire)", () => {
	for (const ext of [...NON_JS_EXTS, ".py"]) {
		it(`N: ignores ${ext}`, () => {
			expect(checkLoggerFormatUserInput("logger.info(req)", `src/app${ext}`)).toEqual([]);
		});
	}

	it("N: ignores test files and content with no logger call at all", () => {
		expect(checkLoggerFormatUserInput("logger.info(req)", "src/app.test.js")).toEqual([]);
		expect(checkLoggerFormatUserInput("emit(req);", "src/app.js")).toEqual([]);
	});

	it("N: a longer identifier that merely starts with a source prefix is not a source", () => {
		expect(checkLoggerFormatUserInput("logger.info(requestId)", "src/app.js")).toEqual([]);
	});

	it("N: `console.log` is not one of the gated levels", () => {
		expect(checkLoggerFormatUserInput("console.log(req)", "src/app.js")).toEqual([]);
	});

	it("N: a string-literal format argument is the SAFE form", () => {
		expect(checkLoggerFormatUserInput('logger.info("msg", req)', "src/app.js")).toEqual([]);
		expect(checkLoggerFormatUserInput("logger.info('msg', req)", "src/app.js")).toEqual([]);
		expect(checkLoggerFormatUserInput("logger.info(`msg`, req)", "src/app.js")).toEqual([]);
	});
});
