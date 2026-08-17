import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	collectFunctionSignature,
	countTopLevelCommas,
	isCliFile,
	isGeneratedFile,
	isPatternDataFile,
	isScriptOrCliPath,
	isStrictTestFile,
	isTestSourcePath,
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
