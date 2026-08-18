import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	__setPackageRootForTesting,
	collectFunctionSignature,
	countTopLevelCommas,
	isCliFile,
	isGeneratedFile,
	isPatternDataFile,
	isScriptOrCliPath,
	isStrictTestFile,
	isTestSourcePath,
	isVendoredOrFixturePath,
	JS_TS_ALL_EXTS,
	JS_TS_EXTS,
	lineHasNoqaSuppression,
} from "./shared.js";

describe("shared mutation boundaries", () => {
	// test-contract: boundary — multiline signatures stop at a delimiter while preserving every preceding source line
	it("collects a signature through a multiline parameter list and stops at the brace", () => {
		const lines = [
			"export function readConfig(",
			"  path: string,",
			"  options?: Options,",
			"): Config {",
			"  return load(path, options);",
		];
		expect(collectFunctionSignature(lines, 0)).toBe(
			" export function readConfig(   path: string,   options?: Options, ): Config {",
		);
	});

	// test-contract: boundary — signature collection honors the documented twenty-line scan bound and arrow terminator
	it("collects an arrow signature and does not scan beyond the twenty-line bound", () => {
		const lines = Array.from({ length: 22 }, (_, index) => `part${index}`);
		lines[21] = "=> result";
		expect(collectFunctionSignature(lines, 0)).not.toContain("part20");
		expect(collectFunctionSignature(["const id = value => value;", "ignored"], 0)).toBe(
			" const id = value => value;",
		);
	});

	// test-contract: invariant — parameter arity counts commas only when all supported delimiters are at top level
	it("counts only top-level commas across every supported nesting delimiter", () => {
		expect(countTopLevelCommas("")).toBe(1);
		expect(countTopLevelCommas("first, second, third")).toBe(3);
		expect(
			countTopLevelCommas("Map<string, number>, (x, y), { a: 1, b: 2 }, [one, two], final"),
		).toBe(5);
	});

	// test-contract: public-api — exported extension collection remains complete and ordered for every supported JS/TS suffix
	it("keeps the JS/TS extension set and ordered array complete", () => {
		const expected = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"];
		expect(JS_TS_ALL_EXTS).toEqual(expected);
		for (const extension of expected) expect(JS_TS_EXTS.has(extension)).toBe(true);
	});

	// test-contract: boundary — strict test-file detection accepts documented conventions without widening near-miss filenames
	it("keeps strict test conventions narrow at filename and directory boundaries", () => {
		for (const path of [
			"/tests/unit.ts",
			"/src/test/fixture.ts",
			"/__tests__/fixture.ts",
			"test_parser.py",
			"parser_test.py",
			"parser_test.go",
			"widget.test.ts",
			"widget.spec.tsx",
			"WidgetTest.java",
			"WidgetTests.java",
			"WidgetTest.swift",
			"WidgetTests.swift",
			"test_widget.swift",
		]) {
			expect(isStrictTestFile(path), path).toBe(true);
		}
		for (const path of [
			"test_parser.js",
			"parser_test.js",
			"parser_test.ts",
			"parser_test.go.bak",
			"widget.test.ts.bak",
			"widget.spec.css",
			"WidgetTest.java.bak",
			"WidgetTests.swift.bak",
			"widget_test_.py",
			"widget_test_.swift",
			"mytests/helper.ts",
			"src/application.ts",
		]) {
			expect(isStrictTestFile(path), path).toBe(false);
		}
	});

	// test-contract: boundary — broad test-source detection anchors directory names and recognizes documented suffix conventions
	it("uses anchored, broad test-source conventions without treating lookalikes as tests", () => {
		for (const path of [
			"tests/helper.ts",
			"test/fixture.ts",
			"__tests__/fixture.rb",
			"src/fixture.test.rb",
			"src/test_fixture.py",
			"src/fixture_test.go",
			"src/FixtureTests.swift",
		]) {
			expect(isTestSourcePath(path), path).toBe(true);
		}
		for (const path of [
			"mytests/helper.ts",
			"contest/fixture.ts",
			"src/testimony.ts",
			"src/fixture.testing.ts",
		]) {
			expect(isTestSourcePath(path), path).toBe(false);
		}
	});

	// test-contract: security — pattern-data exemptions apply to package-owned detector data but never to an outside project
	it("routes package-owned pattern data through the broad data predicate only", () => {
		const packageRoot = process.cwd();
		for (const path of [
			"src/harness/rules/catalog.ts",
			"src/harness/check-registry/catalog.ts",
			"src/harness/check-metadata.ts",
			"src/harness/checks/catalog.ts",
			"src/harness/evaluator/write-content-guards-extra.ts",
			"src/harness/signatures-patterns.ts",
			"src/harness/signatures.ts",
			"src/harness/quality-checks/secret-detection.ts",
			"src/harness/verification-stop-checks.ts",
			"src/hook-template-chunks/guards-inline.ts",
		]) {
			expect(isPatternDataFile(join(packageRoot, path)), path).toBe(true);
		}
		for (const path of [
			join(packageRoot, "..", "user-project/src/harness/rules/catalog.ts"),
			join(packageRoot, "src/lib/ordinary-source.ts"),
		]) {
			expect(isPatternDataFile(path), path).toBe(false);
		}
	});

	// test-contract: public-api — CLI path classification recognizes command roots and valid rooted entry points only
	it("recognizes CLI directories and rooted entry points, but not library lookalikes", () => {
		for (const path of [
			"src/commands/run.ts",
			"src/cmd/run.ts",
			"src/bin/run.ts",
			"src/cli/index.ts",
			"/src/index.ts",
			"/cli/index.ts",
			"/bin/main.js",
			"/cmd/cli.py",
		]) {
			expect(isCliFile(path), path).toBe(true);
		}
		for (const path of [
			"lib/index.ts",
			"/src/xindex.ts",
			"/src/premain.ts",
			"src/index.ts.bak",
			"src/commands-helper.ts",
			"src/mybin/run.ts",
			"src/mycmd/run.ts",
			"src/mycli/run.ts",
		]) {
			expect(isCliFile(path), path).toBe(false);
		}
	});

	// test-contract: boundary — generator markers are line-bounded and limited to the first twenty header lines
	it("requires generator markers to remain within a line in the bounded header", () => {
		expect(isGeneratedFile(["header", "// auto-generated", "code"].join("\n"))).toBe(true);
		// Removing the line separators would incorrectly turn these two lines
		// into the marker `auto-generated`.
		expect(isGeneratedFile(["header", "// auto-", "generated", "code"].join("\n"))).toBe(false);
		expect(isGeneratedFile(Array.from({ length: 21 }, () => "// auto-generated").join("\n"))).toBe(true);
		expect(
			isGeneratedFile(`${Array.from({ length: 20 }, () => "code").join("\n")}\n// auto-generated`),
		).toBe(false);
	});

	// test-contract: public-api — script-like path classification covers singular and plural documented directory forms
	it("recognizes singular/plural script-like roots while preserving path boundaries", () => {
		for (const path of [
			"scripts/run.ts",
			"script/run.ts",
			"bin/run.ts",
			"cli/run.ts",
			"tools/run.ts",
			"tool/run.ts",
			"tutorial/run.ts",
			"tutorials/run.ts",
			"example/run.ts",
			"examples/run.ts",
			"demo/run.ts",
			"demos/run.ts",
			"sample/run.ts",
			"samples/run.ts",
		]) {
			expect(isScriptOrCliPath(path), path).toBe(true);
		}
		for (const path of [
			"myscripts/run.ts",
			"mytutorials/run.ts",
			"myexamples/run.ts",
			"mydemos/run.ts",
			"mysamples/run.ts",
			"src/lib/run.ts",
		]) {
			expect(isScriptOrCliPath(path), path).toBe(false);
		}
	});

	// test-contract: security — noqa suppression accepts mapped Bandit codes and never suppresses unrelated or unknown findings
	it("accepts noqa spacing variants but requires valid mapped codes", () => {
		expect(lineHasNoqaSuppression("eval(x) #noqa:S307", "ubs_eval_input_tainted")).toBe(true);
		expect(lineHasNoqaSuppression("eval(x) # noqa:S307", "ubs_eval_input_tainted")).toBe(true);
		expect(
			lineHasNoqaSuppression("run(x) # noqa: S602,  S605", "child_process_exec_user_input"),
		).toBe(true);
		expect(lineHasNoqaSuppression("run(x) # noqa: S602,S605", "child_process_exec_user_input")).toBe(true);
		expect(lineHasNoqaSuppression("random(x) # noqa: S311", "ubs_eval_input_tainted")).toBe(false);
		expect(lineHasNoqaSuppression("eval(x) # nope: S307", "ubs_eval_input_tainted")).toBe(false);
	});

});

describe("shared mutation boundaries — pass1 W17 residue", () => {
	afterEach(() => {
		__setPackageRootForTesting(undefined);
	});

	// test-contract: security — a Bandit code with no mapped check (S311, random-for-security) must suppress nothing, not even a check id equal to the mutator's own injected placeholder text
	it("never lets an unmapped Bandit code suppress any check, including a Stryker-shaped placeholder id", () => {
		expect(lineHasNoqaSuppression("# noqa: S311", "Stryker was here")).toBe(false);
		expect(lineHasNoqaSuppression("# noqa: S311", "ubs_eval_input_tainted")).toBe(false);
	});

	// test-contract: security — bare `# noqa` with zero spaces before the keyword still suppresses every finding on the line, per documented flake8 convention
	it("treats a zero-space bare noqa as suppress-everything", () => {
		expect(lineHasNoqaSuppression("#noqa", "ubs_eval_input_tainted")).toBe(true);
	});

	// test-contract: security — a single mapped code with zero spaces after the colon still resolves to that code, not to bare-suppress-everything
	it("parses a single code with no space after the colon as that code, not as bare noqa", () => {
		expect(lineHasNoqaSuppression("# noqa:S102", "totally_unrelated_check")).toBe(false);
		expect(lineHasNoqaSuppression("# noqa:S102", "ubs_eval_input_tainted")).toBe(true);
	});

	// test-contract: security — a comma-separated code list tolerates a space before the comma, and every listed code resolves independently
	it("resolves every code in a comma list even when a space precedes the comma", () => {
		expect(lineHasNoqaSuppression("# noqa: S102 , S608", "ubs_sql_string_concat")).toBe(true);
	});

	// test-contract: public-api — isCliFile only treats main/cli/index basenames as entry points; requiring the outer regex match is not a redundant guard
	it("does not treat a non-entry-point basename inside a /cli/ directory as a CLI file", () => {
		expect(isCliFile("/project/cli/foo.ts")).toBe(false);
	});

	// test-contract: public-api — the entry-point basename regex is anchored at the start; a name merely ending in main.ts must not qualify
	it("does not treat a basename that merely ends with main.ts as a CLI entry point", () => {
		expect(isCliFile("/src/mymain.ts")).toBe(false);
	});

	// test-contract: public-api — the entry-point basename regex is anchored at the end; an extra suffix after the extension must not qualify
	it("does not treat a basename with a trailing suffix after the extension as a CLI entry point", () => {
		expect(isCliFile("/src/main.tsx")).toBe(false);
	});

	// test-contract: public-api — the top-level-src-entry check requires the file to sit directly under /src/, not nested arbitrarily deep
	it("does not treat a main/cli/index file nested deep under /src/ as a top-level entry point", () => {
		expect(isCliFile("/project/src/deep/nested/main.ts")).toBe(false);
	});

	// test-contract: boundary — the twenty-line scan window is re-joined with real newlines; two lines must never accidentally fuse into a marker phrase
	it("does not fuse two header lines into a generator marker when re-joining the scan window", () => {
		expect(isGeneratedFile("this file was generat\ned by tool")).toBe(false);
	});

	// test-contract: security — the harness-internal-data exemption's package-root prefix must use the SAME backslash-to-slash conversion as every other path in this module, or the prefix silently narrows
	it("still recognizes the harness-internal exemption when the resolved package root itself contains a raw backslash", () => {
		__setPackageRootForTesting("/fake\\root");
		expect(isPatternDataFile("/fake/root/harness/checks/foo.ts")).toBe(true);
	});

	// test-contract: public-api — isScriptOrCliPath requires the backslash-to-slash normalization to run before matching directory-segment patterns
	it("still recognizes a script directory addressed with backslash separators", () => {
		expect(isScriptOrCliPath("some\\scripts\\foo.py")).toBe(true);
	});

	// test-contract: boundary — the Python test_-prefix branch requires the prefix; ending in .py alone is not sufficient
	it("does not treat a plain .py file lacking the test_ prefix as a strict test file", () => {
		expect(isStrictTestFile("foo.py")).toBe(false);
	});

	// test-contract: boundary — the Java Test/Tests suffix pattern is anchored at the end; extra trailing content must not qualify
	it("does not treat a Java test-looking name with a trailing suffix as a strict test file", () => {
		expect(isStrictTestFile("MyTests.java.bak")).toBe(false);
	});

	// test-contract: boundary — the Swift Test/Tests suffix pattern is anchored at the end; extra trailing content must not qualify
	it("does not treat a Swift test-looking name with a trailing suffix as a strict test file", () => {
		expect(isStrictTestFile("MyTests.swift.orig")).toBe(false);
	});

	// test-contract: boundary — the backslash-to-slash normalization must run before the directory-segment test-source regex is applied
	it("still recognizes a broad test-source directory addressed with backslash separators", () => {
		expect(isTestSourcePath("foo\\tests\\bar.txt")).toBe(true);
	});

	// test-contract: invariant — a bare .py or .swift extension is not itself a broad test-source signal; the test_ prefix is required
	it("does not treat a plain .py file lacking the test_ prefix as a broad test-source path", () => {
		expect(isTestSourcePath("foo.py")).toBe(false);
	});

	// test-contract: invariant — the test_ prefix alone is not a broad test-source signal without a matching .py/.swift extension
	it("does not treat a test_-prefixed file with an unrelated extension as a broad test-source path", () => {
		expect(isTestSourcePath("test_foo.txt")).toBe(false);
	});

	// test-contract: boundary — the Go/Python _test suffix pattern is anchored at the end; extra trailing content must not qualify
	it("does not treat a _test.py-looking name with a trailing suffix as a broad test-source path", () => {
		expect(isTestSourcePath("foo_test.py.bak")).toBe(false);
	});

	// test-contract: boundary — the Java/Swift Test(s) suffix pattern is anchored at the end; extra trailing content must not qualify
	it("does not treat a Java test-looking name with a trailing suffix as a broad test-source path", () => {
		expect(isTestSourcePath("FooTests.java.orig")).toBe(false);
	});

	// test-contract: invariant — the singular Test form (no trailing s) must still qualify under the Java/Swift suffix pattern
	it("still recognizes the singular Test form for the Java suffix pattern", () => {
		expect(isTestSourcePath("FooTest.java")).toBe(true);
	});

	// test-contract: boundary — backslash-to-slash normalization must run before the vendored/fixture directory-segment regex is applied
	it("still recognizes a vendored directory addressed with backslash separators", () => {
		expect(isVendoredOrFixturePath("foo\\vendor\\bar.js")).toBe(true);
	});

	// test-contract: boundary — the minified-asset suffix pattern is anchored at the end; extra trailing content must not qualify
	it("does not treat a .min.js-looking name with a trailing suffix as a minified asset", () => {
		expect(isVendoredOrFixturePath("foo.min.js.bak")).toBe(false);
	});

	// test-contract: boundary — the bundled-asset suffix pattern is anchored at the end; extra trailing content must not qualify
	it("does not treat a .bundle.js-looking name with a trailing suffix as a bundled asset", () => {
		expect(isVendoredOrFixturePath("foo.bundle.js.bak")).toBe(false);
	});
});
