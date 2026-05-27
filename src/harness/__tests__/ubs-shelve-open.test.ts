// Tests for `ubs_shelve_open` — Python shelve.open detector.

import { describe, expect, it } from "vitest";
import { checkShelveOpen } from "../checks/ubs-language-specific.js";

describe("checkShelveOpen", () => {
	it("flags `shelve.open('data.db')`", () => {
		const code = "import shelve\nd = shelve.open('data.db')";
		expect(checkShelveOpen(code, "src/store.py").length).toBeGreaterThan(0);
	});

	it("flags `shelve.open(path)` with identifier arg", () => {
		expect(checkShelveOpen("d = shelve.open(path)", "src/store.py").length).toBeGreaterThan(0);
	});

	it("flags `shelve.open` inside `with` statement", () => {
		const code = "with shelve.open(p) as d:\n    d['k'] = 'v'\n";
		expect(checkShelveOpen(code, "src/store.py").length).toBeGreaterThan(0);
	});

	it("does NOT flag `sqlite3.open(p)`", () => {
		expect(checkShelveOpen("sqlite3.open(p)", "src/store.py")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		expect(checkShelveOpen("shelve.open(p)", "src/store.ts")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkShelveOpen("shelve.open(p)", "tests/test_store.py")).toEqual([]);
	});

	it("respects `# noqa: ubs_shelve_open`", () => {
		const code = "d = shelve.open(p)  # noqa: ubs_shelve_open";
		expect(checkShelveOpen(code, "src/store.py")).toEqual([]);
	});
});
