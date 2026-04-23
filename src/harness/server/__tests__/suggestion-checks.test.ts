import { describe, expect, it } from "vitest";
import { collectSuggestionFindings, getSuggestionChecks } from "../suggestion-checks.js";

describe("collectSuggestionFindings", () => {
	it("returns an array (empty or populated) for clean TS code", () => {
		const findings = collectSuggestionFindings(
			"export function add(a: number, b: number): number { return a + b; }\n",
			"/tmp/test.ts",
		);
		expect(Array.isArray(findings)).toBe(true);
	});

	it("each finding has check, line, message, source fields", () => {
		// Code that should trip at least one heuristic (magic-number, silent catch)
		const code = `
			function handle(): number {
				try {
					return 42; // magic number, no context
				} catch {
					return 0;
				}
			}
		`;
		const findings = collectSuggestionFindings(code, "/tmp/test.ts");
		for (const f of findings) {
			expect(typeof f.check).toBe("string");
			expect(typeof f.line).toBe("number");
			expect(typeof f.message).toBe("string");
			expect(["security", "performance", "quality"]).toContain(f.source);
		}
	});

	it("does not throw on empty input", () => {
		expect(() => collectSuggestionFindings("", "/tmp/empty.ts")).not.toThrow();
	});
});

describe("getSuggestionChecks", () => {
	it("returns a non-empty registry", () => {
		const checks = getSuggestionChecks();
		expect(checks.length).toBeGreaterThan(20);
	});

	it("every entry has check and source strings", () => {
		for (const c of getSuggestionChecks()) {
			expect(typeof c.check).toBe("string");
			expect(c.check.length).toBeGreaterThan(0);
			expect(typeof c.source).toBe("string");
		}
	});

	it("includes core categories of checks", () => {
		const ids = getSuggestionChecks().map((c) => c.check);
		expect(ids).toContain("sql-injection");
		expect(ids).toContain("boolean-trap");
		expect(ids).toContain("magic-numbers");
		expect(ids).toContain("perf-await-in-loop");
	});
});
