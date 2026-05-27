// Tests for `ubs_outer_html_assignment` — .outerHTML = XSS sink.

import { describe, expect, it } from "vitest";
import { checkOuterHtmlAssignment } from "../checks/ubs-language-specific.js";

describe("checkOuterHtmlAssignment — positive cases", () => {
	it("flags `el.outerHTML = html`", () => {
		expect(checkOuterHtmlAssignment("el.outerHTML = html", "src/a.ts").length).toBeGreaterThan(0);
	});

	it("flags `node.outerHTML =` with whitespace", () => {
		expect(checkOuterHtmlAssignment("node.outerHTML  =  html", "src/a.ts").length).toBeGreaterThan(
			0,
		);
	});

	it("flags chained `parent.firstChild.outerHTML = x`", () => {
		expect(
			checkOuterHtmlAssignment("parent.firstChild.outerHTML = x", "src/a.tsx").length,
		).toBeGreaterThan(0);
	});
});

describe("checkOuterHtmlAssignment — negative cases", () => {
	it("does NOT flag reading `.outerHTML`", () => {
		expect(checkOuterHtmlAssignment("const h = el.outerHTML", "src/a.ts")).toEqual([]);
	});

	it("does NOT flag a string literal containing `.outerHTML =`", () => {
		expect(checkOuterHtmlAssignment("const s = '.outerHTML = banned'", "src/a.ts")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		expect(checkOuterHtmlAssignment("el.outerHTML = x", "src/a.py")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkOuterHtmlAssignment("el.outerHTML = x", "src/a.test.ts")).toEqual([]);
	});
});
