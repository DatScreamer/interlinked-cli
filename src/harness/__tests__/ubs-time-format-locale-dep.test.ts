// Tests for `ubs_time_format_locale_dep` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkTimeFormatLocaleDep } from "../checks/ubs-language-specific.js";

describe("checkTimeFormatLocaleDep", () => {
	it("flags JS `date.toLocaleString()` (no args)", () => {
		const code = "const s = date.toLocaleString();\n";
		const matches = checkTimeFormatLocaleDep(code, "src/lib/fmt.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `date.toLocaleDateString()`", () => {
		const code = "const s = date.toLocaleDateString();\n";
		const matches = checkTimeFormatLocaleDep(code, "src/lib/fmt.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `date.toLocaleString('en-US')` (explicit locale)", () => {
		const code = "const s = date.toLocaleString('en-US');\n";
		expect(checkTimeFormatLocaleDep(code, "src/lib/fmt.ts")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		const code = "date.toLocaleString();";
		expect(checkTimeFormatLocaleDep(code, "src/lib/fmt.py")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "date.toLocaleString();";
		expect(checkTimeFormatLocaleDep(code, "src/foo.test.ts")).toEqual([]);
	});
});
