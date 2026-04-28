// Tests for `ubs_unchecked_redirect` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkUncheckedRedirect } from "../checks/ubs-language-specific.js";

describe("checkUncheckedRedirect", () => {
	it("flags `redirect(url)` with identifier arg", () => {
		const code = "function go(url) {\n  redirect(url);\n}\n";
		const matches = checkUncheckedRedirect(code, "src/foo.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `location.href = userUrl`", () => {
		const code = "location.href = userUrl;\n";
		const matches = checkUncheckedRedirect(code, "src/foo.js");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `redirect('/login')` (literal)", () => {
		const code = "redirect('/login');\n";
		expect(checkUncheckedRedirect(code, "src/foo.ts")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		const code = "redirect(url)";
		expect(checkUncheckedRedirect(code, "src/foo.py")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "redirect(url);";
		expect(checkUncheckedRedirect(code, "src/foo.test.ts")).toEqual([]);
	});
});
