import { describe, expect, it } from "vitest";
import { checkFocusedTests, checkPlaceholderTests } from "../generic-checks.js";

// ===========================================
// checkFocusedTests — committed .only / fdescribe / fit markers
// ===========================================

describe("checkFocusedTests", () => {
	it("flags it.only", () => {
		const code = 'it.only("runs this only", () => { expect(1).toBe(1); });';
		const matches = checkFocusedTests(code, "foo.test.ts");
		expect(matches.length).toBe(1);
		expect(matches[0].line).toBe(1);
	});

	it("flags describe.only", () => {
		const code = 'describe.only("scope", () => {});';
		expect(checkFocusedTests(code, "foo.test.ts").length).toBe(1);
	});

	it("flags test.only when tests span multiple blocks in the file", () => {
		const code =
			'describe("group", () => {\n    test.only("a", () => { expect(1).toBe(1); });\n    test("b", () => { expect(1).toBe(1); });\n});';
		expect(checkFocusedTests(code, "foo.test.ts").length).toBe(1);
	});

	it("flags fit shorthand", () => {
		const code = 'fit("focused", () => { expect(1).toBe(1); });';
		expect(checkFocusedTests(code, "foo.test.ts").length).toBe(1);
	});

	it("flags fdescribe shorthand", () => {
		const code = 'fdescribe("group", () => {});';
		expect(checkFocusedTests(code, "foo.test.ts").length).toBe(1);
	});

	it("ignores matches inside a comment", () => {
		const code =
			'// it.only("was disabled", () => {});\nit("real", () => { expect(1).toBe(1); });';
		expect(checkFocusedTests(code, "foo.test.ts")).toEqual([]);
	});

	it("ignores matches inside a string literal", () => {
		const code =
			'const msg = "use it.only to focus";\nit("real", () => { expect(1).toBe(1); });';
		expect(checkFocusedTests(code, "foo.test.ts")).toEqual([]);
	});

	it("only runs on test files", () => {
		const code = 'it.only("x", () => {});';
		expect(checkFocusedTests(code, "app.ts")).toEqual([]);
	});

	it("only runs on JS/TS extensions", () => {
		const code = 'it.only("x", () => {});';
		expect(checkFocusedTests(code, "foo_test.py")).toEqual([]);
	});

	it("caps matches at 15", () => {
		const line = 'it.only("x", () => {});';
		const code = Array(40).fill(line).join("\n");
		expect(checkFocusedTests(code, "foo.test.ts").length).toBe(15);
	});

	it("returns no matches for a clean test file", () => {
		const code = 'it("works", () => { expect(1).toBe(1); });';
		expect(checkFocusedTests(code, "foo.test.ts")).toEqual([]);
	});
});

// ===========================================
// checkPlaceholderTests — .todo, pending single-arg, empty bodies, TODO markers
// ===========================================

describe("checkPlaceholderTests — .todo markers", () => {
	it("flags it.todo", () => {
		const code = 'it.todo("implement this later");';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain(".todo placeholder");
	});

	it("flags test.todo", () => {
		const code = 'test.todo("finish");';
		expect(checkPlaceholderTests(code, "foo.test.ts").length).toBe(1);
	});

	it("flags describe.todo", () => {
		const code = 'describe.todo("not yet written");';
		expect(checkPlaceholderTests(code, "foo.test.ts").length).toBe(1);
	});
});

describe("checkPlaceholderTests — pending single-arg tests", () => {
	it("flags it('name') with no callback", () => {
		const code = 'it("pending test");';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.includes("Pending test"))).toBe(true);
	});

	it("flags test('name') with no callback and no semicolon", () => {
		const code = 'test("pending")';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.includes("Pending test"))).toBe(true);
	});

	it("does NOT flag it('name', cb) — that has a body", () => {
		const code = 'it("works", () => { expect(1).toBe(1); });';
		expect(checkPlaceholderTests(code, "foo.test.ts")).toEqual([]);
	});
});

describe("checkPlaceholderTests — empty-body tests", () => {
	it("flags it('name', () => {})", () => {
		const code = 'it("empty", () => {});';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("flags multi-line empty body with only whitespace", () => {
		const code = 'it("empty", () => {\n   \n   \n});';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("flags async empty body", () => {
		const code = 'it("empty", async () => {});';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("flags function-expression empty body", () => {
		const code = 'it("empty", function () {});';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("does NOT flag a body with a real statement", () => {
		const code = 'it("real", () => {\n    const x = 1;\n    expect(x).toBe(1);\n});';
		expect(checkPlaceholderTests(code, "foo.test.ts")).toEqual([]);
	});
});

describe("checkPlaceholderTests — TODO/FIXME-marker-only bodies", () => {
	it("flags a body whose only line is a TODO comment", () => {
		const code = 'it("marker-only", () => {\n    // TODO: write this\n});';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.startsWith("Test body contains only TODO/FIXME"))).toBe(
			true,
		);
	});

	it("flags a body whose only line is a FIXME comment", () => {
		const code = 'it("marker-only", () => {\n    // FIXME: actually test something\n});';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.startsWith("Test body contains only TODO/FIXME"))).toBe(
			true,
		);
	});

	it("flags a body with an XXX marker and no real statement", () => {
		const code = 'it("marker-only", () => {\n    // XXX placeholder\n});';
		const matches = checkPlaceholderTests(code, "foo.test.ts");
		expect(matches.some((m) => m.text.startsWith("Test body contains only TODO/FIXME"))).toBe(
			true,
		);
	});

	it("does NOT flag a body that has both a TODO comment AND a real assertion", () => {
		const code = 'it("real", () => {\n    // TODO: add edge case\n    expect(1).toBe(1);\n});';
		expect(checkPlaceholderTests(code, "foo.test.ts")).toEqual([]);
	});
});

describe("checkPlaceholderTests — scope and limits", () => {
	it("only runs on test files", () => {
		const code = 'it.todo("skipped");';
		expect(checkPlaceholderTests(code, "app.ts")).toEqual([]);
	});

	it("only runs on JS/TS extensions", () => {
		const code = 'it.todo("skipped");';
		expect(checkPlaceholderTests(code, "foo_test.py")).toEqual([]);
	});

	it("leaves .skip / .only alone (other checks own those)", () => {
		const code = 'it.skip("a", () => {});\nit.only("b", () => { expect(1).toBe(1); });';
		expect(checkPlaceholderTests(code, "foo.test.ts")).toEqual([]);
	});

	it("caps matches at 15", () => {
		const line = 'it.todo("x");';
		const code = Array(40).fill(line).join("\n");
		expect(checkPlaceholderTests(code, "foo.test.ts").length).toBe(15);
	});

	it("returns no matches for a clean test file with real tests", () => {
		const code = 'it("works", () => {\n    const x = 1;\n    expect(x).toBe(1);\n});';
		expect(checkPlaceholderTests(code, "foo.test.ts")).toEqual([]);
	});
});
