// Tests for `ubs_unsafe_format_string` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkUnsafeFormatString } from "../checks/ubs-language-specific.js";

describe("checkUnsafeFormatString", () => {
	it("flags `printf(fmt)` with non-literal format", () => {
		const code = "void log(const char* fmt) {\n  printf(fmt);\n}\n";
		const matches = checkUnsafeFormatString(code, "src/foo.c");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `sprintf(buf, fmt)` with non-literal format", () => {
		const code = "char buf[64];\nsprintf(buf, fmt);\n";
		const matches = checkUnsafeFormatString(code, "src/foo.c");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `printf(\"hello\")` (literal format)", () => {
		const code = 'printf("hello");';
		expect(checkUnsafeFormatString(code, "src/foo.c")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		const code = "printf(fmt)";
		expect(checkUnsafeFormatString(code, "src/foo.py")).toEqual([]);
	});

	it("does NOT flag `snprintf(buf, n, \"%s\", input)` — n is the size, format is the literal", () => {
		// Regression: an earlier version reused the two-arg `sprintf` regex
		// for `snprintf` and so misclassified the size argument (an
		// identifier in slot 2) as a tainted format. The real format slot
		// for snprintf is slot 3, which here holds a literal "%s".
		const code = 'char buf[64];\nsnprintf(buf, n, "%s", input);';
		expect(checkUnsafeFormatString(code, "src/foo.c")).toEqual([]);
	});

	it("does NOT flag `snprintf(buf, sizeof(buf), \"hello %d\", x)` — size in slot 2 is a literal", () => {
		const code = 'char buf[64];\nsnprintf(buf, sizeof(buf), "hello %d", x);';
		expect(checkUnsafeFormatString(code, "src/foo.c")).toEqual([]);
	});

	it("flags `snprintf(buf, n, fmt)` with non-literal format in slot 3", () => {
		// True positive — third arg is an identifier, so the format is
		// caller-controlled.
		const code = "char buf[64];\nsnprintf(buf, n, fmt);";
		const matches = checkUnsafeFormatString(code, "src/foo.c");
		expect(matches.length).toBeGreaterThan(0);
	});
});
