// Tests for `ubs_string_concat_in_loop` (Plan 04 D.1 backlog).
// Gates Java + JS/TS only — Python and Go are covered by the older
// indent-aware `checkStringConcatInLoop` in `checks/performance.ts`. Without
// the language gate, both detectors fire on the same line with different
// `(name, message)` pairs and the post-event dedup can't collapse them.

import { describe, expect, it } from "vitest";
import { checkUbsStringConcatInLoop } from "../checks/ubs-language-specific.js";

describe("checkUbsStringConcatInLoop", () => {
	it("flags `result += part` inside a JS for loop", () => {
		const code = "let result = '';\nfor (const part of parts) {\n  result += part;\n}\n";
		const matches = checkUbsStringConcatInLoop(code, "src/foo.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `result += part` inside a Java for loop", () => {
		const code =
			"String result = \"\";\nfor (String part : parts) {\n  result += part;\n}\n";
		const matches = checkUbsStringConcatInLoop(code, "src/Foo.java");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT fire on Python (handled by checkStringConcatInLoop in performance.ts)", () => {
		const code = "s = ''\nfor c in chunks:\n    s += c\n";
		expect(checkUbsStringConcatInLoop(code, "src/foo.py")).toEqual([]);
	});

	it("does NOT fire on Go (handled by checkStringConcatInLoop in performance.ts)", () => {
		const code =
			"var s string\nfor _, c := range chunks {\n  s += c\n}\n";
		expect(checkUbsStringConcatInLoop(code, "src/foo.go")).toEqual([]);
	});

	it("does NOT flag `result += part` outside a loop in JS", () => {
		const code = "let result = 'hello';\nresult += 'world';\n";
		expect(checkUbsStringConcatInLoop(code, "src/foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "for (const x of y) {\n  s += x;\n}";
		expect(checkUbsStringConcatInLoop(code, "src/foo.test.ts")).toEqual([]);
	});
});
