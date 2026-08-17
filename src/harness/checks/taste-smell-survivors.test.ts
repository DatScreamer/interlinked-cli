import { describe, expect, it } from "vitest";
import {
	checkCommentedOutCode,
	checkFlagArguments,
	checkMagicNumbers,
	checkNegatedConditionWithElse,
	checkNestedTernary,
} from "./taste-smell.js";

const sourcePath = "src/lib/example.ts";

describe("taste-smell survivor boundaries", () => {
	it("recognizes a multi-character operator as expression context", () => {
		expect(checkMagicNumbers("value>>37;", sourcePath)).toEqual([
			{ line: 1, text: "value>>37;" },
		]);
	});

	it("keeps a spaced static readonly declaration out of magic-number findings", () => {
		expect(checkMagicNumbers("static readonly  LIMIT = compute(37);", sourcePath)).toEqual([]);
	});

	it("requires a negated condition, not merely an if with an else", () => {
		expect(
			checkNegatedConditionWithElse("if (ready) {} else { fallback(); }", sourcePath),
		).toEqual([]);
	});

	it("reports an unindented same-line closing brace followed by else", () => {
		expect(checkNegatedConditionWithElse("if (!ready) {} else { fallback(); }", sourcePath)).toEqual([
			{ line: 1, text: "if (!ready) {} else { fallback(); }" },
		]);
	});

	it("reports an unindented closing brace whose else is on the next line", () => {
		expect(checkNegatedConditionWithElse("if (!ready) {\n} else {\n  fallback();\n}", sourcePath)).toEqual([
			{ line: 1, text: "if (!ready) {" },
		]);
	});

	it("does not accept a same-line closing brace when the scan starts with a stray closer", () => {
		// The first-character guard must ignore the leading closer and continue
		// scanning to the actual `} else` boundary.
		expect(checkNegatedConditionWithElse("} if (!ready) {{\n} else {", sourcePath)).toEqual([
			{ line: 1, text: "} if (!ready) {{" },
		]);
	});

	it("uses the trimmed source line in negated-condition findings", () => {
		expect(checkNegatedConditionWithElse("  if (!ready) {} else {}", sourcePath)).toEqual([
			{ line: 1, text: "if (!ready) {} else {}" },
		]);
	});

	it("does not treat a terminal optional chain as a nested ternary", () => {
		expect(checkNestedTernary("const value = primary ? fallback?.", sourcePath)).toEqual([]);
	});

	it("does treat a final bare question mark as a nested ternary", () => {
		expect(checkNestedTernary("const value = primary ? fallback ?", sourcePath)).toEqual([
			{ line: 1, text: "const value = primary ? fallback ?" },
		]);
	});

	it("does not count a nullish operator as a ternary", () => {
		expect(checkNestedTernary("const value = primary ? fallback ?? replacement;", sourcePath)).toEqual([]);
	});

	it("keeps the function-call context for a multi-character callee", () => {
		expect(checkMagicNumbers("processValue(37);", sourcePath)).toEqual([
			{ line: 1, text: "processValue(37);" },
		]);
	});

	it("reports spaced arrow signatures with boolean parameters", () => {
		expect(checkFlagArguments("const build: Handler   = (a: boolean, b: boolean) => a;", sourcePath)).toEqual([
			{ line: 1, text: "[2 boolean params → use options object] const build: Handler   = (a: boolean, b: boolean) => a;" },
		]);
	});

	it("trims a function signature before putting it in the finding", () => {
		expect(checkFlagArguments("  function build(a: boolean, b: boolean) {}", sourcePath)).toEqual([
			{ line: 1, text: "[2 boolean params → use options object] function build(a: boolean, b: boolean) {}" },
		]);
	});

	it("does not infer a function from a typed call site", () => {
		expect(checkFlagArguments("invoke(a: boolean, b: boolean);", sourcePath)).toEqual([]);
	});

	it("does not count a short comment block as disabled code", () => {
		expect(checkCommentedOutCode("// save();\n// audit();", sourcePath)).toEqual([]);
	});

	it("resets the commented-code block start between separate blocks", () => {
		expect(
			checkCommentedOutCode(
				"// note only\nrealCode();\n// save();\n// audit();\n// publish();\nrealCode();",
				sourcePath,
			),
		).toEqual([{ line: 3, text: "[3 lines of commented-out code → use version control instead]" }]);
	});

	it("treats a type-shaped line with an interior semicolon as executable when it has a call", () => {
		expect(
			checkCommentedOutCode("// save();\n// audit();\n// retries: number; doWork();\nrealCode();", sourcePath),
		).toEqual([{ line: 1, text: "[3 lines of commented-out code → use version control instead]" }]);
	});

	it("treats a type-shaped line with an unspaced interior semicolon as executable when it has a call", () => {
		expect(
			checkCommentedOutCode("// save();\n// audit();\n// retries: number;doWork();\nrealCode();", sourcePath),
		).toEqual([{ line: 1, text: "[3 lines of commented-out code → use version control instead]" }]);
	});

	it("does not broaden compound-assignment syntax to arbitrary punctuation", () => {
		expect(checkCommentedOutCode("// save();\n// audit();\n// x ?= value;\nrealCode();", sourcePath)).toEqual([]);
	});

	it("keeps a comparison-shaped Python line from becoming an assignment", () => {
		expect(checkCommentedOutCode("# save()\n# audit()\n# x ==y;\nreal_code()", "scripts/example.py")).toEqual([
			{ line: 1, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});

	it("requires a bare JavaScript call to end at the closing parenthesis", () => {
		expect(checkCommentedOutCode("// save();\n// audit();\n// publish()extra\nrealCode();", sourcePath)).toEqual([]);
	});

	it("requires the fallback call to end after its optional semicolon", () => {
		expect(checkCommentedOutCode("// save();\n// audit();\n// publish();extra\nrealCode();", sourcePath)).toEqual([]);
	});

	it("does not use a non-terminal semicolon as the generic JavaScript fallback", () => {
		expect(checkCommentedOutCode("// save();\n// audit();\n// x = ;more\nrealCode();", sourcePath)).toEqual([]);
	});

	it("does not let an inline TODO hide a disabled statement", () => {
		expect(
			checkCommentedOutCode("// save();\n// audit();\n// return value; // TODO: remove\nrealCode();", sourcePath),
		).toEqual([{ line: 1, text: "[3 lines of commented-out code → use version control instead]" }]);
	});

	it("does not let an inline license marker hide a disabled statement", () => {
		expect(
			checkCommentedOutCode("// save();\n// audit();\n// return value; // Copyright: Example\nrealCode();", sourcePath),
		).toEqual([{ line: 1, text: "[3 lines of commented-out code → use version control instead]" }]);
	});

	it("recognizes Python comments with no space after the hash", () => {
		expect(checkCommentedOutCode("#save()\n#audit()\n#publish()\nreal_code()", "scripts/example.py")).toEqual([
			{ line: 1, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});

	it("recognizes indented Python comments", () => {
		expect(checkCommentedOutCode("  # save()\n  # audit()\n  # publish()\nreal_code()", "scripts/example.py")).toEqual([
			{ line: 1, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});

	it("recognizes JavaScript comments with no space after the slashes", () => {
		expect(checkCommentedOutCode("//save();\n//audit();\n//publish();\nrealCode();", sourcePath)).toEqual([
			{ line: 1, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});

	it("recognizes indented JavaScript comments", () => {
		expect(checkCommentedOutCode("  // save();\n  // audit();\n  // publish();\nrealCode();", sourcePath)).toEqual([
			{ line: 1, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});

	it("skips a license line without changing the executable-code count", () => {
		expect(
			checkCommentedOutCode("// save();\n// audit();\n// publish();\n// Copyright: Example\nrealCode();", sourcePath),
		).toEqual([{ line: 1, text: "[4 lines of commented-out code → use version control instead]" }]);
	});
});
