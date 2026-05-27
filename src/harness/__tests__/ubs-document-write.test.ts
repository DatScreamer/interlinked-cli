// Tests for `ubs_document_write` — document.write XSS sink.

import { describe, expect, it } from "vitest";
import { checkDocumentWrite } from "../checks/ubs-language-specific.js";

describe("checkDocumentWrite — positive cases", () => {
	it("flags `document.write(...)`", () => {
		expect(checkDocumentWrite("document.write(html)", "src/a.ts").length).toBeGreaterThan(0);
	});

	it("flags `document.writeln(...)`", () => {
		expect(checkDocumentWrite("document.writeln(html)", "src/a.ts").length).toBeGreaterThan(0);
	});

	it("flags `document . write(...)` with whitespace", () => {
		expect(checkDocumentWrite("document . write(html)", "src/a.ts").length).toBeGreaterThan(0);
	});
});

describe("checkDocumentWrite — negative cases", () => {
	it("does NOT flag `document.body.appendChild(...)`", () => {
		expect(checkDocumentWrite("document.body.appendChild(node)", "src/a.ts")).toEqual([]);
	});

	it("does NOT flag a string literal containing `document.write`", () => {
		expect(checkDocumentWrite("const s = 'document.write banned'", "src/a.ts")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		expect(checkDocumentWrite("document.write(html)", "src/a.py")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkDocumentWrite("document.write(html)", "src/a.test.ts")).toEqual([]);
	});
});
