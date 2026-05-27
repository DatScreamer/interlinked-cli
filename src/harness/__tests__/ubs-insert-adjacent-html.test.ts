// Tests for `ubs_insert_adjacent_html` — .insertAdjacentHTML XSS sink.

import { describe, expect, it } from "vitest";
import { checkInsertAdjacentHtml } from "../checks/ubs-language-specific.js";

describe("checkInsertAdjacentHtml — positive cases", () => {
	it("flags `el.insertAdjacentHTML('beforeend', html)`", () => {
		const code = `el.insertAdjacentHTML('beforeend', html)`;
		expect(checkInsertAdjacentHtml(code, "src/a.ts").length).toBeGreaterThan(0);
	});

	it("flags chained `parent.firstChild.insertAdjacentHTML(p, h)`", () => {
		const code = `parent.firstChild.insertAdjacentHTML(pos, h)`;
		expect(checkInsertAdjacentHtml(code, "src/a.tsx").length).toBeGreaterThan(0);
	});

	it("flags whitespaced `.insertAdjacentHTML  (`", () => {
		const code = `el.insertAdjacentHTML  (pos, h)`;
		expect(checkInsertAdjacentHtml(code, "src/a.ts").length).toBeGreaterThan(0);
	});
});

describe("checkInsertAdjacentHtml — negative cases", () => {
	it("does NOT flag the safe `.insertAdjacentText(...)`", () => {
		expect(checkInsertAdjacentHtml("el.insertAdjacentText(pos, t)", "src/a.ts")).toEqual([]);
	});

	it("does NOT flag the safe `.insertAdjacentElement(...)`", () => {
		expect(checkInsertAdjacentHtml("el.insertAdjacentElement(pos, n)", "src/a.ts")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		expect(checkInsertAdjacentHtml("el.insertAdjacentHTML(p, h)", "src/a.py")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkInsertAdjacentHtml("el.insertAdjacentHTML(p, h)", "src/a.test.ts")).toEqual([]);
	});
});
